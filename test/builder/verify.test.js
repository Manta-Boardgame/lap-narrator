// verify.py must FIND deliberately wrong videos (design 11.2 T5) and say "unmeasurable" when it cannot tell.
// No PowerPoint needed.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, py, lastJson, makeSynth, readJson } from './helpers/env.js';

const BUILD = join(ROOT, 'builder', 'build_b.py');
const VERIFY = join(ROOT, 'checker', 'video', 'verify.py');

function build(timeline, out, extra = []) {
  const r = py([BUILD, '--timeline', timeline, '--out', out, ...extra]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return join(out, 'video.mp4');
}
function verify(video, timeline, extra = []) {
  const r = py([VERIFY, '--video', video, '--timeline', timeline, '--method', 'B', ...extra]);
  return { status: r.status, result: lastJson(r.stdout) };
}

describe('verify finds wrong videos', { timeout: 300000 }, () => {
  let synth;
  let tl;

  before(() => {
    synth = makeSynth('verify-main');
    tl = join(synth, 'timeline.json');
  });

  test('audio 100 ms late: every slide is out-of-tolerance by about +100 ms, exit code 3', () => {
    const video = build(tl, join(synth, 'late100'), ['--debug-audio-shift-ms', '100']);
    const { status, result } = verify(video, tl);
    assert.equal(status, 3);
    assert.equal(result.pass, false);
    for (const s of result.slides) {
      assert.equal(s.status, 'out-of-tolerance', JSON.stringify(s));
      assert.equal(s.detail.audio, 'out-of-tolerance');
      assert.equal(s.detail.show, 'ok');
      assert.ok(s.diffMs.audio > 99 && s.diffMs.audio < 101, 'measured ' + s.diffMs.audio);
    }
  });

  test('audio 100 ms early is found too (negative difference)', () => {
    const video = build(tl, join(synth, 'early100'), ['--debug-audio-shift-ms', '-100']);
    // slide 1 would start before 0 + 300 ms - 100 ms = 200 ms: still after the start of the video
    const { status, result } = verify(video, tl);
    assert.equal(status, 3);
    for (const s of result.slides) {
      assert.ok(s.diffMs.audio < -99 && s.diffMs.audio > -101, 'measured ' + s.diffMs.audio);
    }
  });

  test('a 20 ms shift sits at the edge: 25 ms late fails, 10 ms late passes (limit is not loosened)', () => {
    const late25 = verify(build(tl, join(synth, 'late25'), ['--debug-audio-shift-ms', '25']), tl);
    assert.equal(late25.status, 3);
    assert.ok(late25.result.slides.every((s) => s.detail.audio === 'out-of-tolerance'));
    const late10 = verify(build(tl, join(synth, 'late10'), ['--debug-audio-shift-ms', '10']), tl);
    assert.equal(late10.status, 0);
    assert.ok(late10.result.slides.every((s) => s.detail.audio === 'ok'));
  });

  test('pictures 3 frames (100 ms) late: slides 2 and 3 are out-of-tolerance, audio still ok', () => {
    const video = build(tl, join(synth, 'vshift'), ['--debug-video-shift-frames', '3']);
    const { status, result } = verify(video, tl);
    assert.equal(status, 3);
    const [s1, s2, s3] = result.slides;
    assert.equal(s1.status, 'ok');
    for (const s of [s2, s3]) {
      assert.equal(s.detail.show, 'out-of-tolerance', JSON.stringify(s));
      assert.ok(s.diffMs.show > 80, 'measured ' + s.diffMs.show);
      assert.equal(s.detail.audio, 'ok');
    }
  });

  test('identical neighbouring pictures: that boundary is "unmeasurable", the others are still measured', () => {
    const dir = makeSynth('verify-samecolour', ['--same-colour']);
    const t2 = join(dir, 'timeline.json');
    const video = build(t2, join(dir, 'out'));
    const { status, result } = verify(video, t2);
    const [s1, s2, s3] = result.slides;
    assert.equal(s1.status, 'ok');
    assert.equal(s2.status, 'unmeasurable', JSON.stringify(s2));
    assert.equal(s2.measured.showStartMs, null);
    assert.equal(s2.diffMs.show, null);
    assert.deepEqual(s2.reasons, ['same-picture-as-previous-slide']);
    assert.equal(s2.detail.audio, 'ok'); // its audio is still measured
    assert.equal(s3.status, 'ok', JSON.stringify(s3));
    assert.equal(status, 0); // unmeasurable is not a failure
    assert.equal(result.allMeasured, false);
    assert.equal(result.counts.unmeasurable, 1);
  });

  test('a WAV whose sound is not in the video cannot be located: audio "unmeasurable" (low-correlation), reason given', () => {
    const dir = makeSynth('verify-noise');
    // replace slide 2's WAV with white noise (same length, 44-byte header)
    const tlj = readJson(join(dir, 'timeline.json'));
    const n = tlj.slides[1].audioSamples;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(96000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      buf.writeInt16LE(((seed >>> 16) % 20000) - 10000, 44 + i * 2);
    }
    writeFileSync(join(dir, 'final', 's257.wav'), buf);
    // the video is built from the tone fixture, verified against the noise timeline
    const video = build(join(synth, 'timeline.json'), join(dir, 'out-from-tone'));
    const { result } = verify(video, join(dir, 'timeline.json'));
    const s2 = result.slides[1];
    assert.equal(s2.status, 'unmeasurable', JSON.stringify(s2));
    assert.equal(s2.measured.audioStartMs, null);
    // since D-003 a non-tone WAV is located by cross-correlation; here the video holds a tone, not this noise
    assert.equal(s2.audioMethod, 'xcorr');
    assert.ok(s2.reasons.includes('low-correlation'), JSON.stringify(s2.reasons));
    assert.ok(s2.corr < 0.5, 'corr ' + s2.corr);
    assert.equal(result.slides[0].status, 'ok');
    assert.equal(result.slides[2].status, 'ok');
  });

  test('a video without any audio stream: audio is "missing" (out-of-tolerance), not unmeasurable', () => {
    const video = build(tl, join(synth, 'noaudio-src'));
    const stripped = join(synth, 'noaudio.mp4');
    const r = py([join(ROOT, 'test', 'builder', 'helpers', 'strip_audio.py'), video, stripped]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { status, result } = verify(stripped, tl);
    assert.equal(status, 3);
    assert.equal(result.audio.present, false);
    for (const s of result.slides) {
      assert.equal(s.detail.audio, 'missing');
      assert.equal(s.status, 'out-of-tolerance');
      assert.equal(s.measured.audioStartMs, null);
    }
  });

  test('an unreadable video is an error: exit 1 and a JSON error, nothing invented', () => {
    const bogus = join(synth, 'not-a-video.mp4');
    writeFileSync(bogus, 'this is not an mp4');
    const r = py([VERIFY, '--video', bogus, '--timeline', tl]);
    assert.equal(r.status, 1);
    assert.equal(lastJson(r.stdout).error.code, 'verify-failed');
  });
});
