// 解析の関数の試験（実機は要らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClock, analyzeWrite, trailingZeroRun, linfit } from './helpers/analyze.js';

const RATE = 48000;
/** 理想の取得：2048 サンプルずつ届く。clockScale で時計の速さをずらす。stallAtSec で、その位置から stallSec 止める。 */
function synth({ sec = 60, clockScale = 1, stallAtSec = null, stallSec = 0, dropAtSec = null, dropSamples = 0 }) {
  const out = [];
  let drop = 0;
  for (let t = 0; t <= sec * 1000; t += 500) {
    let cap = (t / 1000) * RATE * clockScale;
    if (stallAtSec !== null && t / 1000 >= stallAtSec) cap -= Math.min(stallSec, t / 1000 - stallAtSec) * RATE;
    if (dropAtSec !== null && t / 1000 >= dropAtSec) drop = dropSamples;
    cap -= drop;
    out.push({ t: 1000 + t, captured: Math.floor(cap / 2048) * 2048 });
  }
  return out;
}

test('linfit', () => {
  const f = linfit([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.ok(Math.abs(f.slope - 2) < 1e-12 && Math.abs(f.intercept - 1) < 1e-12);
});

test('理想の取得は、ずれが 0 に近く、欠落がない', () => {
  const r = analyzeClock(synth({}), RATE);
  assert.ok(r.ok);
  assert.ok(Math.abs(r.driftPpm) < 600, `drift ${r.driftPpm}`);
  assert.equal(r.jumps, 0);
  assert.ok(r.residualMs.max < 60);
});

test('時計が 0.1% 速いと、約 +1000 ppm', () => {
  const r = analyzeClock(synth({ clockScale: 1.001 }), RATE);
  assert.ok(Math.abs(r.driftPpm - 1000) < 300, `drift ${r.driftPpm}`);
  assert.equal(r.jumps, 0);
});

test('瞬間的な欠落（500 ミリ秒分）は、残差の飛びとして見つかる', () => {
  const r = analyzeClock(synth({ dropAtSec: 30, dropSamples: 24000 }), RATE);
  assert.ok(r.jumps >= 1, `jumps ${r.jumps}`);
  assert.ok(r.maxJumpMs > 300);
});

test('取得が止まった時間を数える', () => {
  const s = synth({ stallAtSec: 20, stallSec: 100 }); // 20 秒から先は進まない
  const r = analyzeClock(s, RATE);
  assert.ok(r.stalls >= 1 && r.maxStallMs >= 400);
});

test('標本が少なければ、理由を返す', () => {
  assert.equal(analyzeClock([{ t: 0, captured: 0 }], RATE).ok, false);
});

test('analyzeWrite と trailingZeroRun', () => {
  const w = analyzeWrite([{ captured: 100, written: 90 }, { captured: 200, written: 150 }, { captured: 300, written: 300 }]);
  assert.equal(w.finalLag, 0);
  assert.equal(w.maxLag, 50);
  assert.equal(trailingZeroRun(Int16Array.from([1, 2, 0, 0, 0])), 3);
  assert.equal(trailingZeroRun(Int16Array.from([0, 0, 5])), 0);
});
