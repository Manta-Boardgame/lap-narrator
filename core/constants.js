// 既定値（CONTRACTS.md 0.6, 0.7, 1.8, 1.10）。変更は提案を通すこと。
export const CONTRACT_VERSION = 1;
export const DEFAULT_SAMPLE_RATE = 48000;
export const RAW_MAX_BYTES = 256 * 1024 * 1024;
export const FINAL_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1024 * 1024;
export const VOLUME_MAX_BYTES = 1_000_000_000;
export const WAV_HEADER_BYTES = 44;
export const DEFAULT_FADE_MS = 8;
export const DEFAULT_FADE_SAMPLES = 384; // 8ms @48k
export const DEFAULT_PRE_PAD_SAMPLES = 14400; // 0.3s @48k
export const DEFAULT_POST_PAD_SAMPLES = 24000; // 0.5s @48k
export const DEFAULT_FPS = 30;
export const DEFAULT_TARGET_LUFS = -16;
export const DEFAULT_CEILING_DB = -1.5;
export const ZIP_FIXED_DATE = Object.freeze({ year: 1980, month: 1, day: 1, hour: 0, minute: 0, second: 0 });

export const EVENT_TYPES = Object.freeze([
  'session-start', 'test-rec', 'rec-start', 'file-rotate', 'durable', 'ok', 'retake',
  'next-slide', 'goto-slide', 'pause', 'resume', 'recovered', 'mark', 'undo', 'redo', 'export',
]);

export const ISSUE_CODES = Object.freeze([
  'bad-undo-target', 'orphan-audio', 'goto-while-recording', 'position-mismatch',
  'beyond-raw-length', 'unknown-raw', 'seq-gap', 'bad-event',
]);
