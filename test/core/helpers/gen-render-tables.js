// core/render/tables.js を作る開発用スクリプト。Math.cos と Math.pow は、ここ（生成のとき）でだけ使い、結果を直書きする。
// 実行時の core/render.js は三角関数も pow も使わない（CONTRACTS.md 1.8、7.2）。
// 使い方：node test/core/helpers/gen-render-tables.js
// 値の検算は test/core/render.test.js が Python（別の実装）で行う。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** CONTRACTS.md 7.2 の 2：対応するフェードの長さ */
export const FADE_LENGTHS = [1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 480];

/** round-half-even（正の数） */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function generate() {
  const fades = {};
  for (const n of FADE_LENGTHS) {
    const t = [];
    for (let i = 0; i < n; i++) t.push(roundHalfEven((65536 * (1 - Math.cos((Math.PI * (i + 0.5)) / n))) / 2));
    fades[n] = t;
  }
  const gain = [];
  for (let i = 0; i <= 840; i++) {
    const db = (i - 600) / 10; // -60.0 .. +24.0 を 0.1 dB 刻み
    gain.push(roundHalfEven((2 ** 20) * Math.pow(10, db / 20)));
  }
  const lines = (arr, per) => {
    let s = '';
    for (let i = 0; i < arr.length; i += per) s += '  ' + arr.slice(i, i + per).join(', ') + ',\n';
    return s;
  };
  let fadeText = '';
  for (const n of FADE_LENGTHS) fadeText += `  ${n}: Object.freeze([\n${lines(fades[n], 16)}  ]),\n`;
  return `// 生成物：node test/core/helpers/gen-render-tables.js で作る（手で書き換えない）。CONTRACTS.md 1.8、7.2。
// 実行時に三角関数と pow を呼ばないため、係数は表として持つ。検算は test/core/render.test.js。

/** 対応するフェードの長さ（7.2 の 2）。これ以外は unsupported-fade-length */
export const FADE_LENGTHS = Object.freeze([${FADE_LENGTHS.join(', ')}]);

/**
 * フェードの係数の表。FADE_Q16[N][i] = round_half_even(65536 * (1 - cos(pi * (i + 0.5) / N)) / 2)、i = 0..N-1。
 * 65536 が 1.0。i = 0 が、結合部に最も近いサンプルの係数。
 */
export const FADE_Q16 = Object.freeze({
${fadeText}});

/**
 * 音量の倍率 10^(dB/20) の表。dB = -60.0 .. +24.0（0.1 dB 刻み、841 個）、2^20 を 1 とする固定小数、round-half-even。
 * 添字は (dB * 10) + 600。
 */
export const GAIN_Q20 = Object.freeze([
${lines(gain, 8)}]);

export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 24;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(join(root, 'core', 'render', 'tables.js'), generate());
  console.log('wrote core/render/tables.js');
}
