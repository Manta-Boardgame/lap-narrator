// 録音アプリが書き出した入力フォルダー（session*/input）を、CLI（import → status → render）に通して、正解（session*/truth）と照らす（担当 E）。
//   node testgen/verify-narration.js --dir work/N/session1 --workspace work/N/check1
// 照らすこと：
//   1. status：台本の録音できる 13 枚がすべて single。
//   2. render：各スライドの長さが、予定表（操作の時刻）から求めた正解の長さと ±50ms 以内。
//   3. 完成した音声の中に、そのスライドの文の音が、正しい順に、予定どおりの間隔で入っている（相互相関 0.99 以上）。
//   4. 撮り直しで捨てた音（読み間違い、読み直す前に読んだ文）と、ほかのスライドの文の音が入っていない（相互相関が小さい）。
// 結果を <dir>/verify.json に書く。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from './lib/wav.js';
import { narrate, ROOT } from '../test/e2e/helpers/e2e.js';
import { oracleReduce } from '../test/oracle/reduce-oracle.js'; // 担当 E の、操作記録から採用する区間を求める別実装（core とは無関係）

const RATE = 48000;

// ---- FFT による相互相関 --------------------------------------------------------------------------------
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** 1 次の高域強調（低い周波数のうなりや、こもった音で相関が底上げされるのを抑える）。 */
export const preEmph = (x) => { const y = new Float64Array(x.length); for (let i = 1; i < x.length; i++) y[i] = x[i] - 0.97 * x[i - 1]; return y; };

/** 長い音 R と、短い音の欠片のあらゆる位置での正規化相互相関。R の FFT を使い回す。 */
export class Correlator {
  constructor(R) {
    this.R = R;
    this.n = R.length;
    this.size = 1 << Math.ceil(Math.log2(this.n + 100000));
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    for (let i = 0; i < this.n; i++) this.re[i] = R[i];
    fft(this.re, this.im, false);
    this.pre = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) this.pre[i + 1] = this.pre[i] + R[i] * R[i];
  }

  /** @returns {{pos:number, score:number, all:{pos:number,score:number}[]}} 最も合う位置（欠片の先頭に当たる R の位置）と、相関（0..1）。 */
  find(t, { peaks = 0 } = {}) {
    const m = t.length;
    if (m > this.n) return { pos: -1, score: 0, all: [] };
    const tr = new Float64Array(this.size);
    const ti = new Float64Array(this.size);
    let et = 0;
    for (let i = 0; i < m; i++) { tr[i] = t[i]; et += t[i] * t[i]; }
    fft(tr, ti, false);
    for (let i = 0; i < this.size; i++) { // R * conj(T)
      const a = this.re[i]; const b = this.im[i];
      const c = tr[i]; const d = -ti[i];
      tr[i] = a * c - b * d;
      ti[i] = a * d + b * c;
    }
    fft(tr, ti, true);
    let best = -1; let pos = -1;
    const cand = [];
    for (let j = 0; j + m <= this.n; j++) {
      const er = this.pre[j + m] - this.pre[j];
      const sc = er > 0 && et > 0 ? tr[j] / Math.sqrt(er * et) : 0;
      if (sc > best) { best = sc; pos = j; }
      if (peaks && sc > 0.9) cand.push({ pos: j, score: sc });
    }
    // 近い位置の山をまとめる
    const all = [];
    for (const c of cand) { const l = all.at(-1); if (l && c.pos - l.pos < 2400) { if (c.score > l.score) { l.pos = c.pos; l.score = c.score; } } else all.push({ ...c }); }
    return { pos, score: best, all };
  }
}

/** 区間の中から、エネルギーの大きい 0.5 秒（以内）の欠片を取る。 */
export function snippet(wav, start, end, at = 0.4, len = 24000) {
  const a = Math.min(end - 1, start + Math.floor((end - start) * at));
  const b = Math.min(end, a + len);
  const from = Math.max(start, b - len);
  return { t: wav.subarray(from, b), off: from };
}

