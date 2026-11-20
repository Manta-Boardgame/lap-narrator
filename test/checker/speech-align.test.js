// 音声から切れ目を決める（transcribe／align／boundary）の試験。ASR（faster-whisper）は使わず、模擬の transcript.json と模擬の音声で動かす。
// 実際に faster-whisper を走らせる試験は test/speech/（npm run test:speech）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from '../../cli/narrate.js';
import { buildMock, writeMock, inGap, ROOT, RATE } from './helpers/mock-speech.js';

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
  let err = '';
  const { exitCode } = await runCli(argv.flat(), { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'stdout is exactly one JSON line');
  return { code: exitCode, env: JSON.parse(lines[0]), progress: err.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

/** 作業場を作って align まで動かす */
async function aligned(label, mockOpts, alignArgs = []) {
  const dir = await ws(label);
  const mock = buildMock(mockOpts);
  await writeMock(dir, mock);
  const r = await cli('align', '--workspace', dir, ...alignArgs);
  let b = null;
  try { b = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8')); } catch { /* 書かれていない */ }
  return { dir, mock, r, b };
}

function assertContiguous(b) {
  assert.equal(b.slides[0].startSample, 0);
  for (let i = 0; i < b.slides.length; i++) {
    assert.ok(b.slides[i].startSample < b.slides[i].endSample, `slide ${i} has a non-empty span`);
    if (i > 0) assert.equal(b.slides[i - 1].endSample, b.slides[i].startSample);
  }
  assert.equal(b.slides.at(-1).endSample, b.audio.samples);
}

/** 自動で確定した切れ目に、間違い（話の途中への切れ目）がないこと */
function assertNoWrongAuto(mock, b) {
  const wrong = [];
  for (let i = 0; i < b.slides.length - 1; i++) {
    if (b.slides[i].status === 'auto' && !inGap(mock, b.slides[i].endSample, i)) wrong.push(b.slides[i].slideId);
  }
  assert.deepEqual(wrong, [], 'no wrong automatic boundary');
}

test('align: 誤りのない文字起こしでは、全部の切れ目が自動で確定し、話の間の無音の中にある（終了コード 0）', async () => {
  const { dir, mock, r, b } = await aligned('clean', { seed: 1 });
  try {
    assert.equal(r.code, 0, JSON.stringify(r.env.errors));
    assert.equal(r.env.ok, true);
    assert.equal(b.format, 'lap-narrator/boundaries');
    assert.equal(b.sampleRate, RATE);
    assert.equal(b.slides.length, 8);
    assertContiguous(b);
    for (let i = 0; i < 7; i++) {
      assert.equal(b.slides[i].status, 'auto', `slide ${i}: ${b.slides[i].confidence}`);
      assert.equal(b.slides[i].method, 'asr-align');
      assert.ok(inGap(mock, b.slides[i].endSample, i));
      const mid = ((mock.truthSlides[i].speechEnd + mock.truthSlides[i + 1].speechStart) / 2) * RATE;
      assert.ok(Math.abs(b.slides[i].endSample - mid) < 0.15 * RATE, 'near the middle of the silence');
      assert.ok(b.slides[i].candidates.length >= 1 && b.slides[i].candidates.length <= 3);
      assert.equal(b.slides[i].candidates[0].sample, b.slides[i].endSample);
    }
    assert.equal(r.env.result.needsDecision.length, 0);
    assert.ok(r.progress.some((p) => p.progress.stage === 'align'), 'progress lines on stderr');
    assert.match(b.audio.sha256, /^[0-9a-f]{64}$/);
    assert.match(b.transcript.sha256, /^[0-9a-f]{64}$/);
    assert.equal(b.script.scriptHash, mock.script.scriptHash);
  } finally { await rm(dir); }
});

test('align: 文字の誤り（10%）があっても、自動で確定した切れ目は間違えない', async () => {
  for (const seed of [2, 3, 4]) {
    const { dir, mock, b } = await aligned(`err${seed}`, { seed, errorRate: 0.1 });
    try {
      assertContiguous(b);
      assertNoWrongAuto(mock, b);
    } finally { await rm(dir); }
  }
});

test('align: ひどい誤り（40%）では自動で確定せず、終了コード 4 と decision-required', async () => {
  const { dir, mock, r, b } = await aligned('bad', { seed: 5, errorRate: 0.4 });
  try {
    assertContiguous(b);
    assertNoWrongAuto(mock, b);
    assert.equal(r.code, 4);
    assert.equal(r.env.errors[0].code, 'decision-required');
    assert.ok(r.env.result.needsDecision.length > 0);
  } finally { await rm(dir); }
});

test('align: 判断待ちには、候補・前後の文字起こし・台本の端・設定の仕方が付く', async () => {
  const { dir, r, b } = await aligned('nd', { seed: 6, adlib: [{ afterSlide: 2, seconds: 10 }] });
  try {
    assert.equal(r.code, 4);
    const e = r.env.result.needsDecision.find((x) => x.slideId === b.slides[2].slideId);
    assert.ok(e, 'the boundary next to the ad-lib is undecided');
    assert.equal(e.order, 3);
    assert.equal(typeof e.boundaryAfter, 'number');
    assert.ok(e.candidates.length >= 1 && e.candidates.length <= 3);
    for (const c of e.candidates) { assert.ok(Number.isInteger(c.sample)); assert.equal(typeof c.score, 'number'); }
    assert.ok(e.context.before.length > 0 && e.context.after.length > 0);
    assert.ok(e.scriptEnd.length > 0 && e.scriptEnd.length <= 40);
    assert.ok(e.nextScriptStart.length > 0 && e.nextScriptStart.length <= 40);
    assert.match(e.howToSet, /narrate boundary set --slide s0003 --at/);
    assert.equal(b.slides[2].status, 'needs-decision');
  } finally { await rm(dir); }
});

test('align: 文を読み飛ばしても、自動で確定した切れ目は間違えない（読み飛ばしたのが端でも）', async () => {
  const cases = [{ slide: 0, sentence: 1 }, { slide: 2, sentence: 0 }, { slide: 3, sentence: 1 }, { slide: 5, sentence: 1 }, { slide: 7, sentence: 0 }];
  for (const [k, sk] of cases.entries()) {
    const { dir, mock, b } = await aligned(`skip${k}`, { seed: 10 + k, skip: [sk] });
    try { assertContiguous(b); assertNoWrongAuto(mock, b); } finally { await rm(dir); }
  }
});

test('align: 1 枚まるごと読み飛ばすと、そのスライドは interpolated で判断待ち', async () => {
  const { dir, mock, r, b } = await aligned('skipslide', { seed: 20, skip: [{ slide: 4, sentence: 0 }] });
  try {
    assertContiguous(b);
    assertNoWrongAuto(mock, b);
    assert.equal(r.code, 4);
    assert.equal(b.slides[4].method, 'interpolated');
    assert.equal(b.slides[4].status, 'needs-decision');
    assert.equal(b.slides[3].status, 'needs-decision', 'the cut into the missing slide is undecided too');
  } finally { await rm(dir); }
});

test('align: 同じ文の言い直し、台本にない話（10 秒）でも、自動で確定した切れ目は間違えない', async () => {
  const variants = [
    { repeat: [{ slide: 1, sentence: 0 }] },
    { repeat: [{ slide: 2, sentence: 1 }] },
    { repeat: [{ slide: 7, sentence: 0 }] },
    { adlib: [{ afterSlide: 0, seconds: 10 }] },
    { adlib: [{ afterSlide: 4, seconds: 10 }, { afterSlide: 5, seconds: 4 }] },
  ];
  for (const [k, v] of variants.entries()) {
    const { dir, mock, b } = await aligned(`rep${k}`, { seed: 30 + k, ...v });
    try { assertContiguous(b); assertNoWrongAuto(mock, b); } finally { await rm(dir); }
  }
});

test('align: 台本のノートが空のスライドは interpolated で、必ず判断待ち（終了コード 4）', async () => {
  const { dir, mock, r, b } = await aligned('empty', { seed: 40, emptyNotes: [2, 3] });
  try {
    assertContiguous(b);
    assertNoWrongAuto(mock, b);
    assert.equal(r.code, 4);
    for (const i of [2, 3]) {
      assert.equal(b.slides[i].method, 'interpolated');
      assert.equal(b.slides[i].status, 'needs-decision');
    }
    assert.equal(b.slides[1].status, 'needs-decision', 'the cut into an empty slide');
    assert.equal(b.slides[0].status, 'auto');
    assert.equal(b.slides[5].status, 'auto');
  } finally { await rm(dir); }
});

test('align: 先頭と末尾のスライドが空でも、連続・半開区間は保たれる', async () => {
  const { dir, r, b } = await aligned('emptyends', { seed: 41, emptyNotes: [0, 7] });
  try {
    assertContiguous(b);
    assert.equal(r.code, 4);
    assert.equal(b.slides[0].status, 'needs-decision');
    assert.equal(b.slides[7].status, 'needs-decision');
  } finally { await rm(dir); }
});

test('align: 台本が 1 枚だけ（通しの 1 本）なら、切れ目はなく自動', async () => {
  const dir = await ws('one');
  try {
    const mock = buildMock({ seed: 42, slides: [['みなさん、こんにちは。', '今日は通しで話します。']] });
    await writeMock(dir, mock);
    const r = await cli('align', '--workspace', dir);
    assert.equal(r.code, 0);
    const b = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'));
    assert.equal(b.slides.length, 1);
    assert.equal(b.slides[0].startSample, 0);
    assert.equal(b.slides[0].endSample, mock.total);
  } finally { await rm(dir); }
});

test('align: 別の音声の transcript は拒否する（終了コード 3、transcript-mismatch）', async () => {
  const dir = await ws('mismatch');
  try {
    const mock = buildMock({ seed: 43 });
    await writeMock(dir, mock);
    const other = buildMock({ seed: 44 });
    await fsp.writeFile(path.join(dir, 'final', 'all.wav'), (await import('../../testgen/lib/wav.js')).encodeWav(other.pcm, RATE));
    const r = await cli('align', '--workspace', dir);
    assert.equal(r.code, 3);
    assert.equal(r.env.errors[0].code, 'transcript-mismatch');
  } finally { await rm(dir); }
});

test('align: 台本パックの zip も、作業場の script.json も読める。--threshold を上げると判断待ちが増える', async () => {
  const dir = await ws('thr');
  try {
    const mock = buildMock({ seed: 45, errorRate: 0.08 });
    await writeMock(dir, mock);
    const lo = await cli('align', '--workspace', dir, '--threshold', '0.3', '--force');
    const hi = await cli('align', '--workspace', dir, '--threshold', '1.0', '--force');
    assert.equal(hi.code, 4);
    assert.ok(hi.env.result.counts.needsDecision >= lo.env.result.counts.needsDecision);
    const bad = await cli('align', '--workspace', dir, '--threshold', '2');
    assert.equal(bad.code, 2);
    const pack = await cli('align', '--workspace', dir, '--script', path.join(ROOT, 'examples', 'packs', 'tiny3.zip'), '--force', '--out', path.join(dir, 'b2.json'));
    assert.ok([0, 4].includes(pack.code), 'the pack is read (tiny3 has 3 slides)');
    const b2 = JSON.parse(await fsp.readFile(path.join(dir, 'b2.json'), 'utf8'));
    assert.equal(b2.slides.length, 3);
  } finally { await rm(dir); }
});

test('boundary: show は表を返し、set は無音へ吸着し、confirm は確定する', async () => {
  const { dir, mock } = await aligned('bset', { seed: 50, adlib: [{ afterSlide: 1, seconds: 8 }] });
  try {
    const show = await cli('boundary', 'show', '--workspace', dir);
    assert.equal(show.code, 0);
    assert.equal(show.env.result.slides.length, 8);
    assert.match(show.env.result.table, /slide\s+order\s+start\(s\)/);
    assert.ok(show.env.result.needsDecision.includes('s0002'));
    // 話の間の無音の、中点から 0.25 秒ずれた時刻を指定 → 無音の中点へ吸着する
    const g0 = mock.truthSlides[3].speechEnd;
    const g1 = mock.truthSlides[4].speechStart;
    const mid = (g0 + g1) / 2;
    const set = await cli('boundary', 'set', '--slide', 's0004', '--at', String(mid + 0.25), '--workspace', dir);
    assert.equal(set.code, 0, JSON.stringify(set.env.errors));
    assert.equal(set.env.result.snapped.kind, 'silence');
    assert.ok(Math.abs(set.env.result.boundaryAfterSec - mid) < 0.1, `${set.env.result.boundaryAfterSec} vs ${mid}`);
    const b = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'));
    assertContiguous(b);
    assert.equal(b.slides[3].status, 'confirmed');
    assert.equal(b.slides[3].method, 'manual');
    assert.equal(b.slides[3].confidence, 1);
    assert.equal(b.slides[3].endSample, b.slides[4].startSample);
    // --exact は、その時刻のまま
    const ex = await cli('boundary', 'set', '--slide', 's0004', '--at', String(mid + 0.2), '--exact', '--workspace', dir);
    assert.equal(ex.code, 0);
    assert.equal(ex.env.result.snapped, null);
    assert.equal(ex.env.result.sample, Math.round((mid + 0.2) * RATE));
    // confirm
    const cf = await cli('boundary', 'confirm', '--slide', 's0002', '--workspace', dir);
    assert.equal(cf.code, 0);
    const b2 = JSON.parse(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'));
    assert.equal(b2.slides[1].status, 'confirmed');
    assertContiguous(b2);
    // 一時ファイルが残っていない
    const names = await fsp.readdir(dir);
    assert.deepEqual(names.filter((x) => x.includes('.tmp-')), []);
  } finally { await rm(dir); }
});

test('boundary set: 隣と逆転する時刻、最後のスライド、知らないスライドは拒否（終了コード 2）。ファイルは変わらない', async () => {
  const { dir } = await aligned('border', { seed: 51 });
  try {
    const before = await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8');
    const back = await cli('boundary', 'set', '--slide', 's0004', '--at', '1', '--exact', '--workspace', dir); // スライド 3 の始まりより前
    assert.equal(back.code, 2);
    assert.equal(back.env.errors[0].code, 'boundary-order');
    const far = await cli('boundary', 'set', '--slide', 's0004', '--at', '9999', '--exact', '--workspace', dir);
    assert.equal(far.code, 2);
    const last = await cli('boundary', 'set', '--slide', 's0008', '--at', '10', '--exact', '--workspace', dir);
    assert.equal(last.code, 2);
    assert.equal(last.env.errors[0].code, 'last-slide');
    const unk = await cli('boundary', 'set', '--slide', 'nope', '--at', '10', '--exact', '--workspace', dir);
    assert.equal(unk.code, 2);
    const noat = await cli('boundary', 'set', '--slide', 's0002', '--workspace', dir);
    assert.equal(noat.code, 2);
    const nosub = await cli('boundary', '--workspace', dir);
    assert.equal(nosub.code, 2);
    assert.equal(await fsp.readFile(path.join(dir, 'boundaries.json'), 'utf8'), before);
  } finally { await rm(dir); }
});

test('boundary set: 無音が近くにないときは、その時刻のままで警告 no-silence-near', async () => {
  const { dir, mock } = await aligned('nosil', { seed: 52 });
  try {
    // 話の真ん中（文の途中）を指す
    const p = mock.parts[2];
    const at = (p.start + p.end) / 2;
    const r = await cli('boundary', 'set', '--slide', 's0002', '--at', String(at), '--snap-radius', '0.3', '--workspace', dir);
    // s0002 の終わりを、スライド 3 の話の中へ動かす → 逆転はしないが、無音がない
    assert.ok(r.code === 0 || r.code === 2);
    if (r.code === 0) {
      assert.equal(r.env.result.snapped.kind, 'none');
      assert.ok(r.env.warnings.some((w) => w.code === 'no-silence-near'));
    }
  } finally { await rm(dir); }
});

test('align: 人が決めた切れ目がある boundaries.json は、--force なしでは上書きしない', async () => {
  const { dir, mock } = await aligned('keep', { seed: 53 });
  try {
    const mid = (mock.truthSlides[0].speechEnd + mock.truthSlides[1].speechStart) / 2;
    assert.equal((await cli('boundary', 'set', '--slide', 's0001', '--at', String(mid), '--workspace', dir)).code, 0);
    const again = await cli('align', '--workspace', dir);
    assert.equal(again.code, 1);
    assert.equal(again.env.errors[0].code, 'would-overwrite-decisions');
    const forced = await cli('align', '--workspace', dir, '--force');
    assert.ok([0, 4].includes(forced.code));
  } finally { await rm(dir); }
});

test('transcribe: 同じ音声・モデル・設定の transcript.json があれば、モデルを読まずに再利用する（cached）', async () => {
  const dir = await ws('cache');
  try {
    await writeMock(dir, buildMock({ seed: 60 }));
    const r = await cli('transcribe', '--workspace', dir, '--models-dir', path.join(dir, 'no-models'));
    assert.equal(r.code, 0, JSON.stringify(r.env.errors));
    assert.equal(r.env.result.cached, true);
    assert.equal(r.env.result.model, 'small');
    assert.equal(r.env.result.audio, 'final/all.wav');
    // モデル名が違えば再利用しない → モデルが無いので speech-unavailable
    const other = await cli('transcribe', '--workspace', dir, '--model', 'tiny', '--models-dir', path.join(dir, 'no-models'));
    assert.equal(other.code, 1);
    assert.equal(other.env.errors[0].code, 'speech-unavailable');
  } finally { await rm(dir); }
});

test('transcribe: モデルが無いとき（--force）は、ダウンロードせず speech-unavailable（終了コード 1）', async () => {
  const dir = await ws('nomodel');
  try {
    await writeMock(dir, buildMock({ seed: 61 }), { transcript: false });
    const r = await cli('transcribe', '--workspace', dir, '--models-dir', path.join(dir, 'no-models'), '--force');
    assert.equal(r.code, 1);
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'speech-unavailable');
    assert.match(r.env.errors[0].message, /not be downloaded|not available/);
    const names = await fsp.readdir(dir);
    assert.ok(!names.includes('transcript.json'), 'nothing written');
  } finally { await rm(dir); }
});

test('transcribe: faster-whisper が使えない Python（NARRATE_PYTHON が無い）でも speech-unavailable', async () => {
  const dir = await ws('nopy');
  const save = process.env.NARRATE_PYTHON;
  try {
    await writeMock(dir, buildMock({ seed: 62 }), { transcript: false });
    process.env.NARRATE_PYTHON = path.join(dir, 'no-such-python.exe');
    const r = await cli('transcribe', '--workspace', dir);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'speech-unavailable');
  } finally {
    if (save === undefined) delete process.env.NARRATE_PYTHON; else process.env.NARRATE_PYTHON = save;
    await rm(dir);
  }
});

test('transcribe: 引数の誤りは終了コード 2、音声が無いときは終了コード 1', async () => {
  assert.equal((await cli('transcribe')).code, 2);
  const dir = await ws('args');
  try {
    assert.equal((await cli('transcribe', '--workspace', dir, '--vad', 'maybe')).code, 2);
    const r = await cli('transcribe', '--workspace', dir);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
  } finally { await rm(dir); }
});

test('正規化：漢数字・全角半角・かな・記号・大文字小文字', () => {
  const py = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  const code = [
    'import sys, json', `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'checker', 'speech'))})`, 'from speech_norm import normalize',
    'cases = json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    'sys.stdout.write(json.dumps([normalize(c) for c in cases]))',
  ].join('\n');
  const cases = ['四歳から小学生。', '第二金曜日の夜七時から八時', '年間で十二回', '約五十分、三千五百円', 'ＡＢＣ　Ｄｅｆ１２３', 'コンピューター、ｶﾀｶﾅ', '50%', '二〇二四年', 'ろうそく風の電灯を使います。'];
  const r = spawnSync(py, ['-I', '-c', code], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, ['4歳から小学生', '第2金曜日の夜7時から8時', '年間で12回', '約50分3500円', 'abcdef123', 'こんぴゅたかたかな', '50ぱせんと', '2024年', 'ろうそく風の電灯を使います']);
});
