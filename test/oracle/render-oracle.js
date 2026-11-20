// 完成した音声（完成 PCM）の、正解を出す別実装。
//
// dev/CONTRACTS.md 1.8「完成 PCM の定義」の、第 1 波の範囲だけ：
//   採用の区間（編集を適用後）を order の順に、結合部ごとに fadeSamples のフェードで連結する。
//   ただし連続した結合部（同じ録音ファイルで 前の終わり == 次の始まり）にはフェードをかけない（CONTRACTS.md 1.8、7.2 の 5）。
//   周波数の変換なし、gain 0 dB、リミッターなし（DECISIONS.md の第 1 波の renderSpec）。
// 丸めは round-half-even、16 ビットに飽和。実行時に三角関数を呼ばない（係数は fade-tables.js の整数の表）。
// core/ は読まない、呼ばない。曖昧な点の自分の読み方は dev/proposals/E-002.md に書いてある。
import { FADE_TABLES } from './fade-tables.js';

/** x / 65536 を round-half-even で整数にする。x は整数（絶対値は 2^31 まで）。 */
export function roundHalfEvenQ16(x) {
  const q = Math.floor(x / 65536); // 切り下げ（負の数でも切り下げ）
  const r = x - q * 65536; // 0 .. 65535
  let v;
  if (r < 32768) v = q;
  else if (r > 32768) v = q + 1;
  else v = q % 2 === 0 ? q : q + 1;
  return v === 0 ? 0 : v; // -0 を 0 にする
}

/** 16 ビットに飽和する */
export function saturate16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** サンプル（整数）× 係数（Q16 の整数）→ round-half-even → 飽和 */
export function mulQ16(sample, coef) {
  return saturate16(roundHalfEvenQ16(sample * coef));
}

/**
 * 1 つのテイクの完成 PCM。
 * @param {{segments:{raw:string,start:number,end:number}[], pcmOf:(raw:string)=>Int16Array, fadeSamples?:number, rateOf?:(raw:string)=>number}} args
 *   segments は採用の区間を order の順に並べたもの。pcmOf は録音ファイルの PCM を返す。
 *   録音ファイルの長さを超える区間は、ファイルの終わりで切る。
 * @returns {Int16Array}
 */
export function oracleRenderTake({ segments, pcmOf, fadeSamples = 384, rateOf }) {
  if (fadeSamples !== 0 && !FADE_TABLES[fadeSamples]) throw new Error(`unsupported-fade-length: ${fadeSamples}`);
  const table = fadeSamples === 0 ? [] : FADE_TABLES[fadeSamples];
  // 各区間を録音ファイルの長さで切り、切ったあとに空になる区間は取り除く（CONTRACTS.md 7.7 の 6）。
  // 連続かどうかは、切ったあとの値で判断する。
  const clamped = [];
  for (const s of segments) {
    if (rateOf && rateOf(s.raw) !== 48000) throw new Error(`unsupported-rate: ${rateOf(s.raw)}`);
    const len = pcmOf(s.raw).length;
    const start = Math.min(s.start, len);
    const end = Math.min(s.end, len);
    if (end > start) clamped.push({ raw: s.raw, start, end });
  }
  segments = clamped;
  const parts = segments.map((s) => Int16Array.from(pcmOf(s.raw).subarray(s.start, s.end)));
  const n = parts.length;
  // 結合部 j（j-1 と j の間）が連続か
  const continuous = (j) => segments[j - 1].raw === segments[j].raw && segments[j - 1].end === segments[j].start;
  for (let j = 0; j < n; j++) {
    const part = parts[j];
    const m = Math.min(fadeSamples, part.length);
    if (j > 0 && !continuous(j)) {
      // 前の結合部：次の区間の始まり（フェードイン）。結合部に近い端が T[0]
      for (let k = 0; k < m; k++) part[k] = mulQ16(part[k], table[k]);
    }
    if (j < n - 1 && !continuous(j + 1)) {
      // 次の結合部：前の区間の終わり（フェードアウト）。結合部に近い端（最後のサンプル）が T[0]
      for (let k = 0; k < m; k++) {
        const idx = part.length - 1 - k;
        part[idx] = mulQ16(part[idx], table[k]);
      }
    }
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Int16Array → リトルエンディアンのバイト列（環境の並びによらない） */
export function pcmToBytes(pcm) {
  const b = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] & 0xffff;
    b[i * 2] = v & 0xff;
    b[i * 2 + 1] = v >> 8;
  }
  return b;
}
