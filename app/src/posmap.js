// 通しの位置（pos）と、録音ファイルの中の位置（raw, sample）の対応。
// CONTRACTS.md 1.4：pos = それより前の録音ファイルの samples の合計 + sample。表示と再生のためだけに使う。

/** @param {{name:string, samples:number}[]} rawFiles 番号順 */
export function totalSamples(rawFiles) {
  let n = 0;
  for (const r of rawFiles) n += r.samples;
  return n;
}

/** 通しの位置から、録音ファイルの中の位置へ。ちょうど境目のときは前のファイルの終わりを返す。 */
export function posToRaw(rawFiles, pos) {
  let base = 0;
  for (const r of rawFiles) {
    if (pos <= base + r.samples) return { raw: r.name, sample: pos - base };
    base += r.samples;
  }
  return null;
}

/** 通しの位置の範囲 [start, end) を、録音ファイルごとの範囲に分ける。 */
export function splitPosRange(rawFiles, start, end) {
  const out = [];
  let base = 0;
  for (const r of rawFiles) {
    const lo = Math.max(start, base);
    const hi = Math.min(end, base + r.samples);
    if (hi > lo) out.push({ raw: r.name, start: lo - base, end: hi - base });
    base += r.samples;
  }
  return out;
}

/** 録音ファイルの先頭の通しの位置。 */
export function baseOf(rawFiles, name) {
  let base = 0;
  for (const r of rawFiles) {
    if (r.name === name) return base;
    base += r.samples;
  }
  return null;
}
