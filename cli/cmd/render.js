// render：選ばれたテイクを、完成した音声にする（設計書 5.1、CONTRACTS.md 1.8、3.2）。
//   narrate render --workspace <dir> [--out <dir>] [--allow-missing]
// 書くもの：<out>/final/<slideId>.wav（大きければ .p001.wav…）、<out>/timeline.json（core の buildTimeline）、<out>/slides/…（予定表が指す絵）。
// 候補が複数あるのに selections.json がないスライドがあれば、何も書かず、終了コード 4 で result.needsDecision に選択肢を出す（自動で決めない）。
// 音声は少しずつ作って書く（全体をメモリに載せない）。計算は core の renderTake、planWavParts、wavHeader、buildTimeline。
//
// 通しの音声を切れ目で切る経路（dev/PLAN2.md、dev/proposals/G-002.md）：
//   narrate render --workspace <dir> [--boundaries <boundaries.json>] [--allow-unconfirmed] [--no-boundaries]
//   --boundaries があるか、<workspace>/boundaries.json があれば、この経路になる（--no-boundaries でスライドごとの経路に戻せる）。
//   通しの完成音声（作業場の、台本が 1 枚の書き出し）を、各スライドの [startSample, endSample) で切って <out>/final/<slideId>.wav を作る。
//   予定表は prePadSamples = 0 で、スライドの切り替えの時刻が切れ目の位置そのもの（showStart = audioStart = startSample、showEnd = endSample）。
//   --tail-margin-ms <n>（既定 100）：各スライドの音声の終わりを、切れ目より n ミリ秒手前にする（postPadSamples = その分）。切れ目の無音の終わりを n ms 切り落とすだけ。
//     PowerPoint（方式 A）は、音声がスライドの時間いっぱいだとスライドを音声の終わりまで延ばし、スライドごとに約 50 ms ずつずれが積もる。0 なら切り落とさない（サンプル単位で切れ目どおり）。
//     ピーク 32 以下か、照合済みの文字起こしと波形の両方で静かな環境音と判定できる場合に限る。それ以外は 0 で作り直し、警告 tail-margin-skipped。
//   切れ目に needs-decision があれば、何も書かず終了コード 4（errors[0].code = "decision-required"、result.needsDecision）。--allow-unconfirmed のときだけ候補のまま進む（警告 unconfirmed-boundaries）。
//   boundaries.json の audio.sha256 と作業場の音声が合わない（audio-mismatch）、台本が違う（script-mismatch）、区間が連続・半開でない（not-contiguous）は、終了コード 3。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  renderTake, planWavParts, wavHeader, createSha256, sha256Hex, buildTimeline, validate, FINAL_MAX_BYTES,
  checkBoundaries, planSlices, undecidedSlides, buildContinuousTimeline, sliceStream,
} from '../../core/index.js';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { intOption } from '../lib/args.js';
import { createFsStore } from '../lib/store.js';
import { fileExists, openAtomicWrite, writeFileAtomic, streamFile } from '../lib/fsutil.js';
import { requireScript, skippedSlideList } from '../lib/workspace.js';
import { computeDecisions, publicCandidate } from '../lib/plan.js';
import { planForTake } from '../lib/workspace.js';
import { checkPackMatches } from '../lib/packcheck.js';
import { secOf } from '../lib/output.js';
import { makeSampleReader, readBoundaries, resolveContinuousAudio, BOUNDARIES_FILE } from '../lib/continuous.js';

import { levelOptions, levelOutput } from '../lib/output-level.js';
import { leadInOptions, planLeadIns, leadInChunks, loadTranscriptWords } from '../lib/lead-in.js';

export const options = { 'lead-in-sec': 'string', 'lead-keep-ms': 'string', out: 'string', script: 'string', 'final-max-bytes': 'string', 'chunk-samples': 'string', boundaries: 'string', 'allow-unconfirmed': 'boolean', 'no-boundaries': 'boolean', 'tail-margin-ms': 'string', 'allow-missing': 'boolean', 'target-lufs': 'string', 'ceiling-db': 'string', 'lookahead-limiter': 'boolean' };

