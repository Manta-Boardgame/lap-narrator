// 通しの経路：アプリの「通しで録った」書き出し（台本が 1 枚だけ）→ import（作業場は N 枚の台本）→ status → render --boundaries → build → verify。
// 切れ目は合成素材の正解（test/cli/helpers/continuous.js）から作る。PowerPoint は動かさない（方式 A は別に、人が手元で確かめる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { frameOf } from '../../core/timeline.js';
import { sha256Hex } from '../../core/sha256.js';
import { run, spawnCli, tmpDir, cleanup, ROOT } from './helpers/cli.js';
import {
  continuousMaterial, continuousSession, freeScript, fullExportFiles, finalExportFiles, makeBoundaries, wavSha256, pcmSha256, RATE,
} from './helpers/continuous.js';

const T = { timeout: 300000 };
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ok = (r, label = '') => { assert.equal(r.code, 0, `${label} ${r.stdout}`); assert.equal(r.env.ok, true); assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] }); return r.env.result; };
const SLIDES = ['s0001', 's0002', 's0003'];
const EXACT = ['--tail-margin-ms', '0']; // 切れ目どおり、サンプル単位で切る（既定は終わりを 100 ms 切り落とす）

function pcmOfWav(file) {
  const buf = readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.length, 44 + buf.readUInt32LE(40), 'a standard 44-byte-header WAV');
  return new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
}

/** 作業場を作る：台本パック tiny3（3 枚）と、通しの全記録（撮り直しを含む）を取り込む */
async function setup(label, { retake = true, kind = 'full', exportOpts, material = continuousMaterial({ retake }) } = {}) {
  const dir = await tmpDir(label);
  const session = continuousSession({ retake, material });
  const ex = kind === 'full' ? await fullExportFiles(path.join(dir, 'ex'), session, exportOpts) : await finalExportFiles(path.join(dir, 'ex'), session, exportOpts);
  const ws = path.join(dir, 'ws');
  const imp = await run('import', ...ex.zips, '--script', PACK, '--workspace', ws);
  return { dir, ws, material, session, ex, imp, script: rj(path.join(ws, 'script.json')) };
}
async function writeBoundaries(c, b = makeBoundaries({ script: c.script, material: c.material }), name = 'boundaries.json') {
  const p = path.join(c.dir, name);
  await fsp.writeFile(p, JSON.stringify(b, null, 2));
  return p;
}

test('取り込み：台本が 1 枚（free）の通しの書き出しを、台本が 3 枚の作業場へ取り込める。拒否せず、台本の食い違いの警告も出さず、continuous-recording を知らせる', T, async () => {
  const c = await setup('cont-import');
  try {
    const r = ok(c.imp, 'import');
    assert.equal(r.committed.length, 1);
    assert.deepEqual(r.continuous, [{ sessionId: 'cont-sess-001', slideId: 'free' }]);
    const codes = c.imp.env.warnings.map((w) => w.code);
    assert.ok(codes.includes('continuous-recording'), codes.join());
    assert.ok(!codes.includes('stale-slides'), '通しの書き出しの台本が違うのは当然');
    assert.ok(!codes.includes('project-mismatch'));
    // 再送しても同じ（取り込みは何も変えない）
    const again = ok(await run('import', ...c.ex.zips, '--workspace', c.ws), 'again');
    assert.equal(again.duplicates.length, 1);
    assert.ok(existsSync(path.join(c.ws, 'sessions', 'cont-sess-001', 'raw', 'rec-000001.wav')));
    // 通しの完成音声が final/all.wav に書かれる（transcribe が読む）。撮り直しで捨てた区間は入らない。SHA-256 は boundaries.audio.sha256 になるもの
    assert.equal(r.continuousAudio.file, 'final/all.wav');
    assert.equal(r.continuousAudio.samples, c.material.all.length);
    assert.equal(r.continuousAudio.sha256, wavSha256(c.material.all));
    assert.equal(sha256Hex(new Uint8Array(readFileSync(path.join(c.ws, 'final', 'all.wav')))), wavSha256(c.material.all));
  } finally { await cleanup(c.dir); }
});

