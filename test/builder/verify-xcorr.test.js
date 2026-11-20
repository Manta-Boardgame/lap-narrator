// verify.py locates speech-like audio by cross-correlation with the slide's own WAV (audioMethod "xcorr").
// No PowerPoint needed. Videos are made with method B, on purpose shifted by --debug-audio-shift-ms.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT, py, lastJson, makeSynth, readJson } from './helpers/env.js';
import { run } from '../cli/helpers/cli.js';

const BUILD = join(ROOT, 'builder', 'build_b.py');
const VERIFY = join(ROOT, 'checker', 'video', 'verify.py');
const HELPERS = join(ROOT, 'test', 'builder', 'helpers');

function build(timeline, out, extra = []) {
  const r = py([BUILD, '--timeline', timeline, '--out', out, ...extra]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return join(out, 'video.mp4');
}
function verify(video, timeline, method = 'B') {
  const r = py([VERIFY, '--video', video, '--timeline', timeline, '--method', method]);
  return { status: r.status, result: lastJson(r.stdout) };
}

describe('verify: audio position by cross-correlation (speech-like WAVs)', { timeout: 300000 }, () => {
  let speech;
  let tl;

  before(() => {
    speech = makeSynth('xcorr-speech', ['--speech']);
    tl = join(speech, 'timeline.json');
  });

  for (const shift of [0, 40, -80]) {
    test(`audio shifted by ${shift} ms is measured as ${shift} ms (within 1 ms), method xcorr, corr high`, () => {
      const video = build(tl, join(speech, 'shift' + shift), ['--debug-audio-shift-ms', String(shift)]);
      const { status, result } = verify(video, tl);
      for (const s of result.slides) {
        assert.equal(s.audioMethod, 'xcorr', JSON.stringify(s));
        assert.ok(s.corr > 0.9, 'corr ' + s.corr);
        assert.ok(Math.abs(s.diffMs.audio - shift) < 1.0, `measured ${s.diffMs.audio} for shift ${shift}`);
        assert.equal(s.detail.audio, Math.abs(shift) > 20 ? 'out-of-tolerance' : 'ok');
      }
      assert.equal(status, Math.abs(shift) > 20 ? 3 : 0);
      assert.equal(result.allMeasured, true);
    });
  }

  test('a 44.1 kHz stereo AAC track (like PowerPoint writes) is measured the same way: 0 ms and +40 ms', () => {
    for (const shift of [0, 40]) {
      const src = build(tl, join(speech, 'r441-' + shift), ['--debug-audio-shift-ms', String(shift)]);
      const out = join(speech, `r441-${shift}.mp4`);
      const r = py([join(HELPERS, 'resample_audio.py'), src, out, '44100']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const { result } = verify(out, tl);
      assert.equal(result.audio.sampleRate, 44100);
      assert.equal(result.audio.channels, 2);
      for (const s of result.slides) {
        assert.equal(s.audioMethod, 'xcorr');
        assert.ok(Math.abs(s.diffMs.audio - shift) < 1.5, `measured ${s.diffMs.audio} for shift ${shift}`);
      }
    }
  });

  test('a digitally silent WAV cannot be located: audio "unmeasurable", reason too-quiet, others measured', () => {
    const dir = makeSynth('xcorr-silent', ['--speech', '--silent-slide', '2']);
    const t2 = join(dir, 'timeline.json');
    const video = build(t2, join(dir, 'out'));
    const { status, result } = verify(video, t2);
    const [s1, s2, s3] = result.slides;
    assert.equal(s2.status, 'unmeasurable', JSON.stringify(s2));
    assert.equal(s2.detail.audio, 'unmeasurable');
    assert.equal(s2.measured.audioStartMs, null);
    assert.equal(s2.diffMs.audio, null);
    assert.deepEqual(s2.reasons, ['too-quiet']);
    assert.equal(s2.audioMethod, 'xcorr');
    assert.equal(s1.status, 'ok');
    assert.equal(s3.status, 'ok');
    assert.equal(status, 0); // unmeasurable is not a failure
    assert.equal(result.allMeasured, false);
    assert.equal(result.counts.unmeasurable, 1);
    assert.equal(result.pass, true);
  });

  test('audio that is not in the video (other speech under the same timeline): "unmeasurable", low-correlation, no invented position', () => {
    const other = makeSynth('xcorr-other', ['--speech']);
    // overwrite slide 2 of the timeline folder with different speech: same length, other seed is not
    // available, so use the tone fixture video instead (its audio is a tone, not this speech)
    const tone = makeSynth('xcorr-tonevideo');
    const video = build(join(tone, 'timeline.json'), join(tone, 'out'));
    const { result } = verify(video, join(other, 'timeline.json'));
    for (const s of result.slides) {
      assert.equal(s.status, 'unmeasurable', JSON.stringify(s));
      assert.equal(s.measured.audioStartMs, null);
      assert.deepEqual(s.reasons, ['low-correlation']);
      assert.ok(s.corr < 0.5, 'corr ' + s.corr);
    }
  });

  test('a loud WAV whose window in the video is digital silence is "missing" (out-of-tolerance)', () => {
    const dir = makeSynth('xcorr-missing', ['--speech', '--silent-slide', '2']);
    const t2 = join(dir, 'timeline.json');
    // video built from the silent-slide-2 timeline; verify against the speech timeline of the same shape
    const video = build(t2, join(dir, 'out'));
    const full = makeSynth('xcorr-missing-ref', ['--speech']);
    const { status, result } = verify(video, join(full, 'timeline.json'));
    const s2 = result.slides[1];
    assert.equal(s2.detail.audio, 'missing', JSON.stringify(s2));
    assert.equal(s2.status, 'out-of-tolerance');
    assert.deepEqual(s2.reasons, ['audio-not-found-in-video']);
    assert.equal(status, 3);
  });

  test('clean tones are still measured with the cue method (audioMethod "cue", corr null)', () => {
    const dir = makeSynth('xcorr-tones');
    const t2 = join(dir, 'timeline.json');
    const { result } = verify(build(t2, join(dir, 'out')), t2);
    for (const s of result.slides) {
      assert.equal(s.audioMethod, 'cue');
      assert.equal(s.corr, null);
      assert.equal(s.detail.audio, 'ok');
    }
  });

  test('long audio (3 slides of 60 s, 3 minutes): onset is still within 1 ms', () => {
    const dir = makeSynth('xcorr-long', ['--speech', '--slide-seconds', '60']);
    const t2 = join(dir, 'timeline.json');
    const video = build(t2, join(dir, 'out'), ['--debug-audio-shift-ms', '25']);
    const { result } = verify(video, t2);
    for (const s of result.slides) {
      assert.equal(s.audioMethod, 'xcorr');
      assert.ok(Math.abs(s.diffMs.audio - 25) < 1.0, `measured ${s.diffMs.audio}`);
    }
    assert.ok(result.audio.durationMs > 180000);
  });

  test('a missing or muted audible tail fails even when the onset and picture still match', async () => {
    const dir = makeSynth('xcorr-tail', ['--speech', '--slide-seconds', '8']);
    const timeline = join(dir, 'timeline.json');
    const split = readJson(timeline);
    const { slides, sampleRate } = split;
    const last = slides.at(-1);
    const raw = readFileSync(join(dir, last.audio));
    const speechSamples = 6 * sampleRate;
    const splitByte = 44 + speechSamples * 2;
    const head = Buffer.from(raw.subarray(0, splitByte));
    const tail = Buffer.concat([raw.subarray(0, 44), raw.subarray(splitByte)]);
    const tailWav = 'final/tail.wav';
    for (const [name, data] of [[last.audio, head], [tailWav, tail]]) {
      data.writeUInt32LE(data.length - 8, 4);
      data.writeUInt32LE(data.length - 44, 40);
      writeFileSync(join(dir, name), data);
    }
    last.audio = [last.audio, tailWav];
    writeFileSync(timeline, JSON.stringify(split));
    const video = build(timeline, join(dir, 'out'));
    assert.equal(verify(video, timeline).status, 0);
    const cut = last.audioStart / sampleRate + 6.5;
    for (const [mode, reason] of [['truncate-at', 'audio-tail-truncated'], ['mute-after', 'audio-tail-silent']]) {
      const out = join(dir, `${mode}.mp4`);
      const r = py([join(HELPERS, 'resample_audio.py'), video, out, '48000', `--${mode}`, String(cut)]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const report = join(dir, `${mode}.json`);
      const v = await run('verify', '--video', out, '--timeline', timeline, '--allow-unmeasurable', '--report', report);
      assert.equal(v.code, 3, v.stdout);
      assert.equal(v.env.errors[0].code, 'out-of-tolerance');
      assert.equal(v.env.result.passMeasuredOnly, false);
      assert.deepEqual(readJson(report), v.env.result);
      const slide = v.env.result.slides.at(-1);
      assert.equal(slide.detail.show, 'ok');
      assert.equal(slide.detail.audio, 'missing');
      assert.ok(Number.isFinite(slide.diffMs.audio) && Math.abs(slide.diffMs.audio) < 1, JSON.stringify(slide));
      assert.deepEqual(slide.reasons, [reason]);
    }

    // A genuine silent ending can be omitted, including silence stored in a separate WAV part.
    tail.fill(0, 44);
    writeFileSync(join(dir, tailWav), tail);
    const withSilence = build(timeline, join(dir, 'split'));
    const noSilence = join(dir, 'truncated-source-silence.mp4');
    const r = py([join(HELPERS, 'resample_audio.py'), withSilence, noSilence, '48000', '--truncate-at', String(last.audioStart / sampleRate + 6.05)]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(verify(noSilence, timeline).status, 0);
  });
});
