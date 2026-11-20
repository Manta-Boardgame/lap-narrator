// ZIP（CONTRACTS.md 0.7）。無圧縮（method 0）、固定日付（1980-01-01 00:00:00）、UTF-8 名、ZIP64 対応。
// 実行環境に依存しない（Uint8Array、DataView、TextEncoder、TextDecoder だけ）。
// 全体をメモリに載せない：書く側は write を呼ぶ側に渡し、読む側は read(start, end) を呼ぶ側に頼る。

import { createSha256 } from './sha256.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const DOS_TIME = 0x0000; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01
const VER_DEFAULT = 20;
const VER_ZIP64 = 45;

const textEncoder = new TextEncoder();

/** ZIP の読み書きで起きるエラー。`code` で種類が分かる。 */
export class ZipError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`zip: ${message}`);
    this.name = 'ZipError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- CRC-32（slice-by-8）

const CRC_TABLE = (() => {
  const t = new Int32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) {
      c = t[c & 255] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

/**
 * CRC-32（ZIP、PNG と同じ）。`prev` に前の結果を渡すと続きを計算できる。
 * @param {Uint8Array} u8
 * @param {number} [prev] 前までの CRC-32（符号なし）。省略は 0
 * @returns {number} 符号なし 32 ビット
 */
export function crc32(u8, prev = 0) {
  const T = CRC_TABLE;
  let c = ~prev;
  let i = 0;
  const n = u8.length;
  for (; i + 8 <= n; i += 8) {
    const lo = c ^ (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24));
    const hi = u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16) | (u8[i + 7] << 24);
    c = T[1792 + (lo & 255)] ^ T[1536 + ((lo >>> 8) & 255)] ^ T[1280 + ((lo >>> 16) & 255)] ^ T[1024 + (lo >>> 24)]
      ^ T[768 + (hi & 255)] ^ T[512 + ((hi >>> 8) & 255)] ^ T[256 + ((hi >>> 16) & 255)] ^ T[hi >>> 24];
  }
  for (; i < n; i++) c = T[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---------------------------------------------------------------- 書き手

/** 64 ビット（Number。2^53 未満）を書く */
function setU64(dv, off, v) {
  dv.setUint32(off, v % 0x100000000, true);
  dv.setUint32(off + 4, Math.floor(v / 0x100000000), true);
}

/**
 * 無圧縮・固定日付・UTF-8 名の ZIP を、`write` に順に書き出す。巻き戻さない（逐次）。
 *
 * - `zip64: 'auto'`（既定）：大きさ・位置が 0xFFFFFFFF 以上、または件数が 0xFFFF 以上のときだけ ZIP64 にする。
 *   `'always'`：すべての項目と終端に ZIP64 の構造を付ける（試験用）。
 * - `Uint8Array` を渡すと、大きさと CRC が先に分かるので、データ記述子（bit 3）を使わない。
 * - 反復可能（同期／非同期）を渡すと、少しずつ書く。CRC が先に分からないのでデータ記述子を使う。
 *   大きさを事前に知っているときは `addFile(name, data, {size})` で教える（`size` が 0xFFFFFFFF 未満なら ZIP64 を付けない）。
 *   教えないときは、4GiB を超えても壊れないよう、その項目の局所ヘッダーに ZIP64 の拡張を付ける
 *   （中央ディレクトリの大きさの欄は、実際の大きさが小さければ通常の 32 ビット）。
 * - `addFile` は直列に処理される（同時に呼んでも順に書く）。失敗した後は書き手を使えない。
 * - `_limits`：試験用の内部オプション。ZIP64 に切り替える閾値（`size`、`offset`、`count`）を差し替える。
 *   本物の 4GiB / 65535 件を作らずに、ZIP64 のバイト列を試験するための物。
 *
 * @param {{write(u8: Uint8Array): Promise<void>|void, zip64?: 'auto'|'always', _limits?: {size?:number, offset?:number, count?:number}}} opts
 * @returns {{addFile(name:string, data: Uint8Array|AsyncIterable<Uint8Array>|Iterable<Uint8Array>, o?: {size?: number}): Promise<{bytes:number, sha256:string}>, finish(): Promise<{bytes:number}>}}
 */
export function createZipWriter(opts) {
  if (!opts || typeof opts.write !== 'function') throw new TypeError('createZipWriter: write is required');
  const mode = opts.zip64 ?? 'auto';
  if (mode !== 'auto' && mode !== 'always') throw new TypeError(`createZipWriter: zip64 must be 'auto' or 'always'`);
  const always = mode === 'always';
  const lim = {
    size: opts._limits?.size ?? U32_MAX,
    offset: opts._limits?.offset ?? U32_MAX,
    count: opts._limits?.count ?? U16_MAX,
  };
  const writeFn = opts.write;
  let offset = 0;
  /** @type {{nameBytes:Uint8Array, crc:number, size:number, offset:number, flags:number}[]} */
  const entries = [];
  const names = new Set();
  let finished = false;
  let broken = false;
  let chain = Promise.resolve();

  async function out(u8) {
    if (u8.length === 0) return;
    await writeFn(u8);
    offset += u8.length;
  }

  async function doAdd(name, nameBytes, data, o) {
    const headerOffset = offset;
    const sha = createSha256();

    if (data instanceof Uint8Array) {
      const size = data.length;
      const crc = crc32(data);
      sha.update(data);
      const z = always || size >= lim.size;
      const extra = z ? new Uint8Array(20) : new Uint8Array(0);
      if (z) {
        const dv = new DataView(extra.buffer);
        dv.setUint16(0, 1, true);
        dv.setUint16(2, 16, true);
        setU64(dv, 4, size);
        setU64(dv, 12, size);
      }
      const h = new Uint8Array(30 + nameBytes.length + extra.length);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, SIG_LOCAL, true);
      dv.setUint16(4, z ? VER_ZIP64 : VER_DEFAULT, true);
      dv.setUint16(6, FLAG_UTF8, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, DOS_TIME, true);
      dv.setUint16(12, DOS_DATE, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, z ? U32_MAX : size, true);
      dv.setUint32(22, z ? U32_MAX : size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, extra.length, true);
      h.set(nameBytes, 30);
      h.set(extra, 30 + nameBytes.length);
      await out(h);
      await out(data);
      entries.push({ nameBytes, crc, size, offset: headerOffset, flags: FLAG_UTF8 });
      return { bytes: size, sha256: sha.digestHex() };
    }

    // 流し込み：CRC と大きさが先に分からない → データ記述子（bit 3）
    const hint = o && o.size !== undefined ? o.size : null;
    const z = always || hint === null || hint >= lim.size;
    const extra = z ? new Uint8Array(20) : new Uint8Array(0); // ZIP64 の拡張（大きさは 0。記述子に入る）
    if (z) {
      const dv = new DataView(extra.buffer);
      dv.setUint16(0, 1, true);
      dv.setUint16(2, 16, true);
    }
    const flags = FLAG_UTF8 | FLAG_DESCRIPTOR;
    const h = new Uint8Array(30 + nameBytes.length + extra.length);
    const hdv = new DataView(h.buffer);
    hdv.setUint32(0, SIG_LOCAL, true);
    hdv.setUint16(4, z ? VER_ZIP64 : VER_DEFAULT, true);
    hdv.setUint16(6, flags, true);
    hdv.setUint16(8, 0, true);
    hdv.setUint16(10, DOS_TIME, true);
    hdv.setUint16(12, DOS_DATE, true);
    hdv.setUint32(14, 0, true);
    hdv.setUint32(18, z ? U32_MAX : 0, true);
    hdv.setUint32(22, z ? U32_MAX : 0, true);
    hdv.setUint16(26, nameBytes.length, true);
    hdv.setUint16(28, extra.length, true);
    h.set(nameBytes, 30);
    h.set(extra, 30 + nameBytes.length);
    await out(h);
    let size = 0;
    let crc = 0;
    for await (const chunk of /** @type {any} */ (data)) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('addFile: chunks must be Uint8Array');
      crc = crc32(chunk, crc);
      sha.update(chunk);
      size += chunk.length;
      await out(chunk);
    }
    if (hint !== null && size !== hint) throw new ZipError('size-mismatch', `${name}: size hint ${hint} but wrote ${size}`);
    if (!z && size >= lim.size) throw new ZipError('zip64-required', `${name}: ${size} bytes need ZIP64 (pass the size or use zip64:'always')`);
    const d = new Uint8Array(z ? 24 : 16);
    const ddv = new DataView(d.buffer);
    ddv.setUint32(0, SIG_DESCRIPTOR, true);
    ddv.setUint32(4, crc, true);
    if (z) { setU64(ddv, 8, size); setU64(ddv, 16, size); } else { ddv.setUint32(8, size, true); ddv.setUint32(12, size, true); }
    await out(d);
    entries.push({ nameBytes, crc, size, offset: headerOffset, flags });
    return { bytes: size, sha256: sha.digestHex() };
  }

  async function doFinish() {
    const cdStart = offset;
    for (const e of entries) {
      const sizeOv = always || e.size >= lim.size;
      const offOv = always || e.offset >= lim.offset;
      const nExtra = (sizeOv ? 16 : 0) + (offOv ? 8 : 0);
      const extra = new Uint8Array(nExtra ? 4 + nExtra : 0);
      if (nExtra) {
        const dv = new DataView(extra.buffer);
        dv.setUint16(0, 1, true);
        dv.setUint16(2, nExtra, true);
        let p = 4;
        if (sizeOv) { setU64(dv, p, e.size); setU64(dv, p + 8, e.size); p += 16; }
        if (offOv) { setU64(dv, p, e.offset); p += 8; }
      }
      const rec = new Uint8Array(46 + e.nameBytes.length + extra.length);
      const dv = new DataView(rec.buffer);
      const ver = nExtra ? VER_ZIP64 : VER_DEFAULT;
      dv.setUint32(0, SIG_CENTRAL, true);
      dv.setUint16(4, ver, true); // made by（0 = MS-DOS 系）
      dv.setUint16(6, ver, true);
      dv.setUint16(8, e.flags, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, DOS_TIME, true);
      dv.setUint16(14, DOS_DATE, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, sizeOv ? U32_MAX : e.size, true);
      dv.setUint32(24, sizeOv ? U32_MAX : e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint16(30, extra.length, true);
      dv.setUint16(32, 0, true); // コメントなし
      dv.setUint16(34, 0, true); // 開始ディスク
      dv.setUint16(36, 0, true); // 内部属性
      dv.setUint32(38, 0, true); // 外部属性
      dv.setUint32(42, offOv ? U32_MAX : e.offset, true);
      rec.set(e.nameBytes, 46);
      rec.set(extra, 46 + e.nameBytes.length);
      await out(rec);
    }
    const cdSize = offset - cdStart;
    const count = entries.length;
    const needZ64 = always || count >= lim.count || cdStart >= lim.offset || cdSize >= lim.size;
    if (needZ64) {
      const rec = new Uint8Array(56 + 20);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, SIG_EOCD64, true);
      setU64(dv, 4, 44);
      dv.setUint16(12, VER_ZIP64, true);
      dv.setUint16(14, VER_ZIP64, true);
      dv.setUint32(16, 0, true);
      dv.setUint32(20, 0, true);
      setU64(dv, 24, count);
      setU64(dv, 32, count);
      setU64(dv, 40, cdSize);
      setU64(dv, 48, cdStart);
      dv.setUint32(56, SIG_LOCATOR64, true);
      dv.setUint32(60, 0, true);
      setU64(dv, 64, offset); // EOCD64 の位置
      dv.setUint32(72, 1, true);
      await out(rec);
    }
    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, SIG_EOCD, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    const cOv = always || count >= lim.count;
    dv.setUint16(8, cOv ? U16_MAX : count, true);
    dv.setUint16(10, cOv ? U16_MAX : count, true);
    dv.setUint32(12, always || cdSize >= lim.size ? U32_MAX : cdSize, true);
    dv.setUint32(16, always || cdStart >= lim.offset ? U32_MAX : cdStart, true);
    dv.setUint16(20, 0, true);
    await out(eocd);
    return { bytes: offset };
  }

  function enqueue(fn) {
    if (broken) return Promise.reject(new ZipError('writer-broken', 'a previous write failed'));
    if (finished) return Promise.reject(new ZipError('finished', 'writer is already finished'));
    const p = chain.then(fn).catch((e) => { broken = true; throw e; });
    chain = p.catch(() => {});
    return p;
  }

  return {
    addFile(name, data, o) {
      // 書き始める前に分かる誤りは、書き手を壊さずに拒否する
      let nameBytes;
      try {
        if (typeof name !== 'string' || name.length === 0) throw new ZipError('bad-name', 'empty name');
        if (name.includes('\0') || name.endsWith('/')) throw new ZipError('bad-name', `unsupported name ${JSON.stringify(name)}`);
        if (names.has(name)) throw new ZipError('duplicate-name', `duplicate name ${JSON.stringify(name)}`);
        nameBytes = textEncoder.encode(name);
        if (nameBytes.length > U16_MAX) throw new ZipError('bad-name', 'name too long');
        if (!(data instanceof Uint8Array)
          && (typeof data === 'string' || data == null || (typeof data[Symbol.asyncIterator] !== 'function' && typeof data[Symbol.iterator] !== 'function'))) {
          throw new TypeError('addFile: data must be a Uint8Array or an (async) iterable of Uint8Array');
        }
        if (o && o.size !== undefined && !(Number.isInteger(o.size) && o.size >= 0)) throw new RangeError('addFile: size must be a non-negative integer');
      } catch (e) {
        return Promise.reject(e);
      }
      const nb = nameBytes;
      if (finished || broken) return enqueue(() => undefined);
      names.add(name);
      return enqueue(() => doAdd(name, nb, data, o));
    },
    finish() {
      const p = enqueue(doFinish);
      finished = true; // 以降の addFile は拒否（すでに待っている呼び出しは先に処理される）
      return p;
    },
  };
}

