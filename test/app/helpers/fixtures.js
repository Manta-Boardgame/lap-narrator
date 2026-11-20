// 試験用の素材。すべて架空・自作（実在の人や発表の内容は使わない）。同じ指定から同じ素材ができる。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 決まった種から決まった列を作る小さな乱数（試験の入力を再現できるようにする）。 */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 既知の PCM（Int16）。正弦波に乱数を足したもの。seed が同じなら同じ。 */
export function makePcm(samples, { seed = 1, rate = 48000, freq = 440, amp = 0.4 } = {}) {
  const rnd = prng(seed);
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * amp + (rnd() - 0.5) * 0.1;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

export const toBase64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');
export const fromBase64 = (b64) => {
  const b = Buffer.from(b64, 'base64');
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/** 偽のマイク入力に渡す WAV（44 バイトの標準ヘッダー、16 ビット、モノラル）。試験の入力をここで作る。 */
export function writeWavFile(file, i16, rate = 48000) {
  const data = Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 台本（CONTRACTS.md 1.1）。ハッシュは 0.4 の規則（canonicalJson のキーの辞書順）で、この試験の中で独立に計算する。
 * recordable: false のスライドを混ぜられる。
 */
export function makeScript({ slides = 3, projectId = 'proj-apptest', title = 'App test deck', nonRecordable = [] } = {}) {
  const list = [];
  for (let i = 1; i <= slides; i++) {
    const slideId = `s${String(i).padStart(4, '0')}`;
    const recordable = !nonRecordable.includes(i);
    const text = `Slide ${i}: this is the sentence to read aloud for slide number ${i}.`;
    // canonicalJson({slideId, text, recordable})：キーを辞書順に、空白なしで
    const canon = `{"recordable":${recordable},"slideId":${JSON.stringify(slideId)},"text":${JSON.stringify(text)}}`;
    list.push({
      slideId, order: i, title: `Title ${i}`, text, recordable, targetSec: 10 + i,
      speaker: i % 2 ? 'Speaker A' : 'Speaker B',
      textHash: sha256(canon),
    });
  }
  const scriptHash = sha256(list.map((s) => s.textHash).join('\n'));
  return { format: 'lap-narrator/script', version: 1, projectId, title, scriptHash, slides: list };
}
