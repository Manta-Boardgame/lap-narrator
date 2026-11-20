// 試験用：メモリ上の ZIP の読み書きの補助と、独立に書いた簡単な構造の読み取り。
import { createZipWriter } from '../../../core/zip.js';

export function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** メモリに書く writer。files は [name, data(Uint8Array|iterable), opts?] の配列 */
export async function buildZip(files, wopts = {}) {
  const chunks = [];
  const w = createZipWriter({ write: (u8) => { chunks.push(u8.slice()); }, ...wopts });
  const results = [];
  for (const [name, data, o] of files) results.push(await w.addFile(name, data, o));
  const fin = await w.finish();
  const bytes = concat(chunks);
  if (bytes.length !== fin.bytes) throw new Error(`finish().bytes ${fin.bytes} != ${bytes.length}`);
  return { bytes, results };
}

export function memRead(bytes) {
  return async (s, e) => bytes.slice(s, e);
}

/** 独立した簡単な読み取り：シグネチャの位置 */
export function findSigs(bytes, sig) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i + 4 <= bytes.length; i++) if (dv.getUint32(i, true) === sig) out.push(i);
  return out;
}

/** 終端レコードの生の値 */
export function rawEocd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pos = bytes.length - 22; // コメントなしの書き手なので末尾 22 バイト
  if (dv.getUint32(pos, true) !== 0x06054b50) throw new Error('EOCD not at end');
  return {
    pos,
    entriesDisk: dv.getUint16(pos + 8, true),
    entries: dv.getUint16(pos + 10, true),
    cdSize: dv.getUint32(pos + 12, true),
    cdOffset: dv.getUint32(pos + 16, true),
  };
}

/** 中央ディレクトリの生の値（読み手とは別に書いた） */
export function rawCentral(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const e = rawEocd(bytes);
  let cdOffset = e.cdOffset;
  let n = e.entries;
  const z64 = findSigs(bytes, 0x06064b50);
  if (z64.length) {
    const p = z64[z64.length - 1];
    n = Number(dv.getBigUint64(p + 32, true));
    cdOffset = Number(dv.getBigUint64(p + 48, true));
  }
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central #${i} at ${p}`);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const rec = {
      madeBy: dv.getUint16(p + 4, true),
      need: dv.getUint16(p + 6, true),
      flags: dv.getUint16(p + 8, true),
      method: dv.getUint16(p + 10, true),
      time: dv.getUint16(p + 12, true),
      date: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true),
      csize32: dv.getUint32(p + 20, true),
      usize32: dv.getUint32(p + 24, true),
      lho32: dv.getUint32(p + 42, true),
      name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      extra: bytes.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen),
    };
    out.push(rec);
    p += 46 + nameLen + extraLen + dv.getUint16(p + 32, true);
  }
  return out;
}

/** 局所ヘッダーの生の値 */
export function rawLocal(bytes, off) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(off, true) !== 0x04034b50) throw new Error(`bad local header at ${off}`);
  const nameLen = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  return {
    need: dv.getUint16(off + 4, true),
    flags: dv.getUint16(off + 6, true),
    method: dv.getUint16(off + 8, true),
    crc: dv.getUint32(off + 14, true),
    csize32: dv.getUint32(off + 18, true),
    usize32: dv.getUint32(off + 22, true),
    name: new TextDecoder().decode(bytes.subarray(off + 30, off + 30 + nameLen)),
    extra: bytes.slice(off + 30 + nameLen, off + 30 + nameLen + extraLen),
    dataOffset: off + 30 + nameLen + extraLen,
  };
}

/** zip64 拡張（id 0x0001）の中身を、64 ビット値の配列で返す。なければ null */
export function z64Fields(extra) {
  const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    if (id === 1) {
      const vals = [];
      for (let q = p + 4; q + 8 <= p + 4 + len; q += 8) vals.push(Number(dv.getBigUint64(q, true)));
      return vals;
    }
    p += 4 + len;
  }
  return null;
}

export const PY_INSPECT = `
import sys, zipfile, json, hashlib
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
out = {"testzip": bad, "entries": []}
for i in z.infolist():
    data = z.read(i)
    out["entries"].append({"name": i.filename, "size": i.file_size, "csize": i.compress_size, "type": i.compress_type,
        "date": list(i.date_time), "flags": i.flag_bits, "off": i.header_offset, "extra": i.extra.hex(),
        "sha": hashlib.sha256(data).hexdigest(), "crc": i.CRC})
print(json.dumps(out))
`;
