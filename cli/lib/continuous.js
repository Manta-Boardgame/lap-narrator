// 通しで録った音声（台本が 1 枚だけの書き出し）を見つけ、完成した 1 本の音声として読む。切れ目 boundaries.json の読み込みもここ。
//   通しの書き出し：台本（セッションの script.json）に録音の対象のスライドが 1 枚だけあり、作業場の台本とは別物（作業場の録音の対象が 1 枚でない、
//   または slideId が違う）。dev/proposals/G-002.md の「通し」とみなす規則。
//   通しの音声（WAV）：全記録なら既定のテイク（撮り直しで捨てた区間を除く）を core の renderTake で作った 1 本、完成版ならその音声。
//   その WAV（44 バイトのヘッダー + PCM）全体の SHA-256 が boundaries.audio.sha256。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { renderTake, parseWavHeader, wavHeader, createSha256 } from '../../core/index.js';
import { CliError, EXIT } from './errors.js';
import { openAtomicWrite, readRange } from './fsutil.js';
import { analyzeSession, candidatesFor, loadSelections, loadSessions, planForTake, recordableSlides, RENDER_RATE } from './workspace.js';
import { secOf } from './output.js';

export const BOUNDARIES_FILE = 'boundaries.json';
export const CONTINUOUS_WAV = 'final/all.wav';

/** セッションの書き出しの manifest.recording（"continuous" か "per-slide"）。書き出しの間で食い違えば "continuous" を優先。無ければ undefined */
export function recordingOf(sess) {
  const xs = ((sess && sess.exports) || []).map((e) => e.recording).filter((r) => r !== undefined);
  return xs.includes('continuous') ? 'continuous' : xs.includes('per-slide') ? 'per-slide' : undefined;
}

/**
 * セッションが「通し」か。manifest.recording があればそれに従う（"per-slide" なら通しではない。"continuous" でも台本の録音の対象は 1 枚のはず）。
 * 無ければ（古い書き出し）、書き出しの台本の録音の対象が 1 枚だけで、作業場の台本の録音の対象とは別物であること。
 */
export function isContinuousScript(sessionScript, workspaceScript, recording) {
  if (!sessionScript || !Array.isArray(sessionScript.slides)) return false;
  const rec = sessionScript.slides.filter((s) => s.recordable === true);
  if (rec.length !== 1) return false;
  if (recording === 'continuous') return true;
  if (recording === 'per-slide') return false;
  if (!workspaceScript) return true;
  const ws = recordableSlides(workspaceScript);
  return !(ws.length === 1 && ws[0].slideId === rec[0].slideId);
}

/** 録音ファイルからサンプルを読む関数（renderTake の readSamples） */
export function makeSampleReader(store, an) {
  const cache = new Map();
  return async (raw, start, end) => {
    let h = cache.get(raw);
    if (!h) {
      const p = `${an.sdir}raw/${raw}.wav`;
      const reader = await store.openRead(p);
      let info;
      try { info = parseWavHeader(await reader.read(0, Math.min(reader.size, 4096))); } catch (e) {
        throw new CliError('bad-raw', `${p} is not a readable WAV (${e.message})`);
      }
      if (info.channels !== 1 || info.bits !== 16) throw new CliError('bad-raw', `${p} must be 16-bit mono`);
      if (an.rawRates[raw] !== undefined && info.sampleRate !== an.rawRates[raw]) throw new CliError('bad-raw', `${p}: the WAV says ${info.sampleRate} Hz but the manifest says ${an.rawRates[raw]} Hz`, { exit: EXIT.MISMATCH });
      h = { reader, offset: info.dataOffset };
      cache.set(raw, h);
    }
    const u8 = await h.reader.read(h.offset + start * 2, h.offset + end * 2);
    const out = new Int16Array(u8.length >> 1);
    new Uint8Array(out.buffer).set(u8.subarray(0, out.length * 2));
    return out;
  };
}

/** WAV ファイル（16 ビット、モノラル）の PCM を、Int16Array のかたまりで読む */
async function* wavFileChunks(abs, chunkSamples, expectRate) {
  const fh = await fsp.open(abs, 'r');
  try {
    const st = await fh.stat();
    let info;
    try { info = parseWavHeader(await readRange(fh, 0, Math.min(st.size, 4096))); } catch (e) {
      throw new CliError('bad-raw', `${abs} is not a readable WAV (${e.message})`);
    }
    if (info.channels !== 1 || info.bits !== 16) throw new CliError('bad-raw', `${abs} must be 16-bit mono`);
    if (expectRate !== undefined && info.sampleRate !== expectRate) throw new CliError('bad-raw', `${abs}: the WAV says ${info.sampleRate} Hz but the manifest says ${expectRate} Hz`, { exit: EXIT.MISMATCH });
    const end = Math.min(st.size, info.dataOffset + info.samples * 2);
    for (let o = info.dataOffset; o < end; o += chunkSamples * 2) {
      const u8 = await readRange(fh, o, Math.min(end, o + chunkSamples * 2));
      const out = new Int16Array(u8.length >> 1);
      new Uint8Array(out.buffer).set(u8.subarray(0, out.length * 2));
      yield out;
    }
  } finally { await fh.close(); }
}