test('status：切れ目がまだなら waiting-for-boundaries（通しの音声は取り込み済み）。スライドは未収録のまま。警告 boundaries-missing', T, async () => {
  const c = await setup('cont-status0');
  try {
    const r = await run('status', '--workspace', c.ws);
    const res = ok(r, 'status');
    assert.equal(res.continuous.present, true);
    assert.equal(res.continuous.sessions[0].slideId, 'free');
    assert.equal(res.continuous.sessions[0].samples, c.material.all.length, '撮り直しで捨てた区間は入らない');
    assert.equal(res.continuous.sessions[0].source, 'full');
    assert.equal(res.boundaries.present, false);
    assert.equal(res.boundaries.state, 'waiting-for-boundaries');
    assert.deepEqual(res.boundaries.slides, []);
    assert.deepEqual(res.counts, { missing: 3, single: 0, multiple: 0, stale: 0 });
    assert.ok(r.env.warnings.some((w) => w.code === 'boundaries-missing'));
  } finally { await cleanup(c.dir); }
});

test('status：切れ目があれば、スライドごとの status／confidence と判断待ちを出す。判断待ちは警告。合わない切れ目は invalid', T, async () => {
  const c = await setup('cont-status1');
  try {
    const b = makeBoundaries({ script: c.script, material: c.material, overrides: { s0002: { status: 'needs-decision', confidence: 0.4 } } });
    await writeBoundaries(c, b, 'boundaries.json');
    await fsp.copyFile(path.join(c.dir, 'boundaries.json'), path.join(c.ws, 'boundaries.json'));
    const r = await run('status', '--workspace', c.ws);
    const res = ok(r, 'status');
    assert.equal(res.boundaries.present, true);
    assert.equal(res.boundaries.state, 'needs-decision');
    assert.equal(res.boundaries.valid, true);
    assert.deepEqual(res.boundaries.needsDecision, ['s0002']);
    assert.deepEqual(res.boundaries.slides.map((s) => [s.slideId, s.status, s.confidence]), [['s0001', 'auto', 0.97], ['s0002', 'needs-decision', 0.4], ['s0003', 'auto', 0.97]]);
    assert.deepEqual(res.slides.map((s) => s.boundary.status), ['auto', 'needs-decision', 'auto']);
    assert.ok(r.env.warnings.some((w) => w.code === 'boundaries-need-decision'));
    // 全部確定ならきれいに ready
    const b2 = makeBoundaries({ script: c.script, material: c.material });
    await fsp.writeFile(path.join(c.ws, 'boundaries.json'), JSON.stringify(b2));
    const res2 = ok(await run('status', '--workspace', c.ws), 'ready');
    assert.equal(res2.boundaries.state, 'ready');
    assert.deepEqual(res2.boundaries.needsDecision, []);
    // 別の台本の切れ目
    await fsp.writeFile(path.join(c.ws, 'boundaries.json'), JSON.stringify(makeBoundaries({ script: c.script, material: c.material, scriptHash: 'f'.repeat(64) })));
    const r3 = await run('status', '--workspace', c.ws);
    assert.equal(r3.code, 0, '状態の表示は失敗にしない');
    assert.equal(r3.env.result.boundaries.state, 'invalid');
    assert.equal(r3.env.result.boundaries.problems[0].code, 'script-mismatch');
    assert.ok(r3.env.warnings.some((w) => w.code === 'boundaries-invalid'));
  } finally { await cleanup(c.dir); }
});