/** 音声の終わりを切り落とす既定の長さ（ミリ秒）。75 ms で方式 A が合い、50 ms では合わなかった（dev/proposals/G-002.md） */
const DEFAULT_TAIL_MARGIN_MS = 100;
/** 波形だけで無音に近いとみなす最大の振幅（16 ビット PCM）。 */
const QUIET_PEAK = 32;
const NOISE_PEAK_MAX = 1024;
const NOISE_CONTEXT_MS = 100;
const WORD_GUARD_MS = 50;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const partName = (slideId, i, n) => (n === 1 ? `${slideId}.wav` : `${slideId}.p${String(i + 1).padStart(3, '0')}.wav`);

/** 音声のかたまりの列を、WAV（大きければ順序付きの複数）に少しずつ書く。ファイルの SHA-256 も一緒に求める */
async function writeWavParts({ finalDir, slideId, sampleRate, total, maxBytes, chunks, onProgress }) {
  const plan = planWavParts(total, maxBytes);
  const parts = [];
  let idx = -1;
  let writer = null;
  let hash = null;
  let left = 0;
  let cur = null;
  const finish = async () => {
    if (!writer) return;
    await writer.commit();
    parts.push({ file: `final/${cur}`, samples: plan[idx], sha256: hash.digestHex() });
    writer = null;
  };
  try {
    let written = 0;
    let n = 0;
    for await (const chunk of chunks) {
      let off = 0;
      while (off < chunk.length) {
        if (!writer || left === 0) {
          await finish();
          idx++;
          if (idx >= plan.length) throw new CliError('render-length-mismatch', `${slideId}: the renderer produced more samples than planned (${total})`);
          cur = partName(slideId, idx, plan.length);
          writer = await openAtomicWrite(path.join(finalDir, cur));
          hash = createSha256();
          const head = wavHeader({ sampleRate, samples: plan[idx] });
          hash.update(head);
          await writer.write(head);
          left = plan[idx];
        }
        const take = Math.min(left, chunk.length - off);
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset + off * 2, take * 2);
        hash.update(bytes);
        await writer.write(bytes);
        left -= take;
        off += take;
        written += take;
      }
      if (onProgress && (++n % 16 === 0)) onProgress(written, total);
    }
    if (left !== 0 || idx !== plan.length - 1) throw new CliError('render-length-mismatch', `${slideId}: the renderer produced fewer samples than planned (${total})`);
    await finish();
  } catch (e) {
    if (writer) await writer.abort();
    for (const p of parts) await fsp.rm(path.join(finalDir, '..', p.file), { force: true });
    throw e;
  }
  return parts;
}

/** 完成版（取り込んだ音声）をそのまま置く。ハッシュを照合する */
async function copyFinal(store, cand, slideId, outDir, sess) {
  const f = (sess.finals || []).find((x) => x.exportId === cand.exportId);
  const fs = f && f.slides.find((x) => x.slideId === slideId);
  if (!fs) throw new CliError('bad-selection', `final ${cand.exportId} has no slide ${slideId}`);
  const parts = [];
  for (const p of fs.parts) {
    const src = store.resolve(`sessions/${sess.sessionId}/finals/${cand.exportId}/${p.file}`);
    const dest = path.join(outDir, ...p.file.split('/'));
    const w = await openAtomicWrite(dest);
    const h = createSha256();
    try {
      await streamFile(src, async (c) => { h.update(c); await w.write(c); });
      if (h.digestHex() !== p.sha256) throw new CliError('hash-mismatch', `${p.file} of export ${cand.exportId} does not match its recorded SHA-256`, { exit: EXIT.MISMATCH });
      await w.commit();
    } catch (e) { await w.abort(); throw e; }
    parts.push({ file: p.file, samples: p.samples, sha256: p.sha256 });
  }
  return { parts, samples: fs.samples, sampleRate: fs.sampleRate, applied: fs.applied || {} };
}

