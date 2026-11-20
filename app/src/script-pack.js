// 台本パック（CONTRACTS.md 1.1）を開く。zip を選んで読む、または script.json を貼り付ける。
// ZIP の読み取り・ハッシュの規則は core/ を使う（ここには書かない）。core が使えないときだけ、
// 構造だけの簡易の検査にして、その旨を警告に出す。

import { readZipDirectory, readZipEntry } from '../../core/zip.js';
import { checkScript } from '../../core/script.js';
import { sha256Hex } from '../../core/sha256.js';

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{6,64}$/;

const isNotImplemented = (e) => e && /not implemented/.test(String(e.message || e));

/** 構造だけの簡易の検査（core/script.js の checkScript が使えないときの代わり）。 */
export function basicScriptCheck(script) {
  const errors = [];
  if (!script || typeof script !== 'object') return { ok: false, errors: ['not-an-object'] };
  if (script.format !== 'lap-narrator/script') errors.push('format');
  if (script.version !== 1) errors.push('version');
  if (!PROJECT_ID.test(script.projectId || '')) errors.push('projectId');
  if (typeof script.title !== 'string') errors.push('title');
  if (!HEX64.test(script.scriptHash || '')) errors.push('scriptHash');
  if (!Array.isArray(script.slides) || script.slides.length === 0) errors.push('slides');
  else {
    const seen = new Set();
    for (const s of script.slides) {
      if (!ID.test(s.slideId || '') || seen.has(s.slideId)) errors.push(`slideId:${s && s.slideId}`);
      seen.add(s.slideId);
      if (!Number.isInteger(s.order) || s.order < 1) errors.push(`order:${s.slideId}`);
      if (typeof s.text !== 'string') errors.push(`text:${s.slideId}`);
      if (typeof s.recordable !== 'boolean') errors.push(`recordable:${s.slideId}`);
      if (!HEX64.test(s.textHash || '')) errors.push(`textHash:${s.slideId}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** @returns {{ok:boolean, errors:string[], warnings:string[]}} */
export function validateScript(script) {
  try {
    const r = checkScript(script);
    return { ok: !!r.ok, errors: r.errors || [], warnings: [] };
  } catch (e) {
    if (!isNotImplemented(e)) return { ok: false, errors: [String(e && e.message || e)], warnings: [] };
    const r = basicScriptCheck(script);
    return { ok: r.ok, errors: r.errors, warnings: ['core-check-unavailable'] };
  }
}

export function parseScriptJson(text) {
  let script;
  try { script = JSON.parse(text); } catch { return { ok: false, errors: ['json-parse'], warnings: [] }; }
  const v = validateScript(script);
  return { ...v, script: v.ok ? script : null };
}

async function collect(iter) {
  const parts = [];
  let n = 0;
  for await (const chunk of iter) { parts.push(chunk); n += chunk.length; }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 台本パックの zip（File）を読む。 */
export async function readScriptPackZip(file) {
  const read = async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
  const dir = await readZipDirectory(read, file.size);
  const byName = new Map(dir.map((e) => [e.name, e]));
  const sj = byName.get('script.json');
  if (!sj) return { ok: false, errors: ['no-script-json'], warnings: [] };
  const text = new TextDecoder().decode(await collect(readZipEntry(read, sj)));
  const parsed = parseScriptJson(text);
  if (!parsed.ok) return parsed;
  const warnings = [...parsed.warnings];
  const images = {};
  for (const s of parsed.script.slides) {
    if (!s.image) continue;
    const e = byName.get(s.image);
    if (!e) { warnings.push(`image-missing:${s.slideId}`); continue; }
    const bytes = await collect(readZipEntry(read, e));
    if (s.imageSha256) {
      try { if (sha256Hex(bytes) !== s.imageSha256) warnings.push(`image-hash-mismatch:${s.slideId}`); } catch (err) { if (!isNotImplemented(err)) throw err; }
    }
    images[s.image] = bytes;
  }
  return { ok: true, errors: [], warnings, script: parsed.script, images };
}
