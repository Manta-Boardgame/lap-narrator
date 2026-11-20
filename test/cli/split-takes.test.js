// split-takes：破棄した区間も含め、区間ごとの WAV に切り出す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { run, tmpDir, cleanup, writeTinySource, exampleExport, finalExport, wavPcm, EXAMPLES } from './helpers/cli.js';

const T = { timeout: 180000 };
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function setup(label) {
  const dir = await tmpDir(label);
  await writeTinySource(path.join(dir, 'src'));
  const pack = path.join(dir, 'pack.zip');
  assert.equal((await run('pack', '--from-json', path.join(dir, 'src'), '--out', pack)).code, 0);
  return { dir, pack, ws: path.join(dir, 'ws') };
}

test('retake：採用（kept）と破棄（discarded）の両方が区間ごとの WAV になり、中身は元の録音のその範囲と同じ', T, async () => {
  const ctx = await setup('split');
  try {
    const ex = await exampleExport('retake', path.join(ctx.dir, 'ex'));
    assert.equal((await run('import', ...ex.zips, '--script', ctx.pack, '--workspace', ctx.ws)).code, 0);
    const out = path.join(ctx.dir, 'takes');
    const r = await run('split-takes', '--session', 'ex-retake', '--out', out, '--workspace', ctx.ws);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
    const seg = rj(path.join(EXAMPLES, 'retake', 'expected.segments.json'));
    const files = r.env.result.files;
    assert.equal(files.length, seg.segments.length);
    assert.ok(files.some((f) => f.status === 'discarded'), '破棄の区間も含む');
    assert.ok(files.some((f) => f.status === 'kept'));
    const raw = readFileSync(path.join(EXAMPLES, 'retake', 'raw', 'rec-000001.wav'));
    for (const s of seg.segments) {
      const f = files.find((x) => x.segmentId === s.segmentId);
      assert.ok(f, s.segmentId);
      assert.equal(f.status, s.status);
      assert.equal(f.takeId, s.takeId);
      assert.equal(f.start, s.start);
      assert.equal(f.end, s.end);
      assert.equal(f.file, `${s.segmentId}_${s.slideId}_${s.takeId}_${s.status}.wav`);
      const w = wavPcm(path.join(out, f.file));
      assert.equal(w.samples, s.end - s.start);
      assert.equal(w.sampleRate, 48000);
      const want = raw.subarray(44 + s.start * 2, 44 + s.end * 2);
      assert.deepEqual(readFileSync(path.join(out, f.file)).subarray(44), want, s.segmentId);
    }
    assert.deepEqual(readdirSync(out).sort(), files.map((f) => f.file).sort());
  } finally { await cleanup(ctx.dir); }
});

test('見本のすべての場面：expected.segments.json の区間と同じ数・範囲の WAV ができる（位置の問題がある場面は範囲内に切り詰める）', T, async () => {
  const ctx = await setup('split-all');
  try {
    for (const name of rj(path.join(EXAMPLES, 'index.json')).map((s) => s.name)) {
      const ws = path.join(ctx.dir, `ws-${name}`);
      const ex = await exampleExport(name, path.join(ctx.dir, `ex-${name}`));
      assert.equal((await run('import', ...ex.zips, '--script', ctx.pack, '--workspace', ws)).code, 0, name);
      const r = await run('split-takes', '--session', `ex-${name}`, '--out', path.join(ctx.dir, `o-${name}`), '--workspace', ws);
      assert.equal(r.code, 0, `${name} ${r.stdout}`);
      const seg = rj(path.join(EXAMPLES, name, 'expected.segments.json'));
      const warned = new Set(r.env.warnings.filter((w) => w.code === 'segment-empty' || w.code === 'raw-missing').map((w) => w.detail.segmentId));
      for (const s of seg.segments) {
        const f = r.env.result.files.find((x) => x.segmentId === s.segmentId);
        if (!f) { assert.ok(warned.has(s.segmentId), `${name} ${s.segmentId} is neither written nor warned`); continue; }
        assert.equal(f.start, s.start, name);
        assert.ok(f.end <= s.end && f.end > f.start, name);
        assert.equal(f.status, s.status);
      }
      assert.equal(r.env.result.files.length + warned.size, seg.segments.length, name);
    }
  } finally { await cleanup(ctx.dir); }
});

test('split-takes の失敗：存在しないセッション、完成版しかないセッション', T, async () => {
  const ctx = await setup('split-bad');
  try {
    const ex = await exampleExport('basic', path.join(ctx.dir, 'ex'));
    await run('import', ...ex.zips, '--script', ctx.pack, '--workspace', ctx.ws);
    const r1 = await run('split-takes', '--session', 'nope', '--out', path.join(ctx.dir, 'o'), '--workspace', ctx.ws);
    assert.equal(r1.code, 1);
    assert.equal(r1.env.errors[0].code, 'no-such-session');
    assert.equal((await run('split-takes', '--out', path.join(ctx.dir, 'o'), '--workspace', ctx.ws)).code, 2);
    // 完成版しかないセッション：切り出す録音がない
    const full = await exampleExport('tiny3-full', path.join(ctx.dir, 'exf'));
    await run('import', ...full.zips, '--script', ctx.pack, '--workspace', path.join(ctx.dir, 'ws0'));
    const rr = (await run('render', '--workspace', path.join(ctx.dir, 'ws0'))).env.result;
    const fin = await finalExport({ renderResult: rr, renderOut: rr.out, sessionDir: path.join(EXAMPLES, 'tiny3-full'), outDir: path.join(ctx.dir, 'fin'), editVersion: 1, exportId: 'exp-fin-only' });
    const ws2 = path.join(ctx.dir, 'ws2');
    assert.equal((await run('import', ...fin.zips, '--script', ctx.pack, '--workspace', ws2)).code, 0);
    const r2 = await run('split-takes', '--session', 'ex-tiny3-full', '--out', path.join(ctx.dir, 'o2'), '--workspace', ws2);
    assert.equal(r2.code, 1);
    assert.equal(r2.env.errors[0].code, 'no-recording');
  } finally { await cleanup(ctx.dir); }
});
