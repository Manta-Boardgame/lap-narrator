// OPFS（端末内のファイル領域）の補助。メインのスレッド用（台本・スライドの絵・設定の保存）。
// 録音ファイルと操作記録は、保存の Worker が同期アクセスで書く（worker/recorder-worker.js）。
// 保存先はこの端末の中だけ。外へは送らない。

let rootPromise = null;

export function lapRoot() {
  if (!rootPromise) {
    rootPromise = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('lap', { create: true }));
  }
  return rootPromise;
}

export async function getDir(parts, create = false) {
  let d = await lapRoot();
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

async function split(path) {
  const parts = Array.isArray(path) ? path : path.split('/').filter(Boolean);
  return { dirParts: parts.slice(0, -1), name: parts[parts.length - 1] };
}

export async function writeFile(path, data) {
  const { dirParts, name } = await split(path);
  const dir = await getDir(dirParts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try { await w.write(data); } finally { await w.close(); }
}

export async function readFile(path) {
  const { dirParts, name } = await split(path);
  try {
    const dir = await getDir(dirParts, false);
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return null;
    throw e;
  }
}

export async function readJson(path) {
  const f = await readFile(path);
  if (!f) return null;
  try { return JSON.parse(await f.text()); } catch { return null; }
}

export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2));
}

export async function listDir(parts) {
  try {
    const dir = await getDir(parts, false);
    const out = [];
    for await (const [name, h] of dir.entries()) out.push({ name, kind: h.kind });
    return out;
  } catch (e) {
    if (e && e.name === 'NotFoundError') return [];
    throw e;
  }
}

export async function removeEntry(parts, { recursive = true } = {}) {
  const { dirParts, name } = await split(parts);
  try {
    const dir = await getDir(dirParts, false);
    await dir.removeEntry(name, { recursive });
  } catch (e) {
    if (!(e && e.name === 'NotFoundError')) throw e;
  }
}

export async function dirSize(parts) {
  let total = 0;
  const walk = async (dir) => {
    for await (const [, h] of dir.entries()) {
      if (h.kind === 'file') total += (await h.getFile()).size;
      else await walk(h);
    }
  };
  try { await walk(await getDir(parts, false)); } catch (e) { if (!(e && e.name === 'NotFoundError')) throw e; }
  return total;
}

/** 端末の保存領域の状況（推定）。 */
export async function storageStatus() {
  const out = { persisted: null, usage: null, quota: null };
  try { out.persisted = await navigator.storage.persisted(); } catch { /* 不明 */ }
  try {
    const e = await navigator.storage.estimate();
    out.usage = e.usage ?? null;
    out.quota = e.quota ?? null;
  } catch { /* 不明 */ }
  return out;
}

/** 起動時に永続化を求め、結果を返す（設計書 4.4）。 */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* 不明 */ }
  return null;
}
