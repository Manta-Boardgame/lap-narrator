// 流れ全体：台本パックを pack → 見本のセッションを zip にして import（巻を分けた場合を含め、順不同と再送）→ status → select → render → build --method B → verify。
// 最後に、できた MP4 を verify が通す。わざとずらした MP4 は verify が見つける。PowerPoint は動かさない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { sha256Hex } from '../../core/sha256.js';
import { wavHeader } from '../../core/wav.js';
import {
  run, spawnCli, runProcessForTest, tmpDir, cleanup, writeTinySource, exampleExport, snapshotDir, wavPcm, EXAMPLES, ROOT,
} from './helpers/cli.js';

const T = { timeout: 300000 };
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ok = (r, label = '') => { assert.equal(r.code, 0, `${label} ${r.stdout}`); assert.equal(r.env.ok, true); assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] }); return r.env.result; };

const RAW = 'raw/rec-000001.wav';
const TONES = [600, 1200, 2400]; // スライドごとの音の高さ（verify が音の始まりを測れるように、離れた高さにする）

/** tiny3-full の録音ファイルを、スライドごとに違う高さの音に差し替える（操作記録はそのまま） */
function toneRaw() {
  const n = 48000;
  const pcm = new Int16Array(n);
  const slideOf = (i) => (i < 24000 ? 0 : i < 33600 ? 1 : i < 43200 ? 2 : -1);
  for (let i = 0; i < n; i++) {
    const s = slideOf(i);
    if (s >= 0) pcm[i] = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * TONES[s] * i) / 48000));
  }
  const out = new Uint8Array(44 + n * 2);
  out.set(wavHeader({ sampleRate: 48000, samples: n }), 0);
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
}

function toneMutate() {
  const raw = toneRaw();
  const sha = sha256Hex(raw);
  return (manifest, vol, datas) => ({
    manifest: {
      ...manifest,
      rawFiles: manifest.rawFiles.map((r) => (r.file === RAW ? { ...r, sha256: sha, samples: 48000 } : r)),
      files: manifest.files.map((f) => (f.path === RAW ? { path: RAW, bytes: raw.length, sha256: sha } : f)),
    },
    datas: datas.map(([n, d]) => (n === RAW ? [n, raw] : [n, d])),
  });
}