// ---------------------------------------------------------------- 読み手

/** @param {(s:number,e:number)=>Promise<Uint8Array>} read @param {number} start @param {number} end */
async function readExact(read, start, end) {
  if (end === start) return new Uint8Array(0);
  const u8 = await read(start, end);
  if (!(u8 instanceof Uint8Array) || u8.length !== end - start) {
    throw new ZipError('short-read', `expected ${end - start} bytes at ${start}, got ${u8 ? u8.length : 'none'}`);
  }
  return u8;
}

/** 64 ビットを Number で読む（2^53 以上は ZipError） */
function getU64(dv, off) {
  const hi = dv.getUint32(off + 4, true);
  if (hi >= 0x200000) throw new ZipError('too-large', 'value exceeds 2^53');
  return dv.getUint32(off, true) + hi * 0x100000000;
}

const textDecoder = new TextDecoder('utf-8');

/**
 * 中央ディレクトリを読む。ZIP64（終端レコードと局所の拡張）にも対応する。
 * `offset` は局所ヘッダーの位置。`method` が 0 以外の項目も一覧には出る（`readZipEntry` が拒否する）。
 * 名前は UTF-8 として読む（bit 11 が立っていない古い ZIP も UTF-8 として読む）。
 * @param {(start:number,end:number)=>Promise<Uint8Array>} read `[start, end)` のバイト列を返す
 * @param {number} size ZIP 全体のバイト数
 * @returns {Promise<{name:string, size:number, offset:number, crc32:number, compressedSize:number, method:number, flags:number}[]>}
 */
