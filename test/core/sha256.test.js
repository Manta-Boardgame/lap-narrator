import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createSha256, sha256Hex } from '../../core/sha256.js';

const enc = new TextEncoder();
const ref = (u8) => createHash('sha256').update(u8).digest('hex');

// FIPS 180-4 / NIST の既知のテストベクトル
test('SHA-256: 既知のテストベクトル（空、abc、448 ビット、896 ビット）', () => {
  assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(
    sha256Hex(enc.encode('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu')),
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  );
});

test('SHA-256: 100 万個の a（FIPS 180-4 の長い入力）、細かく分けて渡す', () => {
  const s = createSha256();
  const chunk = enc.encode('a'.repeat(1000));
  for (let i = 0; i < 1000; i++) s.update(chunk);
  assert.equal(s.digestHex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256: 1 バイトずつ渡しても同じ', () => {
  const data = enc.encode('The quick brown fox jumps over the lazy dog');
  const s = createSha256();
  for (const b of data) s.update(new Uint8Array([b]));
  assert.equal(s.digestHex(), 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('SHA-256: 0〜600 バイトの全長を node:crypto と照合（ブロック境界とパディング境界）', () => {
  const data = randomBytes(600);
  for (let n = 0; n <= 600; n++) {
    assert.equal(sha256Hex(data.subarray(0, n)), ref(data.subarray(0, n)), `n=${n}`);
  }
});

test('SHA-256: 乱数の入力と、分割の仕方を変えた多数の組が node:crypto と一致', () => {
  for (let trial = 0; trial < 300; trial++) {
    const n = Math.floor(Math.random() * 5000);
    const data = randomBytes(n);
    const s = createSha256();
    let off = 0;
    while (off < n) {
      const len = Math.min(n - off, Math.floor(Math.random() * 200));
      s.update(data.subarray(off, off + len));
      off += len;
      if (Math.random() < 0.1) s.digestHex(); // 途中で読んでも状態は壊れない
    }
    assert.equal(s.digestHex(), ref(data), `trial=${trial} n=${n}`);
  }
});

test('SHA-256: 大きな入力（64MiB）と、不揃いな分割', () => {
  const total = 64 * 1024 * 1024;
  const big = randomBytes(total);
  const s = createSha256();
  let off = 0;
  const sizes = [1, 63, 64, 65, 1000003, 4096, 333, 65536 * 7 + 5];
  let i = 0;
  while (off < total) {
    const len = Math.min(total - off, sizes[i++ % sizes.length]);
    s.update(big.subarray(off, off + len));
    off += len;
  }
  assert.equal(s.digestHex(), ref(big));
});

test('SHA-256: 開始位置がずれた view（byteOffset が 0 でない）でも正しい', () => {
  const base = randomBytes(1000);
  const view = base.subarray(37, 937);
  assert.equal(sha256Hex(view), ref(Buffer.from(view)));
  const ab = new Uint8Array(base.buffer, base.byteOffset + 3, 100);
  assert.equal(sha256Hex(ab), ref(Buffer.from(ab)));
});

test('SHA-256: digestHex を 2 回呼んでも同じで、続けて update できる', () => {
  const s = createSha256();
  s.update(enc.encode('ab'));
  const d1 = s.digestHex();
  assert.equal(s.digestHex(), d1);
  assert.equal(d1, ref(enc.encode('ab')));
  s.update(enc.encode('c'));
  assert.equal(s.digestHex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('SHA-256: Uint8Array 以外は拒否（文字列など）', () => {
  assert.throws(() => createSha256().update('abc'), TypeError);
  assert.throws(() => sha256Hex(null), TypeError);
});

// 4GiB を超える入力（長さフィールドの上位語）。時間がかかるので LAP_HEAVY=1 のときだけ動かす。
test('SHA-256: 4GiB を超える入力が node:crypto と一致（LAP_HEAVY=1）', { skip: process.env.LAP_HEAVY !== '1', timeout: 300000 }, () => {
  const chunk = new Uint8Array(1024 * 1024 + 7);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 255;
  const mine = createSha256();
  const theirs = createHash('sha256');
  const n = Math.ceil((2 ** 32 + 12345) / chunk.length);
  for (let i = 0; i < n; i++) { mine.update(chunk); theirs.update(chunk); }
  assert.equal(mine.digestHex(), theirs.digest('hex'));
});
