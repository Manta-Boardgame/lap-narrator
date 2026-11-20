// 試験用：メモリ上の store（CONTRACTS.md 2.2）。
import { sha256Hex } from '../../../core/sha256.js';

export function createMemStore() {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const calls = { openWrite: 0, remove: 0 };
  const store = {
    files,
    calls,
    async readJson(p) { const u = files.get(p); return u ? JSON.parse(dec.decode(u)) : null; },
    async writeJson(p, v) { files.set(p, enc.encode(JSON.stringify(v, null, 2))); },
    async exists(p) { return files.has(p); },
    async list(prefix) { return [...files.keys()].filter((k) => k.startsWith(prefix)).sort(); },
    async openWrite(p) {
      calls.openWrite++;
      const chunks = [];
      files.set(p, new Uint8Array(0));
      return {
        write(u8) { chunks.push(u8.slice()); },
        close() {
          let n = 0; for (const c of chunks) n += c.length;
          const out = new Uint8Array(n); let o = 0;
          for (const c of chunks) { out.set(c, o); o += c.length; }
          files.set(p, out);
        },
      };
    },
    async openRead(p) {
      const u = files.get(p);
      if (!u) throw new Error(`no such file: ${p}`);
      return { size: u.length, async read(s, e) { return u.slice(s, e); } };
    },
    async remove(p) { calls.remove++; files.delete(p); },
  };
  return store;
}

/** prefix の下のすべてのファイルの {パス: SHA-256} */
export function snapshot(store, prefix) {
  const out = {};
  for (const k of [...store.files.keys()].sort()) if (k.startsWith(prefix)) out[k] = sha256Hex(store.files.get(k));
  return out;
}
