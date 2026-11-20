// build の予定表の探し方、last-build.json、verify の場所の決め方と測定不能の扱い（C-001 の 2 章 14、15）。
// 偽の build-a.ps1／verify.py を差し込む。PowerPoint は動かさない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { run, tmpDir, cleanup, writeTinySource, exampleExport } from './helpers/cli.js';

const T = { timeout: 180000 };
const BOM = '﻿';

const FAKE_BUILD_A = `param([string]$Pptx, [string]$Timeline, [string]$OutDir, [string]$Mode = 'both', [int]$GridMs = 0, [int]$TimeoutSec = 300, [int]$VertResolution = 1080, [string]$Python = '', [switch]$KeepWork)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
[IO.File]::WriteAllBytes((Join-Path $OutDir 'video.mp4'), [byte[]](0,0,0,0))
Write-Output '{"ok":true,"method":"A-linked","elapsedMs":5,"notes":[],"video":"video.mp4"}'
exit 0
`;

// FAKE_MODE：pass／unmeasurable（全部）／partial（1 枚だけ測定不能）／fail／both（許容値の外と測定不能）。余計な項目（extra）が増えても壊れないことも見る
const FAKE_VERIFY_PY = `import json, os, sys
with open(os.environ["FAKE_LOG"], "w") as f:
    json.dump({"argv": sys.argv[1:]}, f)
mode = os.environ.get("FAKE_MODE", "pass")
st = {"pass": ["ok", "ok"], "unmeasurable": ["unmeasurable", "unmeasurable"], "partial": ["ok", "unmeasurable"], "fail": ["ok", "out-of-tolerance"], "both": ["out-of-tolerance", "unmeasurable"]}[mode]
slides = [{"slideId": "s%d" % (i + 1), "status": x, "extra": {"newField": i}, "diffMs": {"show": [3.0, -7.5][i], "audio": [-12.0, 2.0][i] if x != "unmeasurable" else None}} for i, x in enumerate(st)]
bad = st.count("out-of-tolerance")
print(json.dumps({"method": "B", "slides": slides, "pass": bad == 0, "allMeasured": "unmeasurable" not in st,
                  "counts": {"ok": st.count("ok"), "outOfTolerance": bad, "unmeasurable": st.count("unmeasurable")}, "futureField": [1, 2]}))
sys.exit(3 if bad else 0)
`;