test('render --boundaries：通しの音声を切れ目で切る。各スライドの音声はサンプル単位で正解の区間に一致し、つなぐと通しの音声に戻る。撮り直しで捨てた区間は入らない', T, async () => {
  const c = await setup('cont-render');
  try {
    const bp = await writeBoundaries(c);
    const r = await run('render', '--workspace', c.ws, '--boundaries', bp, ...EXACT);
    const res = ok(r, 'render');
    assert.equal(res.mode, 'continuous');
    assert.equal(res.continuous.sha256, wavSha256(c.material.all));
    assert.equal(res.continuous.samples, c.material.all.length);
    const out = path.join(c.ws, 'out');
    const pieces = [];
    SLIDES.forEach((id, i) => {
      const f = path.join(out, 'final', `${id}.wav`);
      const pcm = pcmOfWav(f);
      const want = c.material.all.slice(c.material.bounds[i], c.material.bounds[i + 1]);
      assert.equal(pcm.length, want.length, id);
      assert.equal(pcmSha256(pcm), pcmSha256(want), `${id}: PCM が正解の区間と一致`);
      assert.equal(res.finals[i].startSample, c.material.bounds[i]);
      assert.equal(res.finals[i].endSample, c.material.bounds[i + 1]);
      assert.equal(res.finals[i].parts[0].sha256, sha256Hex(new Uint8Array(readFileSync(f))), `${id}: parts[].sha256 はファイルの SHA-256`);
      pieces.push(pcm);
    });
    // つなぐと通しの音声に戻る
    const joined = new Int16Array(pieces.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of pieces) { joined.set(p, o); o += p.length; }
    assert.equal(pcmSha256(joined), pcmSha256(c.material.all));
    // 捨てた区間（大きな振幅 20000 の音）が入っていない：どの区間にも振幅 13000 を超えるサンプルはない（声は 12000 まで）
    for (const p of pieces) for (let i = 0; i < p.length; i++) if (Math.abs(p[i]) > 13000) assert.fail('the discarded take leaked into the output');
    // 予定表：切り替えの時刻は切れ目そのもの
    const tl = rj(path.join(out, 'timeline.json'));
    assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
    assert.equal(tl.prePadSamples, 0);
    assert.equal(tl.postPadSamples, 0);
    assert.equal(tl.totalSamples, c.material.all.length);
    tl.slides.forEach((s, i) => {
      assert.equal(s.slideId, SLIDES[i]);
      assert.equal(s.showStart, c.material.bounds[i]);
      assert.equal(s.audioStart, c.material.bounds[i]);
      assert.equal(s.audioEnd, c.material.bounds[i + 1]);
      assert.equal(s.showEnd, c.material.bounds[i + 1]);
      assert.equal(s.audio, `final/${SLIDES[i]}.wav`);
      assert.ok(existsSync(path.join(out, s.image)), s.image);
    });
    // 方式 B のフレームへの丸め
    assert.equal(frameOf(tl.slides[1].showStart, tl.fps, tl.sampleRate), Math.floor((c.material.bounds[1] * 30 + 24000) / 48000));
    // 作業場に boundaries.json が無くても --boundaries で動き、作業場には何も足さない
    assert.equal(existsSync(path.join(c.ws, 'boundaries.json')), false);
  } finally { await cleanup(c.dir); }
});

test('render：作業場に boundaries.json があれば自動でこの経路になる。--no-boundaries なら従来の経路（通しのスライドは台本にないので、描画するスライドがない）', T, async () => {
  const c = await setup('cont-auto');
  try {
    await fsp.copyFile(await writeBoundaries(c), path.join(c.ws, 'boundaries.json'));
    const res = ok(await run('render', '--workspace', c.ws, ...EXACT), 'auto');
    assert.equal(res.mode, 'continuous');
    assert.equal(res.finals.length, 3);
    const old = await run('render', '--workspace', c.ws, '--no-boundaries', '--out', path.join(c.dir, 'out-old'));
    assert.equal(old.code, 1);
    assert.equal(old.env.errors[0].code, 'missing-slides');
    const both = await run('render', '--workspace', c.ws, '--no-boundaries', '--boundaries', path.join(c.ws, 'boundaries.json'));
    assert.equal(both.code, 2);
  } finally { await cleanup(c.dir); }
});

test('render：切れ目に needs-decision があれば、何も書かずに終了コード 4。decision-required、result.needsDecision に どのスライドか と 使い方', T, async () => {
  const c = await setup('cont-decision');
  try {
    const b = makeBoundaries({ script: c.script, material: c.material, overrides: { s0001: { status: 'needs-decision', confidence: 0.3, method: 'interpolated' }, s0002: { status: 'needs-decision', confidence: 0.45 } } });
    const bp = await writeBoundaries(c, b);
    const r = await run('render', '--workspace', c.ws, '--boundaries', bp, ...EXACT);
    assert.equal(r.code, 4, r.stdout);
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'decision-required');
    assert.deepEqual(r.env.errors[0].detail.slides, ['s0001', 's0002']);
    const nd = r.env.result.needsDecision;
    assert.deepEqual(nd.map((x) => x.slideId), ['s0001', 's0002']);
    assert.equal(nd[1].startSample, c.material.bounds[1]);
    assert.equal(nd[1].confidence, 0.45);
    assert.equal(nd[0].method, 'interpolated');
    assert.match(nd[0].howToDecide, /narrate boundary set --slide s0001 --at <sec>/);
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
    assert.equal(existsSync(path.join(c.ws, 'out')), false, '何も書かない');
    // --allow-unconfirmed のときだけ、候補のまま進む
    const r2 = await run('render', '--workspace', c.ws, '--boundaries', bp, '--allow-unconfirmed', ...EXACT);
    ok(r2, 'allow');
    const w = r2.env.warnings.find((x) => x.code === 'unconfirmed-boundaries');
    assert.ok(w);
    assert.deepEqual(w.detail.slides, ['s0001', 's0002']);
    assert.deepEqual(r2.env.result.finals.map((f) => f.boundary.status), ['needs-decision', 'needs-decision', 'auto']);
    assert.ok(existsSync(path.join(c.ws, 'out', 'timeline.json')));
  } finally { await cleanup(c.dir); }
});