export async function readZipDirectory(read, size) {
  if (!Number.isInteger(size) || size < 22) throw new ZipError('not-a-zip', 'too small to be a ZIP');
  // 終端レコード（EOCD）を後ろから探す
  const tailLen = Math.min(size, 22 + U16_MAX);
  const tailStart = size - tailLen;
  const tail = await readExact(read, tailStart, size);
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD && i + 22 + tdv.getUint16(i + 20, true) <= tail.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not-a-zip', 'end of central directory not found');
  const eocdPos = tailStart + eocd;
  if (tdv.getUint16(eocd + 4, true) !== 0 || tdv.getUint16(eocd + 6, true) !== 0) {
    throw new ZipError('multi-disk', 'multi-disk archives are not supported');
  }
  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);
  // ZIP64：終端の直前に locator があれば、ZIP64 の終端レコードを使う
  if (eocdPos >= 20) {
    const loc = await readExact(read, eocdPos - 20, eocdPos);
    const ldv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
    if (ldv.getUint32(0, true) === SIG_LOCATOR64) {
      if (ldv.getUint32(4, true) !== 0 || ldv.getUint32(16, true) > 1) throw new ZipError('multi-disk', 'multi-disk archives are not supported');
      const z64Pos = getU64(ldv, 8);
      if (z64Pos + 56 > eocdPos) throw new ZipError('bad-zip64', 'ZIP64 end record out of range');
      const rec = await readExact(read, z64Pos, z64Pos + 56);
      const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      if (rdv.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('bad-zip64', 'bad ZIP64 end record');
      count = getU64(rdv, 32);
      cdSize = getU64(rdv, 40);
      cdOffset = getU64(rdv, 48);
    } else if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      throw new ZipError('bad-zip64', 'ZIP64 values expected but the locator is missing');
    }
  } else if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ZipError('bad-zip64', 'ZIP64 values expected but the locator is missing');
  }
  if (cdOffset + cdSize > size) throw new ZipError('bad-directory', 'central directory out of range');
  if (cdSize > 512 * 1024 * 1024) throw new ZipError('too-large', 'central directory too large');
  const cd = await readExact(read, cdOffset, cdOffset + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const result = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('bad-directory', `bad central directory entry #${i}`);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const diskStart = dv.getUint16(p + 34, true);
    let lho = dv.getUint32(p + 42, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipError('bad-directory', `central directory entry #${i} is cut`);
    const name = textDecoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 の拡張：32 ビットの欄が 0xFFFFFFFF のものだけ、この順に入っている
    let q = p + 46 + nameLen;
    const extraEnd = q + extraLen;
    while (q + 4 <= extraEnd) {
      const id = dv.getUint16(q, true);
      const len = dv.getUint16(q + 2, true);
      const body = q + 4;
      if (body + len > extraEnd) throw new ZipError('bad-directory', `bad extra field in entry #${i}`);
      if (id === 0x0001) {
        let r = body;
        const take = () => {
          if (r + 8 > body + len) throw new ZipError('bad-zip64', `short ZIP64 extra in entry #${i}`);
          const v = getU64(dv, r);
          r += 8;
          return v;
        };
        if (usize === U32_MAX) usize = take();
        if (csize === U32_MAX) csize = take();
        if (lho === U32_MAX) lho = take();
        if (diskStart === U16_MAX && r + 4 <= body + len) r += 4;
      }
      q = body + len;
    }
    if (diskStart !== 0 && diskStart !== U16_MAX) throw new ZipError('multi-disk', 'multi-disk archives are not supported');
    result.push({ name, size: usize, offset: lho, crc32: crc, compressedSize: csize, method, flags });
    p = end;
  }
  return result;
}

