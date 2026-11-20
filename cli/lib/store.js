// ワークスペースの保存先（CONTRACTS.md 2.2 の `store`）。node:fs で実装する。
// - パスは `/` 区切りの相対パス。ルートの外へ出るパス（絶対パス、`..`、`\`、ドライブ文字、シンボリックリンク経由）は拒否する。
// - 書き込みは一時ファイルに書いて、`close()` で名前を変える。途中で止まっても、中途半端なファイルは本来の名前に現れない。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { openAtomicWrite, readRange, TMP_MARK } from './fsutil.js';

export class StoreError extends Error {
  constructor(code, message) { super(message); this.name = 'StoreError'; this.code = code; }
}

function checkRel(p, { allowEmpty = false, allowTrailingSlash = false } = {}) {
  if (typeof p !== 'string') throw new StoreError('bad-path', 'path must be a string');
  if (p === '' && allowEmpty) return;
  let q = p;
  if (allowTrailingSlash && q.endsWith('/')) q = q.slice(0, -1);
  if (q === '' || q.length > 512 || q.startsWith('/') || q.includes('\\') || q.includes('\0') || /^[A-Za-z]:/.test(q)
    || q.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new StoreError('bad-path', `path escapes the workspace or is malformed: ${JSON.stringify(p)}`);
  }
}

/** @param {string} root ワークスペースのフォルダ */
export function createFsStore(root) {
  const rootAbs = path.resolve(root);
  let rootReal = null;

  const inside = (full, base) => full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

  function resolveRel(p) {
    checkRel(p);
    const full = path.join(rootAbs, ...p.split('/'));
    if (!inside(full, rootAbs)) throw new StoreError('bad-path', `path escapes the workspace: ${JSON.stringify(p)}`);
    return full;
  }

  /** 最も近い存在する祖先の実体が、ルートの実体の中にあること（シンボリックリンクで外へ出ない） */
  async function guard(full) {
    if (rootReal === null) {
      try { rootReal = await fsp.realpath(rootAbs); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return; // ワークスペースがまだ無い。作られるのは書き込みのときで、親のフォルダを新しく作るだけ
      }
    }
    let cur = full;
    for (;;) {
      try {
        const real = await fsp.realpath(cur);
        if (!inside(real, rootReal)) throw new StoreError('bad-path', `path leaves the workspace through a link: ${full}`);
        return;
      } catch (e) {
        if (e instanceof StoreError) throw e;
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
        const parent = path.dirname(cur);
        if (parent === cur) return;
        cur = parent;
      }
    }
  }

  async function walk(dirAbs, relPrefix, out) {
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return;
      throw e;
    }
    for (const ent of entries) {
      const rel = relPrefix + ent.name;
      if (ent.isDirectory()) await walk(path.join(dirAbs, ent.name), rel + '/', out);
      else if (ent.isFile() && !ent.name.includes(TMP_MARK)) out.push(rel);
    }
  }

  async function pruneEmptyDirs(fromDir) {
    let cur = fromDir;
    while (cur !== rootAbs && inside(cur, rootAbs)) {
      try { await fsp.rmdir(cur); } catch { return; }
      cur = path.dirname(cur);
    }
  }

  const store = {
    root: rootAbs,
    /** 絶対パス（このツール自身が、コピーなどに使う） */
    resolve: resolveRel,

    async readJson(p) {
      const full = resolveRel(p);
      await guard(full);
      let text;
      try { text = await fsp.readFile(full, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) {
        throw new StoreError('bad-json', `${p} is not valid JSON (${e.message})`);
      }
    },

    async writeJson(p, value) {
      const full = resolveRel(p);
      await guard(full);
      const w = await openAtomicWrite(full);
      try {
        await w.write(new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n'));
        await w.commit();
      } catch (e) { await w.abort(); throw e; }
    },

    async exists(p) {
      const full = resolveRel(p);
      await guard(full);
      try { await fsp.stat(full); return true; } catch { return false; }
    },

    async list(prefix) {
      checkRel(prefix, { allowEmpty: true, allowTrailingSlash: true });
      const slash = prefix.lastIndexOf('/');
      const dirPart = slash >= 0 ? prefix.slice(0, slash + 1) : '';
      const dirAbs = dirPart === '' ? rootAbs : resolveRel(dirPart.slice(0, -1));
      await guard(dirAbs);
      const out = [];
      await walk(dirAbs, dirPart, out);
      return out.filter((x) => x.startsWith(prefix)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },

    async openWrite(p) {
      const full = resolveRel(p);
      await guard(full);
      const w = await openAtomicWrite(full);
      return { write: (u8) => w.write(u8), close: () => w.commit(), abort: () => w.abort() };
    },

    async openRead(p) {
      const full = resolveRel(p);
      await guard(full);
      const st = await fsp.stat(full);
      if (!st.isFile()) throw new StoreError('not-a-file', `${p} is not a file`);
      return {
        size: st.size,
        async read(start, end) {
          const fh = await fsp.open(full, 'r');
          try { return await readRange(fh, start, Math.min(end, st.size)); } finally { await fh.close(); }
        },
      };
    },

    async remove(p) {
      const full = resolveRel(p);
      await guard(full);
      try { await fsp.unlink(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await pruneEmptyDirs(path.dirname(full));
    },
  };
  return store;
}
