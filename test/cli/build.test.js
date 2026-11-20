// build／verify：builder／checker のスクリプトを子プロセスで呼ぶ入口。
// 方式 A（PowerPoint）は、偽のスクリプトを NARRATE_BUILDER_DIR で差し込み、呼び出しの組み立て（引数と終了コード 10 の扱い）だけを試す。PowerPoint は動かさない。
// 方式 B は本物のスクリプトを動かす（.venv、-I）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { run, tmpDir, cleanup, writeTinySource, exampleExport } from './helpers/cli.js';

const T = { timeout: 180000 };
const BOM = '﻿';

const FAKE_BUILD_A = `param([string]$Pptx, [string]$Timeline, [string]$OutDir, [string]$Mode = 'both', [int]$GridMs = 0, [int]$TimeoutSec = 300, [int]$VertResolution = 1080, [string]$Python = '', [switch]$KeepWork)
Set-Content -LiteralPath $env:FAKE_LOG -Value @(('Pptx=' + $Pptx), ('Timeline=' + $Timeline), ('OutDir=' + $OutDir), ('Mode=' + $Mode), ('GridMs=' + $GridMs)) -Encoding ASCII
if ($env:FAKE_SLEEP) { Start-Sleep -Seconds ([int]$env:FAKE_SLEEP) }
if ($env:FAKE_EXIT) {
  if ($env:FAKE_EXIT -eq '1') { Write-Output '{"ok":false,"errors":[{"code":"pptx-not-found","message":"fake failure"}]}' }
  exit [int]$env:FAKE_EXIT
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
[IO.File]::WriteAllBytes((Join-Path $OutDir 'video.mp4'), [byte[]](0,0,0,0))
Write-Output '{"ok":true,"method":"A-linked","elapsedMs":5,"fps":30,"width":1920,"height":1080,"notes":[],"video":"video.mp4","variants":[],"unsetClickAnimations":[],"totalElapsedMs":7}'
exit 0
`;

const FAKE_VERIFY_PY = `import json, os, sys, time
with open(os.environ["FAKE_LOG"], "w") as f:
    json.dump({"argv": sys.argv[1:], "isolated": sys.flags.isolated}, f)
if os.environ.get("FAKE_SLEEP"):
    time.sleep(float(os.environ["FAKE_SLEEP"]))
if os.environ.get("FAKE_COMPLETED"):
    with open(os.environ["FAKE_COMPLETED"], "w") as f:
        f.write("completed")
mode = os.environ.get("FAKE_MODE", "pass")
slides = [{"slideId": "s1", "status": "ok"}, {"slideId": "s2", "status": "out-of-tolerance" if mode == "fail" else "ok"}]
if mode == "error":
    print(json.dumps({"error": {"code": "verify-failed", "message": "cannot open the video"}}))
    sys.exit(1)
print(json.dumps({"method": "B", "slides": slides, "pass": mode == "pass"}))
sys.exit(3 if mode == "fail" else 0)
`;

