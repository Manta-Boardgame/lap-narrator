// 通しの録音を切れ目で切った音声（スライドごとの断片）に、「スライドが切り替わってから話し始めるまで」の時間をそろえる処理。
//   narrate render --lead-in-sec <秒> [--lead-keep-ms 250]（cli/cmd/render.js の runContinuous から呼ぶ）
// 1. 断片の音声から、話し始めの位置（onset）を検出する（10 ms 窓の RMS。最初の 1 秒の下位 10% を雑音の床とし、床 +10 dB 以上で、
//    続く 100 ms がすべて床 +6 dB 以上の最初の位置。立ち上がりの始まりまで最大 30 ms さかのぼる）。見つからない、または先頭から話しているときは、onset = 先頭。
//    文字起こしの最初の語が onset より早いときは、その語の開始から onset までに、床 +6 dB 以上の窓があれば、そこを onset にする（語の時刻だけは信じない）。
// 2. onset の手前を keep（既定 250 ms）残して、それより前を捨てる。onset までの長さが lead-in 以上あるときは、足さずに、onset の手前を lead-in の長さだけ残す。
// 3. 足りない分に、部屋の雑音（room tone）を足す。まず断片自身の onset より前の、床に近い連続した区間（200 ms 以上）から作り、
//    なければ録音全体で最も静かな 1 秒から作る。足りない長さは 50 ms のクロスフェードでつないで繰り返す（開始位置をずらし、奇数回目は逆向き）。
//    乱数は使わない（同じ入力から同じ出力）。録音がデジタルの完全な無音しか持たないときだけ 0 を足す（警告 lead-in-room-tone-silent）。
// 実行環境に依存するのは、音声を読む部分（chunks）だけ。計算は Int16Array の上で行う。
import { usageError } from './errors.js';

export const DEFAULT_LEAD_KEEP_MS = 250;
export const LEAD_MAX_SEC = 30;
const WIN_MS = 10;
const FLOOR_SPAN_MS = 1000;
const FLOOR_QUANTILE = 0.1;
const ONSET_RISE_DB = 10;
const ONSET_HOLD_DB = 6;
const ONSET_HOLD_MS = 100;
const HEAD_GUARD_MS = 30;
const BACKOFF_MS = 30;
const OWN_NEAR_NOISE_DB = 9;
const WORD_HOLD_MS = 30;
const BURST_WINDOWS = 3;
const OWN_MIN_MS = 200;
const OWN_MAX_MS = 2000;
const OWN_GUARD_MS = 30;
const CROSSFADE_MS = 50;
const SEAM_MS = 20;
const SEAM_SAFE_MS = 10;
const QUIETEST_MS = 1000;
const WORD_SEARCH_MAX_MS = 1000;
/** これより小さい RMS（16 ビット PCM の値）は、デジタルの無音とみなす */
const DIGITAL_SILENCE_RMS = 0.3;
const MIN_FLOOR_RMS = 1;

const db = (x) => 10 ** (x / 20);

/** `--lead-in-sec`、`--lead-keep-ms` を読む。lead-in が 0 または未指定なら null（従来どおり） */
export function leadInOptions(opts) {
  let keepMs = DEFAULT_LEAD_KEEP_MS;
  if (opts['lead-keep-ms'] !== undefined) {
    const s = String(opts['lead-keep-ms']);
    if (!/^\d+$/.test(s) || Number(s) > 1000) throw usageError('--lead-keep-ms must be an integer from 0 to 1000', { option: 'lead-keep-ms', value: s });
    keepMs = Number(s);
  }
  if (opts['lead-in-sec'] === undefined) return null;
  const s = String(opts['lead-in-sec']).trim();
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n < 0 || n > LEAD_MAX_SEC) throw usageError(`--lead-in-sec must be a number from 0 to ${LEAD_MAX_SEC}`, { option: 'lead-in-sec', value: s });
  return n === 0 ? null : { sec: n, keepMs };
}

/** 10 ms ごと（端数の窓は捨てる）の RMS */
export function windowRms(pcm, win) {
  const n = Math.floor(pcm.length / win);
  const out = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = w * win, e = i + win; i < e; i++) sum += pcm[i] * pcm[i];
    out[w] = Math.sqrt(sum / win);
  }
  return out;
}