test('render：検証の不一致は終了コード 3 で、何も書かない（音声の SHA-256 が違う、長さが違う、台本が違う、区間が連続していない、スライドの一覧が違う）。構造が壊れていても 3、読めない JSON は 1', T, async () => {
  const c = await setup('cont-mismatch');
  try {
    const good = makeBoundaries({ script: c.script, material: c.material });
    const cases = [
      ['audio-mismatch', 'sha256', (b) => { b.audio.sha256 = '0'.repeat(64); }],
      ['audio-mismatch', 'sha256 of a different audio (same length)', (b) => { b.audio.sha256 = wavSha256(c.material.raw.slice(0, c.material.all.length)); }],
      ['audio-mismatch', 'length', (b) => { b.audio.samples += 1; b.slides[2].endSample += 1; }],
      ['audio-mismatch', 'sample rate', (b) => { b.sampleRate = 44100; }],
      ['script-mismatch', 'scriptHash', (b) => { b.script.scriptHash = '1'.repeat(64); }],
      ['not-contiguous', 'gap', (b) => { b.slides[1].startSample += 10; }],
      ['not-contiguous', 'overlap', (b) => { b.slides[1].startSample -= 10; }],
      ['not-contiguous', 'first is not 0', (b) => { b.slides[0].startSample = 3; }],
      ['not-contiguous', 'ends early', (b) => { b.slides[2].endSample -= 1; }],
      ['slides-mismatch', 'missing slide', (b) => { b.slides.pop(); b.audio.samples = b.slides[1].endSample; b.slides[1].endSample = b.audio.samples; }],
      ['bad-boundaries', 'wrong format', (b) => { b.format = 'x'; }],
      ['bad-boundaries', 'status', (b) => { b.slides[0].status = 'maybe'; }],
    ];
    for (const [code, name, mut] of cases) {
      const b = JSON.parse(JSON.stringify(good));
      mut(b);
      const bp = await writeBoundaries(c, b, 'bad.json');
      const r = await run('render', '--workspace', c.ws, '--boundaries', bp, ...EXACT);
      assert.equal(r.code, 3, `${name}: ${r.stdout.slice(0, 400)}`);
      assert.equal(r.env.errors[0].code, code, name);
      assert.equal(existsSync(path.join(c.ws, 'out')), false, `${name}: 何も書かない`);
    }
    await fsp.writeFile(path.join(c.dir, 'broken.json'), '{ not json');
    const r = await run('render', '--workspace', c.ws, '--boundaries', path.join(c.dir, 'broken.json'), ...EXACT);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'bad-boundaries');
    const nofile = await run('render', '--workspace', c.ws, '--boundaries', path.join(c.dir, 'nothing.json'), ...EXACT);
    assert.equal(nofile.code, 1);
    assert.equal(nofile.env.errors[0].code, 'cannot-read');
  } finally { await cleanup(c.dir); }
});

test('render：作業場に通しの音声がなければ終了コード 1（no-continuous-audio）。別の台本の切れ目は 3', T, async () => {
  const dir = await tmpDir('cont-none');
  try {
    const ws = path.join(dir, 'ws');
    ok(await run('import', '--script', PACK, '--workspace', ws), 'script only');
    const script = rj(path.join(ws, 'script.json'));
    const material = continuousMaterial();
    const bp = path.join(dir, 'b.json');
    await fsp.writeFile(bp, JSON.stringify(makeBoundaries({ script, material })));
    const r = await run('render', '--workspace', ws, '--boundaries', bp, ...EXACT);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'no-continuous-audio');
  } finally { await cleanup(dir); }
});

