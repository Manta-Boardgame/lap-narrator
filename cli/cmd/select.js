// select：候補が複数あるスライドで、採用するテイクを選ぶ。selections.json（{slideId: {sessionId, takeId}}）を書く。
// 自動では書かない（取り込みも render も、selections.json を変えない）。
//   narrate select --slide <id> --session <id> --take <id> [--export <id>] --workspace <dir>
//   narrate select --slide <id> --clear --workspace <dir>     選択を取り消す
// --export は、同じテイクに全記録と完成版（編集の版が違う）があるとき、完成版の方を選ぶために使う。
import { CliError, usageError } from '../lib/errors.js';
import { createFsStore } from '../lib/store.js';
import { requireScript } from '../lib/workspace.js';
import { computeDecisions, publicCandidate } from '../lib/plan.js';
import { byStr } from '../lib/output.js';

export const options = { slide: 'string', session: 'string', take: 'string', export: 'string', clear: 'boolean' };

export async function run({ ctx, opts, workspace }) {
  if (!workspace) throw usageError('--workspace is required');
  if (!opts.slide) throw usageError('--slide is required');
  const store = createFsStore(workspace);
  const script = await requireScript(store);
  const d = await computeDecisions(store, script);
  const entry = d.slides.find((x) => x.slide.slideId === opts.slide);
  if (!entry) {
    const any = script.slides.find((s) => s.slideId === opts.slide);
    throw new CliError(any ? 'not-recordable' : 'no-such-slide', any ? `slide ${opts.slide} is not recordable` : `no such slide: ${opts.slide}`, { detail: { slides: d.slides.map((x) => x.slide.slideId) } });
  }
  const selections = { ...d.selections };
  if (opts.clear) {
    delete selections[opts.slide];
  } else {
    if (!opts.session || !opts.take) throw usageError('--session and --take are required (or --clear)');
    const found = entry.cands.filter((c) => c.sessionId === opts.session && c.takeId === opts.take && (opts.export === undefined || (c.source === 'final' && c.exportId === opts.export)));
    if (found.length === 0) {
      throw new CliError('no-such-candidate', `slide ${opts.slide} has no candidate ${opts.session}/${opts.take}${opts.export ? ` (export ${opts.export})` : ''}`, { detail: { candidates: entry.cands.map(publicCandidate) } });
    }
    const pick = found.find((c) => c.source === 'full') || found[0];
    if (pick.stale) ctx.warn('stale-take', `the take ${opts.session}/${opts.take} was recorded with different text than the current script`, { slideId: opts.slide });
    selections[opts.slide] = { sessionId: pick.sessionId, takeId: pick.takeId, ...(pick.source === 'final' ? { exportId: pick.exportId } : {}) };
  }
  const sorted = Object.fromEntries(Object.keys(selections).sort(byStr).map((k) => [k, selections[k]]));
  await store.writeJson('selections.json', sorted);
  return { result: { selections: sorted } };
}