async function setupRendered(label) {
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
  return { dir, ws, b, pack };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('build --method A：build-a.ps1 を呼ぶ引数（-Pptx、-Timeline、-OutDir、-Mode both、-GridMs 33 が既定）と、結果の取り込み', T, async () => {
  const c = await setupRendered('builda');
  try {
    const log = path.join(c.dir, 'log.txt');
    const env = { NARRATE_BUILDER_DIR: c.b, FAKE_LOG: log };
    const r = await withEnv(env, () => run('build', '--method', 'A', '--pptx', path.join(c.dir, 'deck.pptx'), '--workspace', c.ws));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
    const args = Object.fromEntries(readFileSync(log, 'ascii').trim().split('\n').map((l) => l.trim().split(/=(.*)/s).slice(0, 2)));
    assert.equal(path.resolve(args.Pptx), path.join(c.dir, 'deck.pptx'));
    assert.equal(path.resolve(args.Timeline), path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(path.resolve(args.OutDir), path.join(c.ws, 'out'));
    assert.equal(args.Mode, 'both');
    assert.equal(args.GridMs, '33');
    assert.equal(r.env.result.method, 'A-linked');
    assert.equal(r.env.result.videoPath, path.join(c.ws, 'out', 'video.mp4'));
    assert.deepEqual(r.env.result.unsetClickAnimations, []);
    // 指定した値が渡る
    const r2 = await withEnv(env, () => run('build', '--method', 'a', '--pptx', path.join(c.dir, 'deck.pptx'), '--workspace', c.ws, '--mode', 'embedded', '--grid-ms', '0', '--out', path.join(c.dir, 'o2'), '--timeline', path.join(c.ws, 'out', 'timeline.json')));
    assert.equal(r2.code, 0, r2.stdout);
    const a2 = Object.fromEntries(readFileSync(log, 'ascii').trim().split('\n').map((l) => l.trim().split(/=(.*)/s).slice(0, 2)));
    assert.equal(a2.Mode, 'embedded');
    assert.equal(a2.GridMs, '0');
    assert.equal(path.resolve(a2.OutDir), path.join(c.dir, 'o2'));
  } finally { await cleanup(c.dir); }
});

test('build --method A：終了コード 10 は powerpoint-busy、11 は powerpoint-timeout、その他は JSON の errors の code。使い方の誤り', T, async () => {
  const c = await setupRendered('builda-err');
  try {
    const base = { NARRATE_BUILDER_DIR: c.b, FAKE_LOG: path.join(c.dir, 'log.txt') };
    const go = (extra, ...more) => withEnv({ ...base, ...extra }, () => run('build', '--method', 'A', '--pptx', path.join(c.dir, 'deck.pptx'), '--workspace', c.ws, ...more));
    let r = await go({ FAKE_EXIT: '10' });
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'powerpoint-busy');
    assert.equal(r.env.errors[0].detail.exitCode, 10);
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
    r = await go({ FAKE_EXIT: '11' });
    assert.equal(r.env.errors[0].code, 'powerpoint-timeout');
    r = await go({ FAKE_EXIT: '1' });
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'pptx-not-found');
    assert.equal(r.env.errors[0].message, 'fake failure');
    // 時間の上限：止めて powerpoint-timeout
    const t0 = Date.now();
    r = await go({ FAKE_SLEEP: '30' }, '--timeout-sec', '3');
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'powerpoint-timeout');
    assert.ok(Date.now() - t0 < 20000, 'killed in time');
    // 使い方
    assert.equal((await run('build', '--method', 'A', '--workspace', c.ws)).code, 2, '--pptx がない');
    r = await go({}, '--mode', 'bogus');
    assert.equal(r.code, 2);
    r = await withEnv(base, () => run('build', '--method', 'A', '--pptx', path.join(c.dir, 'nothere.pptx'), '--workspace', c.ws));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
  } finally { await cleanup(c.dir); }
});

test('build：予定表がない／壊れている／指す音声がない、ツールがない（方式 B）', T, async () => {
  const c = await setupRendered('buildb-err');
  try {
    let r = await run('build', '--method', 'B', '--workspace', path.join(c.dir, 'empty-ws'));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'timeline-not-found');
    const tl = JSON.parse(readFileSync(path.join(c.ws, 'out', 'timeline.json'), 'utf8'));
    const out2 = path.join(c.dir, 'o2');
    await fsp.mkdir(out2);
    await fsp.writeFile(path.join(out2, 'timeline.json'), JSON.stringify({ ...tl, totalSamples: 'x' }));
    r = await run('build', '--workspace', c.ws, '--out', out2);
    assert.equal(r.code, 3);
    assert.equal(r.env.errors[0].code, 'timeline-invalid');
    await fsp.writeFile(path.join(out2, 'timeline.json'), JSON.stringify(tl));
    r = await run('build', '--workspace', c.ws, '--out', out2);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'missing-file');
    assert.ok(r.env.errors[0].detail.missing.includes('final/s0001.wav'));
    r = await withEnv({ NARRATE_PYTHON: path.join(c.dir, 'no-python.exe') }, () => run('build', '--method', 'B', '--workspace', c.ws));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'tool-missing');
  } finally { await cleanup(c.dir); }
});

test('build --method B：本物の build_b.py を .venv の Python で動かす。video.mp4 と build-report.json ができる', T, async () => {
  const c = await setupRendered('buildb');
  try {
    const r = await run('build', '--method', 'B', '--workspace', c.ws);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.env.result.method, 'B');
    assert.equal(r.env.result.fps, 30);
    assert.equal(r.env.result.slides, 3);
    assert.ok(existsSync(path.join(c.ws, 'out', 'video.mp4')));
    assert.equal(JSON.parse(readFileSync(path.join(c.ws, 'out', 'build-report.json'), 'utf8')).method, 'B');
    assert.ok(r.progress.some((p) => p.progress.stage === 'build'));
    assert.equal((await run('build', '--method', 'B', '--workspace', c.ws, '--script', c.pack)).code, 0);
    // --method の既定は B
    assert.equal((await run('build', '--workspace', c.ws)).code, 0);
  } finally { await cleanup(c.dir); }
});

