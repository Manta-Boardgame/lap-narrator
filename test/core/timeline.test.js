import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameOf, buildTimeline } from '../../core/timeline.js';
import { validate } from '../../core/validate.js';
import { sampleScript } from './helpers/samples.js';

// 独立した検算：有理数の厳密な計算（BigInt）で floor(sample*fps/rate + 1/2) を求める
function refFrame(sample, fps, rate) {
  const num = 2n * BigInt(sample) * BigInt(fps) + BigInt(rate);
  return Number(num / (2n * BigInt(rate)));
}

test('frameOf：半分は切り上げ（方式 B）', () => {
  // 48000 Hz、30 fps：1 フレーム = 1600 サンプル
  assert.equal(frameOf(0, 30, 48000), 0);
  assert.equal(frameOf(799, 30, 48000), 0);
  assert.equal(frameOf(800, 30, 48000), 1); // ちょうど半分 → 切り上げ
  assert.equal(frameOf(1600, 30, 48000), 1);
  assert.equal(frameOf(2399, 30, 48000), 1);
  assert.equal(frameOf(2400, 30, 48000), 2);
  assert.equal(frameOf(161856, 30, 48000), 101); // 161856/1600 = 101.16
});

test('frameOf：奇数の周波数でも厳密（rate / 2 を切り捨てない）', () => {
  // rate = 11025、fps = 1：半分は 5512.5 サンプル。5512 は 0 フレーム、5513 は 1 フレーム
  assert.equal(frameOf(5512, 1, 11025), 0);
  assert.equal(frameOf(5513, 1, 11025), 1);
  // 44100 Hz、30 fps
  assert.equal(frameOf(735, 30, 44100), 1); // 735 * 30 / 44100 = 0.5
  assert.equal(frameOf(734, 30, 44100), 0);
});

test('frameOf：ランダムな入力が、BigInt の厳密な計算と一致（大きな値を含む）', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const rates = [8000, 11025, 16000, 22050, 44100, 48000, 96000, 12345];
  const fpss = [1, 24, 25, 30, 50, 60, 120];
  for (let i = 0; i < 20000; i++) {
    const rate = rates[rnd(rates.length)];
    const fps = fpss[rnd(fpss.length)];
    const sample = i % 3 === 0 ? rnd(1000) : i % 3 === 1 ? rnd(2 ** 30) * 1000 + rnd(1000) : 48000 * 3600 * 100 + rnd(2 ** 30);
    assert.equal(frameOf(sample, fps, rate), refFrame(sample, fps, rate), `${sample} ${fps} ${rate}`);
  }
  // 丸めの境界（半分ちょうど）の前後を、全部の周波数・fps で
  for (const rate of rates) for (const fps of fpss) for (let k = 0; k < 50; k++) {
    for (const d of [-1, 0, 1]) {
      const sample = Math.max(0, Math.floor((k * rate) / fps + rate / (2 * fps)) + d);
      assert.equal(frameOf(sample, fps, rate), refFrame(sample, fps, rate));
    }
  }
});

test('frameOf：不正な引数は RangeError', () => {
  assert.throws(() => frameOf(-1, 30, 48000), RangeError);
  assert.throws(() => frameOf(1.5, 30, 48000), RangeError);
  assert.throws(() => frameOf(1, 0, 48000), RangeError);
  assert.throws(() => frameOf(1, 30, 0), RangeError);
  assert.throws(() => frameOf(2 ** 52, 30, 48000), RangeError);
});

const finalFor = (slideId, samples, files) => ({
  slideId, takeId: 't0001', samples, sampleRate: 48000,
  parts: files.map((file, i) => ({ file, samples: i === 0 ? samples - (files.length - 1) * 10 : 10, sha256: 'a'.repeat(64) })),
});

test('buildTimeline：設計書 1.10 の例の数値（audioSamples 123456 → 14400 / 137856 / 161856）', () => {
  const script = sampleScript();
  const t = buildTimeline({ script, finals: [finalFor('s256', 123456, ['final/s256.wav'])] });
  assert.deepEqual(t.slides, [{
    slideId: 's256', order: 1, image: 'slides/0001.png', audio: 'final/s256.wav', audioSamples: 123456,
    showStart: 0, audioStart: 14400, audioEnd: 137856, showEnd: 161856,
  }]);
  assert.equal(t.totalSamples, 161856);
  assert.equal(t.sampleRate, 48000);
  assert.equal(t.fps, 30);
  assert.equal(t.prePadSamples, 14400);
  assert.equal(t.postPadSamples, 24000);
  assert.deepEqual(validate('timeline', t), { ok: true, errors: [] });
});