/** [from, to) で、rms[i] >= hi かつ i から hold 個の窓がすべて mid 以上である最初の i。なければ -1 */
function firstRise(rms, from, to, hi, mid, hold) {
  for (let i = from; i < to && i + hold <= rms.length; i++) {
    if (rms[i] < hi) continue;
    let ok = true;
    for (let j = i; j < i + hold; j++) if (rms[j] < mid) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/** [from, to) で、rms[i..i+n) がすべて thr 以上である最初の i。なければ -1 */
function firstRun(rms, from, to, thr, n) {
  let run = 0;
  for (let i = from; i < to + n - 1 && i < rms.length; i++) {
    run = rms[i] >= thr ? run + 1 : 0;
    if (run === n) return i - n + 1;
  }
  return -1;
}

/**
 * 断片の話し始めの位置を探す。
 * @param {Int16Array} pcm 断片の音声
 * @param {number} rate
 * @param {{wordStartSec?: number}} [o] 文字起こしの、この断片の最初の語の開始（断片の先頭からの秒）
 * @returns {{found: boolean, onset: number, floorRms: number, source: 'audio'|'burst'|'word'|'head'|'none', rms: Float64Array, win: number}}
 */
export function detectOnset(pcm, rate, o = {}) {
  const win = Math.max(1, Math.round((rate * WIN_MS) / 1000));
  const rms = windowRms(pcm, win);
  const span = Math.min(rms.length, Math.round(FLOOR_SPAN_MS / WIN_MS));
  const hold = Math.round(ONSET_HOLD_MS / WIN_MS);
  const none = (source, floorRms = MIN_FLOOR_RMS) => ({ found: false, onset: 0, floorRms, source, rms, win });
  if (rms.length < hold + 2) return none('none');
  const sorted = Array.from(rms.subarray(0, span)).sort((a, b) => a - b);
  const floorRms = Math.max(sorted[Math.floor(FLOOR_QUANTILE * (sorted.length - 1))], MIN_FLOOR_RMS);
  const hi = floorRms * db(ONSET_RISE_DB);
  const mid = floorRms * db(ONSET_HOLD_DB);
  const at = firstRise(rms, 0, rms.length, hi, mid, hold);
  if (at < 0) return none('none', floorRms);
  // onset より前（捨てる側）に、短くても床 +10 dB 以上の音が 3 窓続く所があれば、そこを話し始めとみなす（話し声を捨てないため）
  const burst = firstRun(rms, 0, at, hi, BURST_WINDOWS);
  const first = burst >= 0 ? burst : at;
  if (first * WIN_MS < HEAD_GUARD_MS) return none('head', floorRms);
  // 立ち上がりの始まりまで、少しさかのぼる（安全側）
  let j = first;
  while (j > 0 && first - j < BACKOFF_MS / WIN_MS && rms[j - 1] >= mid) j--;
  let onset = j * win;
  let source = burst >= 0 ? 'burst' : 'audio';
  // 文字起こしの最初の語が早ければ、その語の開始からの範囲に、床 +6 dB 以上の窓があるかを見る
  if (o.wordStartSec !== undefined && Number.isFinite(o.wordStartSec)) {
    const from = Math.max(0, Math.floor((o.wordStartSec * rate) / win));
    const to = Math.min(j, from + Math.round(WORD_SEARCH_MAX_MS / WIN_MS));
    const k = firstRise(rms, from, to, hi, mid, Math.round(WORD_HOLD_MS / WIN_MS));
    if (k >= 0 && k * win < onset) { onset = k * win; source = 'word'; }
  }
  return { found: true, onset, floorRms, source, rms, win };
}

/** 断片自身の、onset より前の床に近い連続した区間（200 ms 以上）。なければ null */
export function ownRoomToneSource(pcm, det, rate) {
  const { rms, win, onset, floorRms } = det;
  const guard = Math.round(OWN_GUARD_MS / WIN_MS);
  const end = Math.floor(onset / win) - guard;
  if (end < 1) return null;
  const med = Array.from(rms.subarray(0, end)).sort((x, y) => x - y)[Math.floor((end - 1) / 2)];
  const lim = Math.max(med, MIN_FLOOR_RMS) * db(OWN_NEAR_NOISE_DB);
  let best = null;
  let runStart = -1;
  for (let w = 0; w <= end; w++) {
    const ok = w < end && rms[w] <= lim;
    if (ok && runStart < 0) runStart = w;
    if (!ok && runStart >= 0) {
      if (!best || w - runStart >= best.len) best = { from: runStart, len: w - runStart };
      runStart = -1;
    }
  }
  if (!best || best.len * WIN_MS < OWN_MIN_MS) return null;
  const len = Math.min(best.len, Math.round(OWN_MAX_MS / WIN_MS));
  const from = best.from + (best.len - len); // onset に近いほうを使う
  const src = pcm.slice(from * win, (from + len) * win);
  let sum = 0;
  for (let i = 0; i < src.length; i++) sum += src[i] * src[i];
  if (Math.sqrt(sum / src.length) < DIGITAL_SILENCE_RMS) return null;
  return src;
}

/**
 * 録音全体で最も静かな 1 秒の位置（10 ms 窓の平均パワーが最小。デジタルの無音の窓を含まないものを優先）。決定的（同点は先頭）。
 * @param {AsyncIterable<Int16Array>} chunks
 * @returns {Promise<{start: number, length: number, rms: number, silent: boolean}>}
 */
export async function findQuietestBlock(chunks, rate) {
  const win = Math.max(1, Math.round((rate * WIN_MS) / 1000));
  const energy = [];
  let acc = 0;
  let fill = 0;
  for await (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      acc += c[i] * c[i];
      if (++fill === win) { energy.push(acc); acc = 0; fill = 0; }
    }
  }
  const n = energy.length;
  if (n === 0) return { start: 0, length: 0, rms: 0, silent: true };
  const B = Math.min(n, Math.round(QUIETEST_MS / WIN_MS));
  const pe = new Float64Array(n + 1);
  const ps = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    pe[i + 1] = pe[i] + energy[i];
    ps[i + 1] = ps[i] + (Math.sqrt(energy[i] / win) < DIGITAL_SILENCE_RMS ? 1 : 0);
  }
  let best = -1;
  let bestSilentFree = false;
  let bestE = Infinity;
  for (let k = 0; k + B <= n; k++) {
    const free = ps[k + B] - ps[k] === 0;
    const e = pe[k + B] - pe[k];
    if ((free && !bestSilentFree) || (free === bestSilentFree && e < bestE)) { best = k; bestSilentFree = free; bestE = e; }
  }
  return { start: best * win, length: B * win, rms: Math.sqrt(bestE / (B * win)), silent: !bestSilentFree };
}