test('build blocks a stale render and requires explicit approval to build an incomplete timeline', T, async () => {
  const c = await setupRendered('build-missing');
  try {
    const timelinePath = path.join(c.ws, 'out', 'timeline.json');
    const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
    timeline.slides.pop();
    timeline.totalSamples = timeline.slides.at(-1).showEnd;
    await fsp.writeFile(timelinePath, JSON.stringify(timeline));
    const incomplete = await run('build', '--workspace', c.ws);
    assert.equal(incomplete.env.errors[0].code, 'missing-slides');
    assert.deepEqual(incomplete.env.errors[0].detail.slides, ['s0003']);
    const accepted = await run('build', '--workspace', c.ws, '--allow-missing');
    assert.equal(accepted.code, 0, accepted.stdout);
    assert.ok(accepted.env.warnings.some((w) => w.code === 'slide-missing'));

    const selections = path.join(c.ws, 'selections.json');
    await fsp.writeFile(selections, JSON.stringify({ s0001: { sessionId: 'gone', takeId: 't0001' } }));
    const failedRender = await run('render', '--workspace', c.ws);
    assert.equal(failedRender.env.errors[0].code, 'selection-not-found');
    const failedBuild = await run('build', '--workspace', c.ws, '--allow-missing');
    assert.equal(failedBuild.env.errors[0].code, 'stale-timeline');

    await fsp.rm(selections);
    assert.equal((await run('render', '--workspace', c.ws)).code, 0);
    assert.equal((await run('build', '--workspace', c.ws)).code, 0);
  } finally { await cleanup(c.dir); }
});

test('verify：checker/video/verify.py を python -I で呼ぶ引数。0 は ok、3 は out-of-tolerance（result に全体）、1 は verify-failed、時間の上限', T, async () => {
  const c = await setupRendered('verify');
  try {
    const log = path.join(c.dir, 'vlog.json');
    const base = { NARRATE_VERIFY_SCRIPT: path.join(c.dir, 'verify.py'), FAKE_LOG: log };
    await fsp.writeFile(path.join(c.ws, 'out', 'video.mp4'), 'x');
    let r = await withEnv(base, () => run('verify', '--workspace', c.ws));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.env.result.pass, true);
    const rec = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(rec.isolated, 1, 'python -I');
    assert.deepEqual(rec.argv.filter((_, i) => i % 2 === 0), ['--video', '--timeline', '--method']);
    assert.equal(path.resolve(rec.argv[1]), path.join(c.ws, 'out', 'video.mp4'));
    assert.equal(path.resolve(rec.argv[3]), path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(rec.argv[5], 'B');
    // 方式は build-report.json から（A なら A）
    await fsp.writeFile(path.join(c.ws, 'out', 'build-report.json'), JSON.stringify({ method: 'A-linked' }));
    await withEnv(base, () => run('verify', '--workspace', c.ws));
    assert.equal(JSON.parse(readFileSync(log, 'utf8')).argv[5], 'A');
    await withEnv(base, () => run('verify', '--workspace', c.ws, '--method', 'b', '--tolerance-audio-ms', '25'));
    const a3 = JSON.parse(readFileSync(log, 'utf8')).argv;
    assert.equal(a3[5], 'B');
    assert.deepEqual(a3.slice(6), ['--tolerance-audio-ms', '25']);
    // 許容値の外
    r = await withEnv({ ...base, FAKE_MODE: 'fail' }, () => run('verify', '--workspace', c.ws));
    assert.equal(r.code, 3);
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'out-of-tolerance');
    assert.deepEqual(r.env.errors[0].detail.slides, ['s2']);
    assert.equal(r.env.result.slides.length, 2);
    // 読めない
    r = await withEnv({ ...base, FAKE_MODE: 'error' }, () => run('verify', '--workspace', c.ws));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'verify-failed');
    // 上限
    const completed = path.join(c.dir, 'verify-completed.txt');
    r = await withEnv({ ...base, FAKE_SLEEP: '30', FAKE_COMPLETED: completed }, () => run('verify', '--workspace', c.ws, '--timeout-sec', '2'));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'verify-timeout');
    // Windows process startup/termination can be delayed under suite load.
    // Check that the verifier was stopped before finishing its work instead.
    assert.equal(existsSync(completed), false);
    // 使い方・ファイルがない
    assert.equal((await run('verify')).code, 2);
    assert.equal((await run('verify', '--workspace', c.ws, '--method', 'Q')).code, 2);
    r = await run('verify', '--video', path.join(c.dir, 'nothere.mp4'), '--timeline', path.join(c.ws, 'out', 'timeline.json'));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
  } finally { await cleanup(c.dir); }
});

