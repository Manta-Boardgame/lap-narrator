// 開発用の入力（?devinput=1）。既知の PCM を、実時間より速く（speed 倍）保存の経路へ流す。
// 本物のマイクの経路（AudioWorklet）は通らない。保存の Worker 以降（追記、flush、durable、file-rotate）は同じ。

import { sleep } from './util.js';

export function createDevSource({ backend, sampleRate = 48000, onLevel = () => {} }) {
  let armed = false;
  const src = {
    kind: 'dev',
    sampleRate,
    captured: 0,
    async open() {},
    async close() { armed = false; },
    async arm() { armed = true; src.captured = 0; },
    async disarm() {
      armed = false;
      await backend.sync();
      const s = backend.lastStats || {};
      return { captured: src.captured, written: s.written ?? 0 };
    },
    async flush() {
      await backend.sync();
      const s = backend.lastStats || {};
      return { captured: src.captured, written: s.written ?? 0 };
    },
    info() {
      return {
        requested: { source: 'dev-input' },
        actual: { source: 'dev-input', sampleRate, contextSampleRate: sampleRate },
      };
    },
    /**
     * @param {Int16Array} pcm
     * @param {{speed?: number, chunk?: number}} [opts] speed：実時間の何倍で流すか（既定は待たずに全速）
     */
    async feed(pcm, { speed = Infinity, chunk = 4096 } = {}) {
      if (!armed) throw new Error('not-recording');
      const chunkMs = (chunk / sampleRate) * 1000;
      let n = 0;
      for (let off = 0; off < pcm.length; off += chunk) {
        const part = pcm.subarray(off, Math.min(off + chunk, pcm.length));
        backend.onChunk(part);
        src.captured += part.length;
        let peak = 0;
        for (let i = 0; i < part.length; i++) { const a = Math.abs(part[i]); if (a > peak) peak = a; }
        onLevel({ peak: peak / 32768, rms: 0 });
        n++;
        if (Number.isFinite(speed) && speed > 0) await sleep(chunkMs / speed);
        else if (n % 32 === 0) await sleep(0);
      }
      await backend.sync();
      return { fed: pcm.length };
    },
  };
  return src;
}