test('通しの完成版の書き出し（kind: final）からも同じ：音声はそのまま使い、切れ目で切る。全記録と完成版の両方があっても、同じ音声は 1 つとして扱う', T, async () => {
  const c = await setup('cont-final', { kind: 'final' });
  try {
    ok(c.imp, 'import final');
    const st = ok(await run('status', '--workspace', c.ws), 'status');
    assert.equal(st.continuous.sessions[0].source, 'final');
    const bp = await writeBoundaries(c);
    const res = ok(await run('render', '--workspace', c.ws, '--boundaries', bp, ...EXACT), 'render');
    assert.equal(res.continuous.source, 'final');
    SLIDES.forEach((id, i) => {
      assert.equal(pcmSha256(pcmOfWav(path.join(c.ws, 'out', 'final', `${id}.wav`))), pcmSha256(c.material.all.slice(c.material.bounds[i], c.material.bounds[i + 1])));
    });
    // 全記録も足す（同じセッション）。完成版と編集の版が同じなら、完成版は照合用で、候補は全記録の 1 つ
    const full = await fullExportFiles(path.join(c.dir, 'ex-full'), c.session);
    ok(await run('import', ...full.zips, '--workspace', c.ws), 'import full too');
    const res2 = ok(await run('render', '--workspace', c.ws, '--boundaries', bp, '--out', path.join(c.dir, 'out2'), ...EXACT), 'render again');
    assert.equal(res2.continuous.sha256, res.continuous.sha256);
  } finally { await cleanup(c.dir); }
});

test('通しの完成版の音声が 2 つのパートに分かれていても切れる（.p001／.p002 をつなぐ）。切り出しの音声もパートに分けられる', T, async () => {
  const c = await setup('cont-parts', { kind: 'final', exportOpts: { partMaxBytes: 44 + 2 * 100000 } });
  try {
    const fin = rj(path.join(c.ws, 'sessions', 'cont-sess-001', 'session.json')).finals[0].slides[0];
    assert.ok(fin.parts.length >= 2, `parts=${fin.parts.length}`);
    const bp = await writeBoundaries(c);
    const res = ok(await run('render', '--workspace', c.ws, '--boundaries', bp, '--final-max-bytes', String(44 + 2 * 25000), ...EXACT), 'render');
    const tl = rj(path.join(c.ws, 'out', 'timeline.json'));
    assert.ok(Array.isArray(tl.slides[0].audio) && tl.slides[0].audio.length >= 2, '1 枚目の音声は複数のパート');
    assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
    // パートをつなぐとスライドの区間
    const joined = [];
    for (const f of tl.slides[1].audio) joined.push(...pcmOfWav(path.join(c.ws, 'out', f)));
    assert.equal(pcmSha256(Int16Array.from(joined)), pcmSha256(c.material.all.slice(c.material.bounds[1], c.material.bounds[2])));
    assert.equal(res.finals[1].parts.length, tl.slides[1].audio.length);
  } finally { await cleanup(c.dir); }
});

test('撮り直しのない通し（retake なし）と、2 回目の render：古い出力を片付け、同じ結果になる', T, async () => {
  const c = await setup('cont-plain', { retake: false });
  try {
    const bp = await writeBoundaries(c);
    const a = ok(await run('render', '--workspace', c.ws, '--boundaries', bp, ...EXACT), 'first');
    const hashes = a.finals.map((f) => f.parts[0].sha256);
    await fsp.writeFile(path.join(c.ws, 'out', 'final', 'old-slide.wav'), 'x');
    const b = ok(await run('render', '--workspace', c.ws, '--boundaries', bp, ...EXACT), 'second');
    assert.deepEqual(b.finals.map((f) => f.parts[0].sha256), hashes);
    assert.equal(existsSync(path.join(c.ws, 'out', 'final', 'old-slide.wav')), false);
    assert.deepEqual(readdirSync(path.join(c.ws, 'out', 'final')).sort(), SLIDES.map((s) => `${s}.wav`));
  } finally { await cleanup(c.dir); }
});

test('通しの経路を最後まで：import → render --boundaries → build --method B → verify。予定表が既存の build／verify にそのまま通り、絵の切り替えが切れ目のフレームに、音声の始まりが切れ目のサンプルに合う', T, async () => {
  const c = await setup('cont-e2e');
  try {
    const bp = await writeBoundaries(c);
    const rr = ok(await run('render', '--workspace', c.ws, '--boundaries', bp), 'render');
    assert.equal(rr.tailMarginMs, 100, '既定は音声の終わりを 100 ms 切り落とす');
    const built = await spawnCli(['build', '--method', 'B', '--workspace', c.ws]);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const bj = JSON.parse(built.stdout.trim().split('\n').pop());
    assert.equal(bj.ok, true);
    assert.equal(bj.result.slides, 3);
    assert.ok(existsSync(path.join(c.ws, 'out', 'video.mp4')));
    const v = await spawnCli(['verify', '--workspace', c.ws]);
    const vj = JSON.parse(v.stdout.trim().split('\n').pop());
    assert.equal(v.code, 0, v.stdout);
    assert.equal(vj.ok, true, v.stdout);
    assert.equal(vj.result.pass, true);
    assert.equal(vj.result.slides.length, 3);
    for (const s of vj.result.slides) assert.equal(s.status, 'ok', JSON.stringify(s));
    // 絵は 1 フレーム、音声は 20 ms の許容値（方式 B）
    assert.ok(vj.result.maxAbsDiffMs.audio <= 20, `audio ${vj.result.maxAbsDiffMs.audio}`);
    assert.ok(vj.result.maxAbsDiffMs.show <= 34, `show ${vj.result.maxAbsDiffMs.show}`);
    // 動画の長さは通しの音声の長さ
    assert.ok(Math.abs(vj.result.totalMs - (c.material.all.length * 1000) / RATE) <= 40, `total ${vj.result.totalMs}`);
  } finally { await cleanup(c.dir); }
});

