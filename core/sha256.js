// 逐次の SHA-256（FIPS 180-4）。Web Crypto の digest() は全体を要するため使わない（設計書 7 章）。
// 実行環境に依存しない（Uint8Array と Uint32Array だけ）。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/**
 * 1 ブロック（64 バイト）を処理する。
 * @param {Uint32Array} h 状態（8 語）
 * @param {Uint32Array} w 作業用（64 語）
 * @param {Uint8Array} d
 * @param {number} off
 */
function compress(h, w, d, off) {
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1; // Uint32Array への代入で 2^32 を法とする
  }
  let a = h[0], b = h[1], c = h[2], d0 = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    hh = g; g = f; f = e;
    e = (d0 + t1) | 0;
    d0 = c; c = b; b = a;
    a = (t1 + t2) | 0;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d0; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

/** @param {any} u @returns {Uint8Array} */
function asBytes(u) {
  if (u instanceof Uint8Array) return u;
  if (ArrayBuffer.isView(u)) return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
  if (u instanceof ArrayBuffer) return new Uint8Array(u);
  throw new TypeError('sha256: expected Uint8Array');
}

/**
 * 逐次の SHA-256。`update` は何度でも呼べる。`digestHex` は状態を壊さない（呼んだあとも `update` を続けられる）。
 * @returns {{update(u8: Uint8Array): void, digestHex(): string}} 小文字 16 進 64 文字
 */
export function createSha256() {
  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);
  const buf = new Uint8Array(64);
  let bufLen = 0;
  let total = 0; // 入力の総バイト数

  return {
    update(input) {
      const u8 = asBytes(input);
      const n = u8.length;
      if (n === 0) return;
      total += n;
      let i = 0;
      if (bufLen > 0) {
        const take = Math.min(64 - bufLen, n);
        buf.set(u8.subarray(0, take), bufLen);
        bufLen += take;
        i = take;
        if (bufLen < 64) return;
        compress(h, w, buf, 0);
        bufLen = 0;
      }
      for (; i + 64 <= n; i += 64) compress(h, w, u8, i);
      if (i < n) {
        buf.set(u8.subarray(i), 0);
        bufLen = n - i;
      }
    },
    digestHex() {
      const hc = new Uint32Array(h);
      const tailLen = bufLen < 56 ? 64 : 128;
      const tail = new Uint8Array(tailLen);
      tail.set(buf.subarray(0, bufLen));
      tail[bufLen] = 0x80;
      // 長さ（ビット）を 64 ビットのビッグエンディアンで末尾に置く。total*8 を 2 語に分ける。
      const hi = Math.floor(total / 0x20000000);
      const lo = (total % 0x20000000) * 8;
      const dv = new DataView(tail.buffer);
      dv.setUint32(tailLen - 8, hi, false);
      dv.setUint32(tailLen - 4, lo, false);
      for (let off = 0; off < tailLen; off += 64) compress(hc, w, tail, off);
      let s = '';
      for (let i = 0; i < 8; i++) s += hc[i].toString(16).padStart(8, '0');
      return s;
    },
  };
}

/**
 * @param {Uint8Array} u8
 * @returns {string} 小文字 16 進 64 文字
 */
export function sha256Hex(u8) {
  const s = createSha256();
  s.update(u8);
  return s.digestHex();
}
