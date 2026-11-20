// JSON Schema の部分集合による検証（CONTRACTS.md 2.1）。実行環境に依存しない。
// 対応するキーワード：type、properties、required、additionalProperties（真偽のみ）、items、enum、const、pattern、
// minimum、maximum、minLength、maxLength、minItems、maxItems、oneOf、$ref（同じファイル内の #/$defs/... のみ）。
// （$schema、$id、description、$defs は読み飛ばす／参照先として使う。それ以外のキーワードは無視する。）
// スキーマの実体は core/schemas.js（schema/*.schema.json の写し。test/core/validate.test.js が一致を検査する）。

import { SCHEMAS } from './schemas.js';

/**
 * @typedef {{path:string, message:string}} ValidationError
 */

/**
 * 名前で指定したスキーマ（schema/<名前>.schema.json）で検証する。
 * `path` は JSON Pointer（RFC 6901）。値の根は "/"。
 * 未知のスキーマ名は TypeError（呼ぶ側の誤り）。検証の失敗は例外にせず `errors` に出す。
 * @param {string} schemaName 'script'|'manifest'|'events'|'segments'|'edits'|'timeline'|'index'|'cli-result'
 * @param {any} value
 * @returns {{ok:boolean, errors:ValidationError[]}}
 */
export function validate(schemaName, value) {
  const schema = Object.prototype.hasOwnProperty.call(SCHEMAS, schemaName) ? SCHEMAS[schemaName] : null;
  if (!schema) throw new TypeError(`validate: unknown schema "${schemaName}"`);
  return validateWithSchema(schema, value);
}

/**
 * スキーマの実体を渡して検証する（試験や、スキーマ名を持たない場合のため）。`$ref` はこのスキーマの `$defs` を引く。
 * @param {any} schema
 * @param {any} value
 * @returns {{ok:boolean, errors:ValidationError[]}}
 */
export function validateWithSchema(schema, value) {
  /** @type {ValidationError[]} */
  const errors = [];
  check(schema, value, [], schema, errors);
  return { ok: errors.length === 0, errors };
}

const patternCache = new Map();
function regexOf(pattern) {
  let re = patternCache.get(pattern);
  if (!re) {
    try { re = new RegExp(pattern, 'u'); } catch { re = new RegExp(pattern); }
    patternCache.set(pattern, re);
  }
  return re;
}

function ptr(path) {
  return path.length === 0 ? '/' : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isType(t, v) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'string': return typeof v === 'string';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: throw new Error(`validate: unsupported type "${t}" in schema`);
  }
}

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
}

function codePointLength(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) throw new Error(`validate: unsupported $ref "${ref}"`);
  const name = ref.slice('#/$defs/'.length);
  const target = root && root.$defs && Object.prototype.hasOwnProperty.call(root.$defs, name) ? root.$defs[name] : null;
  if (!target) throw new Error(`validate: unresolved $ref "${ref}"`);
  return target;
}

function check(schema, v, path, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push({ path: ptr(path), message: 'no value is allowed here' }); return; }
  if (schema.$ref !== undefined) check(resolveRef(schema.$ref, root), v, path, root, errors);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(t, v))) {
      errors.push({ path: ptr(path), message: `must be ${types.join(' or ')} (got ${typeName(v)})` });
      return; // 型が違えば、他の検査は意味がない
    }
  }
  if (schema.const !== undefined && !equal(schema.const, v)) {
    errors.push({ path: ptr(path), message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => equal(e, v))) {
    errors.push({ path: ptr(path), message: `must be one of ${JSON.stringify(schema.enum)}` });
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push({ path: ptr(path), message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && v > schema.maximum) errors.push({ path: ptr(path), message: `must be <= ${schema.maximum}` });
  }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined || schema.maxLength !== undefined) {
      const n = codePointLength(v);
      if (schema.minLength !== undefined && n < schema.minLength) errors.push({ path: ptr(path), message: `length must be >= ${schema.minLength}` });
      if (schema.maxLength !== undefined && n > schema.maxLength) errors.push({ path: ptr(path), message: `length must be <= ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !regexOf(schema.pattern).test(v)) {
      errors.push({ path: ptr(path), message: `must match pattern ${schema.pattern}` });
    }
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errors.push({ path: ptr(path), message: `must have >= ${schema.minItems} items` });
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push({ path: ptr(path), message: `must have <= ${schema.maxItems} items` });
    if (schema.items !== undefined) for (let i = 0; i < v.length; i++) check(schema.items, v[i], [...path, i], root, errors);
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (schema.required !== undefined) {
      for (const k of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(v, k) || v[k] === undefined) errors.push({ path: ptr(path), message: `missing required property "${k}"` });
      }
    }
    const props = schema.properties || {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(props, k)) check(props[k], v[k], [...path, k], root, errors);
      else if (schema.additionalProperties === false) errors.push({ path: ptr([...path, k]), message: 'additional property is not allowed' });
    }
  }
  if (schema.oneOf !== undefined) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const tmp = [];
      check(sub, v, path, root, tmp);
      if (tmp.length === 0) matches++;
    }
    if (matches !== 1) errors.push({ path: ptr(path), message: matches === 0 ? 'must match one of the allowed forms' : 'must match exactly one of the allowed forms' });
  }
}
