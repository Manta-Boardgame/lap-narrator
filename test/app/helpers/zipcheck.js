// 書き出した ZIP を、Node.js 側で core の読み手を使って検証する補助。
import { readZipDirectory, readZipEntry } from '../../../core/zip.js';
import { sha256Hex } from '../../../core/sha256.js';

export async function openZip(buf) {
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = async (s, e) => u8.slice(s, e);
  const dir = await readZipDirectory(read, u8.length);
  const byName = new Map(dir.map((e) => [e.name, e]));
  const readAll = async (name) => {
    const e = byName.get(name);
    if (!e) throw new Error(`no entry ${name}`);
    const parts = [];
    for await (const c of readZipEntry(read, e)) parts.push(c);
    return Buffer.concat(parts);
  };
  return { names: dir.map((e) => e.name), dir, readAll, read, size: u8.length };
}

export const sha = (buf) => sha256Hex(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));

/** core/importer の store（CONTRACTS.md 2.2）の、メモリ上の実装。 */
export function memStore() {
  const files = new Map();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    files,
    async readJson(p) { return files.has(p) ? JSON.parse(dec.decode(files.get(p))) : null; },
    async writeJson(p, v) { files.set(p, enc.encode(JSON.stringify(v))); },
    async exists(p) { return files.has(p); },
    async list(prefix) { return [...files.keys()].filter((k) => k.startsWith(prefix)); },
    async openWrite(p) {
      const parts = [];
      return { write: (u8) => { parts.push(Uint8Array.from(u8)); }, close: () => { files.set(p, Buffer.concat(parts)); } };
    },
    async openRead(p) {
      const d = files.get(p);
      if (!d) throw new Error(`no file ${p}`);
      return { size: d.length, read: async (s, e) => d.slice(s, e) };
    },
    async remove(p) { files.delete(p); },
  };
}