/** 音声の [start, start + length) を取り出す */
export async function extractRange(chunks, start, length) {
  const out = new Int16Array(length);
  let pos = 0;
  for await (const c of chunks) {
    const lo = Math.max(start, pos);
    const hi = Math.min(start + length, pos + c.length);
    if (hi > lo) out.set(c.subarray(lo - pos, hi - pos), lo - start);
    pos += c.length;
    if (pos >= start + length) break;
  }
  return out;
}

/**
 * 雑音の素材 `src` から n サンプルを作る。50 ms のクロスフェード（等パワー）でつなぎ、繰り返しごとに開始位置をずらし、奇数回目は逆向きにする。決定的。
 * @param {Int16Array} src
 * @param {number} n
 * @param {number} rate
 */
export function fillRoomTone(src, n, rate) {
  const out = new Int16Array(n);
  if (n === 0 || src.length === 0) return out;
  let X = Math.round((rate * CROSSFADE_MS) / 1000);
  if (src.length < 4 * X) X = Math.floor(src.length / 4);
  const m = src.length;
  if (n <= m) { // 1 回で足りる
    out.set(src.subarray(0, n));
    return out;
  }
  const segLen = Math.max(2 * X + 1, Math.floor(m * 0.75));
  const slack = m - segLen;
  const stride = segLen - X;
  const acc = new Float64Array(n);
  for (let j = 0; ; j++) {
    const p = j * stride;
    if (p >= n) break;
    const off = slack > 0 ? (Math.imul(j + 1, 7919) >>> 0) % (slack + 1) : 0;
    const rev = j % 2 === 1;
    for (let t = 0; t < segLen; t++) {
      const at = p + t;
      if (at >= n) break;
      let w = 1;
      if (j > 0 && t < X) w = Math.sin((Math.PI / 2) * ((t + 0.5) / X));
      if (t >= segLen - X) w *= Math.cos((Math.PI / 2) * ((t - (segLen - X) + 0.5) / X));
      acc[at] += w * src[rev ? off + segLen - 1 - t : off + t];
    }
    if (p + segLen - X >= n) break; // n がこの断片の平らな部分までに入った
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(acc[i])));
  return out;
}

/**
 * スライドごとの計画を立てる。音声を 1〜3 回読む（断片ごと、必要なら最も静かな 1 秒を探して取り出す）。
 * @param {{chunks: () => AsyncIterable<Int16Array>, slices: {slideId: string, start: number, end: number, samples: number}[], rate: number,
 *          sliceStream: Function, leadSec: number, keepMs: number, words?: {start: number}[], ctx?: any}} a
 * @returns {Promise<Array<{slideId: string, found: boolean, onsetSource: string, onset: number, start: number, pad: number, tone: Int16Array|null, seam: Int16Array|null,
 *                         roomToneFrom: 'own'|'quietest'|null, floorRms: number}>>}
 */
