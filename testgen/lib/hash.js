// SHA-256 と canonicalJson（CONTRACTS.md 0.4）。core/ は使わない。
import { createHash } from 'node:crypto';

/** @param {Uint8Array|string} data @returns {string} 小文字 16 進 64 文字 */
export function sha256Hex(data) {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return h.digest('hex');
}

/**
 * CONTRACTS.md 0.4 の canonicalJson。
 * キーは UTF-16 コード単位順、空白なし、文字列は JSON 標準のエスケープ、undefined のキーは出さない。
 * NaN と無限大はエラー。
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: NaN/Infinity is not allowed');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
      }
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
    }
    default:
      throw new Error('canonicalJson: unsupported type ' + typeof value);
  }
}

/** 0.4：スライドの文のハッシュ */
export function textHash(slide) {
  return sha256Hex(canonicalJson({ slideId: slide.slideId, text: slide.text, recordable: slide.recordable }));
}

/** 0.4：台本のハッシュ（order の昇順、"\n" でつなぐ） */
export function scriptHash(slides) {
  const sorted = [...slides].sort((a, b) => a.order - b.order);
  return sha256Hex(sorted.map((s) => textHash(s)).join('\n'));
}