async function setup(label) {
  const dir = await tmpDir(label);
  await writeTinySource(path.join(dir, 'src'));
  const pack = path.join(dir, 'pack.zip');
  assert.equal((await run('pack', '--from-json', path.join(dir, 'src'), '--out', pack)).code, 0);
  const ws = path.join(dir, 'ws');
  const ex = await exampleExport('tiny3-full', path.join(dir, 'ex'));
  assert.equal((await run('import', ...ex.zips, '--script', pack, '--workspace', ws)).code, 0);
  assert.equal((await run('render', '--workspace', ws)).code, 0);
  const b = path.join(dir, 'fakebuilder');
  await fsp.mkdir(b, { recursive: true });
  await fsp.writeFile(path.join(b, 'build-a.ps1'), BOM + FAKE_BUILD_A.replace(/\n/g, '\r\n'));
  await fsp.writeFile(path.join(b, 'build_b.py'), 'raise SystemExit(0)\n');
  await fsp.writeFile(path.join(dir, 'verify.py'), FAKE_VERIFY_PY);
  await fsp.writeFile(path.join(dir, 'deck.pptx'), 'pretend pptx');
  return { dir, ws, b };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('build --out <別の場所>：予定表は <workspace>/out から見つかり、result.timeline に入る。last-build.json が書かれ、verify --workspace はそれを読む', T, async () => {
  const c = await setup('lb1');
  try {
    const other = path.join(c.dir, 'elsewhere');
    const env = { NARRATE_BUILDER_DIR: c.b, NARRATE_VERIFY_SCRIPT: path.join(c.dir, 'verify.py'), FAKE_LOG: path.join(c.dir, 'log.json') };
    const b = await withEnv(env, () => run('build', '--method', 'A', '--pptx', path.join(c.dir, 'deck.pptx'), '--workspace', c.ws, '--out', other));
    assert.equal(b.code, 0, b.stdout);
    assert.equal(b.env.result.timeline, path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(b.env.result.videoPath, path.join(other, 'video.mp4'));
    const lb = JSON.parse(readFileSync(path.join(c.ws, 'last-build.json'), 'utf8'));
    assert.equal(lb.format, 'lap-narrator/last-build');
    assert.equal(lb.method, 'A-linked');
    assert.equal(lb.timeline, 'out/timeline.json', '作業場の中は相対');
    assert.equal(path.resolve(lb.video), path.join(other, 'video.mp4'), '作業場の外は絶対');
    const v = await withEnv(env, () => run('verify', '--workspace', c.ws));
    assert.equal(v.code, 0, v.stdout);
    const argv = JSON.parse(readFileSync(env.FAKE_LOG, 'utf8')).argv;
    assert.equal(argv[argv.indexOf('--video') + 1], path.join(other, 'video.mp4'));
    assert.equal(argv[argv.indexOf('--timeline') + 1], path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(argv[argv.indexOf('--method') + 1], 'A');
  } finally { await cleanup(c.dir); }
});

test('build：--out の下に timeline.json があればそれを先に使う。どこにも無ければ、探した場所を添えて timeline-not-found', T, async () => {
  const c = await setup('lb2');
  try {
    const other = path.join(c.dir, 'elsewhere');
    await fsp.cp(path.join(c.ws, 'out'), other, { recursive: true });
    await fsp.rm(path.join(other, 'video.mp4'), { force: true });
    const env = { NARRATE_BUILDER_DIR: c.b };
    const b = await withEnv(env, () => run('build', '--method', 'A', '--pptx', path.join(c.dir, 'deck.pptx'), '--workspace', c.ws, '--out', other));
    assert.equal(b.code, 0, b.stdout);
    assert.equal(b.env.result.timeline, path.join(other, 'timeline.json'));
    await fsp.rm(path.join(c.ws, 'out'), { recursive: true, force: true });
    await fsp.rm(path.join(other, 'timeline.json'));
    const n = await withEnv(env, () => run('build', '--method', 'A', '--pptx', path.join(c.dir, 'deck.pptx'), '--workspace', c.ws, '--out', other));
    assert.equal(n.code, 1);
    assert.equal(n.env.errors[0].code, 'timeline-not-found');
    assert.equal(n.env.errors[0].detail.searched.length, 2);
  } finally { await cleanup(c.dir); }
});

test('verify --workspace --out <dir>：その下の video.mp4 と timeline.json を測る。last-build.json が無ければ <workspace>/out。.json の --out は従来どおり結果の書き出し先', T, async () => {
  const c = await setup('lb3');
  try {
    const env = { NARRATE_VERIFY_SCRIPT: path.join(c.dir, 'verify.py'), FAKE_LOG: path.join(c.dir, 'log.json') };
    const other = path.join(c.dir, 'elsewhere');
    await fsp.cp(path.join(c.ws, 'out'), other, { recursive: true });
    await fsp.writeFile(path.join(other, 'video.mp4'), 'x');
    await fsp.writeFile(path.join(c.ws, 'out', 'video.mp4'), 'x');
    let r = await withEnv(env, () => run('verify', '--workspace', c.ws, '--out', other));
    assert.equal(r.code, 0, r.stdout);
    let argv = JSON.parse(readFileSync(env.FAKE_LOG, 'utf8')).argv;
    assert.equal(argv[argv.indexOf('--video') + 1], path.join(other, 'video.mp4'));
    r = await withEnv(env, () => run('verify', '--workspace', c.ws));
    argv = JSON.parse(readFileSync(env.FAKE_LOG, 'utf8')).argv;
    assert.equal(argv[argv.indexOf('--video') + 1], path.join(c.ws, 'out', 'video.mp4'));
    const rep = path.join(c.dir, 'report.json');
    r = await withEnv(env, () => run('verify', '--workspace', c.ws, '--out', rep));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(readFileSync(rep, 'utf8')).pass, true);
    await fsp.rm(path.join(c.ws, 'out', 'video.mp4'));
    r = await withEnv(env, () => run('verify', '--workspace', c.ws, '--out', path.join(c.dir, 'nodir')));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
  } finally { await cleanup(c.dir); }
});

test('verify：測定不能が 1 つでもあれば終了コード 3、errors[0].code = unmeasurable、pass は false（passMeasuredOnly は測れた分）。--allow-unmeasurable なら 0 と警告', T, async () => {
  const c = await setup('lb4');
  try {
    await fsp.writeFile(path.join(c.ws, 'out', 'video.mp4'), 'x');
    const base = { NARRATE_VERIFY_SCRIPT: path.join(c.dir, 'verify.py'), FAKE_LOG: path.join(c.dir, 'log.json') };
    for (const mode of ['unmeasurable', 'partial']) {
      const r = await withEnv({ ...base, FAKE_MODE: mode }, () => run('verify', '--workspace', c.ws));
      assert.equal(r.code, 3, mode);
      assert.equal(r.env.ok, false);
      assert.equal(r.env.errors[0].code, 'unmeasurable');
      assert.equal(r.env.result.pass, false);
      assert.equal(r.env.result.passMeasuredOnly, true);
      assert.equal(r.env.result.allMeasured, false);
      assert.deepEqual(r.env.result.futureField, [1, 2], '知らない項目はそのまま通す');
      const a = await withEnv({ ...base, FAKE_MODE: mode }, () => run('verify', '--workspace', c.ws, '--allow-unmeasurable'));
      assert.equal(a.code, 0, mode);
      assert.equal(a.env.ok, true);
      assert.equal(a.env.result.pass, true);
      assert.equal(a.env.result.passMeasuredOnly, true);
      assert.equal(a.env.warnings[0].code, 'unmeasurable');
      assert.equal(a.env.errors.length, 0);
    }
    // 許容値の外があるときは、--allow-unmeasurable でも 3。out-of-tolerance が先
    for (const flags of [[], ['--allow-unmeasurable']]) {
      const r = await withEnv({ ...base, FAKE_MODE: 'both' }, () => run('verify', '--workspace', c.ws, ...flags));
      assert.equal(r.code, 3);
      assert.equal(r.env.errors[0].code, 'out-of-tolerance');
      assert.equal(r.env.result.pass, false);
      assert.equal(r.env.result.passMeasuredOnly, false);
    }
    const ok = await withEnv({ ...base, FAKE_MODE: 'pass' }, () => run('verify', '--workspace', c.ws));
    assert.equal(ok.code, 0);
    assert.equal(ok.env.result.pass, true);
    assert.equal(ok.env.result.allMeasured, true);
  } finally { await cleanup(c.dir); }
});

test('verify --workspace --out <build の出力先>：動画は --out の下、予定表は --out に無ければ last-build.json／<workspace>/out。last-build.json が無くても通る。ずれの最大値が出る', T, async () => {
  const c = await setup('lb5');
  try {
    const env = { NARRATE_VERIFY_SCRIPT: path.join(c.dir, 'verify.py'), FAKE_LOG: path.join(c.dir, 'log.json') };
    const other = path.join(c.dir, 'elsewhere');
    await fsp.mkdir(other, { recursive: true });
    await fsp.writeFile(path.join(other, 'video.mp4'), 'x'); // 予定表は <workspace>/out/timeline.json だけにある
    const rep = path.join(c.dir, 'rep.json');
    const r = await withEnv(env, () => run('verify', '--workspace', c.ws, '--out', other, '--report', rep));
    assert.equal(r.code, 0, r.stdout);
    const argv = JSON.parse(readFileSync(env.FAKE_LOG, 'utf8')).argv;
    assert.equal(argv[argv.indexOf('--video') + 1], path.join(other, 'video.mp4'));
    assert.equal(argv[argv.indexOf('--timeline') + 1], path.join(c.ws, 'out', 'timeline.json'));
    assert.deepEqual(r.env.result.maxAbsDiffMs, { show: 7.5, audio: 12 });
    assert.deepEqual(r.env.result.worst, { show: 's2', audio: 's1' });
    assert.equal(JSON.parse(readFileSync(rep, 'utf8')).worst.audio, 's1');
    // last-build.json があっても、--out を明示すればそちらの動画
    await fsp.writeFile(path.join(c.ws, 'out', 'video.mp4'), 'x');
    await fsp.writeFile(path.join(c.ws, 'last-build.json'), JSON.stringify({ format: 'lap-narrator/last-build', version: 1, method: 'B', video: 'out/video.mp4', timeline: 'out/timeline.json' }));
    await withEnv(env, () => run('verify', '--workspace', c.ws, '--out', other));
    assert.equal(JSON.parse(readFileSync(env.FAKE_LOG, 'utf8')).argv[1], path.join(other, 'video.mp4'));
    await withEnv(env, () => run('verify', '--workspace', c.ws));
    assert.equal(JSON.parse(readFileSync(env.FAKE_LOG, 'utf8')).argv[1], path.join(c.ws, 'out', 'video.mp4'));
  } finally { await cleanup(c.dir); }
});

test('skippedSlides：status／render の結果に {slideId, order, title, reason:"not-recordable"} の一覧と、互換の skippedSlideIds', T, async () => {
  const c = await setup('lb6');
  try {
    const sp = path.join(c.ws, 'script.json');
    const sc = JSON.parse(readFileSync(sp, 'utf8'));
    const st0 = await run('status', '--workspace', c.ws);
    assert.deepEqual(st0.env.result.skippedSlides, sc.slides.filter((x) => !x.recordable).map((x) => ({ slideId: x.slideId, order: x.order, title: x.title, reason: 'not-recordable' })));
    // 3 枚目を録音の対象外にした台本（pack で作り直して差し替える）
    const dir2 = path.join(c.dir, 'src2');
    await writeTinySource(dir2);
    const j = JSON.parse(readFileSync(path.join(dir2, 'script.json'), 'utf8'));
    j.slides[2].recordable = false;
    await fsp.writeFile(path.join(dir2, 'script.json'), JSON.stringify(j));
    assert.equal((await run('pack', '--from-json', dir2, '--out', path.join(c.dir, 'pack2.zip'))).code, 0);
    assert.equal((await run('import', path.join(c.dir, 'pack2.zip'), '--workspace', c.ws)).code, 0);
    const st = await run('status', '--workspace', c.ws);
    assert.equal(st.code, 0, st.stdout);
    assert.deepEqual(st.env.result.skippedSlideIds, ['s0003']);
    assert.deepEqual(st.env.result.skippedSlides, [{ slideId: 's0003', order: 3, title: j.slides[2].title, reason: 'not-recordable' }]);
  } finally { await cleanup(c.dir); }
});