test('既定の余裕（--tail-margin-ms 100）：各スライドの音声の終わりを 100 ms 切り落とし（切れ目の無音の終わり）、postPadSamples にする。切り替えの時刻は切れ目のまま。方式 A がスライドを延ばさないための余裕', T, async () => {
  const c = await setup('cont-margin');
  try {
    const bp = await writeBoundaries(c);
    const r = await run('render', '--workspace', c.ws, '--boundaries', bp);
    const res = ok(r, 'render');
    assert.equal(res.tailMarginMs, 100);
    assert.equal(res.tailMarginSamples, 4800);
    assert.equal(r.env.warnings.length, 0);
    const tl = rj(path.join(c.ws, 'out', 'timeline.json'));
    assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
    assert.equal(tl.prePadSamples, 0);
    assert.equal(tl.postPadSamples, 4800);
    assert.equal(tl.totalSamples, c.material.all.length);
    tl.slides.forEach((s, i) => {
      const a = c.material.bounds[i];
      const e = c.material.bounds[i + 1];
      assert.equal(s.showStart, a, '切り替えは切れ目そのもの');
      assert.equal(s.audioStart, a);
      assert.equal(s.audioEnd, e - 4800);
      assert.equal(s.showEnd, e);
      assert.equal(s.audioSamples, e - a - 4800);
      assert.equal(s.audioStart + s.audioSamples + tl.postPadSamples, s.showEnd, '既存の予定表の規則');
      const pcm = pcmOfWav(path.join(c.ws, 'out', s.audio));
      assert.equal(pcmSha256(pcm), pcmSha256(c.material.all.slice(a, e - 4800)), '先頭からの部分はサンプル単位で一致');
      // 切り落とした部分は無音
      for (const v of c.material.all.slice(e - 4800, e)) assert.ok(Math.abs(v) <= 32);
    });
  } finally { await cleanup(c.dir); }
});

test('既定の余裕は小さい声の語尾を残す', T, async () => {
  const material = continuousMaterial({ retake: false });
  const end = material.bounds[1];
  // 無音の末尾に、もとの閾値 1500 より十分小さい声を入れる。
  const quiet = material.voices[0].subarray(1000, 5800).map((sample) => Math.round(sample / 40));
  assert.ok(quiet.some((sample) => Math.abs(sample) > 32));
  assert.ok(quiet.every((sample) => Math.abs(sample) < 1500));
  material.raw.set(quiet, end - quiet.length);
  material.all.set(quiet, end - quiet.length);
  const c = await setup('cont-margin-quiet-voice', { retake: false, material });
  try {
    const r = await run('render', '--workspace', c.ws, '--boundaries', await writeBoundaries(c));
    assert.equal(ok(r, 'render').tailMarginSamples, 0);
    assert.ok(r.env.warnings.some((warning) => warning.code === 'tail-margin-skipped' && warning.detail.slides.includes('s0001')));
    const pcm = pcmOfWav(path.join(c.ws, 'out', 'final', 's0001.wav'));
    assert.equal(pcmSha256(pcm), pcmSha256(material.all.slice(0, end)));
  } finally { await cleanup(c.dir); }
});

