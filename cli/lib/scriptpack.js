// 台本パック（CONTRACTS.md 1.1）の組み立てと読み取り。ハッシュの計算は core の関数。
import { promises as fsp } from 'node:fs';
import {
  createZipWriter, readZipDirectory, readZipEntry, sha256Hex, createSha256, textHash, scriptHash, checkScript, canonicalJson,
} from '../../core/index.js';
import { openAtomicWrite, openFileVolume } from './fsutil.js';
import { CliError, EXIT } from './errors.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SLIDE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{6,64}$/;
export const pad4 = (n) => String(n).padStart(4, '0');

export const isPng = (u8) => u8.length >= 8 && PNG_SIGNATURE.every((b, i) => u8[i] === b);
export const isValidProjectId = (s) => PROJECT_ID.test(s);
export const isValidSlideId = (s) => SLIDE_ID.test(s);

/**
 * 元データ（hash 無し）から script.json を作る。`slides` の各要素は `{slideId, text, recordable, title?, speaker?, targetSec?, imageBytes?}`。
 * `order` は並びの順（1 から）。画像は `slides/NNNN.png`。textHash と scriptHash は core の関数で計算する。
 * @returns {{script: any, images: {name:string, data:Uint8Array}[]}}
 */
export function assembleScript({ title, projectId, slides }) {
  const images = [];
  const out = slides.map((s, i) => {
    const order = i + 1;
    const o = { slideId: s.slideId, order };
    if (s.title !== undefined) o.title = s.title;
    o.text = s.text;
    o.recordable = s.recordable;
    if (s.speaker !== undefined) o.speaker = s.speaker;
    if (s.targetSec !== undefined) o.targetSec = s.targetSec;
    if (s.imageBytes) {
      const name = `slides/${pad4(order)}.png`;
      images.push({ name, data: s.imageBytes });
      o.image = name;
      o.imageSha256 = sha256Hex(s.imageBytes);
    }
    o.textHash = textHash(o);
    return o;
  });
  const script = {
    format: 'lap-narrator/script',
    version: 1,
    projectId,
    title,
    scriptHash: scriptHash(out),
    slides: out,
  };
  return { script, images };
}

/** 内容から決まる projectId（指定がないとき）。同じ内容からは同じ値 */
export function derivedProjectId(title, slides) {
  const h = sha256Hex(new TextEncoder().encode(canonicalJson({ title, slides: slides.map((s) => ({ slideId: s.slideId, text: s.text, recordable: s.recordable })) })));
  return `proj-${h.slice(0, 12)}`;
}

/** 台本パック zip を書く（script.json、slides/…）。同じ内容から同じバイト列 */
export async function writePackZip(outAbs, script, images) {
  const w = await openAtomicWrite(outAbs);
  const hash = createSha256();
  let bytes = 0;
  try {
    const zip = createZipWriter({ write: async (u8) => { hash.update(u8); bytes += u8.length; await w.write(u8); } });
    await zip.addFile('script.json', new TextEncoder().encode(JSON.stringify(script, null, 2) + '\n'));
    for (const im of images) await zip.addFile(im.name, im.data);
    await zip.finish();
    await w.commit();
  } catch (e) {
    await w.abort();
    throw e;
  }
  return { bytes, sha256: hash.digestHex() };
}

async function readEntryBytes(volume, entry, limit) {
  if (entry.size > limit) throw new CliError('bad-pack', `${entry.name} is too large`, { exit: EXIT.FAIL });
  const out = new Uint8Array(entry.size);
  let o = 0;
  for await (const c of readZipEntry(volume.read, entry)) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * 台本パックを開いて検査する。戻り値の `close()` を必ず呼ぶ。
 * 検査：script.json があり、checkScript を通り、各画像が入っていて imageSha256 と合う。
 * @param {string} absPath
 */
export async function openPack(absPath) {
  let volume;
  try { volume = await openFileVolume(absPath); } catch (e) {
    throw new CliError('cannot-read', `cannot read ${absPath} (${e.code || e.message})`, { exit: EXIT.FAIL });
  }
  try {
    let entries;
    try { entries = await readZipDirectory(volume.read, volume.size); } catch (e) {
      throw new CliError('bad-pack', `${absPath} is not a readable ZIP (${e.message})`);
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    const se = byName.get('script.json');
    if (!se) throw new CliError('bad-pack', `${absPath}: script.json is missing`);
    let script;
    try { script = JSON.parse(new TextDecoder().decode(await readEntryBytes(volume, se, 64 * 1024 * 1024))); } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError('bad-pack', `${absPath}: script.json is not readable (${e.message})`);
    }
    const chk = checkScript(script);
    if (!chk.ok) throw new CliError('bad-script', `${absPath}: script.json is invalid`, { exit: EXIT.MISMATCH, detail: { errors: chk.errors.slice(0, 20) } });
    const problems = [];
    for (const s of script.slides) {
      if (s.image === undefined) continue;
      const e = byName.get(s.image);
      if (!e) { problems.push(`${s.slideId}: ${s.image} is missing from the pack`); continue; }
      if (s.imageSha256) {
        const h = createSha256();
        for await (const c of readZipEntry(volume.read, e)) h.update(c);
        if (h.digestHex() !== s.imageSha256) problems.push(`${s.slideId}: ${s.image} does not match imageSha256`);
      }
    }
    if (problems.length) throw new CliError('bad-script', `${absPath}: slide images do not match script.json`, { exit: EXIT.MISMATCH, detail: { problems: problems.slice(0, 20) } });
    return {
      script,
      scriptBytes: await readEntryBytes(volume, se, 64 * 1024 * 1024),
      entries,
      streamEntry: (entry) => readZipEntry(volume.read, entry),
      close: () => volume.close(),
    };
  } catch (e) {
    await volume.close();
    throw e;
  }
}

/** 位置引数が台本パックかどうか（script.json があり、manifest.json が無い ZIP） */
export async function looksLikeScriptPack(absPath) {
  let volume;
  try { volume = await openFileVolume(absPath); } catch { return false; }
  try {
    const entries = await readZipDirectory(volume.read, volume.size);
    const names = new Set(entries.map((e) => e.name));
    return names.has('script.json') && !names.has('manifest.json');
  } catch { return false; } finally { await volume.close(); }
}

/**
 * 台本パックをワークスペースの `script.json` と `slides/` に置く。古い画像のうち、新しい台本が使わないものは消す。
 * @returns {Promise<{script:any, replaced: null | {from:string, to:string}}>}
 */
export async function installPack(store, packAbs) {
  const pack = await openPack(packAbs);
  try {
    const before = await store.readJson('script.json');
    const keep = new Set();
    for (const e of pack.entries) {
      if (e.name === 'script.json') continue;
      if (!pack.script.slides.some((s) => s.image === e.name)) continue;
      keep.add(e.name);
      const w = await store.openWrite(e.name);
      try {
        for await (const c of pack.streamEntry(e)) await w.write(c);
        await w.close();
      } catch (err) { await w.abort(); throw err; }
    }
    for (const old of await store.list('slides/')) if (!keep.has(old)) await store.remove(old);
    await store.writeJson('script.json', pack.script);
    return { script: pack.script, replaced: before && before.scriptHash !== pack.script.scriptHash ? { from: before.scriptHash, to: pack.script.scriptHash } : null };
  } finally {
    await pack.close();
  }
}

export async function readFileBytes(abs) { return new Uint8Array(await fsp.readFile(abs)); }
