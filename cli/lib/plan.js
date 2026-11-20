// スライドごとの候補と採用の決定（status、select、render が共有する）。
import { analyzeSession, candidatesFor, decideSlide, loadSelections, loadSessions, recordableSlides } from './workspace.js';

/**
 * @param {any} store @param {any} script
 */
export async function computeDecisions(store, script) {
  const sessions = await loadSessions(store);
  const analyses = [];
  for (const s of sessions) analyses.push(await analyzeSession(store, s));
  const selections = await loadSelections(store);
  const slides = recordableSlides(script).map((slide) => {
    const cands = candidatesFor(slide, analyses);
    const decision = decideSlide(slide, cands, selections[slide.slideId]);
    return { slide, cands, decision, selection: selections[slide.slideId] || null };
  });
  return { sessions, analyses, selections, slides };
}

/** 候補を外へ出す形にする */
export const publicCandidate = (c) => {
  const { sampleRate, ...rest } = c;
  return { ...rest, sampleRate };
};
