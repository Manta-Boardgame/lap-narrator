// スライドごとの確認音（連番の合図）。スライド n：n 回の短いピッ（1000 Hz、80 ms、間 80 ms）のあと、
// 周波数 400 + 80 n Hz の音を 400 ms。固有の周波数なので、録音から n を読み取れる（Goertzel 法）。
const fadeEnv = (i, n, f) => Math.min(1, i / f, (n - 1 - i) / f);

/** @returns {Int16Array} */
export function slideCue(n, sampleRate = 48000, amp = 12000) {
  const pip = Math.round(sampleRate * 0.08);
  const gap = Math.round(sampleRate * 0.08);
  const tone = Math.round(sampleRate * 0.4);
  const total = n * (pip + gap) + tone;
  const out = new Int16Array(total);
  const f = Math.round(sampleRate * 0.005);
  let o = 0;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < pip; i++) out[o + i] = Math.round(amp * fadeEnv(i, pip, f) * Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
    o += pip + gap;
  }
  const freq = cueFrequency(n);
  for (let i = 0; i < tone; i++) out[o + i] = Math.round(amp * fadeEnv(i, tone, f) * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  return out;
}

export const cueFrequency = (n) => 400 + 80 * n;

/** 特定の周波数の強さ（Goertzel 法）。 */
export function goertzelPower(pcm, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s0 = pcm[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (pcm.length * pcm.length);
}

/** 確認音の後半（長い音）から n を読み取る。候補は 1..maxN。 */
export function detectCue(pcm, sampleRate = 48000, maxN = 200) {
  const tone = Math.round(sampleRate * 0.4);
  const tail = pcm.subarray(Math.max(0, pcm.length - tone));
  let best = 0;
  let bestP = -1;
  for (let n = 1; n <= maxN; n++) {
    const p = goertzelPower(tail, cueFrequency(n), sampleRate);
    if (p > bestP) {
      bestP = p;
      best = n;
    }
  }
  return best;
}
