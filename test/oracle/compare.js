// ReduceResult の比較（oracle の試験と、core との照合で使う）。
// 比べない／ゆるく比べるもの：
//   - issues[].message（自由な文）。issues は (seq, code) の並びで比べる（issues の順序は CONTRACTS.md に決まりがない）
//   - startSec、endSec は 1e-9 の誤差を許す
//   - marks は、期待値にある項目だけを比べる（実際の値に余分な項目があってよい）
//   - strictReason が偽なら、採用（kept）の区間の reason は比べない
import { canonicalJson } from '../../testgen/lib/hash.js';

const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * @returns {string[]} 食い違いの説明（空なら一致）
 */
export function compareReduceResult(actual, expected, opt = {}) {
  const strictReason = opt.strictReason ?? true;
  const diffs = [];
  const d = (m) => diffs.push(m);

  for (const k of ['format', 'version', 'sessionId']) if (actual[k] !== expected[k]) d(`${k}: ${actual[k]} != ${expected[k]}`);

  // 区間
  if (actual.segments.length !== expected.segments.length) {
    d(`segments.length: ${actual.segments.length} != ${expected.segments.length}`);
  }
  const n = Math.min(actual.segments.length, expected.segments.length);
  for (let i = 0; i < n; i++) {
    const a = actual.segments[i];
    const e = expected.segments[i];
    const tag = `segments[${i}] ${e.segmentId}`;
    for (const k of ['segmentId', 'takeId', 'slideId', 'raw', 'start', 'end', 'status', 'order']) {
      if (!same(a[k], e[k])) d(`${tag}.${k}: ${JSON.stringify(a[k])} != ${JSON.stringify(e[k])}`);
    }
    if (strictReason || e.status !== 'kept') {
      if (!same(a.reason, e.reason)) d(`${tag}.reason: ${JSON.stringify(a.reason)} != ${JSON.stringify(e.reason)}`);
    }
    for (const k of ['startSec', 'endSec']) {
      if (e[k] === undefined) {
        if (strictReason && a[k] !== undefined) d(`${tag}.${k}: present but expected absent`);
      } else if (a[k] === undefined || Math.abs(a[k] - e[k]) > 1e-9) {
        d(`${tag}.${k}: ${a[k]} != ${e[k]}`);
      }
    }
  }

  // テイク
  if (actual.takes.length !== expected.takes.length) d(`takes.length: ${actual.takes.length} != ${expected.takes.length}`);
  const nt = Math.min(actual.takes.length, expected.takes.length);
  for (let i = 0; i < nt; i++) {
    const a = actual.takes[i];
    const e = expected.takes[i];
    for (const k of ['takeId', 'slideId', 'status', 'startSeq', 'endSeq', 'segments', 'samples', 'candidate']) {
      if (!same(a[k], e[k])) d(`takes[${i}] ${e.takeId}.${k}: ${JSON.stringify(a[k])} != ${JSON.stringify(e[k])}`);
    }
  }

  if (!same(actual.defaultTakes, expected.defaultTakes)) d(`defaultTakes: ${JSON.stringify(actual.defaultTakes)} != ${JSON.stringify(expected.defaultTakes)}`);
  if (!same(actual.recoverable, expected.recoverable)) d(`recoverable: ${JSON.stringify(actual.recoverable)} != ${JSON.stringify(expected.recoverable)}`);

  // marks（期待値にある項目だけ）
  const am = actual.marks ?? [];
  const em = expected.marks ?? [];
  if (am.length !== em.length) d(`marks.length: ${am.length} != ${em.length}`);
  for (let i = 0; i < Math.min(am.length, em.length); i++) {
    for (const k of Object.keys(em[i])) if (!same(am[i][k], em[i][k])) d(`marks[${i}].${k}: ${JSON.stringify(am[i][k])} != ${JSON.stringify(em[i][k])}`);
  }

  // issues（seq、code の並びで比べる）
  const key = (x) => `${String(x.seq).padStart(8, '0')}:${x.code}`;
  const ai = (actual.issues ?? []).map(key).sort();
  const ei = (expected.issues ?? []).map(key).sort();
  if (!same(ai, ei)) d(`issues: ${JSON.stringify(ai)} != ${JSON.stringify(ei)}`);

  return diffs;
}
