// 種を固定した乱数。浮動小数点は四則演算だけを使う（環境で結果が変わらないように）。
import { createHash } from 'node:crypto';

/** @param {string|number} seed */
export function makeRng(seed) {
  let s;
  if (typeof seed === 'number') {
    s = seed >>> 0;
  } else {
    s = createHash('sha256').update(String(seed), 'utf8').digest().readUInt32LE(0);
  }
  if (s === 0) s = 0x9e3779b9;
  // mulberry32
  function nextU32() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  return {
    nextU32,
    /** [0, 1) */
    float() {
      return nextU32() / 4294967296;
    },
    /** [lo, hi) の整数 */
    int(lo, hi) {
      return lo + (nextU32() % (hi - lo));
    },
    /** 平均 0、標準偏差 1 に近い値（一様乱数 12 個の和 - 6。四則演算だけ） */
    gauss() {
      let a = 0;
      for (let i = 0; i < 12; i++) a += nextU32() / 4294967296;
      return a - 6;
    },
  };
}
