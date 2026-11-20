// boundary review（全部の切れ目を LLM／人が見直す材料）、boundary set の --at-text と previous、align の reviewHint の試験。模擬の transcript で動かす（ASR なし）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runCli } from '../../cli/narrate.js';
import { pythonPath } from '../../cli/lib/exec.js';
import { buildMock, writeMock, inGap, ROOT, RATE, SLIDES } from './helpers/mock-speech.js';

const TMP = path.join(ROOT, 'work', 'G1', 'test');
let n = 0;
async function ws(label) {
  const d = path.join(TMP, `${label}-${process.pid}-${Date.now().toString(36)}-${n++}`);
  await fsp.mkdir(d, { recursive: true });
  return d;
}
const rm = (d) => fsp.rm(d, { recursive: true, force: true });

async function cli(...argv) {
  let out = '';
  const { exitCode } = await runCli(argv.flat(), { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  return { code: exitCode, env: JSON.parse(lines[0]) };
}

async function aligned(label, opts, alignArgs = []) {
  const dir = await ws(label);
  const mock = buildMock(opts);
  await writeMock(dir, mock);
  const r = await cli('align', '--workspace', dir, ...alignArgs);
  return { dir, mock, r };
}

const reviewJson = async (dir, ...extra) => {
  const r = await cli('boundary', 'review', '--workspace', dir, '--format', 'json', ...extra);
  assert.equal(r.code, 0, JSON.stringify(r.env.errors));
  return r.env.result;
};
const flagCodes = (cut) => cut.flags.filter((f) => f.severity === 'warn').map((f) => f.code);

test('review evaluation distinguishes baseline, new and fault-relevant warning codes', () => {
  const scenario = `
import json, runpy
eval = runpy.run_path('checker/speech/eval/review-eval.py')
trials = [
    {'slideId': 'a', 'changed': True, 'flags': ['needs-decision']},
    {'slideId': 'b', 'changed': True, 'flags': ['low-asr-confidence']},
    {'slideId': 'c', 'changed': True, 'flags': ['weak-edge-match', 'weak-edge-match']},
    {'slideId': 'd', 'changed': False},
]
baseline = {'a': ['needs-decision'], 'b': [], 'c': ['extra-words'], 'd': []}
print(json.dumps(eval['summarize_injections'](trials, baseline, eval['TRANSCRIPT_FLAGS'])))
`;
  const r = spawnSync(pythonPath(), ['-I', '-c', scenario], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    attempted: 4, changed: 3, unchanged: ['d'],
    flaggedCuts: { baseline: 2, afterFault: 3, newAfterFault: 2, newRelevantAfterFault: 1 },
    codes: {
      baseline: { 'needs-decision': 1, 'extra-words': 1 },
      afterFault: { 'needs-decision': 1, 'low-asr-confidence': 1, 'weak-edge-match': 1 },
      newAfterFault: { 'low-asr-confidence': 1, 'weak-edge-match': 1 },
      newRelevantAfterFault: { 'weak-edge-match': 1 },
    },
    missedNewRelevant: ['a', 'b'],
  });
});

test('review (a): 全部の切れ目に、位置・状態・前後の文字起こし（▮）・台本の端・照合・無音が入る', async () => {
  const { dir, mock } = await aligned('rv-a', { seed: 1 });
  try {
    const r = await cli('boundary', 'review', '--workspace', dir);
    assert.equal(r.code, 0, JSON.stringify(r.env.errors));
    const md = r.env.result.markdown;
    assert.equal(r.env.result.summary.cuts, 7);
    assert.equal((md.match(/^## \d+\. /gm) || []).length, 7, 'one block per cut, auto ones too');
    assert.equal((md.match(/▮/g) || []).length, 7 + 1, 'a marker in each block (+1 in the legend)');
    assert.match(md, /⟨\d+⟩/, 'time marks');
    assert.match(md, /auto 0\.\d\d/);
    assert.match(md, /台本 末「/);
    assert.match(md, /照合 末文 [\d.]+s \d+% \/ 次頭文 [\d.]+s \d+%/);
    assert.match(md, /無音 [\d.]+–[\d.]+\*/, 'the quiet stretch that holds the cut is starred');
    // 台本の端：スライド 1 の末尾とスライド 2 の先頭（60 字以内）
    assert.ok(md.includes('ひだまり公園の春の清掃活動について、計画をご説明します。'));
    // JSON 形式
    const j = await reviewJson(dir);
    assert.equal(j.cuts.length, 7);
    const c = j.cuts[0];
    assert.equal(c.slideId, 's0001');
    assert.equal(c.nextSlideId, 's0002');
    assert.equal(c.status, 'auto');
    assert.ok(c.transcript.before.length > 5 && c.transcript.after.length > 5);
    assert.ok(c.script.end.length <= 60 && c.script.nextStart.length <= 60);
    assert.ok(c.match.lastSentenceOfSlide.found && c.match.firstSentenceOfNext.found);
    assert.ok(c.match.lastSentenceOfSlide.match > 0.9);
    assert.ok(c.silence.some((s) => s.atCut));
    assert.ok(inGap(mock, c.sample, 0));
    for (const cut of j.cuts) assert.deepEqual(flagCodes(cut), [], `a clean recording has no flags (${cut.slideId})`);
    // --out
    const out = path.join(dir, 'review.md');
    const w = await cli('boundary', 'review', '--workspace', dir, '--out', out);
    assert.equal(w.code, 0);
    assert.match(await fsp.readFile(out, 'utf8'), /^# 切れ目の見直し/);
    const wj = await cli('boundary', 'review', '--workspace', dir, '--out', path.join(dir, 'review.json'));
    assert.equal(JSON.parse(await fsp.readFile(path.join(dir, 'review.json'), 'utf8')).cuts.length, 7);
    assert.equal(wj.env.result.format, 'json');
  } finally { await rm(dir); }
});

test('review (a): 怪しさの印：読み飛ばし、言い直し、アドリブ、弱い一致、誤認識の注入', async () => {
  const cases = [
    { name: 'skip', opts: { seed: 2, skip: [{ slide: 2, sentence: 1 }] }, cut: 2, codes: ['skipped-sentence'] }, // スライド 3 の最後の文を飛ばした → 切れ目 3（index 2）
    { name: 'repeat', opts: { seed: 3, repeat: [{ slide: 3, sentence: 1 }] }, cut: 3, codes: ['repeat-suspected'] },
    { name: 'adlib', opts: { seed: 4, adlib: [{ afterSlide: 4, seconds: 10 }] }, cut: 4, codes: ['extra-words'] },
    { name: 'garble-half', opts: { seed: 5, garble: [{ slide: 0, sentence: 1, rate: 0.55 }] }, cut: 0, codes: ['weak-edge-match', 'skipped-sentence', 'needs-decision'] },
    { name: 'garble-all', opts: { seed: 6, garble: [{ slide: 5, sentence: 1, rate: 1 }] }, cut: 5, codes: ['skipped-sentence', 'weak-edge-match', 'needs-decision'] },
  ];
  for (const c of cases) {
    const { dir } = await aligned(`rv-${c.name}`, c.opts);
    try {
      const j = await reviewJson(dir);
      const got = flagCodes(j.cuts[c.cut]);
      assert.ok(got.some((x) => c.codes.includes(x)), `${c.name}: flags ${JSON.stringify(got)} should include one of ${c.codes}`);
      const others = j.cuts.filter((_, i) => i !== c.cut && Math.abs(i - c.cut) > 1);
      for (const o of others) assert.deepEqual(flagCodes(o), [], `${c.name}: far cut ${o.slideId} has no flags`);
    } finally { await rm(dir); }
  }
});

test('review (b): 1 切れ目は 450 字以内、16 枚で数千字（長い録音でも膨らまない）', async () => {
  const slides = [...SLIDES, ...SLIDES]; // 16 枚
  const dir = await ws('rv-b');
  try {
    const mock = buildMock({ seed: 7, slides });
    await writeMock(dir, mock);
    const a = await cli('align', '--workspace', dir);
    assert.ok([0, 4].includes(a.code));
    const r = await cli('boundary', 'review', '--workspace', dir);
    const s = r.env.result.summary;
    assert.equal(s.cuts, 15);
    assert.ok(s.maxCutChars <= 450, `max per cut ${s.maxCutChars}`);
    assert.ok(s.markdownChars <= 7500, `total ${s.markdownChars}`);
    // 文脈の秒数を小さくすると短くなる
    const small = await cli('boundary', 'review', '--workspace', dir, '--context-sec', '6');
    assert.ok(small.env.result.summary.markdownChars < s.markdownChars);
    // 上限を厳しくすると、文脈が縮む（最小 5 秒）
    const tight = await cli('boundary', 'review', '--workspace', dir, '--max-chars', '300');
    assert.ok(tight.env.result.summary.markdownChars < s.markdownChars);
  } finally { await rm(dir); }
});

test('review: 台本・音声が違う boundaries.json、足りないファイルは断る', async () => {
  const { dir } = await aligned('rv-bad', { seed: 8 });
  try {
    await fsp.rm(path.join(dir, 'transcript.json'));
    const r = await cli('boundary', 'review', '--workspace', dir);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
    const none = await ws('rv-none');
    const r2 = await cli('boundary', 'review', '--workspace', none);
    assert.equal(r2.env.errors[0].code, 'no-boundaries');
    await rm(none);
  } finally { await rm(dir); }
});

test('set --at-text (c): 語句の直後の無音へ吸着する。before-text は直前の無音', async () => {
  const { dir, mock } = await aligned('tx-a', { seed: 9 });
  try {
    // スライド 3（index 2）の最後の文の最後の語句 → 切れ目 3 は、その直後の無音の中点
    const phrase = 'お越しください';
    const r = await cli('boundary', 'set', '--slide', 's0003', '--at-text', `…${phrase}。▮`, '--workspace', dir);
    assert.equal(r.code, 0, JSON.stringify(r.env.errors));
    assert.equal(r.env.result.via, 'at-text');
    assert.equal(r.env.result.snapped.kind, 'silence');
    const mid = ((mock.truthSlides[2].speechEnd + mock.truthSlides[3].speechStart) / 2) * RATE;
    assert.ok(Math.abs(r.env.result.sample - mid) < 0.15 * RATE, 'in the middle of the silence after the phrase');
    assert.ok(inGap(mock, r.env.result.sample, 2));
    // 次のスライドの最初の語句の直前
    const b = await cli('boundary', 'set', '--slide', 's0003', '--before-text', '集合場所は公園の南口', '--workspace', dir);
    assert.equal(b.code, 0, JSON.stringify(b.env.errors));
    assert.ok(inGap(mock, b.env.result.sample, 2));
    assert.equal(b.env.result.text.mode, 'before');
    // ⟨10⟩ のような目印、句読点、全角の違いは無視する
    const m = await cli('boundary', 'set', '--slide', 's0003', '--at-text', 'お⟨25⟩越し、ください', '--workspace', dir);
    assert.equal(m.code, 0, JSON.stringify(m.env.errors));
  } finally { await rm(dir); }
});

test('set --at-text (c): 複数の場所に当たると ambiguous-text（終了コード 2）。--nth で選べる。無いと text-not-found', async () => {
  const { dir } = await aligned('tx-b', { seed: 10 });
  try {
    const before = await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8');
    // 「ます」はスライド 4（index 3）と 5 の範囲に複数ある
    const amb = await cli('boundary', 'set', '--slide', 's0004', '--at-text', 'ます', '--workspace', dir);
    assert.equal(amb.code, 2);
    assert.equal(amb.env.errors[0].code, 'ambiguous-text');
    const occ = amb.env.result.occurrences;
    assert.ok(occ.length >= 2);
    assert.ok(occ.every((o) => o.context.includes('【') && /--nth \d+/.test(o.howToSet)));
    assert.equal(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'), before, 'nothing written');
    // --nth で選ぶ（スライドの範囲内のどれか）
    const nth = await cli('boundary', 'set', '--slide', 's0004', '--at-text', 'ます', '--nth', '1', '--workspace', dir);
    assert.ok(nth.code === 0 || nth.code === 2, JSON.stringify(nth.env.errors)); // 逆転するなら boundary-order
    const nf = await cli('boundary', 'set', '--slide', 's0004', '--at-text', '存在しない語句です', '--workspace', dir);
    assert.equal(nf.code, 2);
    assert.equal(nf.env.errors[0].code, 'text-not-found');
    const tiny = await cli('boundary', 'set', '--slide', 's0004', '--at-text', '。', '--workspace', dir);
    assert.equal(tiny.code, 2);
    const both = await cli('boundary', 'set', '--slide', 's0004', '--at-text', 'ます', '--at', '10', '--workspace', dir);
    assert.equal(both.code, 2);
  } finally { await rm(dir); }
});

test('set (d): auto の切れ目も直せる。status confirmed、method manual、previous に前の値が残る（入れ子で履歴）', async () => {
  const { dir, mock } = await aligned('set-d', { seed: 11 });
  try {
    const b0 = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'));
    assert.equal(b0.slides[1].status, 'auto');
    const orig = b0.slides[1].endSample;
    const mid = (mock.truthSlides[1].speechEnd + mock.truthSlides[2].speechStart) / 2;
    const r = await cli('boundary', 'set', '--slide', 's0002', '--at', String(mid + 0.1), '--workspace', dir);
    assert.equal(r.code, 0);
    let b = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'));
    const s = b.slides[1];
    assert.equal(s.status, 'confirmed');
    assert.equal(s.method, 'manual');
    assert.equal(s.confidence, 1);
    assert.equal(s.previous.endSample, orig);
    assert.equal(s.previous.status, 'auto');
    assert.equal(s.previous.method, 'asr-align');
    assert.equal(s.previous.via, 'at');
    assert.equal(b.slides[2].startSample, s.endSample, 'still contiguous');
    // もう一度直すと、履歴が入れ子になる
    const r2 = await cli('boundary', 'set', '--slide', 's0002', '--at', String(mid), '--exact', '--workspace', dir);
    assert.equal(r2.code, 0);
    b = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'));
    assert.equal(b.slides[1].previous.method, 'manual');
    assert.equal(b.slides[1].previous.previous.endSample, orig);
    // review は、手で直した切れ目を示す
    const j = await reviewJson(dir);
    assert.ok(j.cuts[1].flags.some((f) => f.code === 'moved-by-hand'));
    assert.equal(j.cuts[1].previous.endSample, b.slides[1].previous.endSample);
    // confirm も previous を残す
    const cf = await cli('boundary', 'confirm', '--slide', 's0004', '--workspace', dir);
    assert.equal(cf.env.result.previous.status, 'auto');
    // core の検査を通る（schema の追加項目は許される）
    const v = await cli('validate', path.join(dir, 'boundaries.json'));
    assert.ok([0, 1, 3].includes(v.code));
  } finally { await rm(dir); }
});

test('align (3): 終了コード 0 でも result.reviewHint が出る（確かさが 0.9 未満の件数と、boundary review の案内）', async () => {
  const { dir, r } = await aligned('hint', { seed: 12 });
  try {
    assert.equal(r.code, 0);
    assert.equal(typeof r.env.result.reviewHint, 'string');
    assert.match(r.env.result.reviewHint, /判断待ちは 0 件/);
    assert.match(r.env.result.reviewHint, /boundary review/);
    assert.match(r.env.result.reviewHint, /0\.9 未満のものが \d+ 件/);
  } finally { await rm(dir); }
  const bad = await aligned('hint2', { seed: 13, adlib: [{ afterSlide: 1, seconds: 10 }] });
  try {
    assert.equal(bad.r.code, 4);
    assert.match(bad.r.env.result.reviewHint, /判断待ちは [1-9]\d* 件/);
  } finally { await rm(bad.dir); }
});