export async function planLeadIns(a) {
  const { rate, slices, leadSec, keepMs, ctx } = a;
  const L = Math.round(leadSec * rate);
  const K = Math.round((keepMs * rate) / 1000);
  const words = (a.words || []).filter((w) => w && Number.isFinite(w.start));
  const plans = [];
  for await (const piece of a.sliceStream(a.chunks(), slices.map((s) => s.samples))) {
    const sl = slices[piece.index];
    const frag = new Int16Array(sl.samples);
    let o = 0;
    for await (const c of piece.chunks) { frag.set(c, o); o += c.length; }
    const t0 = sl.start / rate;
    const t1 = sl.end / rate;
    const inSlice = words.filter((w) => w.start >= t0 && w.start < t1).map((w) => w.start - t0);
    const det = detectOnset(frag, rate, inSlice.length ? { wordStartSec: Math.min(...inSlice) } : {});
    if (!det.found && ctx) {
      ctx.warn('lead-in-onset-not-found', `slide ${sl.slideId}: could not find where the speech starts (${det.source === 'head' ? 'it starts at the very beginning of the cut' : 'no speech found'}); the start of the cut is used`, { slideId: sl.slideId, reason: det.source });
    }
    const onset = det.found ? det.onset : 0;
    let start;
    let pad;
    if (onset >= L) { start = onset - L; pad = 0; } else { start = Math.max(0, onset - K); pad = L - (onset - start); }
    const plan = { slideId: sl.slideId, found: det.found, onsetSource: det.source, onset, start, pad, tone: null, seam: null, roomToneFrom: null, floorRms: det.floorRms };
    if (pad > 0) {
      const xs = Math.min(Math.round((SEAM_MS * rate) / 1000), onset - start - Math.round((SEAM_SAFE_MS * rate) / 1000));
      plan.seamLen = Math.max(0, xs);
      const own = det.found ? ownRoomToneSource(frag, det, rate) : null;
      if (own) { plan.tone = fillRoomTone(own, pad + plan.seamLen, rate); plan.roomToneFrom = 'own'; } else plan.roomToneFrom = 'quietest';
    }
    plans.push(plan);
  }
  const needQuiet = plans.filter((p) => p.pad > 0 && p.roomToneFrom === 'quietest');
  if (needQuiet.length) {
    const q = await findQuietestBlock(a.chunks(), rate);
    const src = q.length ? await extractRange(a.chunks(), q.start, q.length) : new Int16Array(0);
    if (q.silent && ctx) ctx.warn('lead-in-room-tone-silent', 'the recording has no room noise to copy (it is digital silence everywhere); silence was added in front of the speech', { slides: needQuiet.map((p) => p.slideId) });
    for (const p of needQuiet) p.tone = fillRoomTone(src, p.pad + p.seamLen, rate);
  }
  for (const p of plans) {
    if (p.tone) { p.seam = p.seamLen > 0 ? p.tone.subarray(p.pad, p.pad + p.seamLen) : null; p.tone = p.tone.subarray(0, p.pad); }
  }
  return plans;
}

/**
 * 断片の音声（先頭からのかたまりの列）を、計画どおりに作り直す：先頭の `start` サンプルを捨て、前に room tone を足す。
 * room tone の終わりでは、20 ms のクロスフェードで断片につなぐ（断片の onset より前の部分だけを使う）。
 */
export async function* leadInChunks(chunks, plan) {
  if (plan.pad > 0) yield plan.tone;
  const seam = plan.seam;
  const xs = seam ? seam.length : 0;
  let pos = 0;
  for await (const c of chunks) {
    const lo = Math.max(0, plan.start - pos);
    if (lo < c.length) {
      const part = c.subarray(lo);
      const a0 = pos + lo; // part[0] の、断片の中での位置
      if (xs > 0 && a0 < plan.start + xs) {
        const out = part.slice();
        for (let i = 0; i < out.length; i++) {
          const k = a0 + i - plan.start;
          if (k >= xs) break;
          const w = Math.sin((Math.PI / 2) * ((k + 0.5) / xs));
          out[i] = Math.round(part[i] * w + seam[k] * Math.cos((Math.PI / 2) * ((k + 0.5) / xs)));
        }
        yield out;
      } else yield part;
    }
    pos += c.length;
  }
}

/** 最初の語などのために、作業場の transcript.json の語を読む。音声の SHA-256 が一致しなければ空 */
export async function loadTranscriptWords(store, audioSha256, file = 'transcript.json') {
  try {
    if (!(await store.exists(file))) return [];
    const f = await store.openRead(file);
    const bytes = await f.read(0, f.size);
    const t = JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ''));
    if (!t || !t.audio || t.audio.sha256 !== audioSha256 || !Array.isArray(t.words)) return [];
    return t.words;
  } catch { return []; }
}
