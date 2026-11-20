// 最小の PNG 書き出し。1 ビットのパレット画像（2 色）、無圧縮の deflate（stored ブロック）。
// zlib を使わないので、Node.js の版が変わっても同じバイト列になる。
import { crc32, adler32 } from './crc32.js';

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32LE(0, 0);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length).copy(out, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function zlibStored(raw) {
  const blocks = [Buffer.from([0x78, 0x01])];
  let p = 0;
  do {
    const n = Math.min(65535, raw.length - p);
    const last = p + n >= raw.length ? 1 : 0;
    const h = Buffer.alloc(5);
    h[0] = last;
    h.writeUInt16LE(n, 1);
    h.writeUInt16LE(~n & 0xffff, 3);
    blocks.push(h, Buffer.from(raw.buffer, raw.byteOffset + p, n));
    p += n;
  } while (p < raw.length);
  const ad = Buffer.alloc(4);
  ad.writeUInt32BE(adler32(raw), 0);
  blocks.push(ad);
  return Buffer.concat(blocks);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number][]} palette  2 色
 * @param {Uint8Array} pixels width*height 個、0 か 1
 * @returns {Uint8Array}
 */
export function encodePng1bpp(width, height, palette, pixels) {
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (rowBytes + 1);
    raw[base] = 0; // filter none
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x]) raw[base + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 3; // indexed
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const plte = Buffer.from(palette.flat());
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', zlibStored(raw)), chunk('IEND', Buffer.alloc(0))]);
  return new Uint8Array(png.buffer, png.byteOffset, png.length);
}

// ---- スライドの絵：固有の背景色、大きな番号（7 セグメント風）、下に 16 ビットの番号の帯 ----

// セグメント a(上) b(右上) c(右下) d(下) e(左下) f(左上) g(中)
const SEG = {
  0: 'abcdef',
  1: 'bc',
  2: 'abdeg',
  3: 'abcdg',
  4: 'bcfg',
  5: 'acdfg',
  6: 'acdefg',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
};

function hsvToRgb(h, s, v) {
  // 四則演算と floor だけ
  const hh = (h % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** スライドの番号から、背景色と文字色を決める（固有になるように）。 */
export function slideColors(order) {
  const hue = (order * 137) % 360;
  const val = [0.85, 0.55, 0.7][order % 3];
  const bg = hsvToRgb(hue, 0.65, val);
  const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  const fg = lum > 140 ? [16, 16, 16] : [250, 250, 250];
  return { bg, fg };
}

/**
 * @param {number} order スライドの番号（1 から）
 * @param {{width?:number,height?:number}} [opt]
 */
export function renderSlidePng(order, opt = {}) {
  const width = opt.width ?? 320;
  const height = opt.height ?? 180;
  const { bg, fg } = slideColors(order);
  const px = new Uint8Array(width * height); // 0 = 背景、1 = 文字色
  const rect = (x0, y0, w, h) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) px[y * width + x] = 1;
    }
  };
  // 枠
  const bw = Math.max(2, Math.round(width / 80));
  rect(0, 0, width, bw);
  rect(0, height - bw, width, bw);
  rect(0, 0, bw, height);
  rect(width - bw, 0, bw, height);
  // 番号（最大 4 桁）
  const digits = String(order).split('');
  const dh = Math.round(height * 0.55);
  const dw = Math.round(dh * 0.55);
  const t = Math.max(2, Math.round(dh / 9));
  const gap = Math.round(dw * 0.35);
  const totalW = digits.length * dw + (digits.length - 1) * gap;
  let x0 = Math.round((width - totalW) / 2);
  const y0 = Math.round(height * 0.12);
  for (const d of digits) {
    const on = SEG[d];
    const half = Math.round((dh - t) / 2);
    if (on.includes('a')) rect(x0, y0, dw, t);
    if (on.includes('g')) rect(x0, y0 + half, dw, t);
    if (on.includes('d')) rect(x0, y0 + dh - t, dw, t);
    if (on.includes('f')) rect(x0, y0, t, half + t);
    if (on.includes('b')) rect(x0 + dw - t, y0, t, half + t);
    if (on.includes('e')) rect(x0, y0 + half, t, dh - half);
    if (on.includes('c')) rect(x0 + dw - t, y0 + half, t, dh - half);
    x0 += dw + gap;
  }
  // 16 ビットの番号の帯（下）：1 のビットは文字色のブロック
  const cell = Math.floor((width - 4 * bw) / 17);
  const by = Math.round(height * 0.78);
  const bh = Math.round(height * 0.12);
  const bx0 = Math.round((width - cell * 17) / 2);
  rect(bx0, by, cell, bh); // 開始の印（必ず 1）
  for (let i = 0; i < 16; i++) {
    if ((order >> (15 - i)) & 1) rect(bx0 + cell * (i + 1), by, cell, bh);
  }
  return encodePng1bpp(width, height, [bg, fg], px);
}