test('既定の余裕は照合済みの無発話と安定した環境音がそろう場合に取れる', T, async () => {
  const material = continuousMaterial({ retake: false });
  // 先頭スライドの無発話を延ばしてから、一定音量の低い雑音を入れる。
  const end = material.bounds[1] + 4800;
  material.bounds[1] = end;
  let seed = 98765;
  const noise = Int16Array.from({ length: 9600 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 24) * 2 - 255;
  });
  material.raw.set(noise, end - noise.length);
  material.all.set(noise, end - noise.length);
  const c = await setup('cont-margin-background', { retake: false, material });
  try {
    const b = makeBoundaries({ script: c.script, material });
    const transcript = { format: 'lap-narrator/transcript', version: 1, audio: b.audio, model: 'small', segments: [],
      words: [{ w: '語句', start: 0.4, end: 0.9 }] };
    const writeTranscript = async () => {
      const data = Buffer.from(JSON.stringify(transcript));
      await fsp.writeFile(path.join(c.ws, 'transcript.json'), data);
      b.transcript.sha256 = sha256Hex(data);
    };
    await writeTranscript();
    const bp = await writeBoundaries(c, b);
    const render = async () => (await run('render', '--workspace', c.ws, '--boundaries', bp));
    assert.equal(ok(await render()).tailMarginSamples, 4800);

    // 文字起こしの内容が変わると、切れ目にひもづいた SHA が一致するまで環境音扱いしない。
    await fsp.appendFile(path.join(c.ws, 'transcript.json'), '\n');
    assert.equal(ok(await render()).tailMarginSamples, 0);
    transcript.words.push({ w: '語尾', start: end / RATE - 0.08, end: end / RATE - 0.02 });
    await writeTranscript();
    await writeBoundaries(c, b);
    const r = await render();
    assert.equal(ok(r).tailMarginSamples, 0);
    assert.ok(r.env.warnings.some((warning) => warning.code === 'tail-margin-skipped'));
    const pcm = pcmOfWav(path.join(c.ws, 'out', 'final', 's0001.wav'));
    assert.equal(pcmSha256(pcm), pcmSha256(material.all.slice(0, end)));
  } finally { await cleanup(c.dir); }
});

