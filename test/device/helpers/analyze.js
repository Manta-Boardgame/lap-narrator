// 実機の録音の測定値の解析（担当 F）。純粋な計算だけ（実機がなくても試験できる）。
//
// 入力：標本 {t, captured, written, ...}。t は、ページの performance.now()（ミリ秒）、captured は、取得側（AudioWorklet）が
// 渡した、その録音の開始からのサンプル数、written は、保存の Worker が書き込んだサンプル数。
//
// 「時計のゆるやかなずれ」と「瞬間的な欠落」を分ける：
//   - ずれ（ppm）：captured / 周波数 を、t に対して直線で当てはめたときの傾きと 1 の差。
//   - 欠落：(1) Worker が数えた、フレーム番号の不連続（gaps）。(2) 直線からの残差が大きく飛ぶ点（取得側が黙って落とした疑い）。
//           (3) 録音が終わったあとの captured と written の差（取得したのに書けなかった分）。
//           (4) 取得が進まない時間（止まり）の長さ。

export function linfit(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: NaN, intercept: NaN, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const slope = sxx === 0 ? NaN : sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);

/**
 * @param {{t:number, captured:number}[]} samples 同じ録音（arm）の標本。t の昇順
 * @param {number} rate 周波数
 * @param {{trimHeadMs?:number, stallMs?:number, jumpMs?:number}} [o]
 */
export function analyzeClock(samples, rate, { trimHeadMs = 1500, stallMs = 400, jumpMs = 120 } = {}) {
  const pts = samples.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.captured));
  if (pts.length < 3) return { ok: false, reason: 'too-few-samples', n: pts.length };
  const t0 = pts[0].t;
  const used = pts.filter((s) => s.t - t0 >= trimHeadMs && s.captured > 0);
  if (used.length < 3) return { ok: false, reason: 'too-few-samples-after-trim', n: used.length };
  const xs = used.map((s) => (s.t - t0) / 1000);
  const ys = used.map((s) => s.captured / rate);
  const fit = linfit(xs, ys);
  const resMs = ys.map((y, i) => (y - (fit.intercept + fit.slope * xs[i])) * 1000);
  const absSorted = resMs.map(Math.abs).sort((a, b) => a - b);
  // 止まり：取得が進まないまま経った時間（標本の間隔が長いだけの場合を除くため、前後の標本の captured が同じものだけ数える）
  let maxStallMs = 0;
  let stalls = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].captured === pts[i - 1].captured && pts[i - 1].captured > 0) {
      const d = pts[i].t - pts[i - 1].t;
      if (d >= stallMs) stalls++;
      if (d > maxStallMs) maxStallMs = d;
    }
  }
  // 残差の飛び：隣り合う標本の残差の差が jumpMs を超える所
  let jumps = 0;
  let maxJumpMs = 0;
  for (let i = 1; i < resMs.length; i++) {
    const d = Math.abs(resMs[i] - resMs[i - 1]);
    if (d > maxJumpMs) maxJumpMs = d;
    if (d > jumpMs) jumps++;
  }
  return {
    ok: true,
    n: used.length,
    spanSec: xs[xs.length - 1] - xs[0],
    effectiveRate: fit.slope * rate, // 1 秒あたりに取得したサンプル数（時計の差を含む）
    driftPpm: (fit.slope - 1) * 1e6, // 取得の時計が、ページの時計より速い（正）か遅い（負）か
    residualMs: { p50: percentile(absSorted, 50), p95: percentile(absSorted, 95), max: absSorted[absSorted.length - 1] },
    stalls, maxStallMs, jumps, maxJumpMs,
  };
}

/** 保存の Worker の書き込みが、取得に追いついているか。最後の標本の captured - written と、途中の最大の遅れ。 */
export function analyzeWrite(samples) {
  const pts = samples.filter((s) => Number.isFinite(s.captured) && Number.isFinite(s.written));
  if (!pts.length) return { ok: false };
  let maxLag = 0;
  for (const s of pts) maxLag = Math.max(maxLag, s.captured - s.written);
  const last = pts[pts.length - 1];
  return { ok: true, finalCaptured: last.captured, finalWritten: last.written, finalLag: last.captured - last.written, maxLag };
}

/** 録音ファイルの尻の、無音の長さ（0 が続くサンプル数）。強制終了のあとの尻が欠けていないかの目安。 */
export function trailingZeroRun(i16) {
  let n = 0;
  for (let i = i16.length - 1; i >= 0 && i16[i] === 0; i--) n++;
  return n;
}

export function rmsOf(i16, start = 0, end = i16.length) {
  let s = 0;
  const e = Math.min(end, i16.length);
  for (let i = start; i < e; i++) s += i16[i] * i16[i];
  return e > start ? Math.sqrt(s / (e - start)) / 32768 : 0;
}
