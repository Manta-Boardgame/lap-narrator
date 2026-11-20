// 予定表 timeline.json（CONTRACTS.md 1.10）。整数の演算だけ。実行環境に依存しない。
import { DEFAULT_SAMPLE_RATE, DEFAULT_FPS, DEFAULT_PRE_PAD_SAMPLES, DEFAULT_POST_PAD_SAMPLES } from './constants.js';

/** a >= 0, b > 0 の整数。floor(a / b) を正確に求める（浮動小数点の割り算の丸めで 1 ずれないよう補正する） */
function floorDiv(a, b) {
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (r < 0) q -= 1; else if (r >= b) q += 1;
  return q;
}

/**
 * サンプルの位置をフレームに丸める（方式 B）：`floor((sample * fps + rate / 2) / rate)`、半分は切り上げ。整数の演算。
 * 奇数の `rate` でも正確（分子と分母を 2 倍して計算する）。
 * @param {number} sample 0 以上の整数
 * @param {number} fps 正の整数
 * @param {number} rate 正の整数（サンプリング周波数）
 * @returns {number}
 */
export function frameOf(sample, fps, rate) {
  if (!Number.isInteger(sample) || sample < 0) throw new RangeError(`frameOf: bad sample ${sample}`);
  if (!Number.isInteger(fps) || fps < 1) throw new RangeError(`frameOf: bad fps ${fps}`);
  if (!Number.isInteger(rate) || rate < 1) throw new RangeError(`frameOf: bad rate ${rate}`);
  const num = 2 * sample * fps + rate;
  if (!Number.isSafeInteger(num)) throw new RangeError('frameOf: sample is too large');
  return floorDiv(num, 2 * rate);
}

/**
 * 予定表を作る。録音の対象（`recordable: true`）で、完成した音声（`samples` が 1 以上）があるスライドだけが入る。順番は台本の `order`。
 * 各スライドの `showStart[i+1] = showEnd[i]`、`audioStart = showStart + prePadSamples`、`audioEnd = audioStart + audioSamples`、
 * `showEnd = audioEnd + postPadSamples`（1.10）。
 *
 * `finals` は完成版の manifest の `finals[]` の形：`{slideId, samples, sampleRate?, parts:[{file, samples}]}`。
 * 音声のパスは `parts` が 1 つなら文字列、複数なら配列（順序付き）。`parts` が無いときは `audio`（文字列または配列）を使う。
 * 同じ `slideId` の完成版が複数あれば TypeError。台本に無い `slideId` の完成版は無視する。
 * 周波数は `args.sampleRate`、無ければ完成版の `sampleRate`、それも無ければ 48000。完成版の周波数が違えば RangeError。
 *
 * @param {{script:any, finals:any[], sampleRate?:number, fps?:number, prePadSamples?:number, postPadSamples?:number}} args
 * @returns {any} timeline.json（schema/timeline）
 */
export function buildTimeline(args) {
  const { script, finals } = args || {};
  if (!script || !Array.isArray(script.slides)) throw new TypeError('buildTimeline: script.slides is required');
  if (!Array.isArray(finals)) throw new TypeError('buildTimeline: finals must be an array');
  const fps = args.fps === undefined ? DEFAULT_FPS : args.fps;
  const pre = args.prePadSamples === undefined ? DEFAULT_PRE_PAD_SAMPLES : args.prePadSamples;
  const post = args.postPadSamples === undefined ? DEFAULT_POST_PAD_SAMPLES : args.postPadSamples;
  let sampleRate = args.sampleRate;
  if (sampleRate === undefined) {
    const f = finals.find((x) => x && Number.isInteger(x.sampleRate));
    sampleRate = f ? f.sampleRate : DEFAULT_SAMPLE_RATE;
  }
  for (const [name, v, min] of [['fps', fps, 1], ['prePadSamples', pre, 0], ['postPadSamples', post, 0], ['sampleRate', sampleRate, 1]]) {
    if (!Number.isInteger(v) || v < min) throw new RangeError(`buildTimeline: bad ${name} ${v}`);
  }
  const bySlide = new Map();
  for (const f of finals) {
    if (!f || typeof f.slideId !== 'string') continue;
    if (bySlide.has(f.slideId)) throw new TypeError(`buildTimeline: more than one final for slide ${f.slideId}`);
    if (Number.isInteger(f.sampleRate) && f.sampleRate !== sampleRate) throw new RangeError(`buildTimeline: slide ${f.slideId} is ${f.sampleRate} Hz, expected ${sampleRate} Hz`);
    bySlide.set(f.slideId, f);
  }
  const ordered = script.slides.map((s, i) => ({ s, i })).sort((a, b) => (a.s.order - b.s.order) || (a.i - b.i)).map((x) => x.s);
  const slides = [];
  let cursor = 0;
  for (const s of ordered) {
    if (!s || s.recordable !== true) continue;
    const f = bySlide.get(s.slideId);
    if (!f) continue;
    const parts = Array.isArray(f.parts) ? f.parts : null;
    const audioSamples = Number.isInteger(f.samples) ? f.samples : (parts ? parts.reduce((a, p) => a + p.samples, 0) : 0);
    if (!(audioSamples >= 1)) continue; // 音声のないスライドは予定表に入れない
    let audio;
    if (parts && parts.length) {
      const files = parts.map((p) => p.file);
      audio = files.length === 1 ? files[0] : files;
    } else {
      audio = f.audio;
    }
    if (audio === undefined) throw new TypeError(`buildTimeline: slide ${s.slideId} has no audio file`);
    const showStart = cursor;
    const audioStart = showStart + pre;
    const audioEnd = audioStart + audioSamples;
    const showEnd = audioEnd + post;
    slides.push({ slideId: s.slideId, order: s.order, image: s.image, audio, audioSamples, showStart, audioStart, audioEnd, showEnd });
    cursor = showEnd;
  }
  return {
    format: 'lap-narrator/timeline',
    version: 1,
    sampleRate,
    fps,
    prePadSamples: pre,
    postPadSamples: post,
    slides,
    totalSamples: cursor,
  };
}
