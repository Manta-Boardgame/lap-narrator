// ファイルの入出力の道具（node:fs）。書き込みは一時ファイルに書いて、閉じるときに名前を変える。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const TMP_MARK = '.tmp-';

const tmpName = (target) => `${target}${TMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 名前の変更。Windows では、相手のファイルが一時的に使われていると失敗するので、少し待って数回やり直す */
async function renameWithRetry(from, to) {
  let last;
  for (let i = 0; i < 8; i++) {
    try { await fsp.rename(from, to); return; } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      await sleep(25 * (i + 1));
    }
  }
  throw last;
}

/**
 * 一時ファイルに書いて、`commit()` で本来の名前にする書き手。`abort()` で捨てる。親のフォルダは作る。
 * @param {string} absPath
 * @returns {Promise<{write(u8:Uint8Array):Promise<void>, commit():Promise<void>, abort():Promise<void>, path:string}>}
 */
export async function openAtomicWrite(absPath) {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = tmpName(absPath);
  const fh = await fsp.open(tmp, 'w');
  let done = false;
  return {
    path: absPath,
    async write(u8) {
      let off = 0;
      while (off < u8.length) {
        const { bytesWritten } = await fh.write(u8, off, u8.length - off);
        off += bytesWritten;
      }
    },
    async commit() {
      if (done) return;
      done = true;
      await fh.close();
      try { await renameWithRetry(tmp, absPath); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    },
    async abort() {
      if (done) return;
      done = true;
      try { await fh.close(); } catch { /* 後始末 */ }
      await fsp.rm(tmp, { force: true });
    },
  };
}

/** 小さなファイルを一度に書く（一時ファイル経由） */
export async function writeFileAtomic(absPath, data) {
  const w = await openAtomicWrite(absPath);
  try {
    await w.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    await w.commit();
  } catch (e) {
    await w.abort();
    throw e;
  }
}

/**
 * 読み取り用の入口。呼ぶたびに開いて閉じる版（`openReadAt`）ではなく、1 つの記述子を持つ版。必ず `close()` する。
 * @param {string} absPath
 * @returns {Promise<{name:string, size:number, read:(s:number,e:number)=>Promise<Uint8Array>, close:()=>Promise<void>}>}
 */
export async function openFileVolume(absPath) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw Object.assign(new Error(`not a file: ${absPath}`), { code: 'EISDIR' });
    return {
      name: path.basename(absPath),
      size: st.size,
      read: (s, e) => readRange(fh, s, e),
      close: () => fh.close(),
    };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

export async function readRange(fh, start, end) {
  const len = Math.max(0, end - start);
  const buf = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, start + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, off);
}

/** 1 回だけ範囲を読む（開いて閉じる） */
export async function readFileRange(absPath, start, end) {
  const fh = await fsp.open(absPath, 'r');
  try { return await readRange(fh, start, end); } finally { await fh.close(); }
}

export async function fileExists(absPath) {
  try { await fsp.stat(absPath); return true; } catch { return false; }
}

/** ファイルを少しずつ読んで `fn(chunk)` に渡す */
export async function streamFile(absPath, fn, chunkBytes = 1024 * 1024) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    for (let o = 0; o < size; o += chunkBytes) await fn(await readRange(fh, o, Math.min(size, o + chunkBytes)));
    return size;
  } finally { await fh.close(); }
}