test('流れ全体：pack → import（2 巻、順不同、再送）→ status → select → render → build --method B → verify', T, async () => {
  const dir = await tmpDir('flow');
  try {
    // ---- pack
    await writeTinySource(path.join(dir, 'src'));
    const packZip = path.join(dir, 'tiny3-pack.zip');
    const p = ok(await run('pack', '--from-json', path.join(dir, 'src'), '--out', packZip), 'pack');
    assert.equal(p.slideCount, 3);
    const sessionScript = rj(path.join(EXAMPLES, 'tiny3-full', 'script.json'));
    assert.equal(p.scriptHash, sessionScript.scriptHash, '台本パックのハッシュは、見本のセッションが録った台本と同じ');
    assert.equal((await run('validate', packZip)).code, 0);

    // ---- import：第 2 巻（録音ファイル）を先に、索引は 2 番目、第 1 巻は 3 番目、そのあと全部を再送
    const ws = path.join(dir, 'ws');
    const ex = await exampleExport('tiny3-full', path.join(dir, 'exports'), {
      volumeFiles: [['README.txt', 'script.json', 'events.jsonl', 'segments.json', 'edits.json'], [RAW]],
      mutate: toneMutate(),
    });
    assert.equal(ex.zips.length, 2);
    const a = ok(await run('import', ex.zips[1], '--script', packZip, '--workspace', ws), 'import vol2');
    assert.deepEqual(a.pending, [{ exportId: 'exp-tiny3-full', missing: [1] }]);
    assert.deepEqual(a.committed, []);
    assert.equal(ok(await run('status', '--workspace', ws)).counts.missing, 3, '巻が欠けている間は、録音なし');
    const b = ok(await run('import', ex.index, '--workspace', ws), 'import index');
    assert.deepEqual(b.received, []);
    const c = ok(await run('import', ex.zips[0], '--workspace', ws), 'import vol1');
    assert.deepEqual(c.committed, ['ex-tiny3-full']);
    assert.deepEqual(c.pending, []);
    const before = snapshotDir(ws, 'sessions/');
    const d = ok(await run('import', ex.index, ...ex.zips, '--workspace', ws), 're-import');
    assert.deepEqual(d.received, []);
    assert.equal(d.duplicates.length, 2);
    assert.deepEqual(snapshotDir(ws, 'sessions/'), before);

    // ---- status：3 枚とも録音が 1 件
    let st = ok(await run('status', '--workspace', ws), 'status');
    assert.deepEqual(st.slides.map((s) => s.state), ['single', 'single', 'single']);
    assert.equal(st.totalSamples, 38400);
    assert.deepEqual(st.staleSlides, []);

    // ---- 別のセッションが同じスライドを録っていた：候補が複数になり、選ぶまで render は進まない
    const ex2 = await exampleExport('basic', path.join(dir, 'exports2'));
    ok(await run('import', ...ex2.zips, '--workspace', ws), 'import basic');
    st = ok(await run('status', '--workspace', ws));
    assert.deepEqual(st.slides.map((s) => s.state), ['multiple', 'single', 'single']);
    assert.deepEqual(st.needsDecision, ['s0001']);
    const refused = await run('render', '--workspace', ws);
    assert.equal(refused.code, 4);
    assert.equal(refused.env.result.needsDecision[0].slideId, 's0001');
    assert.equal(existsSync(path.join(ws, 'out')), false);
    ok(await run('select', '--slide', 's0001', '--session', 'ex-tiny3-full', '--take', 't0001', '--workspace', ws), 'select');

    // ---- render
    const rr = ok(await run('render', '--workspace', ws), 'render');
    const out = rr.out;
    assert.deepEqual(rr.finals.map((f) => [f.slideId, f.sessionId, f.samples]), [['s0001', 'ex-tiny3-full', 19200], ['s0002', 'ex-tiny3-full', 9600], ['s0003', 'ex-tiny3-full', 9600]]);
    assert.equal(rr.totalSamples, 38400 + 3 * (14400 + 24000));
    const tl = rj(path.join(out, 'timeline.json'));
    assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
    assert.equal(tl.totalSamples, rr.totalSamples);
    // 結合部のない 2 枚目・3 枚目は、録音をそのまま切り出した音（フェードなし）
    const tone = toneRaw();
    for (const [id, from, to] of [['s0002', 24000, 33600], ['s0003', 33600, 43200]]) {
      const w = readFileSync(path.join(out, 'final', `${id}.wav`));
      assert.deepEqual(new Uint8Array(w.subarray(44)), tone.subarray(44 + from * 2, 44 + to * 2), id);
    }
    // 1 枚目は結合部（9600／14400）にフェードがかかる。期待値の長さと一致する
    assert.equal(wavPcm(path.join(out, 'final', 's0001.wav')).samples, rj(path.join(EXAMPLES, 'tiny3-full', 'expected.render.json')).finals[0].samples);

    // ---- build --method B（本物のプロセス）
    const built = await spawnCli(['build', '--method', 'B', '--workspace', ws]);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const bEnv = JSON.parse(built.stdout);
    assert.equal(bEnv.ok, true);
    assert.equal(bEnv.result.method, 'B');
    assert.ok(existsSync(path.join(out, 'video.mp4')));
    assert.ok(built.stderr.split('\n').filter(Boolean).every((l) => JSON.parse(l).progress), '標準エラー出力は 1 行 1 JSON の進み具合だけ');

    // ---- verify：できた MP4 を通す
    const v = await spawnCli(['verify', '--workspace', ws]);
    assert.equal(v.code, 0, v.stdout + v.stderr);
    const vEnv = JSON.parse(v.stdout);
    assert.equal(vEnv.ok, true);
    assert.equal(vEnv.result.pass, true);
    assert.equal(vEnv.result.slides.length, 3);
    assert.equal(vEnv.result.counts.outOfTolerance, 0);
    for (const s of vEnv.result.slides) {
      assert.equal(s.status, 'ok', JSON.stringify(s));
      assert.ok(typeof s.diffMs.show === 'number' && typeof s.diffMs.audio === 'number', '絵も音声も測れている');
      assert.ok(Math.abs(s.diffMs.show) <= 34 && Math.abs(s.diffMs.audio) <= 20, JSON.stringify(s));
    }
    assert.equal(vEnv.result.allMeasured, true);

    // ---- わざとずらした MP4 は、verify が見つける（終了コード 3）
    const bad = path.join(dir, 'bad');
    const py = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
    const shifted = await runProcessForTest(py, ['-I', path.join(ROOT, 'builder', 'build_b.py'), '--timeline', path.join(out, 'timeline.json'), '--out', bad, '--debug-audio-shift-ms', '120']);
    assert.equal(shifted.code, 0, shifted.stderr);
    const vb = await run('verify', '--video', path.join(bad, 'video.mp4'), '--timeline', path.join(out, 'timeline.json'));
    assert.equal(vb.code, 3, vb.stdout);
    assert.equal(vb.env.ok, false);
    assert.equal(vb.env.errors[0].code, 'out-of-tolerance');
    assert.equal(vb.env.result.pass, false);
  } finally { await cleanup(dir); }
});