/**
 * 通しの書き出しを探す。[{an, slide, cands}]。`slide` はセッションの台本の、録音の対象の 1 枚。
 * `cands` は候補（既定のものが先。全記録のテイク、または完成版）。
 */
export async function findContinuousSources(store, script) {
  const out = [];
  for (const sess of await loadSessions(store)) {
    const sscript = await store.readJson(`sessions/${sess.sessionId}/script.json`);
    if (!isContinuousScript(sscript, script, recordingOf(sess))) continue;
    const slide = sscript.slides.find((s) => s.recordable === true);
    const an = await analyzeSession(store, sess);
    const cands = candidatesFor(slide, [an]).sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || (a.takeId < b.takeId ? -1 : a.takeId > b.takeId ? 1 : 0));
    if (cands.length) out.push({ an, slide, cands });
  }
  return out;
}

/**
 * 候補の音声を開く。`chunks()` は呼ぶたびに最初から読み直す（Int16Array の非同期の列）。
 * @returns {{sampleRate:number, samples:number, chunks:()=>AsyncIterable<Int16Array>}}
 */
export function openCandidateAudio(store, src, cand, { chunkSamples = 65536 } = {}) {
  const { an, slide } = src;
  if (cand.problem) throw new CliError(cand.problem.code, `continuous recording ${cand.sessionId}/${cand.takeId}: ${cand.problem.message}`);
  if (cand.source === 'full') {
    const pl = planForTake(an, cand.takeId, slide);
    if (!pl.plan) throw new CliError(pl.problem.code, `continuous recording ${cand.sessionId}/${cand.takeId}: ${pl.problem.message}`);
    return {
      sampleRate: pl.plan.sampleRate, samples: pl.plan.totalSamples,
      chunks: () => {
        try { return renderTake({ ...pl.args, readSamples: makeSampleReader(store, an), chunkSamples }); } catch (e) { throw new CliError(e.code || 'render-error', e.message); }
      },
    };
  }
  const f = (an.sess.finals || []).find((x) => x.exportId === cand.exportId);
  const fs = f && f.slides.find((x) => x.slideId === slide.slideId);
  if (!fs) throw new CliError('bad-selection', `final ${cand.exportId} has no slide ${slide.slideId}`);
  return {
    sampleRate: fs.sampleRate, samples: fs.samples,
    chunks: async function* finalChunks() {
      for (const p of fs.parts) yield* wavFileChunks(store.resolve(`sessions/${an.sess.sessionId}/finals/${cand.exportId}/${p.file}`), chunkSamples, fs.sampleRate);
    },
  };
}

const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** 音声を読んで、WAV として書いたときの SHA-256 と長さを求める（ファイルは書かない） */
export async function hashAudio(audio) {
  const h = createSha256();
  h.update(wavHeader({ sampleRate: audio.sampleRate, samples: audio.samples }));
  let n = 0;
  for await (const c of audio.chunks()) { h.update(bytesOf(c)); n += c.length; }
  if (n !== audio.samples) throw new CliError('render-length-mismatch', `the continuous audio has ${n} samples, expected ${audio.samples}`, { exit: EXIT.MISMATCH });
  return { sha256: h.digestHex(), samples: n };
}

const publicCand = (c) => ({ sessionId: c.sessionId, takeId: c.takeId, source: c.source, ...(c.exportId !== undefined ? { exportId: c.exportId } : {}), samples: c.samples, sampleRate: c.sampleRate, default: !!c.default });

/**
 * 作業場の通しの音声を 1 つに決める。
 * `want` に `{sha256, samples, sampleRate}` があれば、それと一致するものを探す（一致しなければ終了コード 3 の `audio-mismatch`）。
 * なければ、selections.json（slideId が通しのスライド）→ 候補が 1 つならそれ → 複数なら終了コード 4。
 * @returns {Promise<{src:any, cand:any, audio:any, sha256:string, samples:number, sampleRate:number}>}
 */
