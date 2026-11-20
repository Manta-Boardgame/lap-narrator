// validate：形式（JSON Schema）とハッシュだけを検証する（設計書 5.1、CONTRACTS.md 3.2）。計算は core の validate、checkScript、createSha256。
//   narrate validate <file.json|file.jsonl|zip|folder> [--schema <name>]
// 見るもの：
//   - JSON：`format` で schema を選ぶ（script、manifest、segments、edits、timeline、index、boundaries、transcript、cli-result）。--schema で指定もできる
//   - script.json：schema に加えて、textHash と scriptHash（checkScript）
//   - events.jsonl：各行を schema（events）で
//   - manifest.json：files[] の大きさと SHA-256 を、同じ ZIP／フォルダの中のファイルと照合
//   - 台本パック：画像の SHA-256（imageSha256）
//   - timeline.json：showStart／audioStart／audioEnd／showEnd のつながり
//   - boundaries.json：schema に加えて、区間が連続・半開か（checkBoundaries。台本・音声との照合はしない）
// 不一致があれば終了コード 3。読めないパスは 1。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validate, checkScript, checkBoundaries, readZipDirectory, readZipEntry, createSha256, parseJsonl } from '../../core/index.js';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { openFileVolume, streamFile } from '../lib/fsutil.js';

export const options = { schema: 'string' };

const SCHEMA_BY_FORMAT = {
  'lap-narrator/script': 'script', 'lap-narrator/manifest': 'manifest', 'lap-narrator/segments': 'segments',
  'lap-narrator/edits': 'edits', 'lap-narrator/timeline': 'timeline', 'lap-narrator/index': 'index',
  'lap-narrator/boundaries': 'boundaries', 'lap-narrator/transcript': 'transcript',
};
const KNOWN_NAMES = [['script.json', 'script'], ['manifest.json', 'manifest'], ['segments.json', 'segments'], ['edits.json', 'edits'], ['timeline.json', 'timeline'], ['boundaries.json', 'boundaries'], ['transcript.json', 'transcript']];
const dec = new TextDecoder();

function bySchemaName(name) {
  return KNOWN_NAMES.find(([n]) => n === name)?.[1] ?? (/_index\.json$/.test(name) ? 'index' : null);
}