test('流れ全体（見本のままの音）：tiny3-full を 1 巻で取り込み、render → build → verify。音の高さが近いので音声が測定不能なら終了コード 3、--allow-unmeasurable なら絵の切り替えは測れて許容値の外はない', T, async () => {
  const dir = await tmpDir('flow2');
  try {
    await writeTinySource(path.join(dir, 'src'));
    const packZip = path.join(dir, 'pack.zip');
    ok(await run('pack', '--from-json', path.join(dir, 'src'), '--out', packZip));
    const ws = path.join(dir, 'ws');
    const ex = await exampleExport('tiny3-full', path.join(dir, 'ex'));
    ok(await run('import', ...ex.zips, ex.index, '--script', packZip, '--workspace', ws));
    ok(await run('render', '--workspace', ws));
    ok(await run('build', '--method', 'B', '--workspace', ws));
    // 測定不能が 1 つでもあれば、既定では終了コード 3（errors[0].code = unmeasurable、pass は false）。測れた分の合否は passMeasuredOnly
    const v = await run('verify', '--workspace', ws);
    if (v.env.result.allMeasured === false) {
      assert.equal(v.code, 3, v.stdout);
      assert.equal(v.env.ok, false);
      assert.equal(v.env.errors[0].code, 'unmeasurable');
      assert.equal(v.env.result.pass, false);
      assert.equal(v.env.result.passMeasuredOnly, true);
    } else {
      assert.equal(v.code, 0, v.stdout);
      assert.equal(v.env.result.pass, true);
    }
    // --allow-unmeasurable：測れた分で合否を決める
    const w = await run('verify', '--workspace', ws, '--allow-unmeasurable');
    assert.equal(w.code, 0, w.stdout);
    assert.equal(w.env.result.pass, true);
    assert.equal(w.env.result.passMeasuredOnly, true);
    if (v.env.result.allMeasured === false) assert.ok(w.env.warnings.some((x) => x.code === 'unmeasurable'));
    assert.deepEqual(w.env.result.slides.map((x) => x.detail.show), ['ok', 'ok', 'ok']);
    assert.ok(w.env.result.slides.every((x) => x.status !== 'out-of-tolerance'));
  } finally { await cleanup(dir); }
});
