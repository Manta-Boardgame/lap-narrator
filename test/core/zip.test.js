import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { writeFileSync, mkdirSync, rmSync, createWriteStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createZipWriter, readZipDirectory, readZipEntry, crc32, ZipError } from '../../core/zip.js';
import { sha256Hex } from '../../core/sha256.js';
import { runPython, hasPython, WORK_A } from './helpers/python.js';
import { buildZip, memRead, concat, findSigs, rawEocd, rawCentral, rawLocal, z64Fields, PY_INSPECT } from './helpers/zipbytes.js';

const enc = new TextEncoder();
const hex = (u8) => createHash('sha256').update(u8).digest('hex');
const DIR = join(WORK_A, 'zip-test');

async function collect(it) {
  const chunks = [];
  for await (const c of it) chunks.push(c);
  return concat(chunks);
}
async function readAll(bytes, entries) {
  const out = {};
  for (const e of entries) out[e.name] = await collect(readZipEntry(memRead(bytes), e));
  return out;
}
function pyInspect(bytes, name = 'x.zip') {
  mkdirSync(DIR, { recursive: true });
  const p = join(DIR, name);
  writeFileSync(p, bytes);
  const r = runPython(PY_INSPECT, [p]);
  assert.equal(r.status, 0, `python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const pyTest = { skip: !hasPython };

test.after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 後始末 */ } });

// ---------------------------------------------------------------- CRC-32

test('crc32: 既知の値と zlib.crc32 に一致、続きの計算ができる', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  for (let n = 0; n < 300; n++) {
    const d = randomBytes(n);
    assert.equal(crc32(d), nodeCrc32(d), `n=${n}`);
  }
  const big = randomBytes(1_000_003);
  assert.equal(crc32(big), nodeCrc32(big));
  const a = big.subarray(0, 12345);
  const b = big.subarray(12345);
  assert.equal(crc32(b, crc32(a)), nodeCrc32(big));
});

// ---------------------------------------------------------------- 書いて読む（自分の読み手）

test('ZIP: 書いたものを自分の読み手で読める（空、1 バイト、日本語名、スペース、大きめ）', async () => {
  const files = [
    ['README.txt', enc.encode('hello\n')],
    ['empty.bin', new Uint8Array(0)],
    ['one.bin', new Uint8Array([7])],
    ['日本語/ファイル 名.txt', enc.encode('こんにちは')],
    ['raw/rec-000001.wav', randomBytes(300_001)],
  ];
  const { bytes, results } = await buildZip(files);
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.deepEqual(dir.map((e) => e.name), files.map((f) => f[0]));
  assert.deepEqual(dir.map((e) => e.size), files.map((f) => f[1].length));
  const got = await readAll(bytes, dir);
  for (const [name, data] of files) assert.deepEqual(got[name], new Uint8Array(data), name);
  // addFile の戻り値は大きさと SHA-256
  results.forEach((r, i) => { assert.equal(r.bytes, files[i][1].length); assert.equal(r.sha256, hex(files[i][1])); });
  // CRC は中央ディレクトリに入っている
  dir.forEach((e, i) => assert.equal(e.crc32, nodeCrc32(files[i][1])));
  assert.ok(dir.every((e) => e.method === 0 && e.compressedSize === e.size));
});

test('ZIP: 同じ入力から同じバイト列（固定日付）、日付は 1980-01-01 00:00:00', async () => {
  const files = [['a.txt', enc.encode('A')], ['b/c.txt', enc.encode('BC')]];
  const x = await buildZip(files);
  const y = await buildZip(files);
  assert.deepEqual(x.bytes, y.bytes);
  const cd = rawCentral(x.bytes);
  for (const r of cd) { assert.equal(r.time, 0); assert.equal(r.date, 0x0021); assert.equal(r.method, 0); assert.ok(r.flags & 0x0800); }
});

test('ZIP: 空の ZIP（項目 0 件）も書けて読める', async () => {
  const { bytes } = await buildZip([]);
  assert.equal(bytes.length, 22);
  assert.deepEqual(await readZipDirectory(memRead(bytes), bytes.length), []);
});

test('ZIP: 流し込み（同期、非同期、大きさを教える／教えない）を書いて読める', async () => {
  const a = randomBytes(10_000);
  const b = randomBytes(5_555);
  async function* agen() { for (let i = 0; i < b.length; i += 1000) yield new Uint8Array(b.subarray(i, i + 1000)); }
  const files = [
    ['sync.bin', [new Uint8Array(a.subarray(0, 3000)), new Uint8Array(a.subarray(3000))], { size: a.length }],
    ['async.bin', agen(), { size: b.length }],
    ['nohint.bin', [new Uint8Array(a)]],
    ['none.bin', []],
  ];
  const { bytes, results } = await buildZip(files);
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  const got = await readAll(bytes, dir);
  assert.deepEqual(got['sync.bin'], new Uint8Array(a));
  assert.deepEqual(got['async.bin'], new Uint8Array(b));
  assert.deepEqual(got['nohint.bin'], new Uint8Array(a));
  assert.equal(got['none.bin'].length, 0);
  assert.deepEqual(results.map((r) => r.sha256), [hex(a), hex(b), hex(a), hex(new Uint8Array(0))]);
  // 流し込みはデータ記述子（bit 3）を使う
  const cd = rawCentral(bytes);
  assert.ok(cd.every((r) => r.flags & 0x0008));
  // 大きさを教えた項目は ZIP64 の拡張を付けない。教えない項目は付ける（4GiB を超えても壊れない安全側）
  const l0 = rawLocal(bytes, 0);
  assert.equal(l0.extra.length, 0);
  const noHintOff = dir.find((e) => e.name === 'nohint.bin').offset;
  assert.deepEqual(z64Fields(rawLocal(bytes, noHintOff).extra), [0, 0]);
  // ただし中央ディレクトリは、実際の大きさが小さければ通常の 32 ビット
  assert.equal(z64Fields(cd[2].extra), null);
  assert.equal(cd[2].usize32, a.length);
});

test('ZIP: 大きさを教えた値と実際が違う、4GiB 超なのに教えていない、はエラー', async () => {
  await assert.rejects(buildZip([['x', [new Uint8Array(10)], { size: 11 }]]), { code: 'size-mismatch' });
  await assert.rejects(
    buildZip([['x', [new Uint8Array(200)], { size: 5 }]], { _limits: { size: 100 } }),
    { code: 'size-mismatch' },
  );
  // 教えた大きさが閾値未満なのに、実際は閾値以上（教え方の誤り）
  await assert.rejects(
    buildZip([['x', [new Uint8Array(200)], { size: 150 }]], { _limits: { size: 100 } }),
    { code: 'size-mismatch' },
  );
});

test('ZIP: 不正な名前、重複、不正なデータ、終了後の追加は拒否され、書き手は壊れない（事前に分かる誤り）', async () => {
  const chunks = [];
  const w = createZipWriter({ write: (u8) => { chunks.push(u8.slice()); } });
  await assert.rejects(w.addFile('', new Uint8Array(1)), { code: 'bad-name' });
  await assert.rejects(w.addFile('dir/', new Uint8Array(0)), { code: 'bad-name' });
  await assert.rejects(w.addFile('a\u0000b', new Uint8Array(0)), { code: 'bad-name' });
  await assert.rejects(w.addFile('x'.repeat(70000), new Uint8Array(0)), { code: 'bad-name' });
  await assert.rejects(w.addFile('ok', 'string'), TypeError);
  await assert.rejects(w.addFile('ok', null), TypeError);
  await assert.rejects(w.addFile('ok', new Uint8Array(0), { size: -1 }), RangeError);
  await w.addFile('ok', enc.encode('1'));
  await assert.rejects(w.addFile('ok', enc.encode('2')), { code: 'duplicate-name' });
  await w.addFile('ok2', enc.encode('2'));
  await w.finish();
  await assert.rejects(w.addFile('late', enc.encode('3')), { code: 'finished' });
  await assert.rejects(w.finish(), { code: 'finished' });
  const bytes = concat(chunks);
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.deepEqual(dir.map((e) => e.name), ['ok', 'ok2']);
});

test('ZIP: write が失敗したら以降は使えない', async () => {
  let n = 0;
  const w = createZipWriter({ write: () => { if (++n === 2) throw new Error('disk full'); } });
  await assert.rejects(w.addFile('a', enc.encode('hello')), /disk full/);
  await assert.rejects(w.addFile('b', enc.encode('x')), { code: 'writer-broken' });
});

test('ZIP: addFile を待たずに続けて呼んでも順に書く', async () => {
  const chunks = [];
  const w = createZipWriter({ write: async (u8) => { await new Promise((r) => setTimeout(r, 1)); chunks.push(u8.slice()); } });
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(w.addFile(`f${i}`, enc.encode(`data${i}`)));
  const fin = w.finish();
  await Promise.all(ps);
  await fin;
  const bytes = concat(chunks);
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.deepEqual(dir.map((e) => e.name), ['f0', 'f1', 'f2', 'f3', 'f4']);
  const got = await readAll(bytes, dir);
  assert.equal(new TextDecoder().decode(got.f3), 'data3');
});

// ---------------------------------------------------------------- Python の zipfile が読む

test('Python zipfile が読める（auto）：名前、中身、無圧縮、固定日付、UTF-8 フラグ', pyTest, async () => {
  const files = [
    ['README.txt', enc.encode('hello\n')],
    ['empty.bin', new Uint8Array(0)],
    ['日本語/ファイル 名.txt', enc.encode('こんにちは')],
    ['raw/rec-000001.wav', randomBytes(200_000)],
    ['stream.bin', [randomBytes(70_000)], { size: 70_000 }],
  ];
  const { bytes } = await buildZip(files);
  const info = pyInspect(bytes);
  assert.equal(info.testzip, null);
  assert.deepEqual(info.entries.map((e) => e.name), files.map((f) => f[0]));
  for (let i = 0; i < 4; i++) {
    const e = info.entries[i];
    assert.equal(e.size, files[i][1].length);
    assert.equal(e.csize, files[i][1].length);
    assert.equal(e.type, 0);
    assert.deepEqual(e.date, [1980, 1, 1, 0, 0, 0]);
    assert.equal(e.sha, hex(files[i][1]));
    assert.ok(e.flags & 0x800, 'UTF-8 flag');
    assert.equal(e.extra, '');
  }
  assert.equal(info.entries[4].size, 70_000);
  assert.ok(info.entries[4].flags & 0x8, 'data descriptor flag');
});

test('Python zipfile が読める（流し込みで大きさを教えない項目：局所ヘッダーに ZIP64 拡張）', pyTest, async () => {
  const d = randomBytes(33_333);
  const { bytes } = await buildZip([['a', [d]], ['b', [new Uint8Array(d.subarray(0, 100))], { size: 100 }]]);
  const info = pyInspect(bytes);
  assert.equal(info.testzip, null);
  assert.equal(info.entries[0].sha, hex(d));
  assert.equal(info.entries[1].sha, hex(d.subarray(0, 100)));
});

test('ZIP64 always：構造のバイト列（独立に読む）と Python zipfile の両方で確かめる', pyTest, async () => {
  const files = [['a.txt', enc.encode('AAA')], ['日本語.bin', randomBytes(1000)], ['s.bin', [randomBytes(500)], { size: 500 }]];
  const { bytes } = await buildZip(files, { zip64: 'always' });
  // 終端：ZIP64 の終端レコードと locator が EOCD の直前にある。EOCD の欄は 0xFFFF / 0xFFFFFFFF
  const eocd = rawEocd(bytes);
  assert.equal(eocd.entries, 0xffff);
  assert.equal(eocd.cdSize, 0xffffffff);
  assert.equal(eocd.cdOffset, 0xffffffff);
  const z64 = findSigs(bytes, 0x06064b50);
  const loc = findSigs(bytes, 0x07064b50);
  assert.equal(z64.length, 1);
  assert.equal(loc.length, 1);
  assert.equal(loc[0], eocd.pos - 20);
  assert.equal(z64[0] + 56, loc[0]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(Number(dv.getBigUint64(z64[0] + 4, true)), 44);
  assert.equal(Number(dv.getBigUint64(z64[0] + 24, true)), 3);
  assert.equal(Number(dv.getBigUint64(z64[0] + 32, true)), 3);
  assert.equal(Number(dv.getBigUint64(loc[0] + 8, true)), z64[0]);
  assert.equal(dv.getUint32(loc[0] + 16, true), 1);
  // 各項目：32 ビットの欄は 0xFFFFFFFF、拡張に大きさ 2 つと位置
  const cd = rawCentral(bytes);
  cd.forEach((r, i) => {
    assert.equal(r.usize32, 0xffffffff);
    assert.equal(r.csize32, 0xffffffff);
    assert.equal(r.lho32, 0xffffffff);
    assert.equal(r.need, 45);
    const f = z64Fields(r.extra);
    const size = [3, 1000, 500][i];
    assert.equal(f.length, 3);
    assert.equal(f[0], size);
    assert.equal(f[1], size);
    assert.equal(rawLocal(bytes, f[2]).name, files[i][0]);
  });
  // 局所ヘッダーにも ZIP64 の拡張
  assert.deepEqual(z64Fields(rawLocal(bytes, z64Fields(cd[0].extra)[2]).extra), [3, 3]);
  // 自分の読み手
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.deepEqual(dir.map((e) => [e.name, e.size]), [['a.txt', 3], ['日本語.bin', 1000], ['s.bin', 500]]);
  const got = await readAll(bytes, dir);
  assert.deepEqual(got['a.txt'], enc.encode('AAA'));
  // Python
  const info = pyInspect(bytes);
  assert.equal(info.testzip, null);
  assert.deepEqual(info.entries.map((e) => [e.name, e.size]), [['a.txt', 3], ['日本語.bin', 1000], ['s.bin', 500]]);
  assert.equal(info.entries[0].sha, hex(enc.encode('AAA')));
  assert.equal(info.entries[1].sha, hex(files[1][1]));
  assert.ok(info.entries.every((e) => e.extra.startsWith('0100')), 'zip64 extra present');
});

test('閾値を差し替えた ZIP64（大きさ）：閾値以上の項目だけ ZIP64、それ未満は通常', pyTest, async () => {
  const small = enc.encode('x'.repeat(99)); // 閾値 100 未満
  const edge = enc.encode('y'.repeat(100)); // ちょうど閾値 → ZIP64
  const big = randomBytes(500);
  const { bytes } = await buildZip([['small', small], ['edge', edge], ['big', big], ['streamed', [randomBytes(300)], { size: 300 }]], { _limits: { size: 100 } });
  const cd = rawCentral(bytes);
  assert.equal(z64Fields(cd[0].extra), null);
  assert.equal(cd[0].usize32, 99);
  assert.deepEqual(z64Fields(cd[1].extra), [100, 100]);
  assert.equal(cd[1].usize32, 0xffffffff);
  assert.deepEqual(z64Fields(cd[2].extra), [500, 500]);
  assert.deepEqual(z64Fields(cd[3].extra), [300, 300]);
  assert.ok(cd.every((r, i) => i === 0 || r.need === 45));
  // 局所ヘッダー：Uint8Array は実際の大きさを拡張に、小さい項目は付けない
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.equal(rawLocal(bytes, dir[0].offset).extra.length, 0);
  assert.deepEqual(z64Fields(rawLocal(bytes, dir[1].offset).extra), [100, 100]);
  assert.deepEqual(dir.map((e) => e.size), [99, 100, 500, 300]);
  const info = pyInspect(bytes);
  assert.equal(info.testzip, null);
  assert.deepEqual(info.entries.map((e) => e.size), [99, 100, 500, 300]);
  assert.equal(info.entries[1].sha, hex(edge));
  assert.equal(info.entries[2].sha, hex(big));
  // 終端：中央ディレクトリの大きさが閾値以上になると ZIP64 の終端が付く
  assert.ok(findSigs(bytes, 0x06064b50).length === 1);
});

test('閾値を差し替えた ZIP64（位置）：閾値以上の位置にある項目だけ、位置を拡張に入れる', pyTest, async () => {
  // 項目 0（位置 0）、項目 1（位置 = 局所ヘッダー + 200 バイト）… 閾値 300
  const files = [['a', randomBytes(200)], ['b', randomBytes(200)], ['c', randomBytes(200)], ['d', randomBytes(50)]];
  const { bytes } = await buildZip(files, { _limits: { offset: 300 } });
  const cd = rawCentral(bytes);
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  dir.forEach((e, i) => {
    const over = e.offset >= 300;
    assert.equal(cd[i].lho32 === 0xffffffff, over, `${e.name} offset=${e.offset}`);
    const f = z64Fields(cd[i].extra);
    if (over) { assert.deepEqual(f, [e.offset]); assert.equal(cd[i].need, 45); } else assert.equal(f, null);
    assert.equal(cd[i].usize32, files[i][1].length); // 大きさは通常の欄
  });
  assert.ok(dir.some((e) => e.offset >= 300) && dir.some((e) => e.offset < 300));
  const info = pyInspect(bytes);
  assert.equal(info.testzip, null);
  info.entries.forEach((e, i) => { assert.equal(e.off, dir[i].offset); assert.equal(e.sha, hex(files[i][1])); });
  // 中央ディレクトリの位置も閾値以上なので、終端も ZIP64
  assert.equal(findSigs(bytes, 0x06064b50).length, 1);
  assert.equal(rawEocd(bytes).cdOffset, 0xffffffff);
});

test('閾値を差し替えた ZIP64（件数）：閾値未満は通常の終端、閾値以上で ZIP64 の終端', pyTest, async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => [`f${i}`, enc.encode(`d${i}`)]);
  const a = await buildZip(mk(2), { _limits: { count: 3 } });
  assert.equal(findSigs(a.bytes, 0x06064b50).length, 0);
  assert.equal(rawEocd(a.bytes).entries, 2);
  const b = await buildZip(mk(3), { _limits: { count: 3 } });
  assert.equal(findSigs(b.bytes, 0x06064b50).length, 1);
  assert.equal(rawEocd(b.bytes).entries, 0xffff);
  for (const z of [a, b]) {
    const dir = await readZipDirectory(memRead(z.bytes), z.bytes.length);
    const info = pyInspect(z.bytes);
    assert.equal(info.testzip, null);
    assert.deepEqual(info.entries.map((e) => e.name), dir.map((e) => e.name));
  }
  assert.equal((await readZipDirectory(memRead(b.bytes), b.bytes.length)).length, 3);
});

test('本物の件数の境界：65534 件は通常、65535 件と 65536 件は ZIP64 の終端。Python で読める', pyTest, async () => {
  for (const n of [65534, 65535, 65536]) {
    const chunks = [];
    const w = createZipWriter({ write: (u8) => { chunks.push(u8); } });
    const empty = new Uint8Array(0);
    for (let i = 0; i < n; i++) await w.addFile(`e/${i}`, empty);
    await w.finish();
    const bytes = concat(chunks);
    const z64 = findSigs(bytes, 0x06064b50).length;
    assert.equal(z64, n >= 65535 ? 1 : 0, `n=${n}`);
    const dir = await readZipDirectory(memRead(bytes), bytes.length);
    assert.equal(dir.length, n);
    assert.equal(dir[n - 1].name, `e/${n - 1}`);
    const info = pyInspect(bytes, `many-${n}.zip`);
    assert.equal(info.entries.length, n);
    assert.equal(info.entries[n - 1].name, `e/${n - 1}`);
  }
});

// ---------------------------------------------------------------- Python が作った ZIP を読む

const PY_MAKE = `
import sys, zipfile, io, os, json
kind, path = sys.argv[1], sys.argv[2]
class NoSeek(io.RawIOBase):
    def __init__(self, f): self.f = f
    def writable(self): return True
    def write(self, b): return self.f.write(b)
    def flush(self): self.f.flush()
with open(path, "wb") as raw:
    if kind == "stored":
        z = zipfile.ZipFile(raw, "w", zipfile.ZIP_STORED)
        z.writestr("a.txt", b"hello")
        z.writestr("日本語.txt", "こんにちは".encode("utf-8"))
        z.writestr("dir/empty", b"")
        z.writestr("big.bin", bytes(range(256)) * 1000)
        z.close()
    elif kind == "force64":
        z = zipfile.ZipFile(raw, "w", zipfile.ZIP_STORED)
        zi = zipfile.ZipInfo("f64.bin"); zi.compress_type = zipfile.ZIP_STORED
        with z.open(zi, "w", force_zip64=True) as f: f.write(b"force64 data" * 100)
        z.writestr("normal.txt", b"normal")
        z.close()
    elif kind == "stream":
        z = zipfile.ZipFile(NoSeek(raw), "w", zipfile.ZIP_STORED)
        zi = zipfile.ZipInfo("s.bin"); zi.compress_type = zipfile.ZIP_STORED
        with z.open(zi, "w") as f: f.write(b"streamed " * 500)
        z.writestr("t.txt", b"t")
        z.close()
    elif kind == "many":
        z = zipfile.ZipFile(raw, "w", zipfile.ZIP_STORED)
        for i in range(70000): z.writestr("m/%d" % i, b"")
        z.close()
    elif kind == "deflate":
        z = zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED)
        z.writestr("c.txt", b"compress me " * 100)
        z.close()
`;
function pyMake(kind) {
  mkdirSync(DIR, { recursive: true });
  const p = join(DIR, `py-${kind}.zip`);
  const r = runPython(PY_MAKE, [kind, p]);
  assert.equal(r.status, 0, r.stderr);
  return new Uint8Array(readFileSyncBuf(p));
}
import { readFileSync } from 'node:fs';
function readFileSyncBuf(p) { return readFileSync(p); }

test('Python が作った ZIP を読める：無圧縮、日本語名、空の項目', pyTest, async () => {
  const bytes = pyMake('stored');
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.deepEqual(dir.map((e) => e.name), ['a.txt', '日本語.txt', 'dir/empty', 'big.bin']);
  const got = await readAll(bytes, dir);
  assert.equal(new TextDecoder().decode(got['日本語.txt']), 'こんにちは');
  assert.equal(got['big.bin'].length, 256_000);
  assert.equal(got['dir/empty'].length, 0);
});

test('Python が作った ZIP を読める：force_zip64、データ記述子（シーク不可の出力）', pyTest, async () => {
  for (const kind of ['force64', 'stream']) {
    const bytes = pyMake(kind);
    const dir = await readZipDirectory(memRead(bytes), bytes.length);
    const got = await readAll(bytes, dir);
    if (kind === 'force64') {
      assert.deepEqual(dir.map((e) => e.name), ['f64.bin', 'normal.txt']);
      assert.equal(new TextDecoder().decode(got['f64.bin']), 'force64 data'.repeat(100));
    } else {
      assert.deepEqual(dir.map((e) => e.name), ['s.bin', 't.txt']);
      assert.equal(new TextDecoder().decode(got['s.bin']), 'streamed '.repeat(500));
      assert.ok(dir[0].flags & 8, 'Python が bit 3 を使った');
    }
  }
});

test('Python が作った 70000 件の ZIP（ZIP64 の終端）を読める', pyTest, async () => {
  const bytes = pyMake('many');
  assert.ok(findSigs(bytes, 0x06064b50).length >= 1);
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.equal(dir.length, 70000);
  assert.equal(dir[69999].name, 'm/69999');
});

test('圧縮された項目は一覧には出るが、readZipEntry は unsupported', pyTest, async () => {
  const bytes = pyMake('deflate');
  const dir = await readZipDirectory(memRead(bytes), bytes.length);
  assert.equal(dir[0].name, 'c.txt');
  assert.equal(dir[0].method, 8);
  await assert.rejects(collect(readZipEntry(memRead(bytes), dir[0])), { code: 'unsupported' });
});

// ---------------------------------------------------------------- 読み手の堅さ

test('readZipEntry：chunkBytes ごとに返す、中身は一致、CRC を照合する', async () => {
  const d = randomBytes(10_001);
  const { bytes } = await buildZip([['x', d]]);
  const [e] = await readZipDirectory(memRead(bytes), bytes.length);
  const sizes = [];
  const chunks = [];
  for await (const c of readZipEntry(memRead(bytes), e, { chunkBytes: 4096 })) { sizes.push(c.length); chunks.push(c); }
  assert.deepEqual(sizes, [4096, 4096, 1809]);
  assert.deepEqual(concat(chunks), new Uint8Array(d));
  // 空の項目：何も返さない
  const z2 = await buildZip([['e', new Uint8Array(0)]]);
  const [e2] = await readZipDirectory(memRead(z2.bytes), z2.bytes.length);
  assert.deepEqual((await collect(readZipEntry(memRead(z2.bytes), e2))).length, 0);
  // 壊す：データの 1 バイトを変えると、最後に crc-mismatch
  const broken = bytes.slice();
  broken[e.offset + 30 + 1 + 5000] ^= 0xff;
  await assert.rejects(collect(readZipEntry(memRead(broken), e)), { code: 'crc-mismatch' });
  // verifyCrc:false なら通る
  const raw = await collect(readZipEntry(memRead(broken), e, { verifyCrc: false }));
  assert.equal(raw.length, d.length);
  await assert.rejects(readZipEntry(memRead(bytes), e, { chunkBytes: 0 }).next(), RangeError);
});

test('readZipEntry：チャンクの大きさ 1 でも同じ中身', async () => {
  const d = randomBytes(100);
  const { bytes } = await buildZip([['x', d]]);
  const [e] = await readZipDirectory(memRead(bytes), bytes.length);
  assert.deepEqual(await collect(readZipEntry(memRead(bytes), e, { chunkBytes: 1 })), new Uint8Array(d));
});

test('readZipDirectory：ZIP でない／切れた／短い入力は ZipError', async () => {
  await assert.rejects(readZipDirectory(memRead(new Uint8Array(0)), 0), ZipError);
  await assert.rejects(readZipDirectory(memRead(new Uint8Array(21)), 21), { code: 'not-a-zip' });
  const junk = randomBytes(5000);
  await assert.rejects(readZipDirectory(memRead(junk), junk.length), { code: 'not-a-zip' });
  const { bytes } = await buildZip([['a', enc.encode('hello')], ['b', randomBytes(300)]]);
  for (const cut of [bytes.length - 1, bytes.length - 22, bytes.length - 40, 60, 30, 1]) {
    await assert.rejects(readZipDirectory(memRead(bytes.slice(0, cut)), cut), ZipError, `cut=${cut}`);
  }
  // 中央ディレクトリの位置が範囲外
  const bad = bytes.slice();
  new DataView(bad.buffer).setUint32(bad.length - 6, 0x7fffffff, true);
  await assert.rejects(readZipDirectory(memRead(bad), bad.length), { code: 'bad-directory' });
  // read が短いバイト列を返す
  await assert.rejects(readZipDirectory(async (s, e) => new Uint8Array(1), bytes.length), { code: 'short-read' });
});

test('readZipDirectory：コメント付きの終端や、前に余計なデータがあるものは（コメントのみ）読める', async () => {
  const { bytes } = await buildZip([['a', enc.encode('hello')]]);
  const withComment = concat([bytes.subarray(0, bytes.length - 2), new Uint8Array([3, 0]), enc.encode('abc')]);
  const dir = await readZipDirectory(memRead(withComment), withComment.length);
  assert.deepEqual(dir.map((e) => e.name), ['a']);
});

test('ランダムな破損（1 バイト変更）で、例外は ZipError か正常終了のどちらか（クラッシュしない）', async () => {
  const { bytes } = await buildZip([['a', enc.encode('hello')], ['日本語', randomBytes(100)], ['c', [randomBytes(50)], { size: 50 }]]);
  for (let trial = 0; trial < 400; trial++) {
    const b = bytes.slice();
    b[Math.floor(Math.random() * b.length)] ^= 1 << Math.floor(Math.random() * 8);
    try {
      const dir = await readZipDirectory(memRead(b), b.length);
      for (const e of dir) await collect(readZipEntry(memRead(b), e));
    } catch (e) {
      assert.ok(e instanceof ZipError || e instanceof RangeError, `unexpected ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    }
  }
});

