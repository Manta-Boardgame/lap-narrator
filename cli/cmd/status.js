// status：スライドごとの状態（missing／single／multiple／stale）、合計の時間、台本の版の食い違い（設計書 5.1、CONTRACTS.md 3.2）。
//   missing   候補がない（未収録）
//   single    候補が 1 件
//   multiple  候補が 2 件以上（別のセッション、または編集の版が違う完成版）。`select` で選ぶ。選んだら resolved: true
//   stale     録音はあるが、台本の文が変わっている（textHash が違う）。要確認
// 通しで録った音声（台本が 1 枚だけの書き出し）と切れ目（boundaries.json）の状態は、continuous と boundaries に出す（dev/proposals/G-002.md）：
//   continuous  { present, sessions:[{sessionId, slideId, takeId, source, samples, sec, ...}] }
//   boundaries  { present, state, valid, slides:[{slideId, status, confidence, method, startSample, endSample}], needsDecision:[slideId], problems:[{code,message}], audio:{samplesMatch} }
//     state：none（通しの音声も切れ目もない）／waiting-for-boundaries（通しの音声は取り込み済みで、切れ目がまだ）／needs-decision／ready／invalid
// 同じセッションの中の別のテイクは `alternative` として一覧に出す（既定のテイクが採用される。数には入れない）。
import { usageError } from '../lib/errors.js';
import { createFsStore } from '../lib/store.js';
import { requireScript, estimateTimeline, skippedSlideList, RENDER_RATE } from '../lib/workspace.js';
import { computeDecisions, publicCandidate } from '../lib/plan.js';
import { checkPackMatches } from '../lib/packcheck.js';
import { pendingExports } from '../lib/workspace.js';
import { secOf } from '../lib/output.js';
import { checkBoundaries, undecidedSlides } from '../../core/index.js';
import { continuousSummary, readBoundaries, BOUNDARIES_FILE } from '../lib/continuous.js';

export const options = { script: 'string' };

/** 状態の表を作る（render の前の確認にも使う） */
export async function buildStatus(store) {
  const script = await requireScript(store);
  const d = await computeDecisions(store, script);
  const slides = d.slides.map(({ slide, cands, decision, selection }) => ({
    slideId: slide.slideId,
    order: slide.order,
    title: slide.title,
    state: decision.state,
    candidates: cands.map(publicCandidate),
    selected: decision.chosen ? { sessionId: decision.chosen.sessionId, takeId: decision.chosen.takeId, source: decision.chosen.source, ...(decision.chosen.exportId !== undefined ? { exportId: decision.chosen.exportId } : {}), samples: decision.chosen.samples } : null,
    resolved: decision.chosen !== null,
    needsDecision: decision.needsDecision,
    ...(decision.selectionInvalid ? { selectionInvalid: selection } : {}),
    samples: decision.chosen ? decision.chosen.samples : 0,
    sec: decision.chosen ? secOf(decision.chosen.samples, RENDER_RATE) : 0,
  }));
  const chosen = d.slides.filter((x) => x.decision.chosen).map((x) => ({ slideId: x.slide.slideId, samples: x.decision.chosen.samples }));
  const totalSamples = chosen.reduce((n, c) => n + c.samples, 0);
  const timelineSamples = chosen.length ? estimateTimeline(script, chosen) : 0;
  return {
    script, d,
    result: {
      projectId: script.projectId,
      scriptHash: script.scriptHash,
      sampleRate: RENDER_RATE,
      slides,
      counts: {
        missing: slides.filter((s) => s.state === 'missing').length,
        single: slides.filter((s) => s.state === 'single').length,
        multiple: slides.filter((s) => s.state === 'multiple').length,
        stale: slides.filter((s) => s.state === 'stale').length,
      },
      totalSamples,
      totalSec: secOf(totalSamples, RENDER_RATE),
      timelineSamples,
      timelineSec: secOf(timelineSamples, RENDER_RATE),
      staleSlides: d.slides.filter((x) => x.cands.some((c) => c.stale)).map((x) => x.slide.slideId),
      needsDecision: slides.filter((s) => s.needsDecision).map((s) => s.slideId),
      skippedSlides: skippedSlideList(script),
      skippedSlideIds: skippedSlideList(script).map((s) => s.slideId),
      sessions: d.sessions.map((s) => ({
        sessionId: s.sessionId, projectId: s.projectId, scriptHash: s.scriptHash,
        exports: s.exports.map((e) => ({ exportId: e.exportId, kind: e.kind, editVersion: e.editVersion })),
        finals: (s.finals || []).map((f) => ({ exportId: f.exportId, role: f.role, editVersion: f.editVersion })),
        issues: d.analyses.find((a) => a.sess.sessionId === s.sessionId)?.reduce?.issues.length ?? null,
      })),
    },
  };
}