test('buildTimeline：録音の対象で音声があるスライドだけ。showStart[i+1] = showEnd[i]。分割した音声は配列', () => {
  const script = sampleScript(); // s256 (rec), s257 (補足: recordable false), s258 (rec)
  const finals = [
    finalFor('s258', 1000, ['final/s258.p001.wav', 'final/s258.p002.wav']),
    finalFor('s257', 500, ['final/s257.wav']), // recordable:false → 入らない
    finalFor('s256', 2000, ['final/s256.wav']),
  ];
  const t = buildTimeline({ script, finals });
  assert.deepEqual(t.slides.map((s) => s.slideId), ['s256', 's258']);
  assert.equal(t.slides[0].showStart, 0);
  assert.equal(t.slides[1].showStart, t.slides[0].showEnd);
  assert.deepEqual(t.slides[1].audio, ['final/s258.p001.wav', 'final/s258.p002.wav']);
  assert.equal(t.slides[1].audioSamples, 1000);
  assert.equal(t.totalSamples, t.slides[1].showEnd);
  assert.equal(t.slides[1].showEnd, 14400 + 2000 + 24000 + 14400 + 1000 + 24000);
  assert.deepEqual(validate('timeline', t), { ok: true, errors: [] });
});

test('buildTimeline：音声のないスライド、samples が 0、台本に無い slideId は入れない。空でもよい', () => {
  const script = sampleScript();
  let t = buildTimeline({ script, finals: [finalFor('s256', 100, ['final/s256.wav']), { slideId: 'zzz', samples: 5, parts: [{ file: 'f', samples: 5 }] }, { slideId: 's258', samples: 0, parts: [] }] });
  assert.deepEqual(t.slides.map((s) => s.slideId), ['s256']);
  t = buildTimeline({ script, finals: [] });
  assert.deepEqual(t.slides, []);
  assert.equal(t.totalSamples, 0);
  assert.deepEqual(validate('timeline', t), { ok: true, errors: [] });
});

test('buildTimeline：台本の order の順（finals の順によらない）、パディングと fps の指定', () => {
  const script = sampleScript();
  const t = buildTimeline({
    script, fps: 25, prePadSamples: 100, postPadSamples: 200, sampleRate: 48000,
    finals: [finalFor('s258', 10, ['b.wav']), finalFor('s256', 20, ['a.wav'])],
  });
  assert.deepEqual(t.slides.map((s) => [s.slideId, s.showStart, s.audioStart, s.audioEnd, s.showEnd]), [['s256', 0, 100, 120, 320], ['s258', 320, 420, 430, 630]]);
  assert.equal(t.fps, 25);
  assert.equal(t.totalSamples, 630);
});

test('buildTimeline：同じ入力から同じ出力。重複した完成版と周波数の食い違いはエラー', () => {
  const script = sampleScript();
  const finals = [finalFor('s256', 100, ['a.wav'])];
  assert.equal(JSON.stringify(buildTimeline({ script, finals })), JSON.stringify(buildTimeline({ script, finals })));
  assert.throws(() => buildTimeline({ script, finals: [finals[0], finals[0]] }), TypeError);
  assert.throws(() => buildTimeline({ script, finals: [{ ...finals[0], sampleRate: 44100 }], sampleRate: 48000 }), RangeError);
  assert.throws(() => buildTimeline({ script: null, finals: [] }), TypeError);
  assert.throws(() => buildTimeline({ script, finals: [], fps: 0 }), RangeError);
});

test('buildTimeline：周波数は finals から決まる（44.1kHz）', () => {
  const script = sampleScript();
  const t = buildTimeline({ script, finals: [{ slideId: 's256', samples: 441, sampleRate: 44100, parts: [{ file: 'a.wav', samples: 441 }] }] });
  assert.equal(t.sampleRate, 44100);
  assert.equal(t.slides[0].audioSamples, 441);
});