/**
 * 項目の中身を、`chunkBytes`（既定 1MiB）ずつ順に返す。method 0（無圧縮）だけ。
 * `entry.crc32` があれば、最後まで読んだときに CRC を照合し、合わなければ ZipError('crc-mismatch') を投げる
 * （`opts.verifyCrc: false` で止められる）。暗号化と圧縮された項目は ZipError('unsupported')。
 * @param {(start:number,end:number)=>Promise<Uint8Array>} read
 * @param {{name:string,size:number,offset:number, crc32?:number, compressedSize?:number, method?:number, flags?:number}} entry
 * @param {{chunkBytes?:number, verifyCrc?:boolean}} [opts]
 * @returns {AsyncIterable<Uint8Array>}
 */
export async function* readZipEntry(read, entry, opts) {
  const chunkBytes = opts && opts.chunkBytes !== undefined ? opts.chunkBytes : 1024 * 1024;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('readZipEntry: chunkBytes must be a positive integer');
  if (entry.method !== undefined && entry.method !== 0) throw new ZipError('unsupported', `${entry.name}: compression method ${entry.method} is not supported`);
  if (entry.flags !== undefined && (entry.flags & 1)) throw new ZipError('unsupported', `${entry.name}: encrypted entries are not supported`);
  if (entry.compressedSize !== undefined && entry.compressedSize !== entry.size) throw new ZipError('bad-entry', `${entry.name}: stored size mismatch`);
  const head = await readExact(read, entry.offset, entry.offset + 30);
  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hdv.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('bad-entry', `${entry.name}: local header not found`);
  const dataStart = entry.offset + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
  const verify = entry.crc32 !== undefined && !(opts && opts.verifyCrc === false);
  let crc = 0;
  let pos = 0;
  while (pos < entry.size) {
    const n = Math.min(chunkBytes, entry.size - pos);
    const chunk = await readExact(read, dataStart + pos, dataStart + pos + n);
    if (verify) crc = crc32(chunk, crc);
    pos += n;
    yield chunk;
  }
  if (verify && crc !== entry.crc32) throw new ZipError('crc-mismatch', `${entry.name}: CRC-32 mismatch`);
}
