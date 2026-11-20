// JSON の正規化と JSON Lines（CONTRACTS.md 0.2, 0.4）。実行環境に依存しない。

/**
 * 正規化した JSON 文字列（CONTRACTS.md 0.4）。ハッシュ用。
 * - キーは UTF-16 のコード単位順。空白なし。
 * - 文字列は JSON 標準のエスケープ（`"`、`\`、U+0000〜U+001F）だけ。日本語はそのまま。
 * - 数は JSON.stringify と同じ書き方。NaN と無限大はエラー（TypeError）。
 * - 値が undefined のキーは出さない。配列の中の undefined は null。
 * - BigInt、関数、Symbol、Map、Set、型付き配列、循環参照はエラー（TypeError）。
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === undefined) throw new TypeError('canonicalJson: undefined is not serializable');
  return ser(value, [], '$');
}

function ser(v, stack, path) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
      return 'null';
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
  if (typeof v.toJSON === 'function') {
    const r = v.toJSON();
    if (r === undefined) return 'null';
    return ser(r, stack, path);
  }
  if (v instanceof Map || v instanceof Set || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    throw new TypeError(`canonicalJson: unsupported object at ${path}`);
  }
  if (stack.includes(v)) throw new TypeError(`canonicalJson: circular reference at ${path}`);
  stack.push(v);
  let out;
  if (Array.isArray(v)) {
    const parts = new Array(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = ser(v[i], stack, `${path}[${i}]`);
    out = '[' + parts.join(',') + ']';
  } else {
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      const x = v[k];
      if (x === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + ser(x, stack, `${path}.${k}`));
    }
    out = '{' + parts.join(',') + '}';
  }
  stack.pop();
  return out;
}

/**
 * JSON Lines を読む。1 行に 1 つの JSON。空行（空白だけの行を含む）は無視する。先頭の BOM は無視する。
 * 行末は LF または CRLF。
 *
 * 途中で切れた行の扱い（CONTRACTS.md 1.4、設計書 4.5 の 1）：
 * - 既定：読めない行があれば SyntaxError（`err.line` に 1 から数えた行番号）。
 * - `{tolerateTruncated: true}`：**最後の空でない行**だけが読めないとき、その行を捨てる。
 *   戻り値は通常どおり配列のまま。捨てた行数は、配列の（列挙されない）プロパティ `dropped`（0 または 1）に入る。
 *   途中の行が読めないときは、このオプションがあっても SyntaxError（壊れた記録を黙って捨てない）。
 * @param {string} text
 * @param {{tolerateTruncated?: boolean}} [opts]
 * @returns {any[]} 配列。`result.dropped` に捨てた行数（常に付く）
 */
export function parseJsonl(text, opts) {
  const tolerate = !!(opts && opts.tolerateTruncated);
  if (typeof text !== 'string') throw new TypeError('parseJsonl: text must be a string');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n');
  // 最後の空でない行の番号
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { last = i; break; }
  }
  const out = [];
  let dropped = 0;
  for (let i = 0; i <= last; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      if (tolerate && i === last) { dropped = 1; break; }
      const err = new SyntaxError(`parseJsonl: line ${i + 1}: ${e.message}`);
      /** @type {any} */ (err).line = i + 1;
      throw err;
    }
  }
  Object.defineProperty(out, 'dropped', { value: dropped, enumerable: false, writable: true, configurable: true });
  return out;
}

/**
 * JSON Lines にする。各項目は canonicalJson の 1 行、各行の終わりに LF。空配列は空文字列。
 * @param {any[]} items
 * @returns {string}
 */
export function stringifyJsonl(items) {
  let s = '';
  for (const it of items) s += canonicalJson(it) + '\n';
  return s;
}