/** 予定表を検査して書く。予定表が指す絵を <out>/ の下へ写す */
async function emitTimeline(store, outDir, timeline) {
  const v = validate('timeline', timeline);
  if (!v.ok) throw new CliError('timeline-invalid', 'the timeline does not match schema/timeline', { exit: EXIT.MISMATCH, detail: { errors: v.errors.slice(0, 10) } });
  for (const s of timeline.slides) {
    const dest = path.join(outDir, ...s.image.split('/'));
    const w = await openAtomicWrite(dest);
    try { await streamFile(store.resolve(s.image), (c) => w.write(c)); await w.commit(); } catch (e) { await w.abort(); throw e; }
  }
  await writeFileAtomic(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
}

/** 今回の書き出しに入らない古い音声（このツールの名前の形のもの）を片付ける */
async function sweepOldFinals(finalDir, finals) {
  const keep = new Set(finals.flatMap((f) => f.parts.map((p) => path.basename(p.file))));
  for (const name of await fsp.readdir(finalDir)) {
    if (/^[A-Za-z0-9_-]+(\.p\d{3})?\.wav$/.test(name) && !keep.has(name)) await fsp.rm(path.join(finalDir, name), { force: true });
  }
}

const boundaryError = (errors) => new CliError(errors[0].code, errors[0].message, { exit: EXIT.MISMATCH, detail: { errors: errors.slice(0, 20) } });

async function matchingTranscriptWords(store, boundaries) {
  try {
    const file = await store.openRead(boundaries.transcript.file);
    const bytes = await file.read(0, file.size);
    if (sha256Hex(bytes) !== boundaries.transcript.sha256) return [];
    const transcript = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
    if (!validate('transcript', transcript).ok || transcript.audio.sha256 !== boundaries.audio.sha256) return [];
    return transcript.words;
  } catch {
    return [];
  }
}

function quietTail(tail, rate, contextSamples) {
  if (tail.peak <= QUIET_PEAK) return true;
  if (!tail.pcm || tail.peak > NOISE_PEAK_MAX) return false;
  // 直前の 100 ms を参照にし、20 ms ごとの実効値が安定しているときだけ環境音とみなす。
  const rms = (from, to) => {
    const out = [];
    const block = Math.max(1, Math.round(rate * 0.02));
    for (let lo = from; lo < to; lo += block) {
      const hi = Math.min(to, lo + block);
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += tail.pcm[i] ** 2;
      out.push(Math.sqrt(sum / (hi - lo)));
    }
    return out.sort((a, b) => a - b);
  };
  const before = rms(0, contextSamples);
  const removed = rms(contextSamples, tail.pcm.length);
  const floor = before[Math.floor(before.length / 2)];
  return floor > QUIET_PEAK && floor <= 256
    && before.every((value) => value >= 0.65 * floor && value <= 1.7 * floor)
    && removed.every((value) => value <= 1.7 * floor)
    && removed[Math.floor(removed.length / 2)] <= 1.2 * floor;
}

/** 先頭 n サンプルを渡し、切り落とす部分のピークと必要なときだけ前後の波形を記録する。 */
async function* headOf(chunks, n, tail) {
  let start = 0;
  for await (const c of chunks) {
    const keep = Math.max(0, Math.min(n - start, c.length));
    if (keep) yield c.subarray(0, keep);
    for (let i = keep; i < c.length; i++) tail.peak = Math.max(tail.peak, Math.abs(c[i]));
    if (tail.pcm) {
      const lo = Math.max(0, tail.startSample - start);
      if (lo < c.length) tail.pcm.set(c.subarray(lo), start + lo - tail.startSample);
    }
    start += c.length;
  }
}

/** 通しの音声を切れ目で切る経路 */
async function runContinuous({ ctx, opts, store, script, workspace, outDir, maxBytes, chunkSamples, level, leadIn }) {
  const marginMs = intOption(opts, 'tail-margin-ms', DEFAULT_TAIL_MARGIN_MS, { min: 0, max: 1000 });
  const loaded = await readBoundaries(store, opts.boundaries);
  if (!loaded) throw new CliError('cannot-read', `no ${BOUNDARIES_FILE} in the workspace`);
  const b = loaded.boundaries;
  // 台本と構造・区間の検査（音声を読む前にできること）
  const chk = checkBoundaries(b, { script });
  if (!chk.ok) throw boundaryError(chk.errors);

  // 判断待ちの切れ目：何も書かずに止まる（自動では決めない）
  const undecided = undecidedSlides(b);
  if (undecided.length && !opts['allow-unconfirmed']) {
    const bySlide = new Map(script.slides.map((s) => [s.slideId, s]));
    const list = undecided.map((s) => ({
      slideId: s.slideId, order: s.order, title: bySlide.get(s.slideId)?.title ?? '',
      startSample: s.startSample, endSample: s.endSample, confidence: s.confidence ?? null, method: s.method ?? null,
      candidates: s.candidates ?? [],
      howToDecide: `narrate boundary show --workspace <dir>; then narrate boundary set --slide ${s.slideId} --at <sec> --workspace <dir> (or narrate boundary confirm --slide ${s.slideId} --workspace <dir> to accept the candidate)`,
    }));
    throw new CliError('decision-required', `${undecided.length} slide boundary(ies) need a decision and nothing was written (${undecided.map((s) => s.slideId).join(', ')}); decide them, or pass --allow-unconfirmed to go on with the candidates`, {
      exit: EXIT.DECISION, detail: { slides: undecided.map((s) => s.slideId) }, result: { needsDecision: list },
    });
  }
  if (undecided.length) ctx.warn('unconfirmed-boundaries', `${undecided.length} slide boundary(ies) are not confirmed and were used as they are (${undecided.map((s) => s.slideId).join(', ')})`, { slides: undecided.map((s) => s.slideId) });

  // 作業場の通しの音声が、切れ目の作られた音声と同じか（SHA-256、長さ、周波数）
  const found = await resolveContinuousAudio(store, script, { want: { sha256: b.audio.sha256, samples: b.audio.samples, sampleRate: b.sampleRate }, chunkSamples });
  const audioChk = checkBoundaries(b, { script, audio: { sha256: found.sha256, samples: found.samples, sampleRate: found.sampleRate } });
  if (!audioChk.ok) throw boundaryError(audioChk.errors);

  const slices = planSlices(b);
  const bySlide = new Map(script.slides.map((s) => [s.slideId, s]));
  for (const sl of slices) {
    const sd = bySlide.get(sl.slideId);
    if (sd.image === undefined) throw new CliError('slide-image-missing', `slide ${sl.slideId} has no picture in the script`);
    if (!(await store.exists(sd.image))) throw new CliError('slide-image-missing', `the picture ${sd.image} is not in the workspace (import the script pack again)`);
  }

  const finalDir = path.join(outDir, 'final');
  await fsp.mkdir(finalDir, { recursive: true });
  const contextSamples = Math.round(NOISE_CONTEXT_MS * found.sampleRate / 1000);
  const words = marginMs >= 20 && marginMs <= DEFAULT_TAIL_MARGIN_MS && contextSamples > 0
    ? await matchingTranscriptWords(store, b) : [];

  // --lead-in-sec：各スライドの話し始め（onset）を検出し、切り替えから話し始めまでをそろえる計画（cli/lib/lead-in.js）。音量の処理（levelOutput）より前に、finals の WAV へ書く。
  let leadPlans = null;
  if (leadIn) {
    try {
      leadPlans = await planLeadIns({
        chunks: () => found.audio.chunks(), slices, rate: found.sampleRate, sliceStream, leadSec: leadIn.sec, keepMs: leadIn.keepMs,
        words: await loadTranscriptWords(store, found.sha256), ctx,
      });
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(e.code || 'render-error', e.message);
    }
  }

  // 通しの音声を切って書く。margin > 0 のときは、各スライドの音声の終わりを margin サンプル切り落とす（切り落とす部分が無音でなければ notQuiet に入れる）
  const cutAll = async (margin) => {
    const finals = [];
    const notQuiet = [];
    let done = 0;
    ctx.progress('render', 0, slices.length);
    try {
      for await (const piece of sliceStream(found.audio.chunks(), slices.map((s) => s.samples))) {
        const sl = slices[piece.index];
        const keep = sl.samples - margin;
        const from = (sl.end - margin - contextSamples) / found.sampleRate - WORD_GUARD_MS / 1000;
        const to = sl.end / found.sampleRate + WORD_GUARD_MS / 1000;
        const hasSpeechInSlide = words.some((word) => word.end > sl.start / found.sampleRate && word.end <= from);
        const canCheckNoise = margin > 0 && keep >= contextSamples && hasSpeechInSlide
          && !words.some((word) => word.end > from && word.start < to);
        const tail = { peak: 0, startSample: keep - contextSamples,
          pcm: canCheckNoise ? new Int16Array(margin + contextSamples) : null };
        const lp = leadPlans ? leadPlans[piece.index] : null;
        if (lp && keep - lp.start < 1) throw new CliError('lead-in-failed', `slide ${sl.slideId}: nothing is left after trimming the head for --lead-in-sec`);
        const cutChunks = margin === 0 ? piece.chunks : headOf(piece.chunks, keep, tail);
        const chunks = lp ? leadInChunks(cutChunks, lp) : cutChunks;
        const total = lp ? keep - lp.start + lp.pad : keep;
        const parts = await writeWavParts({ finalDir, slideId: sl.slideId, sampleRate: found.sampleRate, total, maxBytes, chunks });
        if (margin > 0 && !quietTail(tail, found.sampleRate, contextSamples)) notQuiet.push(sl.slideId);
        finals.push({
          slideId: sl.slideId, takeId: found.cand.takeId, sessionId: found.cand.sessionId, source: 'continuous', parts, samples: total, sampleRate: found.sampleRate,
          applied: {}, startSample: sl.start, endSample: sl.end, boundary: { status: sl.status, ...(sl.confidence !== undefined ? { confidence: sl.confidence } : {}), ...(sl.method !== undefined ? { method: sl.method } : {}) },
          ...(lp ? { leadIn: { sec: leadIn.sec, onsetSample: sl.start + lp.onset, trimmedHeadSamples: lp.start, paddedSamples: lp.pad, roomToneFrom: lp.roomToneFrom, onsetFound: lp.found, onsetSource: lp.onsetSource } } : {}),
        });
        ctx.progress('render', ++done, slices.length);
      }
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(e.code || 'render-error', e.message);
    }
    return { finals, notQuiet };
  };
  let margin = Math.round((marginMs * found.sampleRate) / 1000);
  if (margin > 0 && slices.some((sl) => sl.samples - margin < 1)) {
    ctx.warn('tail-margin-skipped', `a slide is shorter than the tail margin (${marginMs} ms); the audio was cut exactly at the boundaries`, { slides: slices.filter((sl) => sl.samples - margin < 1).map((sl) => sl.slideId) });
    margin = 0;
  }
  let cut = await cutAll(margin);
  if (cut.notQuiet.length) {
    ctx.warn('tail-margin-skipped', `the last ${marginMs} ms of slide(s) ${cut.notQuiet.join(', ')} are not silent; the audio was cut exactly at the boundaries (PowerPoint, method A, may then drift slide by slide)`, { slides: cut.notQuiet, marginMs });
    margin = 0;
    cut = await cutAll(0);
  }
  const finals = cut.finals;
  const leveling = level ? await levelOutput({ ctx, outDir, finals, options: level, continuous: true }) : null;

  // --lead-in-sec のときは、各スライドの長さが変わる（捨てた先頭、足した room tone）。予定表は、新しい長さで並べ直した切れ目に載せる（形は変えない）
  let tlBoundaries = b;
  if (leadPlans) {
    let cur = 0;
    const moved = b.slides.map((s, i) => { const len = finals[i].samples + margin; const m = { ...s, startSample: cur, endSample: cur + len }; cur += len; return m; });
    tlBoundaries = { ...b, audio: { ...b.audio, samples: cur }, slides: moved };
  }
  let timeline;
  try { timeline = buildContinuousTimeline({ script, boundaries: tlBoundaries, finals, tailMarginSamples: margin }); } catch (e) {
    throw new CliError('timeline-failed', e.message, { exit: e instanceof RangeError ? EXIT.MISMATCH : EXIT.FAIL });
  }
  await sweepOldFinals(finalDir, finals);
  await emitTimeline(store, outDir, timeline);

  return {
    result: {
      out: outDir,
      mode: 'continuous',
      ...(leveling ? { leveling } : {}),
      tailMarginSamples: margin,
      tailMarginMs: Math.round((margin * 1000) / found.sampleRate),
      continuous: {
        sessionId: found.cand.sessionId, takeId: found.cand.takeId, slideId: found.src.slide.slideId, source: found.cand.source,
        ...(found.cand.exportId !== undefined ? { exportId: found.cand.exportId } : {}), samples: found.samples, sha256: found.sha256, boundaries: loaded.path,
      },
      finals: finals.map((f) => ({
        slideId: f.slideId, takeId: f.takeId, sessionId: f.sessionId, source: f.source, parts: f.parts, samples: f.samples, sampleRate: f.sampleRate, sec: secOf(f.samples, f.sampleRate),
        startSample: f.startSample, endSample: f.endSample, boundary: f.boundary, applied: f.applied,
        ...(f.leadIn ? { leadIn: f.leadIn } : {}),
      })),
      timeline: 'timeline.json',
      timelinePath: path.join(outDir, 'timeline.json'),
      totalSamples: timeline.totalSamples,
      totalSec: secOf(timeline.totalSamples, timeline.sampleRate),
      skippedSlides: skippedSlideList(script),
      skippedSlideIds: skippedSlideList(script).map((s) => s.slideId),
      skipped: { missing: [], stale: [], unrenderable: [] },
    },
  };
}

export async function run({ ctx, opts, workspace }) {
  if (!workspace) throw usageError('--workspace is required');
  if (!LITTLE_ENDIAN) throw new CliError('unsupported-platform', 'this tool needs a little-endian machine');
  const outDir = path.resolve(opts.out || path.join(workspace, 'out'));
  const maxBytes = intOption(opts, 'final-max-bytes', FINAL_MAX_BYTES, { min: 46 });
  const chunkSamples = intOption(opts, 'chunk-samples', 65536, { min: 1 });
  if (opts['no-boundaries'] && opts.boundaries !== undefined) throw usageError('--no-boundaries and --boundaries cannot be used together');
  const level = levelOptions(opts);
  const leadIn = leadInOptions(opts);
  // A previous timeline can refer to files replaced during this attempt. Block its use until render completes.
  const timelinePath = path.join(outDir, 'timeline.json');
  const incomplete = `${timelinePath}.incomplete`;
  if (await fileExists(timelinePath)) await writeFileAtomic(incomplete, 'Run render again before building.\n');
  const store = createFsStore(workspace);
  const script = await requireScript(store);
  if (opts.script) await checkPackMatches(store, opts.script);
  const args = { ctx, opts, store, script, workspace, outDir, maxBytes, chunkSamples, level, leadIn };
  const result = await render(args);
  await fsp.rm(incomplete, { force: true });
  return result;
}

async function render({ ctx, opts, store, script, workspace, outDir, maxBytes, chunkSamples, level, leadIn }) {
  if (!opts['no-boundaries'] && (opts.boundaries !== undefined || await store.exists(BOUNDARIES_FILE))) {
    return runContinuous({ ctx, opts, store, script, workspace, outDir, maxBytes, chunkSamples, level, leadIn });
  }
  if (leadIn) ctx.warn('lead-in-ignored', '--lead-in-sec applies only to a continuous recording cut at boundaries; it was ignored', { leadInSec: leadIn.sec });

  const d = await computeDecisions(store, script);

  // 選択が候補に合わない
  const bad = d.slides.filter((x) => x.decision.selectionInvalid);
  if (bad.length) {
    throw new CliError('selection-not-found', `selections.json names a take that is not a candidate (${bad.map((x) => x.slide.slideId).join(', ')})`, {
      detail: { slides: bad.map((x) => ({ slideId: x.slide.slideId, selection: x.selection, candidates: x.cands.map(publicCandidate) })) },
    });
  }
  // 判断が要る（自動では決めない）
  const need = d.slides.filter((x) => x.decision.needsDecision);
  if (need.length) {
    const list = need.map((x) => ({
      slideId: x.slide.slideId, order: x.slide.order, title: x.slide.title,
      candidates: x.cands.filter((c) => !c.stale && !c.alternative).map(publicCandidate),
      alternatives: x.cands.filter((c) => c.alternative).map(publicCandidate),
      howToSelect: `narrate select --slide ${x.slide.slideId} --session <sessionId> --take <takeId> --workspace <dir>`,
    }));
    throw new CliError('decision-required', `${need.length} slide(s) have more than one candidate and no selection (${need.map((x) => x.slide.slideId).join(', ')})`, {
      exit: EXIT.DECISION, detail: { slides: need.map((x) => x.slide.slideId) }, result: { needsDecision: list },
    });
  }

  // 未収録、古い台本の録音、自動で選ばれた描画不能な録音は、明示的な許可がある場合のみ省く。
  const unrenderable = d.slides.filter((x) => x.decision.chosen && x.decision.chosen.problem && !x.decision.bySelection);
  const missing = d.slides.filter((x) => !x.decision.chosen && x.decision.state === 'missing').map((x) => x.slide.slideId);
  const staleSkipped = d.slides.filter((x) => !x.decision.chosen && x.decision.state === 'stale').map((x) => x.slide.slideId);
  const skipped = { missing, stale: staleSkipped, unrenderable: unrenderable.map((x) => x.slide.slideId) };
  const omitted = new Set(Object.values(skipped).flat());
  const invalidPick = d.slides.find((x) => x.decision.bySelection && x.decision.chosen?.problem);
  if (invalidPick) {
    const { sessionId, takeId, problem } = invalidPick.decision.chosen;
    const { slideId } = invalidPick.slide;
    throw new CliError(problem.code, `slide ${slideId}: ${problem.message}`, { detail: { slideId, sessionId, takeId } });
  }
  if (omitted.size && !opts['allow-missing']) {
    const slides = d.slides.filter((x) => omitted.has(x.slide.slideId)).map((x) => x.slide.slideId);
    throw new CliError('missing-slides', `no usable recording for ${slides.length} recordable slide(s) (${slides.join(', ')}); pass --allow-missing to omit them`, {
      detail: { slides, skipped },
    });
  }
  for (const x of unrenderable) {
    const p = x.decision.chosen.problem;
    ctx.warn('slide-unrenderable', `slide ${x.slide.slideId}: ${p.message}`, { slideId: x.slide.slideId, sessionId: x.decision.chosen.sessionId, takeId: x.decision.chosen.takeId, code: p.code });
  }
  const todo = d.slides.filter((x) => x.decision.chosen && !omitted.has(x.slide.slideId));
  if (missing.length) ctx.warn('slide-missing', `${missing.length} recordable slide(s) have no recording and are left out`, { slides: missing });
  if (staleSkipped.length) ctx.warn('stale-slide-skipped', `${staleSkipped.length} slide(s) were recorded with different text and are left out (select the take to use it anyway)`, { slides: staleSkipped });
  if (todo.length === 0) throw new CliError('nothing-to-render', 'no slide has a recording to render');

  // 先に確かめられることは、書く前に確かめる
  for (const x of todo) {
    const c = x.decision.chosen;
    if (x.slide.image === undefined) throw new CliError('slide-image-missing', `slide ${x.slide.slideId} has no picture in the script`);
    if (!(await store.exists(x.slide.image))) throw new CliError('slide-image-missing', `the picture ${x.slide.image} is not in the workspace (import the script pack again)`);
    if (c.stale) ctx.warn('stale-take', `slide ${x.slide.slideId}: the selected take was recorded with different text than the current script`, { slideId: x.slide.slideId });
  }

  const finalDir = path.join(outDir, 'final');
  await fsp.mkdir(finalDir, { recursive: true });
  const finals = [];
  const anBySession = new Map(d.analyses.map((a) => [a.sess.sessionId, a]));
  for (let i = 0; i < todo.length; i++) {
    const { slide, decision } = todo[i];
    const c = decision.chosen;
    ctx.progress('render', i, todo.length);
    const an = anBySession.get(c.sessionId);
    if (c.source === 'full') {
      const pl = planForTake(an, c.takeId, slide);
      if (!pl.plan) throw new CliError(pl.problem.code, `slide ${slide.slideId}: ${pl.problem.message}`);
      if (an.edits && an.edits.limiter) ctx.warn('limiter-not-applied', `session ${an.sess.sessionId}: edits.json asks for a limiter, which is not available yet (renderSpec version 1)`, { sessionId: an.sess.sessionId });
      let gen;
      try {
        gen = renderTake({ ...pl.args, readSamples: makeSampleReader(store, an), chunkSamples });
      } catch (e) { throw new CliError(e.code || 'render-error', `slide ${slide.slideId}: ${e.message}`); }
      let parts;
      try {
        parts = await writeWavParts({
          finalDir, slideId: slide.slideId, sampleRate: pl.plan.sampleRate, total: pl.plan.totalSamples, maxBytes, chunks: gen,
          onProgress: (done, total) => ctx.progress(`render:${slide.slideId}`, done, total),
        });
      } catch (e) {
        if (e instanceof CliError) throw e;
        throw new CliError(e.code || 'render-error', `slide ${slide.slideId}: ${e.message}`);
      }
      finals.push({
        slideId: slide.slideId, takeId: c.takeId, sessionId: c.sessionId, source: 'full', parts, samples: pl.plan.totalSamples,
        sampleRate: pl.plan.sampleRate, applied: pl.plan.applied,
      });
    } else {
      const r = await copyFinal(store, c, slide.slideId, outDir, an.sess);
      finals.push({ slideId: slide.slideId, takeId: c.takeId, sessionId: c.sessionId, source: 'final', exportId: c.exportId, ...r });
    }
  }
  ctx.progress('render', todo.length, todo.length);

  const leveling = level ? await levelOutput({ ctx, outDir, finals, options: level }) : null;

  // 予定表（core の buildTimeline）。絵は <out>/ の下へ写す（予定表の相対パスが指す）
  let timeline;
  try { timeline = buildTimeline({ script, finals, sampleRate: finals[0].sampleRate }); } catch (e) {
    throw new CliError('timeline-failed', e.message, { exit: e instanceof RangeError ? EXIT.MISMATCH : EXIT.FAIL });
  }
  await sweepOldFinals(finalDir, finals);
  await emitTimeline(store, outDir, timeline);

  return {
    result: {
      out: outDir,
      ...(leveling ? { leveling } : {}),
      finals: finals.map((f) => ({ slideId: f.slideId, takeId: f.takeId, sessionId: f.sessionId, source: f.source, ...(f.exportId ? { exportId: f.exportId } : {}), parts: f.parts, samples: f.samples, sampleRate: f.sampleRate, sec: secOf(f.samples, f.sampleRate), applied: f.applied })),
      timeline: 'timeline.json',
      timelinePath: path.join(outDir, 'timeline.json'),
      totalSamples: timeline.totalSamples,
      totalSec: secOf(timeline.totalSamples, timeline.sampleRate),
      skippedSlides: skippedSlideList(script),
      skippedSlideIds: skippedSlideList(script).map((s) => s.slideId),
      skipped,
    },
  };
}
