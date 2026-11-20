// ワークスペースの読み取り：台本、選択、統合したセッション、スライドごとの候補（設計書 5.1、6.6）。計算は core の関数。
import {
  checkScript, parseJsonl, reduceEvents, planRender, defaultRenderSpec, buildTimeline,
} from '../../core/index.js';
import { CliError, EXIT } from './errors.js';
import { byStr, secOf } from './output.js';

export const RENDER_RATE = 48000;

/** 作業場の台本。無ければ null */
export async function loadScript(store) {
  const script = await store.readJson('script.json');
  if (script === null) return null;
  const chk = checkScript(script);
  if (!chk.ok) throw new CliError('bad-script', 'workspace script.json is invalid', { exit: EXIT.MISMATCH, detail: { errors: chk.errors.slice(0, 20) } });
  return script;
}

export async function requireScript(store) {
  const s = await loadScript(store);
  if (!s) throw new CliError('no-script', 'the workspace has no script yet (give a script pack with --script <pack.zip> to import)', { exit: EXIT.FAIL });
  return s;
}

export async function loadSelections(store) {
  const s = await store.readJson('selections.json');
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** 統合したセッションの session.json の一覧（sessionId の順） */
export async function loadSessions(store) {
  const out = [];
  for (const p of await store.list('sessions/')) {
    const m = /^sessions\/([^/]+)\/session\.json$/.exec(p);
    if (!m) continue;
    const s = await store.readJson(p);
    if (s) out.push(s);
  }
  return out.sort((a, b) => byStr(a.sessionId, b.sessionId));
}

/** 受領したが、まだ統合していない書き出し（巻が欠けている）：[{exportId, volumes, received:[...], missing:[...]}] */
export async function pendingExports(store) {
  const receipts = (await store.readJson('receipts.json')) ?? [];
  const sessions = await loadSessions(store);
  const committed = new Set(sessions.flatMap((s) => s.exports.map((e) => e.exportId)));
  const byExport = new Map();
  for (const r of receipts) {
    if (committed.has(r.exportId)) continue;
    const e = byExport.get(r.exportId) || { exportId: r.exportId, volumes: r.volumes, kind: r.kind, sessionId: r.sessionId, received: [] };
    e.received.push(r.volume);
    byExport.set(r.exportId, e);
  }
  return [...byExport.values()].map((e) => {
    const have = new Set(e.received);
    const missing = [];
    for (let v = 1; v <= e.volumes; v++) if (!have.has(v)) missing.push(v);
    return { ...e, received: e.received.sort((a, b) => a - b), missing };
  }).sort((a, b) => byStr(a.exportId, b.exportId));
}

/**
 * セッションの解釈：events.jsonl から reduceEvents で作る（segments.json と食い違ったら events.jsonl が正）。
 * 全記録が無いセッション（完成版だけ）は reduce が null。
 */
export async function analyzeSession(store, sess) {
  const sdir = `sessions/${sess.sessionId}/`;
  const scriptJson = await store.readJson(`${sdir}script.json`);
  const edits = await store.readJson(`${sdir}edits.json`);
  const rawFiles = sess.rawFiles || [];
  const preserveFileRotations = (sess.exports || []).some((e) => e.kind === 'full' && e.preserveFileRotations === true);
  let reduce = null;
  if (sess.events && (await store.exists(`${sdir}events.jsonl`))) {
    const r = await store.openRead(`${sdir}events.jsonl`);
    const text = new TextDecoder().decode(await r.read(0, r.size));
    const events = parseJsonl(text, { tolerateTruncated: true });
    reduce = reduceEvents(events, rawFiles.map((f) => ({ name: f.file, sampleRate: f.sampleRate, samples: f.samples, durableSamples: f.durableSamples })), {
      sessionId: sess.sessionId,
      trackFileRotations: preserveFileRotations,
    });
  }
  return {
    sess,
    sdir,
    scriptHashes: new Map(((scriptJson && scriptJson.slides) || []).map((s) => [s.slideId, s.textHash])),
    edits: edits || null,
    reduce,
    preserveFileRotations,
    rawRates: Object.fromEntries(rawFiles.map((f) => [f.file, f.sampleRate])),
    rawLengths: Object.fromEntries(rawFiles.map((f) => [f.file, f.samples])),
  };
}

/** speaker ごとの倍率（edits.gainDb） */
export const gainFor = (edits, slide) => {
  const g = edits && edits.gainDb && slide && slide.speaker !== undefined ? edits.gainDb[slide.speaker] : undefined;
  return typeof g === 'number' && Number.isFinite(g) ? g : 0;
};

/** 全記録のテイクの描画計画（長さ。編集を適用したあと）。描画できなければ problem */
export function planForTake(an, takeId, slide) {
  const r = an.reduce;
  const segs = r.segments.filter((s) => s.takeId === takeId && s.status === 'kept').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const args = {
    segments: segs, rawRates: an.rawRates, rawLengths: an.rawLengths, allSegments: r.segments, edits: an.edits || {},
    gainDb: gainFor(an.edits, slide), spec: { ...defaultRenderSpec(), sampleRate: RENDER_RATE, preserveFileRotations: an.preserveFileRotations },
  };
  try { return { segs, args, plan: planRender(args) }; } catch (e) {
    return { segs, args, plan: null, problem: { code: e.code || 'render-error', message: e.message } };
  }
}

/**
 * スライドごとの候補。
 * - 全記録のセッション：閉じていて採用の区間があるテイクすべてを候補にする。そのセッションの既定のテイク（edits.selections、なければ reduce の既定）に `default: true`。
 *   既定でないテイクは `alternative: true`（`select` で選べるが、「候補が複数」の数には入れない）。
 * - 完成版：役割が `candidate`（全記録の編集の版と違う、または全記録が無い）のものを候補にする。`verify-only` は数えない。
 * - `stale`：セッションの台本の textHash が、作業場の台本と違う（または無い）。
 */
export function candidatesFor(slide, analyses) {
  const out = [];
  for (const an of analyses) {
    const tid = an.scriptHashes.get(slide.slideId);
    const stale = tid !== slide.textHash;
    if (an.reduce) {
      const takes = an.reduce.takes.filter((t) => t.slideId === slide.slideId && t.candidate);
      const edited = an.edits && an.edits.selections ? an.edits.selections[slide.slideId] : undefined;
      const def = takes.some((t) => t.takeId === edited) ? edited : an.reduce.defaultTakes[slide.slideId];
      for (const t of takes) {
        const pl = planForTake(an, t.takeId, slide);
        const samples = pl.plan ? pl.plan.totalSamples : t.samples;
        out.push({
          sessionId: an.sess.sessionId, takeId: t.takeId, source: 'full', samples, sampleRate: RENDER_RATE, sec: secOf(samples, RENDER_RATE),
          default: t.takeId === def, alternative: t.takeId !== def, stale,
          ...(pl.problem ? { problem: pl.problem } : {}),
        });
      }
    }
    for (const f of an.sess.finals || []) {
      if (f.role !== 'candidate') continue;
      const fs = f.slides.find((x) => x.slideId === slide.slideId);
      if (!fs) continue;
      out.push({
        sessionId: an.sess.sessionId, takeId: fs.takeId, source: 'final', exportId: f.exportId, editVersion: f.editVersion,
        samples: fs.samples, sampleRate: fs.sampleRate, sec: secOf(fs.samples, fs.sampleRate),
        default: true, alternative: false, stale,
      });
    }
  }
  return out;
}

/** 選択（selections.json の 1 件）に合う候補。exportId があればそれも合わせる。無ければ全記録のテイクを優先 */
export function findSelected(cands, sel) {
  if (!sel) return null;
  const same = cands.filter((c) => c.sessionId === sel.sessionId && c.takeId === sel.takeId);
  if (sel.exportId !== undefined) return same.find((c) => c.source === 'final' && c.exportId === sel.exportId) || null;
  return same.find((c) => c.source === 'full') || same[0] || null;
}

/**
 * スライドの状態と採用する候補を決める。
 * 数える候補：古くなっておらず（stale でなく）、既定のもの（alternative でない）。1 件なら single、2 件以上なら multiple、0 件で古い候補があれば stale、なければ missing。
 * 選択があれば、それを採用する（古くても。ただし警告）。
 */
export function decideSlide(slide, cands, selection) {
  const counted = cands.filter((c) => !c.stale && !c.alternative);
  const staleOnly = cands.filter((c) => c.stale && !c.alternative);
  let state;
  if (counted.length >= 2) state = 'multiple';
  else if (counted.length === 1) state = 'single';
  else if (staleOnly.length) state = 'stale';
  else state = 'missing';
  const sel = selection ? findSelected(cands, selection) : null;
  const selectionInvalid = !!selection && !sel;
  let chosen = null;
  let needsDecision = false;
  if (sel) chosen = sel;
  else if (state === 'single') chosen = counted[0];
  else if (state === 'multiple') needsDecision = true;
  return { state, chosen, needsDecision, selectionInvalid, bySelection: !!sel, countedCount: counted.length };
}

/** 予定表の長さの見積もり：採用した候補の長さから core の buildTimeline で求める */
export function estimateTimeline(script, chosenList) {
  const finals = chosenList.map((c) => ({ slideId: c.slideId, samples: c.samples, sampleRate: RENDER_RATE, parts: [{ file: `final/${c.slideId}.wav`, samples: c.samples }] }));
  return buildTimeline({ script, finals, sampleRate: RENDER_RATE }).totalSamples;
}

export const recordableSlides = (script) => script.slides.filter((s) => s.recordable === true).sort((a, b) => a.order - b.order);

/** 台本で録音の対象でないスライド（動画に入らない）：[{slideId, order, title, reason}]（order 順）。台本が無い・読めなければ null */
export function skippedSlideList(script) {
  if (!script || !Array.isArray(script.slides)) return null;
  return script.slides.filter((s) => !s.recordable).sort((a, b) => a.order - b.order)
    .map((s) => ({ slideId: s.slideId, order: s.order, title: s.title ?? '', reason: 'not-recordable' }));
}
