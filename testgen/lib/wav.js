// WAV の読み書き（CONTRACTS.md 0.5）。標準の 44 バイトのヘッダーだけを書く。
const enc = (s) => Buffer.from(s, 'ascii');

/** @param {Int16Array} samples @param {number} sampleRate @returns {Uint8Array} */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  enc('RIFF').copy(out, 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  enc('WAVE').copy(out, 8);
  enc('fmt ').copy(out, 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  enc('data').copy(out, 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/**
 * チャンクをたどって読む（fmt が 18 バイトのものや、LIST などの追加チャンクがあるものも読める）。
 * @param {Uint8Array} u8
 * @returns {{sampleRate:number, channels:number, bits:number, format:number, samples:Int16Array}}
 */
export function decodeWav(u8) {
  const b = Buffer.from(u8.buffer, u8.byteOffset, u8.length);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    let size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (body + size > b.length) size = b.length - body; // 壊れた長さは実際の長さに切り詰める
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { start: body, size };
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM is supported');
  const n = Math.floor(data.size / 2 / fmt.channels);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(data.start + i * 2 * fmt.channels); // 先頭のチャンネルだけ
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, format: fmt.format, samples };
}

/** 任意の（読める）WAV を、標準の 44 バイトのヘッダーのモノラル WAV に書き直す。 */
export function normalizeWav(u8) {
  const w = decodeWav(u8);
  return { bytes: encodeWav(w.samples, w.sampleRate), sampleRate: w.sampleRate, samples: w.samples.length };
}
