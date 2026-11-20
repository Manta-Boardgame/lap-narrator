// 録音した音声の再生（直前を聞く、復旧した続きを聞く）。録音ファイルを通しの位置で読み、つなげて鳴らす。
import { splitPosRange } from './posmap.js';

export function createPlayer() {
  let ctx = null;
  let current = null;

  async function ensure() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  function stop() {
    if (current) {
      try { current.src.stop(); } catch { /* すでに止まっている */ }
      current = null;
    }
  }

  /** Int16 の PCM を再生する。終わったら解決する。speed は試験用の早送り。 */
  async function playPcm(pcm, sampleRate, { speed = 1 } = {}) {
    stop();
    const c = await ensure();
    const buf = c.createBuffer(1, Math.max(1, pcm.length), sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    src.connect(c.destination);
    const ended = new Promise((resolve) => { src.onended = resolve; });
    current = { src };
    const startedAt = performance.now();
    src.start();
    await ended;
    if (current && current.src === src) current = null;
    return { samples: pcm.length, sampleRate, playedMs: performance.now() - startedAt };
  }

  /**
   * 通しの位置の範囲の並びを読んで、つなげて再生する。
   * @param {{readRaw:(raw:string,start:number,end:number)=>Promise<Int16Array>}} backend
   * @param {{name:string, samples:number, sampleRate:number}[]} rawFiles
   * @param {{start:number,end:number}[]} pieces
   */
  async function playPieces(backend, rawFiles, pieces, opts = {}) {
    const parts = [];
    let total = 0;
    for (const p of pieces) {
      for (const r of splitPosRange(rawFiles, p.start, p.end)) {
        const pcm = await backend.readRaw(r.raw, r.start, r.end);
        parts.push(pcm);
        total += pcm.length;
      }
    }
    const all = new Int16Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    const rate = rawFiles.length ? rawFiles[rawFiles.length - 1].sampleRate : 48000;
    if (total === 0) return { samples: 0, sampleRate: rate, playedMs: 0, requested: pieces };
    const r = await playPcm(all, rate, opts);
    return { ...r, requested: pieces };
  }

  return { playPcm, playPieces, stop };
}

/** 採用した音声の終わりから、samples 分さかのぼった範囲（通しの位置）。 */
export function lastPieces(allPieces, samples) {
  let need = samples;
  const out = [];
  for (let i = allPieces.length - 1; i >= 0 && need > 0; i--) {
    const p = allPieces[i];
    const len = p.end - p.start;
    const use = Math.min(len, need);
    out.unshift({ start: p.end - use, end: p.end });
    need -= use;
  }
  return out;
}