test('addFile の SHA-256 は node:crypto と一致（大きめのデータ）', async () => {
  const d = randomBytes(5_000_000);
  const { results } = await buildZip([['big', d]]);
  assert.equal(results[0].sha256, hex(d));
  assert.equal(results[0].sha256, sha256Hex(d));
});

// ---------------------------------------------------------------- 本物の 4GiB（時間と容量が要るので LAP_HEAVY=1 のときだけ）

test('本物の 4GiB の境界：4GiB を超える項目と、その後ろの位置（LAP_HEAVY=1）', { skip: !hasPython || process.env.LAP_HEAVY !== '1', timeout: 900000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, 'huge.zip');
  const ws = createWriteStream(path);
  const sink = (u8) => new Promise((res, rej) => { ws.write(u8, (e) => (e ? rej(e) : res())); });
  const w = createZipWriter({ write: sink });
  const total = 2 ** 32 + 12345; // 4GiB + 12345 バイト
  const block = new Uint8Array(1 << 20).fill(0x5a);
  async function* gen() {
    let left = total;
    while (left > 0) { const n = Math.min(left, block.length); yield n === block.length ? block : block.subarray(0, n); left -= n; }
  }
  const r1 = await w.addFile('huge.bin', gen(), { size: total });
  const r2 = await w.addFile('after.txt', enc.encode('after the 4GiB boundary'));
  await w.finish();
  await new Promise((res) => ws.end(res));
  assert.equal(r1.bytes, total);
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const read = async (s, e) => { const b = Buffer.alloc(e - s); readSync(fd, b, 0, e - s, s); return new Uint8Array(b); };
  try {
    const dir = await readZipDirectory(read, size);
    assert.equal(dir[0].size, total);
    assert.ok(dir[1].offset >= 2 ** 32, 'after.txt の位置は 4GiB 以上');
    assert.equal(new TextDecoder().decode(await collect(readZipEntry(read, dir[1]))), 'after the 4GiB boundary');
    // 最初の項目の SHA-256 を読み戻して照合
    const h = createHash('sha256');
    for await (const c of readZipEntry(read, dir[0], { chunkBytes: 8 << 20 })) h.update(c);
    assert.equal(h.digest('hex'), r1.sha256);
  } finally { closeSync(fd); }
  const py = runPython(
    'import sys,zipfile,hashlib,json\nz=zipfile.ZipFile(sys.argv[1])\ni=z.infolist()\nh=hashlib.sha256()\nf=z.open(i[0])\nwhile True:\n    b=f.read(1<<24)\n    if not b: break\n    h.update(b)\nprint(json.dumps([i[0].file_size,i[1].header_offset,z.read(i[1]).decode(),h.hexdigest()]))',
    [path],
  );
  assert.equal(py.status, 0, py.stderr);
  const [psize, poff, ptext, psha] = JSON.parse(py.stdout);
  assert.equal(psize, total);
  assert.ok(poff >= 2 ** 32);
  assert.equal(ptext, 'after the 4GiB boundary');
  assert.equal(psha, r1.sha256);
  assert.equal(r2.bytes, 'after the 4GiB boundary'.length);
});
