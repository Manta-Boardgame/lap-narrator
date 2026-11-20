// 台本のハッシュ（CONTRACTS.md 0.4, 1.1）。実行環境に依存しない。
import { canonicalJson } from './json.js';
import { sha256Hex } from './sha256.js';
import { validate } from './validate.js';

const encoder = new TextEncoder();

/**
 * スライドの文のハッシュ：`sha256(utf8(canonicalJson({slideId, text, recordable})))`。
 * `slideId` と `text` は文字列、`recordable` は真偽値でなければ TypeError。
 * @param {{slideId:string, text:string, recordable:boolean}} slide
 * @returns {string} 小文字 16 進 64 文字
 */
export function textHash(slide) {
  if (slide === null || typeof slide !== 'object') throw new TypeError('textHash: slide must be an object');
  if (typeof slide.slideId !== 'string') throw new TypeError('textHash: slideId must be a string');
  if (typeof slide.text !== 'string') throw new TypeError('textHash: text must be a string');
  if (typeof slide.recordable !== 'boolean') throw new TypeError('textHash: recordable must be a boolean');
  return sha256Hex(encoder.encode(canonicalJson({ slideId: slide.slideId, text: slide.text, recordable: slide.recordable })));
}

/**
 * 台本のハッシュ：全スライドを `order` の昇順に並べ、文のハッシュを "\n" でつないだ文字列の SHA-256。
 * 題名・担当・目安の秒数・絵は含めない。`textHash` が無いスライドは、`slideId`、`text`、`recordable` から求める。
 * `order` が同じものは、渡された順を保つ（安定）。スライドが 0 件のときは空文字列の SHA-256。
 * @param {{order:number, textHash?:string, slideId?:string, text?:string, recordable?:boolean}[]} slides
 * @returns {string}
 */
export function scriptHash(slides) {
  if (!Array.isArray(slides)) throw new TypeError('scriptHash: slides must be an array');
  const sorted = slides
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order - b.s.order) || (a.i - b.i))
    .map((x) => x.s);
  const hashes = sorted.map((s) => (typeof s.textHash === 'string' ? s.textHash : textHash(/** @type {any} */ (s))));
  return sha256Hex(encoder.encode(hashes.join('\n')));
}

/**
 * 台本（script.json）を検査する：スキーマ（schema/script）に加え、スライドの `textHash` と全体の `scriptHash` が
 * 規則どおりか、`slideId` と `order` が重複していないか。
 * @param {any} script
 * @returns {{ok:boolean, errors:string[]}}
 */
export function checkScript(script) {
  const errors = [];
  const schemaResult = validate('script', script);
  for (const e of schemaResult.errors) errors.push(`${e.path}: ${e.message}`);
  if (script && typeof script === 'object' && Array.isArray(script.slides)) {
    const ids = new Set();
    const orders = new Set();
    const recomputed = [];
    script.slides.forEach((s, i) => {
      if (s === null || typeof s !== 'object') return;
      if (typeof s.slideId === 'string') {
        if (ids.has(s.slideId)) errors.push(`/slides/${i}/slideId: duplicate slideId "${s.slideId}"`);
        ids.add(s.slideId);
      }
      if (typeof s.order === 'number') {
        if (orders.has(s.order)) errors.push(`/slides/${i}/order: duplicate order ${s.order}`);
        orders.add(s.order);
      }
      if (typeof s.slideId === 'string' && typeof s.text === 'string' && typeof s.recordable === 'boolean') {
        const h = textHash(s);
        recomputed.push({ order: s.order, textHash: h });
        if (typeof s.textHash === 'string' && s.textHash !== h) errors.push(`/slides/${i}/textHash: does not match the slide text (expected ${h})`);
      }
    });
    // 全スライドの文のハッシュがそろっているときだけ、台本のハッシュを確かめる
    if (recomputed.length === script.slides.length && typeof script.scriptHash === 'string' && recomputed.every((r) => typeof r.order === 'number')) {
      const h = scriptHash(recomputed);
      if (script.scriptHash !== h) errors.push(`/scriptHash: does not match the slides (expected ${h})`);
    }
  }
  return { ok: errors.length === 0, errors };
}