/** 通しの音声と切れ目の状態（音声の SHA-256 は測らない。確かめるのは render） */
export async function boundariesStatus(store, script) {
  const continuous = await continuousSummary(store, script);
  let loaded = null;
  let readProblem = null;
  try { loaded = await readBoundaries(store); } catch (e) { readProblem = { code: e.code || 'bad-boundaries', message: e.message }; }
  if (!loaded && !readProblem) {
    return { continuous, boundaries: { present: false, state: continuous.present ? 'waiting-for-boundaries' : 'none', file: BOUNDARIES_FILE, valid: null, slides: [], needsDecision: [], problems: [] } };
  }
  if (readProblem) return { continuous, boundaries: { present: true, state: 'invalid', file: BOUNDARIES_FILE, valid: false, slides: [], needsDecision: [], problems: [readProblem] } };
  const b = loaded.boundaries;
  const chk = checkBoundaries(b, { script });
  const slides = Array.isArray(b && b.slides) ? b.slides.filter((s) => s && typeof s === 'object').map((s) => ({
    slideId: s.slideId, status: s.status, confidence: s.confidence ?? null, method: s.method ?? null, startSample: s.startSample, endSample: s.endSample,
  })) : [];
  const needsDecision = chk.ok ? undecidedSlides(b).map((s) => s.slideId) : slides.filter((s) => s.status === 'needs-decision').map((s) => s.slideId);
  const problems = chk.errors.map((e) => ({ code: e.code, message: e.message }));
  let samplesMatch = null;
  if (b && b.audio && Number.isInteger(b.audio.samples) && continuous.present) {
    samplesMatch = continuous.sessions.some((s) => s.samples === b.audio.samples);
    if (!samplesMatch) problems.push({ code: 'audio-mismatch', message: 'the length of the continuous audio in the workspace differs from boundaries.audio.samples' });
  }
  if (b && b.audio && !continuous.present) problems.push({ code: 'no-continuous-audio', message: 'the workspace has no continuous recording for these boundaries' });
  const valid = chk.ok && samplesMatch !== false && continuous.present;
  const state = !chk.ok || !valid ? 'invalid' : needsDecision.length ? 'needs-decision' : 'ready';
  return { continuous, boundaries: { present: true, state, file: BOUNDARIES_FILE, valid, slides, needsDecision, problems, audio: { samplesMatch } } };
}

export async function run({ ctx, opts, workspace }) {
  if (!workspace) throw usageError('--workspace is required');
  const store = createFsStore(workspace);
  if (opts.script) await checkPackMatches(store, opts.script);
  const st = await buildStatus(store);
  const pending = await pendingExports(store);
  for (const p of pending) ctx.warn('volumes-missing', `export ${p.exportId} is waiting for volume(s) ${p.missing.join(', ')}`, { exportId: p.exportId, missing: p.missing });
  if (st.result.staleSlides.length) ctx.warn('stale-slides', `${st.result.staleSlides.length} slide(s) were recorded with different text`, { staleSlides: st.result.staleSlides });
  for (const s of st.result.slides) if (s.selectionInvalid) ctx.warn('bad-selection', `the selection for ${s.slideId} does not match any candidate`, { slideId: s.slideId });
  const { continuous, boundaries } = await boundariesStatus(store, st.script);
  const byId = new Map(boundaries.slides.map((s) => [s.slideId, s]));
  const slides = boundaries.present ? st.result.slides.map((s) => (byId.has(s.slideId) ? { ...s, boundary: { status: byId.get(s.slideId).status, confidence: byId.get(s.slideId).confidence } } : s)) : st.result.slides;
  if (boundaries.state === 'waiting-for-boundaries') ctx.warn('boundaries-missing', 'a continuous recording is imported but there are no boundaries yet; make them with transcribe -> align (narrate boundary set for the uncertain ones), then render', { sessions: continuous.sessions.map((s) => s.sessionId) });
  if (boundaries.state === 'needs-decision') ctx.warn('boundaries-need-decision', `${boundaries.needsDecision.length} slide boundary(ies) need a decision (${boundaries.needsDecision.join(', ')}); render stops with exit code 4 until they are decided`, { slides: boundaries.needsDecision });
  if (boundaries.state === 'invalid') ctx.warn('boundaries-invalid', 'boundaries.json does not fit the workspace; render will refuse it', { problems: boundaries.problems });
  return { result: { ...st.result, slides, continuous, boundaries, pending } };
}
