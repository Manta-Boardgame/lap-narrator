// Method B (PyAV) and verify on the 3-slide synthetic fixture. No PowerPoint needed.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, py, lastJson, makeSynth, readJson, freshDir } from './helpers/env.js';

// independent of the Python code: frame(sample) = floor((sample*fps + rate/2) / rate) with integers
const frameOf = (sample, fps, rate) => Math.floor((2 * sample * fps + rate) / (2 * rate));

describe('method B: build_b.py + verify.py', { timeout: 300000 }, () => {
  let synth;
  let timeline;
  let out;
  let report;
  let result;
  let verifyExit;

  before(() => {
    synth = makeSynth('b-main');
    timeline = readJson(join(synth, 'timeline.json'));
    out = join(synth, 'out');
    const b = py([join(ROOT, 'builder', 'build_b.py'), '--timeline', join(synth, 'timeline.json'), '--out', out]);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    report = lastJson(b.stdout);
    const v = py([join(ROOT, 'checker', 'video', 'verify.py'), '--video', join(out, 'video.mp4'),
      '--timeline', join(synth, 'timeline.json'), '--method', 'B']);
    verifyExit = v.status;
    result = lastJson(v.stdout);
  });

  test('frame rounding formula is exact and never accumulates error', () => {
    const r = py([join(ROOT, 'test', 'builder', 'helpers', 'frame_check.py'), join(ROOT, 'builder', 'build_b.py')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastJson(r.stdout).ok, true);
  });

  test('build-report.json has the CONTRACTS fields', () => {
    const file = readJson(join(out, 'build-report.json'));
    assert.equal(file.method, 'B');
    for (const k of ['elapsedMs', 'fps', 'width', 'height', 'notes']) assert.ok(k in file, k);
    assert.equal(file.fps, 30);
    assert.equal(file.width, 1920);
    assert.equal(file.height, 1080);
    assert.ok(Array.isArray(file.notes));
    assert.deepEqual(report.slideStartFrames, file.slideStartFrames);
  });

  test('slide boundaries are the rounded cumulative sample positions', () => {
    for (const s of timeline.slides) {
      assert.equal(report.slideStartFrames[s.slideId], frameOf(s.showStart, timeline.fps, timeline.sampleRate), s.slideId);
    }
    assert.equal(report.frames, frameOf(timeline.totalSamples, timeline.fps, timeline.sampleRate));
  });

  test('MP4 is 1080p, 30 fps constant, H.264 yuv420p, AAC 48 kHz', () => {
    const r = py([join(ROOT, 'test', 'builder', 'helpers', 'probe.py'), join(out, 'video.mp4')]);
    assert.equal(r.status, 0, r.stderr);
    const p = lastJson(r.stdout);
    assert.equal(p.video.codec, 'h264');
    assert.equal(p.video.pixFmt, 'yuv420p');
    assert.equal(p.video.width, 1920);
    assert.equal(p.video.height, 1080);
    assert.equal(p.video.fps, 30);
    assert.equal(p.video.constantFrameInterval, true);
    assert.equal(p.video.startMs, 0);
    assert.equal(p.audio.codec, 'aac');
    assert.equal(p.audio.sampleRate, 48000);
    assert.equal(p.audio.startMs, 0);
  });

  test('verify reports every slide within the method B tolerances (audio 20 ms, picture 1 frame)', () => {
    assert.equal(verifyExit, 0, JSON.stringify(result.slides));
    assert.equal(result.method, 'B');
    assert.equal(result.toleranceMs.audio, 20);
    assert.ok(Math.abs(result.toleranceMs.show - 1000 / 30) < 0.01);
    assert.equal(result.slides.length, 3);
    for (const [i, s] of result.slides.entries()) {
      const t = timeline.slides[i];
      assert.equal(s.slideId, t.slideId);
      assert.deepEqual(s.expected, { showStart: t.showStart, audioStart: t.audioStart });
      assert.equal(s.status, 'ok', JSON.stringify(s));
      assert.ok(Math.abs(s.diffMs.audio) <= 20, 'audio ' + s.diffMs.audio);
      assert.ok(Math.abs(s.diffMs.show) <= 1000 / 30, 'show ' + s.diffMs.show);
      // sample-accurate audio: far better than the 20 ms limit
      assert.ok(Math.abs(s.diffMs.audio) < 1, 'audio ' + s.diffMs.audio);
      // the picture lands on the rounded frame
      const wantMs = (frameOf(t.showStart, 30, 48000) * 1000) / 30;
      assert.ok(Math.abs(s.measured.showStartMs - wantMs) < 0.5, `${s.measured.showStartMs} vs ${wantMs}`);
    }
    assert.equal(result.pass, true);
    assert.deepEqual(result.counts, { ok: 3, outOfTolerance: 0, unmeasurable: 0 });
    assert.ok(Math.abs(result.expectedTotalMs - (timeline.totalSamples * 1000) / 48000) < 0.01);
    assert.ok(Math.abs(result.totalDiffMs) <= 2 * (1000 / 30));
    assert.equal(result.audio.present, true);
    assert.deepEqual(result.audio.gaps, []);
  });

  test('build_b refuses a WAV whose length differs from the timeline (exit 1, error code)', () => {
    const dir = makeSynth('b-badlen');
    const tl = readJson(join(dir, 'timeline.json'));
    tl.slides[0].audioSamples += 1;
    tl.slides[0].audioEnd += 1;
    tl.slides[0].showEnd += 1;
    // keep the chain consistent so that only the WAV length is wrong
    for (let i = 1; i < tl.slides.length; i++) {
      for (const k of ['showStart', 'audioStart', 'audioEnd', 'showEnd']) tl.slides[i][k] += 1;
    }
    tl.totalSamples += 1;
    writeJsonFile(join(dir, 'tl-bad.json'), tl);
    const r = py([join(ROOT, 'builder', 'build_b.py'), '--timeline', join(dir, 'tl-bad.json'), '--out', join(dir, 'o')]);
    assert.equal(r.status, 1);
    const j = lastJson(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.errors[0].code, 'audio-length-mismatch');
  });

  test('build_b: a missing picture is an error (exit 1, error code), not a crash', () => {
    const dir = makeSynth('b-noimage');
    const tl = readJson(join(dir, 'timeline.json'));
    tl.slides[1].image = 'slides/missing.png';
    writeJsonFile(join(dir, 'tl-noimage.json'), tl);
    const r = py([join(ROOT, 'builder', 'build_b.py'), '--timeline', join(dir, 'tl-noimage.json'), '--out', join(dir, 'o')]);
    assert.equal(r.status, 1);
    assert.equal(lastJson(r.stdout).errors[0].code, 'bad-image');
    assert.ok(!existsSync(join(dir, 'o', 'build-report.json')));
  });

  test('build_b output is deterministic in timing: building twice gives the same frame boundaries', () => {
    const dir = freshDir('b-twice');
    const a = py([join(ROOT, 'builder', 'build_b.py'), '--timeline', join(synth, 'timeline.json'), '--out', join(dir, 'a')]);
    const b = py([join(ROOT, 'builder', 'build_b.py'), '--timeline', join(synth, 'timeline.json'), '--out', join(dir, 'b')]);
    assert.deepEqual(lastJson(a.stdout).slideStartFrames, lastJson(b.stdout).slideStartFrames);
  });
});

function writeJsonFile(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