/** 検査する対象の入口：名前の一覧、全体を読む、少しずつ読む */
async function openSource(abs) {
  let st;
  try { st = await fsp.stat(abs); } catch { throw new CliError('cannot-read', `no such file or folder: ${abs}`); }
  if (st.isDirectory()) {
    const names = [];
    const walk = async (rel) => {
      for (const e of await fsp.readdir(path.join(abs, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(r); else if (e.isFile()) names.push(r);
      }
    };
    await walk('');
    return {
      kind: 'folder', names: names.sort(),
      readAll: async (n) => new Uint8Array(await fsp.readFile(path.join(abs, ...n.split('/')))),
      stream: async (n, fn) => { await streamFile(path.join(abs, ...n.split('/')), fn); },
      close: async () => {},
    };
  }
  if (/\.zip$/i.test(abs)) {
    const vol = await openFileVolume(abs);
    let entries;
    try { entries = await readZipDirectory(vol.read, vol.size); } catch (e) { await vol.close(); throw new CliError('bad-zip', `${path.basename(abs)} is not a readable ZIP (${e.message})`); }
    const by = new Map(entries.map((e) => [e.name, e]));
    return {
      kind: 'zip', names: entries.map((e) => e.name).sort(),
      readAll: async (n) => {
        const e = by.get(n);
        const out = new Uint8Array(e.size);
        let o = 0;
        for await (const c of readZipEntry(vol.read, e)) { out.set(c, o); o += c.length; }
        return out;
      },
      stream: async (n, fn) => { for await (const c of readZipEntry(vol.read, by.get(n))) await fn(c); },
      close: () => vol.close(),
    };
  }
  const base = path.basename(abs);
  return {
    kind: 'file', names: [base],
    readAll: async () => new Uint8Array(await fsp.readFile(abs)),
    stream: async (n, fn) => { await streamFile(abs, fn); },
    close: async () => {},
  };
}

function checkTimeline(tl, add) {
  let prevEnd = 0;
  tl.slides.forEach((s, i) => {
    if (s.showStart !== prevEnd) add('/slides/' + i + '/showStart', `showStart ${s.showStart} differs from the previous showEnd ${prevEnd}`);
    if (s.audioStart !== s.showStart + tl.prePadSamples) add('/slides/' + i + '/audioStart', 'audioStart != showStart + prePadSamples');
    if (s.audioEnd !== s.audioStart + s.audioSamples) add('/slides/' + i + '/audioEnd', 'audioEnd != audioStart + audioSamples');
    if (s.showEnd !== s.audioEnd + tl.postPadSamples) add('/slides/' + i + '/showEnd', 'showEnd != audioEnd + postPadSamples');
    prevEnd = s.showEnd;
  });
  if (tl.totalSamples !== prevEnd) add('/totalSamples', `totalSamples ${tl.totalSamples} differs from the last showEnd ${prevEnd}`);
}

async function hashOf(src, name) {
  const h = createSha256();
  let bytes = 0;
  await src.stream(name, (c) => { h.update(c); bytes += c.length; });
  return { sha256: h.digestHex(), bytes };
}

export async function run({ opts, positionals }) {
  if (positionals.length !== 1) throw usageError('validate takes exactly one path');
  if (opts.schema !== undefined && !Object.values(SCHEMA_BY_FORMAT).includes(opts.schema) && opts.schema !== 'events' && opts.schema !== 'cli-result') throw usageError(`unknown schema ${opts.schema}`);
  const abs = path.resolve(positionals[0]);
  const src = await openSource(abs);
  const checked = [];
  const problems = []; // {file, kind, path, message}
  try {
    const present = new Set(src.names);
    const check = (file, schema, errs) => {
      checked.push({ file, schema, ok: errs.length === 0, errors: errs.length });
      for (const e of errs) problems.push({ file, kind: e.kind || 'schema-error', path: e.path, message: e.message });
    };
    for (const name of src.names) {
      const base = name.split('/').pop();
      const top = !name.includes('/');
      if (!top) continue;
      if (/\.jsonl$/i.test(base)) {
        const errs = [];
        let events;
        try { events = parseJsonl(dec.decode(await src.readAll(name))); } catch (e) { check(name, 'events', [{ path: e.line ? `line ${e.line}` : '/', message: `not readable JSON Lines (${e.message})` }]); continue; }
        events.forEach((ev, i) => { for (const e of validate('events', ev).errors) errs.push({ path: `line ${i + 1}${e.path}`, message: e.message }); });
        check(name, 'events', errs);
        continue;
      }
      if (!/\.json$/i.test(base)) continue;
      let value;
      try { value = JSON.parse(dec.decode(await src.readAll(name)).replace(/^﻿/, '')); } catch (e) {
        check(name, null, [{ path: '/', message: `not valid JSON (${e.message})` }]);
        continue;
      }
      const chosen = opts.schema ?? (value && typeof value === 'object' ? SCHEMA_BY_FORMAT[value.format] : undefined) ?? bySchemaName(base) ?? (value && typeof value === 'object' && 'ok' in value && 'command' in value ? 'cli-result' : null);
      if (!chosen) { if (src.kind === 'file') check(name, null, [{ path: '/', message: 'cannot tell which schema applies (use --schema <name>)' }]); continue; }
      const errs = validate(chosen, value).errors.map((e) => ({ path: e.path, message: e.message }));
      if (chosen === 'script') {
        const chk = checkScript(value);
        // checkScript にはスキーマの誤りも入る。重複を避け、ハッシュの誤りだけを足す
        for (const m of chk.errors) if (/textHash|scriptHash|duplicate/.test(m)) { const i = m.indexOf(': '); errs.push({ kind: 'script-hash', path: m.slice(0, i), message: m.slice(i + 2) }); }
        if (value && Array.isArray(value.slides) && src.kind !== 'file') {
          for (const s of value.slides) {
            if (typeof s.image === 'string' && typeof s.imageSha256 === 'string' && present.has(s.image)) {
              const h = await hashOf(src, s.image);
              if (h.sha256 !== s.imageSha256) errs.push({ kind: 'hash-mismatch', path: `/slides/${s.slideId}/imageSha256`, message: `${s.image} does not match imageSha256` });
            }
          }
        }
      }
      if (chosen === 'manifest' && value && Array.isArray(value.files) && src.kind !== 'file') {
        for (const f of value.files) {
          if (!present.has(f.path)) { errs.push({ kind: 'hash-mismatch', path: `/files/${f.path}`, message: `${f.path} is listed in the manifest but missing` }); continue; }
          const h = await hashOf(src, f.path);
          if (h.bytes !== f.bytes) errs.push({ kind: 'hash-mismatch', path: `/files/${f.path}`, message: `size ${h.bytes} differs from the manifest (${f.bytes})` });
          else if (h.sha256 !== f.sha256) errs.push({ kind: 'hash-mismatch', path: `/files/${f.path}`, message: 'SHA-256 differs from the manifest' });
        }
        for (const n of src.names) if (n !== 'manifest.json' && !value.files.some((f) => f.path === n) && !/^__MACOSX/.test(n)) {
          // 巻の中の、manifest が数えていないファイル。一覧にない README などは取り込みでも拒否される
          errs.push({ kind: 'hash-mismatch', path: `/files`, message: `${n} is not listed in the manifest` });
        }
      }
      if (chosen === 'boundaries' && errs.length === 0) for (const e of checkBoundaries(value).errors) errs.push({ kind: e.code, path: '/', message: e.message });
      if (chosen === 'timeline' && errs.length === 0) checkTimeline(value, (p, m) => errs.push({ kind: 'timeline-mismatch', path: p, message: m }));
      check(name, chosen, errs);
    }
  } finally {
    await src.close();
  }
  const ok = problems.length === 0;
  const result = { ok, path: abs, checked, errors: problems };
  if (ok) return { result };
  return {
    result,
    errors: problems.slice(0, 50).map((p) => ({ code: p.kind, message: `${p.file}: ${p.path} ${p.message}`, detail: { file: p.file, path: p.path } })),
    exit: EXIT.MISMATCH,
  };
}