export async function resolveContinuousAudio(store, script, { want = null, chunkSamples = 65536, log } = {}) {
  const sources = await findContinuousSources(store, script);
  if (sources.length === 0) {
    throw new CliError('no-continuous-audio', 'the workspace has no continuous recording (a recording whose script has a single slide); import the app export first', { exit: EXIT.FAIL });
  }
  const all = sources.flatMap((src) => src.cands.map((cand) => ({ src, cand })));
  if (!want) {
    const sel = await loadSelections(store);
    const picked = all.filter(({ src, cand }) => {
      const s = sel[src.slide.slideId];
      return s && s.sessionId === cand.sessionId && s.takeId === cand.takeId && (s.exportId === undefined || s.exportId === cand.exportId);
    });
    const pool = picked.length ? picked : all.filter(({ cand }) => !cand.alternative && !cand.stale);
    if (pool.length !== 1) {
      throw new CliError('decision-required', `${pool.length} continuous recordings are candidates; say which one to use (or make boundaries first: they pin the audio by its SHA-256)`, {
        exit: EXIT.DECISION, result: { needsDecision: [{ slideId: sources[0].slide.slideId, candidates: all.map(({ cand }) => publicCand(cand)) }] },
      });
    }
    const { src, cand } = pool[0];
    const audio = openCandidateAudio(store, src, cand, { chunkSamples });
    const h = await hashAudio(audio);
    return { src, cand, audio, ...h, sampleRate: audio.sampleRate };
  }
  const tried = [];
  for (const { src, cand } of all) {
    const row = publicCand(cand);
    if (cand.problem) { tried.push({ ...row, skipped: cand.problem.code }); continue; }
    if (want.samples !== undefined && cand.samples !== want.samples) { tried.push({ ...row, skipped: 'samples-differ' }); continue; }
    if (want.sampleRate !== undefined && cand.sampleRate !== want.sampleRate) { tried.push({ ...row, skipped: 'sample-rate-differs' }); continue; }
    const audio = openCandidateAudio(store, src, cand, { chunkSamples });
    const h = await hashAudio(audio);
    if (log) log(`continuous audio ${cand.sessionId}/${cand.takeId}: sha256 ${h.sha256}`);
    if (want.sha256 === undefined || h.sha256 === want.sha256) return { src, cand, audio, ...h, sampleRate: audio.sampleRate };
    tried.push({ ...row, sha256: h.sha256 });
  }
  throw new CliError('audio-mismatch', 'the continuous audio in the workspace is not the audio these boundaries were made for (SHA-256 or length differs)', {
    exit: EXIT.MISMATCH, detail: { boundaries: want, workspace: tried },
  });
}

/**
 * 通しの音声を WAV として `<workspace>/final/all.wav` に書く（文字起こしなど、ファイルを要る側のため）。すでに同じ内容があれば書き直さない。
 * @returns {Promise<{file:string, path:string, sha256:string, samples:number, sampleRate:number, sessionId:string, takeId:string, slideId:string, written:boolean}>}
 */
export async function materializeContinuousAudio(store, script, { want = null, chunkSamples = 65536 } = {}) {
  const r = await resolveContinuousAudio(store, script, { want, chunkSamples });
  const abs = store.resolve(CONTINUOUS_WAV);
  let have = null;
  try {
    const st = await fsp.stat(abs);
    if (st.size === 44 + r.samples * 2) {
      have = await hashAudio({ sampleRate: r.sampleRate, samples: r.samples, chunks: () => wavFileChunks(abs, chunkSamples, r.sampleRate) });
    }
  } catch { have = null; }
  let written = false;
  if (!have || have.sha256 !== r.sha256) {
    const w = await openAtomicWrite(abs);
    try {
      await w.write(wavHeader({ sampleRate: r.sampleRate, samples: r.samples }));
      for await (const c of r.audio.chunks()) await w.write(bytesOf(c));
      await w.commit();
      written = true;
    } catch (e) { await w.abort(); throw e; }
  }
  return { file: CONTINUOUS_WAV, path: abs, sha256: r.sha256, samples: r.samples, sampleRate: r.sampleRate, sessionId: r.cand.sessionId, takeId: r.cand.takeId, slideId: r.src.slide.slideId, written };
}

/** 作業場の boundaries.json（または指定のパス）を読む。無ければ null。読めなければ CliError */
export async function readBoundaries(store, explicitPath) {
  let text;
  let where;
  try {
    if (explicitPath) { where = path.resolve(explicitPath); text = await fsp.readFile(where, 'utf8'); } else {
      where = store.resolve(BOUNDARIES_FILE);
      text = await fsp.readFile(where, 'utf8');
    }
  } catch (e) {
    if (e.code === 'ENOENT' && !explicitPath) return null;
    throw new CliError('cannot-read', `cannot read ${where} (${e.code || e.message})`, { exit: EXIT.FAIL });
  }
  try { return { path: where, boundaries: JSON.parse(text.replace(/^﻿/, '')) }; } catch (e) {
    throw new CliError('bad-boundaries', `${where} is not valid JSON (${e.message})`, { exit: EXIT.FAIL });
  }
}

/** status に出す通しの音声の要約 */
export async function continuousSummary(store, script) {
  const sources = await findContinuousSources(store, script);
  const sessions = sources.map(({ an, slide, cands }) => {
    const sel = cands.find((c) => c.default) || cands[0];
    return {
      sessionId: an.sess.sessionId, slideId: slide.slideId, takeId: sel.takeId, source: sel.source,
      ...(sel.exportId !== undefined ? { exportId: sel.exportId } : {}), samples: sel.samples, sampleRate: sel.sampleRate, sec: secOf(sel.samples, sel.sampleRate || RENDER_RATE),
      candidates: cands.length,
    };
  });
  return { present: sessions.length > 0, sessions };
}
