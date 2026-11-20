// 小さな補助関数。計算（区間、ハッシュ、WAV、ZIP）は core/ を使い、ここには書かない。

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 秒数を m:ss（1 時間以上は h:mm:ss）にする。表示専用。 */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** サンプル数を m:ss にする。表示専用。 */
export function fmtSamples(samples, sampleRate) {
  if (!sampleRate) return '0:00';
  return fmtClock(samples / sampleRate);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** sessionId / exportId 用の乱数の識別子（0.3 の形：[A-Za-z0-9_-]{6,64}）。 */
export function randomId(length = 12) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += ID_CHARS[b % ID_CHARS.length];
  return out;
}

export function pad(n, width) { return String(n).padStart(width, '0'); }
export const takeIdOf = (n) => `t${pad(n, 4)}`;
export const checkpointIdOf = (n) => `c${pad(n, 4)}`;
export const rawNameOf = (n) => `rec-${pad(n, 6)}`;
export const rawNumberOf = (name) => Number(/^rec-(\d{6})$/.exec(name)?.[1] ?? NaN);

export function bytesToBase64(u8) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 簡単な発行・購読。 */
export class Emitter {
  constructor() { this.listeners = new Set(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(...args) { for (const fn of [...this.listeners]) { try { fn(...args); } catch (e) { console.error(e); } } }
}
