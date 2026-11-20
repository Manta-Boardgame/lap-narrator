// PowerPoint (COM) tests: export-slides.ps1 and method A (build-a.ps1).
// Only owner D runs PowerPoint (dev/RULES.md 2.7). These tests:
//   * are skipped (not failed) when PowerPoint is missing or ALREADY RUNNING - a running PowerPoint may hold
//     the user's documents, so nothing is touched;
//   * run strictly one after the other (one PowerPoint job at a time);
//   * only ever use decks made under work/D/test/ by make-pptx.mjs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  ROOT, WORK, py, ps, lastJson, makeSynth, makeDeck, readJson, freshDir, pngSize,
  powerPointSkipReason, powerPointRunning,
} from './helpers/env.js';

const skip = powerPointSkipReason();
const testStart = new Date();
const measurements = {};

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HELPERS = join(ROOT, 'test', 'builder', 'helpers');

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(200);
  }
  return false;
}
async function waitNoPowerPoint(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!powerPointRunning()) return true;
    await sleep(700);
  }
  return false;
}

/** Quits a PowerPoint that is still alive after an abnormal end - only one that started during this test run
 *  AND has no presentation open (so it cannot be the user's). */
function cleanupLeftover() {
  if (process.platform !== 'win32') return 'n/a';
  const since = testStart.toISOString();
  const cmd = `
$since = [DateTime]::Parse('${since}').ToLocalTime()
$procs = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since })
if ($procs.Count -eq 0) { 'none'; return }
$app = $null
try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
$docs = -1
if ($app) { try { $docs = [int]$app.Presentations.Count + [int]$app.ProtectedViewWindows.Count } catch { } }
if ($docs -eq 0) {
  try { $app.Quit() } catch { }
  Start-Sleep -Seconds 3
  Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since } | Stop-Process -Force -ErrorAction SilentlyContinue
  'quit leftover'
} else { 'left alone (documents open or unknown)' }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout ?? '').trim();
}

function tryLast(stdout) {
  try { return lastJson(stdout); } catch { return null; }
}

function runBuildA({ deck, timeline, out, mode = 'both', grid = 0, timeoutSec = 120 }) {
  const args = ['-Pptx', deck, '-Timeline', timeline, '-OutDir', out, '-Mode', mode,
    '-TimeoutSec', String(timeoutSec), '-KeepWork'];
  if (grid) args.push('-GridMs', String(grid));
  const r = ps('builder/build-a.ps1', args, { timeout: 420000 });
  return { status: r.status, json: tryLast(r.stdout), raw: r };
}

function inspect(pptx) {
  const r = py([join(HELPERS, 'pptx_inspect.py'), pptx]);
  assert.equal(r.status, 0, r.stderr);
  return lastJson(r.stdout);
}

describe('PowerPoint COM: export-slides.ps1 and method A (build-a.ps1)', { skip: skip || false, timeout: 1500000 }, () => {
  before(() => {
    assert.equal(powerPointRunning(), false);
  });
  after(() => {
    const leftover = cleanupLeftover();
    measurements.leftoverCleanup = leftover;
    writeFileSync(join(WORK, 'measurements-powerpoint.json'), JSON.stringify(measurements, null, 2) + '\n');
    console.log('PowerPoint leftover check: ' + leftover);
  });

  let exportDir; // slides exported from the simple deck

  test('export-slides: pictures 1920x1080, SlideID, notes (Japanese kept, LF), hidden flag; PowerPoint is gone afterwards', () => {
    const deck = makeDeck('ppt-export', 'simple');
    const before = sha256(deck);
    exportDir = join(WORK, 'ppt-export', 'out');
    const t0 = Date.now();
    const r = ps('builder/export-slides.ps1', ['-Pptx', deck, '-OutDir', exportDir, '-TimeoutSec', '120'], { timeout: 180000 });
    measurements.exportSlidesMs = Date.now() - t0;
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = lastJson(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.slides, 3);
    for (const n of ['0001', '0002', '0003']) {
      assert.deepEqual(pngSize(join(exportDir, 'slides', n + '.png')), { width: 1920, height: 1080 }, n);
    }
    const doc = readJson(join(exportDir, 'slides.json'));
    assert.equal(doc.format, 'lap-narrator/slides-export');
    assert.deepEqual(doc.slides.map((s) => s.slideId), [256, 257, 258]);
    assert.deepEqual(doc.slides.map((s) => s.index), [1, 2, 3]);
    assert.deepEqual(doc.slides.map((s) => s.image), ['slides/0001.png', 'slides/0002.png', 'slides/0003.png']);
    assert.deepEqual(doc.slides.map((s) => s.hidden), [false, false, false]);
    assert.equal(doc.slides[0].notes, 'First slide narration. 一枚目の原稿です。');
    assert.equal(doc.slides[1].notes, 'Second slide.\n二行目のノート。');
    assert.equal(doc.slides[2].notes, '');
    assert.equal(sha256(deck), before, 'the deck must not change');
    // the file itself has no BOM and uses LF
    const raw = readFileSync(join(exportDir, 'slides.json'));
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(!raw.includes('\r'));
  });

  test('export-slides: a hidden slide is flagged and still exported; notes of every slide are read', async () => {
    const deck = makeDeck('ppt-export-mixed', 'mixed');
    const out = join(WORK, 'ppt-export-mixed', 'out');
    const r = ps('builder/export-slides.ps1', ['-Pptx', deck, '-OutDir', out, '-TimeoutSec', '120'], { timeout: 180000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = readJson(join(out, 'slides.json'));
    assert.deepEqual(doc.slides.map((s) => s.hidden), [false, false, false, false, true]);
    assert.deepEqual(doc.slides.map((s) => s.slideId), [256, 257, 258, 259, 260]);
    assert.equal(doc.slides[4].notes, 'Hidden in the source deck.');
    assert.equal(doc.slides.every((s) => s.mediaShapes === 0 && s.clickEffects === 0), true);
    assert.ok(existsSync(join(out, 'slides', '0005.png')));
    assert.ok(await waitNoPowerPoint(), 'PowerPoint must be closed again');
  });

  test('method B from PowerPoint-exported PNGs: verify passes the method B tolerances', () => {
    const dir = makeSynth('ppt-b-from-export');
    cpSync(join(exportDir, 'slides'), join(dir, 'slides'), { recursive: true });
    const tl = join(dir, 'timeline.json');
    const b = py([join(ROOT, 'builder', 'build_b.py'), '--timeline', tl, '--out', join(dir, 'out')]);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const v = py([join(ROOT, 'checker', 'video', 'verify.py'), '--video', join(dir, 'out', 'video.mp4'), '--timeline', tl, '--method', 'B']);
    const res = lastJson(v.stdout);
    assert.equal(v.status, 0, JSON.stringify(res.slides));
    assert.deepEqual(res.counts, { ok: 3, outOfTolerance: 0, unmeasurable: 0 });
  });

  test('method A (literal times): linked and embedded versions, audio decoded from both MP4s, deck untouched', async () => {
    const synth = makeSynth('ppt-a-literal');
    const tlPath = join(synth, 'timeline.json');
    const tl = readJson(tlPath);
    const deck = makeDeck('ppt-a-literal-deck', 'simple');
    const before = sha256(deck);
    const out = join(WORK, 'ppt-a-literal-out');
    freshDir('ppt-a-literal-out');
    const t0 = Date.now();
    const r = runBuildA({ deck, timeline: tlPath, out });
    measurements.methodA_literal_wallMs = Date.now() - t0;
    assert.equal(r.status, 0, r.raw.stdout + r.raw.stderr);
    const rep = readJson(join(out, 'build-report.json'));
    for (const k of ['method', 'elapsedMs', 'fps', 'width', 'height', 'notes']) assert.ok(k in rep, k);
    assert.equal(rep.method, 'A-linked');
    assert.equal(rep.width, 1920);
    assert.equal(rep.height, 1080);
    assert.ok(rep.fps > 29.5 && rep.fps < 31, 'fps ' + rep.fps);
    assert.equal(rep.variants.length, 2);
    assert.deepEqual(rep.variants.map((v) => v.method), ['A-linked', 'A-embedded']);
    assert.equal(sha256(deck), before, 'the original deck must not change');
    assert.ok(existsSync(join(out, 'video.mp4')));

    for (const v of rep.variants) {
      assert.equal(v.audioInVideo, true, v.method + ' audio must be in the MP4');
      assert.equal(v.width, 1920);
      assert.equal(v.height, 1080);
      // independent decode of the MP4 (do not trust the report)
      const file = join(out, v.video);
      const ver = py([join(ROOT, 'checker', 'video', 'verify.py'), '--video', file, '--timeline', tlPath, '--method', 'A']);
      const res = lastJson(ver.stdout);
      assert.equal(res.audio.present, true);
      assert.equal(res.slides.length, 3);
      for (const s of res.slides) {
        assert.notEqual(s.measured.audioStartMs, null, v.method + ' ' + s.slideId + ' audio not found');
        assert.notEqual(s.measured.showStartMs, null, v.method + ' ' + s.slideId + ' picture not found');
      }
      // the speaker icon is hidden: the corner where it would sit is plain background
      const reg = py([join(HELPERS, 'region_std.py'), file, '1.0', '20', '20', '120', '120']);
      assert.ok(lastJson(reg.stdout).std < 1, v.method + ' icon visible: ' + reg.stdout);
      measurements['methodA_literal_' + v.method] = {
        elapsedMs: v.elapsedMs, createVideoMs: v.createVideoMs, audioInVideo: v.audioInVideo, verifyPass: res.pass,
        diffMs: res.slides.map((s) => s.diffMs), totalDiffMs: res.totalDiffMs, fps: v.fps,
        audioSampleRate: res.audio.sampleRate, audioChannels: res.audio.channels,
      };
    }

    // the two versions really differ in how the audio is stored
    const linked = inspect(join(out, '_work', 'deck-linked.pptx'));
    const embedded = inspect(join(out, '_work', 'deck-embedded.pptx'));
    assert.deepEqual(linked.embeddedWavs, []);
    for (const [i, s] of tl.slides.entries()) {
      const sl = linked.slides[i + 1];
      assert.deepEqual(sl.audioRelExternal, [true, true].slice(0, sl.audioRelCount), 'linked slide ' + (i + 1));
      assert.ok(sl.audioTargets.every((t) => t.endsWith(s.slideId + '.wav')), JSON.stringify(sl.audioTargets));
    }
    assert.equal(embedded.embeddedWavs.length, 3);
    for (const i of [1, 2, 3]) assert.equal(embedded.slides[i].audioRelExternal.includes(true), false);

    // times written into the deck: AdvanceTime = showEnd-showStart, delay = audioStart-showStart, icon hidden
    for (const [i, s] of tl.slides.entries()) {
      const wantAdv = Math.round(((s.showEnd - s.showStart) * 1000) / tl.sampleRate);
      for (const deckInfo of [linked, embedded]) {
        const sl = deckInfo.slides[i + 1];
        assert.ok(sl.advTm.every((a) => Math.abs(Number(a) - wantAdv) <= 1), `advTm ${sl.advTm} vs ${wantAdv}`);
        assert.deepEqual(sl.advClick, ['0', '0']);
        assert.deepEqual(sl.delays, ['300']);
        assert.equal(sl.hideDuringShow, true);
        assert.equal(sl.hidden, false);
      }
    }
    assert.ok(await waitNoPowerPoint(), 'PowerPoint must be closed again');
  });

  test('method A with -GridMs 33: every boundary within the 50 ms target (reported, not assumed)', () => {
    const synth = makeSynth('ppt-a-grid');
    const tlPath = join(synth, 'timeline.json');
    const deck = makeDeck('ppt-a-grid-deck', 'simple');
    const out = join(WORK, 'ppt-a-grid-out');
    freshDir('ppt-a-grid-out');
    const r = runBuildA({ deck, timeline: tlPath, out, grid: 33 });
    assert.equal(r.status, 0, r.raw.stdout + r.raw.stderr);
    const rep = readJson(join(out, 'build-report.json'));
    for (const v of rep.variants) {
      assert.equal(v.gridMs, 33);
      assert.equal(v.audioInVideo, true);
      const ver = py([join(ROOT, 'checker', 'video', 'verify.py'), '--video', join(out, v.video), '--timeline', tlPath, '--method', 'A']);
      const res = lastJson(ver.stdout);
      for (const s of res.slides) {
        assert.ok(Math.abs(s.diffMs.show) <= 50, `${v.method} show ${s.diffMs.show}`);
        assert.ok(Math.abs(s.diffMs.audio) <= 50, `${v.method} audio ${s.diffMs.audio}`);
      }
      assert.equal(res.pass, true);
      measurements['methodA_grid33_' + v.method] = {
        elapsedMs: v.elapsedMs, diffMs: res.slides.map((s) => s.diffMs), totalDiffMs: res.totalDiffMs,
      };
    }
  });

  test('slides that are not in the timeline are hidden (deck with 5 slides, timeline with 3)', async () => {
    const synth = makeSynth('ppt-a-mixed', ['--ids', 's256,s258,s259']);
    const tlPath = join(synth, 'timeline.json');
    const deck = makeDeck('ppt-a-mixed-deck', 'mixed');
    const out = join(WORK, 'ppt-a-mixed-out');
    freshDir('ppt-a-mixed-out');
    const r = runBuildA({ deck, timeline: tlPath, out, mode: 'linked' });
    assert.equal(r.status, 0, r.raw.stdout + r.raw.stderr);
    const rep = readJson(join(out, 'build-report.json'));
    const v = rep.variants[0];
    assert.equal(v.audioInVideo, true);
    // the three pictures (red, green, blue) were found in this order; a visible yellow or grey slide would
    // have added at least its own duration to the video
    const ver = py([join(ROOT, 'checker', 'video', 'verify.py'), '--video', join(out, v.video), '--timeline', tlPath, '--method', 'A']);
    const res = lastJson(ver.stdout);
    const shows = res.slides.map((s) => s.measured.showStartMs);
    assert.ok(shows.every((x) => x !== null), JSON.stringify(shows));
    assert.ok(shows[0] < shows[1] && shows[1] < shows[2]);
    assert.ok(Math.abs(res.totalDiffMs) < 150, 'total ' + res.totalDiffMs);
    // the saved copy marks slide 2 (excluded, visible in the source) and slide 5 (hidden in the source) as hidden
    const dk = inspect(join(out, '_work', 'deck-linked.pptx'));
    assert.deepEqual([1, 2, 3, 4, 5].map((i) => dk.slides[i].hidden), [false, true, false, false, true]);
    measurements.methodA_mixed = { diffMs: res.slides.map((s) => s.diffMs), totalDiffMs: res.totalDiffMs };
    assert.ok(await waitNoPowerPoint());
  });

  test('animations that wait for a click are reported as "unset"; no timing is invented', async () => {
    const synth = makeSynth('ppt-a-click');
    const tlPath = join(synth, 'timeline.json');
    const deck = makeDeck('ppt-a-click-deck', 'simple');
    const add = ps('test/builder/helpers/add-click-effect.ps1', ['-Pptx', deck, '-SlideIndex', '2'], { timeout: 120000 });
    assert.equal(add.status, 0, add.stdout + add.stderr);
    const out = join(WORK, 'ppt-a-click-out');
    freshDir('ppt-a-click-out');
    const r = runBuildA({ deck, timeline: tlPath, out, mode: 'linked' });
    assert.equal(r.status, 0, r.raw.stdout + r.raw.stderr);
    const rep = readJson(join(out, 'build-report.json'));
    assert.deepEqual(rep.unsetClickAnimations, [{ slideId: 's257', clickEffects: 1 }]);
    assert.ok(rep.notes.some((n) => n.startsWith('unset:') && n.includes('s257')), JSON.stringify(rep.notes));
    assert.ok(await waitNoPowerPoint());
  });

  test('errors: unknown slide id (exit 1, error code, PowerPoint closed again)', async () => {
    const synth = makeSynth('ppt-a-bad');
    const tlPath = join(synth, 'timeline.json');
    const tl = readJson(tlPath);
    tl.slides[1].slideId = 's999';
    writeFileSync(tlPath, JSON.stringify(tl));
    const deck = makeDeck('ppt-a-bad-deck', 'simple');
    const r = runBuildA({ deck, timeline: tlPath, out: join(WORK, 'ppt-a-bad-out'), mode: 'linked' });
    assert.equal(r.status, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.errors[0].code, 'slide-not-found');
    assert.ok(await waitNoPowerPoint(), 'PowerPoint must be closed again after an error');
  });

  test('errors found before PowerPoint starts: missing audio file, split audio (exit 1, nothing started)', () => {
    const synth = makeSynth('ppt-a-bad2');
    const tlPath = join(synth, 'timeline.json');
    const deck = makeDeck('ppt-a-bad2-deck', 'simple');
    const tl = readJson(tlPath);
    tl.slides[0].audio = 'final/nope.wav';
    writeFileSync(join(synth, 'tl-missing.json'), JSON.stringify(tl));
    let r = runBuildA({ deck, timeline: join(synth, 'tl-missing.json'), out: join(WORK, 'ppt-a-bad2-out') });
    assert.equal(r.status, 1);
    assert.equal(r.json.errors[0].code, 'audio-not-found');
    const tl2 = readJson(tlPath);
    tl2.slides[0].audio = ['final/s256.wav'];
    writeFileSync(join(synth, 'tl-split.json'), JSON.stringify(tl2));
    r = runBuildA({ deck, timeline: join(synth, 'tl-split.json'), out: join(WORK, 'ppt-a-bad2-out') });
    assert.equal(r.status, 1);
    assert.equal(r.json.errors[0].code, 'multi-part-audio');
    assert.equal(powerPointRunning(), false);
  });

  test('safety: PowerPoint that already has a document open is never touched (exit 10), its document stays open', async () => {
    const dir = freshDir('ppt-busy');
    const deck = makeDeck('ppt-busy-deck', 'simple');
    const synth = makeSynth('ppt-busy-synth');
    const signal = join(dir, 'release.flag');
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(HELPERS, 'hold-open.ps1'), '-Pptx', deck, '-SignalFile', signal, '-MaxSec', '150'], { windowsHide: true });
    let out = '';
    holder.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((res) => holder.on('exit', res));
    try {
      assert.ok(await waitFor(() => out.includes('READY'), 90000), 'holder did not get PowerPoint ready: ' + out);
      const e = ps('builder/export-slides.ps1', ['-Pptx', deck, '-OutDir', join(dir, 'x')], { timeout: 120000 });
      assert.equal(e.status, 10, e.stdout + e.stderr);
      const ej = lastJson(e.stdout);
      assert.equal(ej.errors[0].code, 'powerpoint-busy');
      assert.equal(ej.errors[0].detail.presentations, 1);
      const b = runBuildA({ deck, timeline: join(synth, 'timeline.json'), out: join(dir, 'y'), mode: 'linked' });
      assert.equal(b.status, 10, b.raw.stdout + b.raw.stderr);
      assert.equal(b.json.errors[0].code, 'powerpoint-busy');
      assert.ok(!existsSync(join(dir, 'y', 'video.mp4')));
    } finally {
      writeFileSync(signal, 'release');
      await Promise.race([exited, sleep(60000)]);
      if (holder.exitCode === null) holder.kill();
    }
    const state = lastJson(out);
    assert.equal(state.presentationsAtEnd, 1, 'the "user" document must still be open');
    assert.equal(state.nameUnchanged, true);
    assert.equal(state.slidesAtEnd, 3);
    assert.ok(await waitNoPowerPoint(), 'holder must have closed its PowerPoint');
  });
});
