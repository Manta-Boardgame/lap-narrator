// 見本のセッションごとに、完成した音声の期待値（スライドごとの既定のテイクの PCM の SHA-256）を作る。
// 入力は「手で導いた期待値（expected.segments.json）」と録音ファイル。計算は test/oracle/render-oracle.js（別実装）。
// 小さな固定の値（手で計算した少数のサンプル）で render-oracle 自体を確かめる試験は、test/oracle/render-oracle.test.js にある。
import { basename } from 'node:path';
import { sha256Hex } from './lib/hash.js';
import { decodeWav } from './lib/wav.js';
import { oracleRenderTake, pcmToBytes } from '../test/oracle/render-oracle.js';

export const FADE_SAMPLES = 384;

/** @param {{files:Map<string,Uint8Array>, manifest:object, expected:object}} built */
export function frozenRender(built) {
  const pcm = new Map();
  const rate = new Map();
  for (const r of built.manifest.rawFiles) {
    const w = decodeWav(built.files.get(r.file));
    pcm.set(basename(r.file, '.wav'), w.samples);
    rate.set(basename(r.file, '.wav'), w.sampleRate);
  }
  const segById = new Map(built.expected.segments.map((s) => [s.segmentId, s]));
  const finals = [];
  const unrenderable = [];
  for (const [slideId, takeId] of Object.entries(built.expected.defaultTakes)) {
    const take = built.expected.takes.find((t) => t.takeId === takeId);
    const segments = take.segments.map((id) => segById.get(id));
    if (segments.some((g) => !pcm.has(g.raw))) {
      unrenderable.push({ slideId, takeId, reason: 'raw file is not in the session' });
      continue;
    }
    const out = oracleRenderTake({ segments, pcmOf: (r) => pcm.get(r), fadeSamples: FADE_SAMPLES, rateOf: (r) => rate.get(r) });
    finals.push({ slideId, takeId, samples: out.length, sha256: sha256Hex(pcmToBytes(out)) });
  }
  const res = {
    note: 'Expected final PCM (SHA-256 of 16-bit little-endian samples) for each default take, from test/oracle/render-oracle.js. Wave-1 scope: no resampling, gain 0 dB, no limiter. See dev/proposals/E-002.md.',
    sampleRate: 48000,
    fadeSamples: FADE_SAMPLES,
    finals,
  };
  if (unrenderable.length) res.unrenderable = unrenderable;
  return res;
}