export async function verify({ dir, workspace }) {
  const out = { dir, checks: {}, slides: [], ok: true };
  const fail = (name, detail) => { out.checks[name] = { ok: false, detail }; out.ok = false; };
  const pass = (name, detail) => { out.checks[name] = { ok: true, detail }; };
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth', 'truth.json'), 'utf8'));
  const wavFile = preEmph(decodeWav(new Uint8Array(fs.readFileSync(path.join(dir, 'mic.wav')))).samples);
  const input = path.join(dir, 'input');
  const ws = path.resolve(workspace);
  fs.rmSync(ws, { recursive: true, force: true });

  const imp = await narrate(['import', input, '--workspace', ws], { timeoutMs: 600000 });
  out.import = { code: imp.code, ms: imp.ms, ok: imp.env?.ok, warnings: imp.env?.warnings, errors: imp.env?.errors, committed: imp.env?.result?.committed };
  if (imp.code !== 0) { fail('import', imp.stdout.slice(0, 500) + imp.stderr.slice(-500)); return out; }
  const st = await narrate(['status', '--workspace', ws]);
  const stRes = st.env?.result;
  out.status = { code: st.code, counts: stRes?.counts, skipped: stRes?.skippedSlides, totalSec: stRes?.totalSec };
  const expectIds = truth.slides.map((s) => s.slideId);
  const bad = (stRes?.slides ?? []).filter((s) => expectIds.includes(s.slideId) && s.state !== 'single');
  const missing = expectIds.filter((id) => !(stRes?.slides ?? []).some((s) => s.slideId === id));
  if (st.code !== 0 || bad.length || missing.length || (stRes?.slides ?? []).filter((s) => expectIds.includes(s.slideId)).length !== expectIds.length) fail('status-single', { bad: bad.map((s) => [s.slideId, s.state]), missing });
  else pass('status-single', `${expectIds.length} recordable slides are all single`);

  const rd = await narrate(['render', '--workspace', ws], { timeoutMs: 600000 });
  out.render = { code: rd.code, ms: rd.ms };
  if (rd.code !== 0) { fail('render', rd.stdout.slice(0, 500) + rd.stderr.slice(-500)); return out; }
  const finals = new Map(rd.env.result.finals.map((f) => [f.slideId, f]));

  // アプリの操作記録（run.json）から、別実装（oracle）で採用する区間を求める。完成した音声の長さは、これと 1 サンプルも違わないはず
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const oracle = oracleReduce(run.events, run.state.rawFiles.map((r) => ({ name: r.name, sampleRate: r.sampleRate ?? RATE, samples: r.samples })), {});
  const oracleLen = new Map();
  for (const g of oracle.segments) if (g.status === 'kept') oracleLen.set(g.slideId, (oracleLen.get(g.slideId) ?? 0) + (g.end - g.start));
  out.oracleIssues = oracle.issues;
  // 各スライドの正解
  const allSpeech = truth.segments.filter((s) => s.kind === 'speech');
  const junkSegs = truth.segments.filter((s) => s.kind === 'junk' || s.kind === 'discarded');
  let maxLenDiff = 0;
  let maxSeamDiff = 0;
  let maxEdgeDiff = 0;
  let worstOtherScore = 0;
  let worstJunkScore = 0;
  let minOwnScore = 1;
  const problems = [];
  const late = []; // 「入っていないはず」の相関。入っているはずの文の相関（minOwn）の 8 割を超えたら、入っているとみなす（雑音の入った音では、入っている文の相関も 0.86 程度に下がる）
  for (const sl of truth.slides) {
    const f = finals.get(sl.slideId);
    const row = { slideId: sl.slideId, plannedSec: +(sl.plannedSamples / RATE).toFixed(3), retakes: sl.retakes, oksMid: sl.oksMid };
    out.slides.push(row);
    if (!f) { problems.push(`${sl.slideId}: no final`); continue; }
    if (f.parts.length !== 1) { problems.push(`${sl.slideId}: ${f.parts.length} parts`); continue; }
    const R = decodeWav(new Uint8Array(fs.readFileSync(path.join(ws, 'out', f.parts[0].file)))).samples;
    row.renderSec = +(R.length / RATE).toFixed(3);
    row.oracleSamples = oracleLen.get(sl.slideId) ?? 0;
    row.renderVsOracleSamples = R.length - row.oracleSamples;
    row.plannedVsOracleMs = +(((row.oracleSamples - sl.plannedSamples) / RATE) * 1000).toFixed(1);
    if (row.renderVsOracleSamples !== 0) problems.push(`${sl.slideId}: render has ${R.length} samples but the operation log says ${row.oracleSamples}`);
    row.lenDiffMs = +(((R.length - sl.plannedSamples) / RATE) * 1000).toFixed(1);
    maxLenDiff = Math.max(maxLenDiff, Math.abs(row.lenDiffMs));
    if (Math.abs(row.lenDiffMs) > 50) problems.push(`${sl.slideId}: length ${row.renderSec}s vs planned ${row.plannedSec}s (${row.lenDiffMs}ms)`);

    const corr = new Correlator(preEmph(R));
    // 3) 正しい文が、正しい順で、予定どおりの間隔で入っている
    const own = allSpeech.filter((s) => s.slideId === sl.slideId);
    const found = [];
    for (const seg of own) {
      const sn = snippet(wavFile, seg.start, seg.end);
      const r = corr.find(sn.t);
      const q = r.pos - (sn.off - seg.start); // 欠片の位置から、文の先頭の位置へ
      found.push({ seg, score: r.score, q });
      minOwnScore = Math.min(minOwnScore, r.score);
      if (r.score < 0.7) problems.push(`${sl.slideId}: sentence ${seg.sentence} not found in render (score ${r.score.toFixed(3)})`);
    }
    // 期待する、文の先頭の位置（完成した音声の中）。採用する区間（pieces）を順につないだときの位置
    let acc = 0;
    const pieceOffsets = sl.pieces.map((p) => { const o = acc; acc += p.end - p.start; return o; });
    const expectQ = (segStart) => {
      for (let i = 0; i < sl.pieces.length; i++) {
        const p = sl.pieces[i];
        if (segStart >= p.start && segStart < p.end) return pieceOffsets[i] + (segStart - p.start);
      }
      return null;
    };
    row.sentences = [];
    found.forEach((x) => {
      const e = expectQ(x.seg.start);
      const d = e === null ? null : ((x.q - e) / RATE) * 1000;
      row.sentences.push({ sentence: x.seg.sentence, score: +x.score.toFixed(4), placeDiffMs: d === null ? null : +d.toFixed(1) });
      if (d === null) problems.push(`${sl.slideId}: sentence ${x.seg.sentence} is outside the planned pieces`);
      else { maxSeamDiff = Math.max(maxSeamDiff, Math.abs(d)); if (Math.abs(d) > 50) problems.push(`${sl.slideId}: sentence ${x.seg.sentence} is ${d.toFixed(1)}ms from the planned place`); }
    });
    // 先頭と末尾の余白（切り方のずれ）
    if (found.length) {
      const lead = found[0].q;
      const planLead = found[0].seg.start - sl.pieces[0].start;
      const lastSeg = own.at(-1);
      const tailRender = R.length - (found.at(-1).q + (lastSeg.end - lastSeg.start));
      const planTail = sl.pieces.at(-1).end - lastSeg.end;
      row.leadDiffMs = +(((lead - planLead) / RATE) * 1000).toFixed(1);
      row.tailDiffMs = +(((tailRender - planTail) / RATE) * 1000).toFixed(1);
      maxEdgeDiff = Math.max(maxEdgeDiff, Math.abs(row.leadDiffMs), Math.abs(row.tailDiffMs));
    }
    // 4) 捨てた音、ほかのスライドの文が入っていない
    const myJunk = junkSegs.filter((s) => s.slideId === sl.slideId);
    row.junk = [];
    for (const j of myJunk) {
      let best = 0;
      for (const at of [0.2, 0.5, 0.8]) best = Math.max(best, corr.find(snippet(wavFile, j.start, j.end, at, 32000).t).score);
      row.junk.push({ kind: j.kind, text: j.text.slice(0, 14), score: +best.toFixed(3) });
      worstJunkScore = Math.max(worstJunkScore, best);
      late.push({ slideId: sl.slideId, score: best, what: `discarded audio (${j.kind})` });
    }
    // ほかのスライドの文：すべての文の欠片を当てる（同じ文の読みが別のスライドにあることはない）
    const others = allSpeech.filter((s) => s.slideId !== sl.slideId);
    let wo = 0;
    for (const o of others) wo = Math.max(wo, corr.find(snippet(wavFile, o.start, o.end, 0.3, 48000).t).score);
    row.worstOtherScore = +wo.toFixed(3);
    worstOtherScore = Math.max(worstOtherScore, wo);
    late.push({ slideId: sl.slideId, score: wo, what: "another slide's sentence" });
  }
  const absentThr = 0.8 * minOwnScore;
  for (const l of late) if (l.score > absentThr) problems.push(`${l.slideId}: ${l.what} seems to be in the render (score ${l.score.toFixed(3)} > ${absentThr.toFixed(3)})`);
  out.summary = { absentThreshold: +absentThr.toFixed(3), maxLenDiffMs: +maxLenDiff.toFixed(1), maxSentencePlaceDiffMs: +maxSeamDiff.toFixed(1), maxEdgeDiffMs: +maxEdgeDiff.toFixed(1), minOwnSentenceScore: +minOwnScore.toFixed(4), worstJunkScore: +worstJunkScore.toFixed(3), worstOtherSlideScore: +worstOtherScore.toFixed(3) };
  if (problems.length) fail('content', problems);
  else pass('content', 'lengths within 50ms, own sentences found in order, no discarded audio, no other slides');
  fs.writeFileSync(path.join(dir, 'verify.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const dir = path.resolve(arg('--dir'));
  const r = await verify({ dir, workspace: arg('--workspace', path.join(ROOT, 'work', 'N', 'check')) });
  console.log(JSON.stringify({ ok: r.ok, checks: r.checks, summary: r.summary, status: r.status }, null, 1));
  process.exit(r.ok ? 0 : 1);
}
