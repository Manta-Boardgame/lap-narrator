// render --lead-in-sec：通しの経路（import → render → build --method B → verify）で、各スライドの話し始めが切り替えから lead-in の長さにそろう。
// 素材は雑音の床の上の「話し」（正解の話し始めを知っている）。PowerPoint は動かさない（方式 B だけ）。計算そのものの試験は test/cli/lead-in.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { sha256Hex } from '../../core/sha256.js';
import { run, spawnCli, tmpDir, cleanup, ROOT } from './helpers/cli.js';
import { continuousSession, fullExportFiles, makeBoundaries, RATE } from './helpers/continuous.js';

const T = { timeout: 300000 };
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ok = (r, label = '') => { assert.equal(r.code, 0, `${label} ${r.stdout.slice(0, 600)}`); assert.equal(r.env.ok, true); assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] }); return r.env.result; };
const EXACT = ['--tail-margin-ms', '0'];
const SLIDES = ['s0001', 's0002', 's0003'];
const sec = (s) => Math.round(s * RATE);
const SIGMA = 20;

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1; }; }
function floorNoise(n, seed) { const r = lcg(seed); const o = new Int16Array(n); for (let i = 0; i < n; i++) o[i] = Math.round((r() + r() + r()) * SIGMA); return o; }
function speech(n, seed) {
  const r = lcg(seed); const o = new Int16Array(n); const ramp = sec(0.005); let lp = 0;
  for (let i = 0; i < n; i++) { lp += 0.35 * (r() - lp); o[i] = Math.round(lp * 2.2 * 8000 * (0.4 + 0.6 * Math.abs(Math.sin((Math.PI * 4 * i) / RATE + seed))) * Math.min(1, i / ramp, (n - 1 - i) / ramp)); }
  return o;
}
const cat = (parts) => { const o = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const mix = (a, b) => { const o = Int16Array.from(a); for (let i = 0; i < b.length; i++) o[i] += b[i]; return o; };

/** スライドごとに [雑音 pre][話し][雑音 post]。pre が lead-in（2 s）より短いものと長いものを混ぜる */
function material() {
  const specs = [{ pre: 0.7, talk: 1.1, post: 0.5 }, { pre: 3.2, talk: 0.9, post: 0.4 }, { pre: 0.15, talk: 1.3, post: 0.4 }];
  const segs = specs.map((sp, i) => ({ pre: sp.pre, seg: cat([floorNoise(sec(sp.pre), 10 + i), mix(floorNoise(sec(sp.talk), 20 + i), speech(sec(sp.talk), 30 + i)), floorNoise(sec(sp.post), 40 + i)]) }));
  const all = cat(segs.map((s) => s.seg));
  const bounds = [0];
  for (const s of segs) bounds.push(bounds[bounds.length - 1] + s.seg.length);
  return { raw: all, all, a: bounds[1], b: bounds[1], bounds, trueOnsets: segs.map((s) => sec(s.pre)) };
}

async function setup(label) {
  const dir = await tmpDir(label);
  const m = material();
  const session = continuousSession({ retake: false, material: m });
  const ex = await fullExportFiles(path.join(dir, 'ex'), session);
  const ws = path.join(dir, 'ws');
  ok(await run('import', ...ex.zips, '--script', PACK, '--workspace', ws), 'import');
  const script = rj(path.join(ws, 'script.json'));
  await fsp.writeFile(path.join(ws, 'boundaries.json'), JSON.stringify(makeBoundaries({ script, material: m })));
  return { dir, ws, m };
}
function pcmOfWav(file) {
  const buf = readFileSync(file);
  assert.equal(buf.length, 44 + buf.readUInt32LE(40));
  return new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
}
/** 独立の測り方：5 ms 窓の RMS が、先頭 0.3 s の雑音（RMS）の 8 倍を超えた最初の位置（秒）。連続 3 窓 */
function speechStartSec(pcm) {
  const w = sec(0.005);
  const rms = (i) => { let s = 0; for (let k = i; k < i + w; k++) s += pcm[k] * pcm[k]; return Math.sqrt(s / w); };
  let base = 0; let n = 0;
  for (let i = 0; i + w <= sec(0.3); i += w) { base += rms(i) ** 2; n++; }
  const thr = 8 * Math.sqrt(base / n);
  for (let i = 0; i + 3 * w <= pcm.length; i += w) if (rms(i) > thr && rms(i + w) > thr && rms(i + 2 * w) > thr) return i / RATE;
  return null;
}
const finalHashes = (res) => res.finals.map((f) => f.parts.map((p) => p.sha256).join('+'));

test('render --lead-in-sec 2：各スライドの話し始めが切り替えから 2 秒（±40 ms）。短い無音には room tone を足し、長い無音は切り詰める。予定表は新しい長さで並ぶ', T, async () => {
  const c = await setup('leadin-basic');
  try {
    const base = ok(await run('render', '--workspace', c.ws, ...EXACT, '--out', path.join(c.dir, 'out-base')), 'base');
    const r = await run('render', '--workspace', c.ws, '--lead-in-sec', '2', ...EXACT);
    const res = ok(r, 'lead-in');
    assert.equal(r.env.warnings.length, 0, JSON.stringify(r.env.warnings));
    const out = path.join(c.ws, 'out');
    const tl = rj(path.join(out, 'timeline.json'));
    assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
    assert.equal(tl.prePadSamples, 0);
    let cum = 0;
    SLIDES.forEach((id, i) => {
      const f = res.finals[i];
      const pcm = pcmOfWav(path.join(out, 'final', `${id}.wav`));
      assert.equal(pcm.length, f.samples);
      const t = speechStartSec(pcm);
      assert.ok(t !== null && Math.abs(t - 2.0) <= 0.04, `${id}: speech starts ${t} s after the switch`);
      // leadIn の欄
      assert.equal(f.leadIn.sec, 2);
      assert.equal(f.leadIn.onsetFound, true);
      assert.ok(Math.abs(f.leadIn.onsetSample - (c.m.bounds[i] + c.m.trueOnsets[i])) <= sec(0.04), `${id}: onsetSample ${f.leadIn.onsetSample}`);
      assert.equal(f.leadIn.paddedSamples > 0, i !== 1, `${id}: padded ${f.leadIn.paddedSamples}`);
      assert.equal(f.leadIn.roomToneFrom, i === 1 ? null : (i === 0 ? 'own' : 'quietest'));
      assert.equal(f.leadIn.trimmedHeadSamples > 0, i !== 2);
      assert.equal(f.startSample, c.m.bounds[i], '元の切れ目の位置はそのまま');
      // 予定表：切り替え = 直前までの完成音声の長さの合計
      assert.equal(tl.slides[i].showStart, cum, id);
      assert.equal(tl.slides[i].audioStart, cum);
      cum += f.samples;
      assert.equal(tl.slides[i].showEnd, cum);
    });
    assert.equal(tl.totalSamples, cum);
    assert.equal(res.totalSamples, cum);
    assert.ok(res.totalSec > base.totalSec + 0.5, `${res.totalSec} vs ${base.totalSec}`);
    assert.equal(cum, base.finals.reduce((n, f) => n + f.samples, 0) + res.finals.reduce((n, f) => n + f.leadIn.paddedSamples - f.leadIn.trimmedHeadSamples, 0));
  } finally { await cleanup(c.dir); }
});

test('(f)(e) --lead-in-sec 0 は従来と完全に同一の出力（音声の SHA-256、leadIn の欄なし）。同じ入力の 2 回目は同じ SHA-256', T, async () => {
  const c = await setup('leadin-zero');
  try {
    const a = ok(await run('render', '--workspace', c.ws, ...EXACT, '--out', path.join(c.dir, 'o1')), 'plain');
    const z = ok(await run('render', '--workspace', c.ws, '--lead-in-sec', '0', ...EXACT, '--out', path.join(c.dir, 'o2')), 'zero');
    assert.deepEqual(finalHashes(z), finalHashes(a));
    assert.ok(z.finals.every((f) => f.leadIn === undefined));
    assert.equal(z.totalSamples, a.totalSamples);
    assert.equal(sha256Hex(readFileSync(path.join(c.dir, 'o1', 'timeline.json'))), sha256Hex(readFileSync(path.join(c.dir, 'o2', 'timeline.json'))));
    for (const id of SLIDES) assert.equal(sha256Hex(readFileSync(path.join(c.dir, 'o1', 'final', `${id}.wav`))), sha256Hex(readFileSync(path.join(c.dir, 'o2', 'final', `${id}.wav`))));
    // lead-in あり：2 回やって同じ
    const x = ok(await run('render', '--workspace', c.ws, '--lead-in-sec', '2', ...EXACT, '--out', path.join(c.dir, 'o3')), 'x');
    const y = ok(await run('render', '--workspace', c.ws, '--lead-in-sec', '2', ...EXACT, '--out', path.join(c.dir, 'o4')), 'y');
    assert.deepEqual(finalHashes(x), finalHashes(y));
    assert.notDeepEqual(finalHashes(x), finalHashes(a));
    for (const id of SLIDES) assert.equal(sha256Hex(readFileSync(path.join(c.dir, 'o3', 'final', `${id}.wav`))), sha256Hex(readFileSync(path.join(c.dir, 'o4', 'final', `${id}.wav`))));
  } finally { await cleanup(c.dir); }
});

test('引数：範囲の外・数でない値は終了コード 2。通しでない経路（--no-boundaries）で指定されたら、警告 lead-in-ignored を出して無視する', T, async () => {
  const c = await setup('leadin-args');
  try {
    for (const bad of ['31', '-1', 'abc']) assert.equal((await run('render', '--workspace', c.ws, '--lead-in-sec', bad, ...EXACT)).code, 2, bad);
    assert.equal((await run('render', '--workspace', c.ws, '--lead-in-sec', '2', '--lead-keep-ms', '1001', ...EXACT)).code, 2);
    const r = await run('render', '--workspace', c.ws, '--no-boundaries', '--lead-in-sec', '2', '--out', path.join(c.dir, 'old'));
    assert.ok(r.env.warnings.some((w) => w.code === 'lead-in-ignored'), JSON.stringify(r.env.warnings));
    assert.equal((await run('render', '--workspace', c.ws, '--no-boundaries', '--lead-in-sec', '0', '--out', path.join(c.dir, 'old2'))).env.warnings.some((w) => w.code === 'lead-in-ignored'), false);
  } finally { await cleanup(c.dir); }
});

test('音量の処理（--target-lufs）より前に room tone を足す：足したあとの音声に音量の処理がかかる（足した部分も同じ利得）', T, async () => {
  const c = await setup('leadin-level');
  try {
    const plain = ok(await run('render', '--workspace', c.ws, '--lead-in-sec', '2', ...EXACT, '--out', path.join(c.dir, 'p')), 'plain');
    const lev = await run('render', '--workspace', c.ws, '--lead-in-sec', '2', '--target-lufs', '-30', '--ceiling-db', '-1.5', ...EXACT, '--out', path.join(c.dir, 'l'));
    const res = ok(lev, 'leveled');
    const gainDb = res.leveling[0].gainDb;
    assert.ok(Math.abs(gainDb) > 3, `the test needs a real gain (${gainDb} dB)`);
    // 足した部分（先頭の 0.2〜0.5 s は room tone）の RMS の比 = 利得
    const rms = (p) => { let s = 0; for (let i = sec(0.2); i < sec(0.5); i++) s += p[i] * p[i]; return Math.sqrt(s / sec(0.3)); };
    const before = pcmOfWav(path.join(c.dir, 'p', 'final', 's0003.wav'));
    const after = pcmOfWav(path.join(c.dir, 'l', 'final', 's0003.wav'));
    assert.ok(Math.abs(20 * Math.log10(rms(after) / rms(before)) - gainDb) < 0.7, `pad gain ${20 * Math.log10(rms(after) / rms(before))} dB vs ${gainDb} dB`);
    // 話し始めの位置は変わらない
    assert.ok(Math.abs(speechStartSec(after) - 2.0) <= 0.04);
    assert.equal(plain.finals[2].leadIn.paddedSamples, res.finals[2].leadIn.paddedSamples);
  } finally { await cleanup(c.dir); }
});

test('既定の tail margin（100 ms）と一緒でも動く：予定表の postPadSamples は余裕のとおり、または余裕を取れなければ 0（警告）', T, async () => {
  const c = await setup('leadin-margin');
  try {
    const r = await run('render', '--workspace', c.ws, '--lead-in-sec', '2');
    const res = ok(r, 'render');
    const tl = rj(path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(tl.postPadSamples, res.tailMarginSamples);
    assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
    let cum = 0;
    tl.slides.forEach((s, i) => { assert.equal(s.showStart, cum); cum += res.finals[i].samples + res.tailMarginSamples; assert.equal(s.showEnd, cum); });
  } finally { await cleanup(c.dir); }
});

test('通しを最後まで（方式 B）：render --lead-in-sec 2 → build → verify。動画の音声の話し始めが、予定表の切り替えから 2 秒（±50 ms）', T, async () => {
  const c = await setup('leadin-e2e');
  try {
    ok(await run('render', '--workspace', c.ws, '--lead-in-sec', '2', ...EXACT), 'render');
    const built = await spawnCli(['build', '--method', 'B', '--workspace', c.ws]);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const v = await spawnCli(['verify', '--workspace', c.ws]);
    const vj = JSON.parse(v.stdout.trim().split('\n').pop());
    assert.equal(v.code, 0, v.stdout.slice(-1500));
    assert.equal(vj.result.pass, true);
    for (const s of vj.result.slides) assert.equal(s.status, 'ok', JSON.stringify(s));
    assert.ok(vj.result.maxAbsDiffMs.audio <= 20, `audio ${vj.result.maxAbsDiffMs.audio}`);
    assert.ok(existsSync(path.join(c.ws, 'out', 'video.mp4')));
  } finally { await cleanup(c.dir); }
});
