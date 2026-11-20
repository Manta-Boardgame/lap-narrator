import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoudnessMeter } from '../../core/loudness.js';

const RATE = 48000;

test('BS.1770 calibration, silence, and independent-of-chunk observations', () => {
  const tone = Int16Array.from({ length: RATE * 2 }, (_, i) => Math.round(32767 * Math.sin(i * 2 * Math.PI * 997 / RATE)));
  const whole = createLoudnessMeter(RATE);
  whole.push(tone);
  assert.ok(Math.abs(whole.integratedLufs() - (-3.01)) < 0.02, whole.integratedLufs());

  const chunked = createLoudnessMeter(RATE);
  assert.equal(chunked.integratedLufs(), -Infinity);
  assert.equal(chunked.truePeakDb(), -Infinity);
  for (let i = 0; i < tone.length; i += 97) {
    chunked.push(tone.subarray(i, i + 97));
    if (i === 0) assert.equal(chunked.integratedLufs(), -Infinity);
    chunked.truePeakDb();
  }
  assert.equal(chunked.integratedLufs(), whole.integratedLufs());
  assert.equal(chunked.truePeakDb(), whole.truePeakDb());

  const gated = createLoudnessMeter(RATE);
  gated.push(new Int16Array(RATE * 2));
  assert.equal(gated.integratedLufs(), -Infinity);
  gated.push(tone);
  assert.ok(Math.abs(gated.integratedLufs() - whole.integratedLufs()) < 0.5);
  assert.throws(() => createLoudnessMeter(44100), RangeError);
});

test('true peak detects the inter-sample peak of a quarter-rate tone', () => {
  const tone = Int16Array.from({ length: RATE }, (_, i) => Math.round(20000 * Math.sin(Math.PI * i / 2 + Math.PI / 4)));
  const meter = createLoudnessMeter(RATE);
  meter.push(tone);
  const peak = meter.truePeakDb();
  assert.ok(peak > 20 * Math.log10(14143 / 32768) + 2.7, peak);
});