test('既定の余裕：切り落とす部分に音があれば（切れ目が声に近い）、切り落とさずに作り直し、警告 tail-margin-skipped。余裕より短いスライドも同じ', T, async () => {
  const c = await setup('cont-margin2');
  try {
    const b = makeBoundaries({ script: c.script, material: c.material });
    const e1 = c.material.bounds[1];
    // 切れ目 1 を、声（スライド 1）の途中に動かす
    b.slides[0].endSample = e1 - 9000;
    b.slides[1].startSample = e1 - 9000;
    const bp = await writeBoundaries(c, b);
    const r = await run('render', '--workspace', c.ws, '--boundaries', bp);
    const res = ok(r, 'render');
    assert.equal(res.tailMarginSamples, 0);
    const w = r.env.warnings.find((x) => x.code === 'tail-margin-skipped');
    assert.ok(w && w.detail.slides.includes('s0001'), JSON.stringify(r.env.warnings));
    const tl = rj(path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(tl.postPadSamples, 0);
    assert.equal(tl.slides[0].audioEnd, e1 - 9000);
    assert.equal(pcmSha256(pcmOfWav(path.join(c.ws, 'out', 'final', 's0001.wav'))), pcmSha256(c.material.all.slice(0, e1 - 9000)), '切り落としていない');
    // 余裕（100 ms）より短いスライド：最後のスライドを 3000 サンプル（62.5 ms）にする
    const b2 = makeBoundaries({ script: c.script, material: c.material });
    const total = c.material.all.length;
    b2.slides[1].endSample = total - 3000;
    b2.slides[2].startSample = total - 3000;
    const r2 = await run('render', '--workspace', c.ws, '--boundaries', await writeBoundaries(c, b2, 'short.json'), '--out', path.join(c.dir, 'out2'));
    ok(r2, 'short slide');
    assert.ok(r2.env.warnings.some((x) => x.code === 'tail-margin-skipped' && /shorter than the tail margin/.test(x.message)), JSON.stringify(r2.env.warnings));
    assert.equal(r2.env.result.tailMarginSamples, 0);
    // 引数の誤り
    assert.equal((await run('render', '--workspace', c.ws, '--boundaries', bp, '--tail-margin-ms', '-5')).code, 2);
    assert.equal((await run('render', '--workspace', c.ws, '--boundaries', bp, '--tail-margin-ms', 'abc')).code, 2);
  } finally { await cleanup(c.dir); }
});

test('manifest.recording：continuous なら通し（session.json に記録）。per-slide なら、台本が 1 枚でも通しとみなさない。無ければ台本が 1 枚の書き出しを通しとみなす（後方互換）', T, async () => {
  const { isContinuousScript, recordingOf } = await import('../../cli/lib/continuous.js');
  // 印つきの通し
  const c = await setup('cont-rec1', { exportOpts: { manifestExtra: { recording: 'continuous' } } });
  try {
    ok(c.imp, 'import');
    const sj = rj(path.join(c.ws, 'sessions', 'cont-sess-001', 'session.json'));
    assert.equal(sj.exports[0].recording, 'continuous');
    assert.equal(recordingOf(sj), 'continuous');
    const st = ok(await run('status', '--workspace', c.ws), 'status');
    assert.equal(st.continuous.present, true);
  } finally { await cleanup(c.dir); }
  // 印が per-slide：台本が 1 枚でも、通しではない（従来どおり、台本の食い違いの警告）
  const d = await setup('cont-rec2', { exportOpts: { manifestExtra: { recording: 'per-slide' } } });
  try {
    ok(d.imp, 'import');
    assert.equal(d.imp.env.result.continuous, undefined);
    assert.ok(d.imp.env.warnings.some((w) => w.code === 'stale-slides'));
    const st = ok(await run('status', '--workspace', d.ws), 'status');
    assert.equal(st.continuous.present, false);
    assert.equal(st.boundaries.state, 'none');
    assert.equal(existsSync(path.join(d.ws, 'final', 'all.wav')), false);
  } finally { await cleanup(d.dir); }
  // 規則そのもの
  const one = freeScript();
  const wsFree = { slides: [{ slideId: 'free', recordable: true }] }; // 作業場の台本も free 1 枚
  assert.equal(isContinuousScript(one, wsFree), false, '印なし：作業場と同じ 1 枚なら通常の録音');
  assert.equal(isContinuousScript(one, wsFree, 'continuous'), true, '印があれば従う');
  assert.equal(isContinuousScript(one, { slides: [{ slideId: 'a', recordable: true }, { slideId: 'b', recordable: true }] }), true);
  assert.equal(isContinuousScript(one, { slides: [{ slideId: 'a', recordable: true }, { slideId: 'b', recordable: true }] }, 'per-slide'), false);
  assert.equal(isContinuousScript({ slides: [{ slideId: 'a', recordable: true }, { slideId: 'b', recordable: true }] }, null, 'continuous'), false, '台本の録音の対象が 1 枚でなければ、印があっても通しにできない');
});

test('validate：boundaries.json と transcript.json を、format で選んだ schema で検査する（--schema boundaries も）。区間が連続していなければ終了コード 3', T, async () => {
  const c = await setup('cont-validate');
  try {
    const good = makeBoundaries({ script: c.script, material: c.material });
    const p = path.join(c.dir, 'boundaries.json');
    await fsp.writeFile(p, JSON.stringify(good));
    const r = await run('validate', p);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.env.result.checked[0].schema, 'boundaries');
    assert.equal((await run('validate', path.join(c.dir, 'boundaries.json'), '--schema', 'boundaries')).code, 0);
    // 名前が違っても format で選ぶ
    const q = path.join(c.dir, 'cuts.json');
    await fsp.writeFile(q, JSON.stringify(good));
    assert.equal((await run('validate', q)).env.result.checked[0].schema, 'boundaries');
    // 形の誤り
    const bad = JSON.parse(JSON.stringify(good));
    bad.slides[0].status = 'maybe';
    await fsp.writeFile(q, JSON.stringify(bad));
    const r2 = await run('validate', q);
    assert.equal(r2.code, 3);
    assert.match(r2.env.errors[0].message, /status/);
    // 連続していない
    const gap = JSON.parse(JSON.stringify(good));
    gap.slides[1].startSample += 10;
    await fsp.writeFile(q, JSON.stringify(gap));
    const r3 = await run('validate', q);
    assert.equal(r3.code, 3);
    assert.equal(r3.env.errors[0].code, 'not-contiguous');
    // transcript
    const t = { format: 'lap-narrator/transcript', version: 1, audio: { sha256: 'a'.repeat(64), samples: 10 }, model: 'small', words: [{ w: 'あ', start: 0, end: 0.1, p: 0.9 }], segments: [{ start: 0, end: 0.1, text: 'あ' }] };
    const tp = path.join(c.dir, 'transcript.json');
    await fsp.writeFile(tp, JSON.stringify(t));
    const r4 = await run('validate', tp);
    assert.equal(r4.code, 0, r4.stdout);
    assert.equal(r4.env.result.checked[0].schema, 'transcript');
    t.words[0].start = -1;
    await fsp.writeFile(tp, JSON.stringify(t));
    assert.equal((await run('validate', tp)).code, 3);
  } finally { await cleanup(c.dir); }
});
