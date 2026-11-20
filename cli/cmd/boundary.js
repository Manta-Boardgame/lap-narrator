// boundary：スライドの切れ目（boundaries.json）を見る・決める。
//   narrate boundary show --workspace <dir>
//   narrate boundary set --slide <id> --at <秒> [--exact] [--snap-radius 1.0] --workspace <dir>
//       そのスライドの終わり（＝次のスライドの始まり）の切れ目を決める。既定は、指定の時刻に最も近い無音（0.2 秒以上）の中点へ吸着する（--snap）。
//       吸着しない（その時刻のまま）のは --exact。近くに無音がなければ、その時刻のまま（警告 no-silence-near）。
//       status:"confirmed"、method:"manual"、confidence:1 になる。隣の切れ目と逆転・重なるときは拒否（終了コード 2、errors[0].code = "boundary-order"）。
//   narrate boundary set --slide <id> --at-text "文字起こしの語句" [--nth N] [--exact]
//       秒数の代わりに、文字起こしの語句（review に出る文字起こしからそのまま写す。句読点・かなの種類・漢数字は問わない）を指定する。
//       そのスライドと次のスライドの範囲の中でその語句を探し、**語句の終わりの直後の無音**の中点に置く（--before-text なら語句の始まりの直前の無音）。
//       複数の場所に当たるときは、候補を出して終了コード 2（errors[0].code = "ambiguous-text"）。--nth N で選ぶ。見つからないときは text-not-found（終了コード 2）。
//   narrate boundary confirm --slide <id> --workspace <dir>      候補のまま確定する（status:"confirmed"）
//   narrate boundary review --workspace <dir> [--out review.md|review.json] [--format md|json] [--context-sec 15] [--max-chars 450]
//       **すべての**切れ目（auto も）を、LLM／人が検算できる形で出す：位置・確かさ・状態、前後の約 15 秒の文字起こし（位置に ▮、5 秒ごとに ⟨秒⟩）、
//       台本の端、台本の文が文字起こしのどこに当たったか（一致度）、近くの無音、次点の候補、怪しさの印（flags）。1 切れ目 450 字以内（既定）。
//   直した切れ目（set／confirm）は、前の値を slides[].previous に残す（監査用。入れ子で履歴をたどれる）。
// boundaries.json は一時ファイル経由で書く。書く前に、連続・半開区間の条件（始まりが 0、end[i] == start[i+1]、最後の end == audio.samples）を確かめる。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { fileExists, writeFileAtomic } from '../lib/fsutil.js';
import { runSpeechPython, pythonFailure } from './transcribe.js';
import { floatOption } from './align.js';
import { intOption } from '../lib/args.js';

export const options = {
  slide: 'string', at: 'string', 'at-text': 'string', 'before-text': 'string', nth: 'string', exact: 'boolean', snap: 'boolean', 'snap-radius': 'string',
  out: 'string', format: 'string', 'context-sec': 'string', 'max-chars': 'string', script: 'string', transcript: 'string',
};

const FILE = 'boundaries.json';

/** 連続・半開区間の条件。壊れていれば CliError */
export function checkBoundaries(doc) {
  const bad = (m) => new CliError('bad-boundaries', `boundaries.json is not valid: ${m}`, { exit: EXIT.MISMATCH });
  if (!doc || doc.format !== 'lap-narrator/boundaries' || !Array.isArray(doc.slides) || doc.slides.length === 0) throw bad('missing format or slides');
  if (!Number.isInteger(doc.sampleRate) || doc.sampleRate <= 0) throw bad('sampleRate');
  const total = doc.audio && doc.audio.samples;
  if (!Number.isInteger(total) || total <= 0) throw bad('audio.samples');
  const s = doc.slides;
  if (s[0].startSample !== 0) throw bad('the first slide must start at sample 0');
  for (let i = 0; i < s.length; i++) {
    if (!Number.isInteger(s[i].startSample) || !Number.isInteger(s[i].endSample) || s[i].startSample >= s[i].endSample) throw bad(`slide ${s[i].slideId} has an empty or reversed span`);
    if (i > 0 && s[i - 1].endSample !== s[i].startSample) throw bad(`slide ${s[i].slideId} does not start where ${s[i - 1].slideId} ends`);
  }
  if (s[s.length - 1].endSample !== total) throw bad('the last slide must end at audio.samples');
}

async function load(workspace) {
  const file = path.join(workspace, FILE);
  if (!(await fileExists(file))) throw new CliError('no-boundaries', `no ${FILE} in the workspace (run narrate align first)`);
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { throw new CliError('bad-boundaries', `cannot read ${file}: ${e.message}`); }
  checkBoundaries(doc);
  return { file, doc };
}

const sec = (doc, n) => Math.round((n / doc.sampleRate) * 1000) / 1000;
const pending = (doc) => doc.slides.filter((s) => s.status === 'needs-decision').map((s) => s.slideId);
const rows = (doc) => doc.slides.map((s) => ({ slideId: s.slideId, order: s.order, startSec: sec(doc, s.startSample), endSec: sec(doc, s.endSample), startSample: s.startSample, endSample: s.endSample, confidence: s.confidence, method: s.method, status: s.status }));

function table(doc) {
  const head = ['slide', 'order', 'start(s)', 'end(s)', 'confidence', 'status', 'method'];
  const body = rows(doc).map((r) => [r.slideId, String(r.order), r.startSec.toFixed(3), r.endSec.toFixed(3), r.confidence.toFixed(2), r.status, r.method]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}

function findSlide(doc, id) {
  const i = doc.slides.findIndex((s) => s.slideId === id);
  if (i < 0) throw new CliError('no-such-slide', `no such slide in boundaries.json: ${id}`, { exit: EXIT.USAGE, detail: { slides: doc.slides.map((s) => s.slideId) } });
  return i;
}

/** 直す前の値を previous に残す（すでに previous があれば入れ子にする） */
function rememberPrevious(s, via) {
  const prev = { endSample: s.endSample, status: s.status, ...(s.method !== undefined ? { method: s.method } : {}), ...(s.confidence !== undefined ? { confidence: s.confidence } : {}), via };
  if (s.previous) prev.previous = s.previous;
  s.previous = prev;
}

const TEXT_EXIT = { 'text-not-found': EXIT.USAGE, 'bad-text': EXIT.USAGE, 'bad-nth': EXIT.USAGE, 'slides-mismatch': EXIT.MISMATCH, 'audio-mismatch': EXIT.MISMATCH };

function audioPathOf(workspace, doc) {
  return path.isAbsolute(doc.audio.file) ? doc.audio.file : path.join(workspace, ...doc.audio.file.split('/'));
}
function transcriptPathOf(workspace, doc, opts) {
  if (opts.transcript) return path.resolve(opts.transcript);
  const f = doc.transcript && doc.transcript.file;
  return f ? (path.isAbsolute(f) ? f : path.join(workspace, ...f.split('/'))) : path.join(workspace, 'transcript.json');
}

async function review({ ctx, opts, workspace, file, doc }) {
  const audio = audioPathOf(workspace, doc);
  const transcript = transcriptPathOf(workspace, doc, opts);
  const script = path.resolve(opts.script || path.join(workspace, 'script.json'));
  for (const [what, p] of [['audio', audio], ['transcript', transcript], ['script', script]]) if (!(await fileExists(p))) throw new CliError('cannot-read', `review needs the ${what}, but it is missing: ${p}`);
  const contextSec = floatOption(opts, 'context-sec', 15, { min: 3, max: 120 });
  const maxChars = intOption(opts, 'max-chars', 450, { min: 150, max: 5000 });
  const r = await runSpeechPython(ctx, 'review.py', ['--boundaries', file, '--transcript', transcript, '--script', script, '--audio', audio, '--context-sec', String(contextSec), '--max-chars', String(maxChars)], { timeoutMs: 600000 });
  if (r.code !== 0 || !r.out || r.out.ok !== true) throw pythonFailure(r, 'review', { exitFor: TEXT_EXIT });
  const { review: rv, markdown } = r.out;
  const outArg = opts.out ? path.resolve(opts.out) : null;
  const format = opts.format || (outArg && /\.json$/i.test(outArg) ? 'json' : 'md');
  if (format !== 'md' && format !== 'json') throw usageError('--format must be md or json');
  if (outArg) {
    await writeFileAtomic(outArg, format === 'json' ? JSON.stringify(rv, null, 1) + '\n' : markdown);
    return { result: { out: outArg, format, summary: rv.summary } };
  }
  return { result: format === 'json' ? { format, summary: rv.summary, cuts: rv.cuts } : { format, summary: rv.summary, markdown } };
}

async function locateText({ ctx, opts, workspace, doc, i }) {
  const mode = opts['before-text'] !== undefined ? 'before' : 'after';
  const text = mode === 'before' ? opts['before-text'] : opts['at-text'];
  const transcript = transcriptPathOf(workspace, doc, opts);
  const audio = audioPathOf(workspace, doc);
  for (const [what, p] of [['audio', audio], ['transcript', transcript]]) if (!(await fileExists(p))) throw new CliError('cannot-read', `--at-text needs the ${what}, but it is missing: ${p}`);
  const lo = doc.slides[i].startSample / doc.sampleRate;
  const hi = doc.slides[i + 1].endSample / doc.sampleRate;
  const args = ['--transcript', transcript, '--audio', audio, '--text', text, '--lo', String(lo), '--hi', String(hi), '--mode', mode];
  if (opts.nth !== undefined) args.push('--nth', String(intOption(opts, 'nth', 0, { min: 1, max: 1000 })));
  const r = await runSpeechPython(ctx, 'locate.py', args, { timeoutMs: 300000 });
  if (r.code !== 0 || !r.out || r.out.ok !== true) throw pythonFailure(r, 'locate', { exitFor: TEXT_EXIT });
  const { occurrences, chosen } = r.out;
  if (!chosen) {
    const slide = doc.slides[i].slideId;
    const wsArg = ` --workspace ${workspace}`;
    const cands = occurrences.map((o, k) => ({ nth: k + 1, startSec: o.startSec, endSec: o.endSec, context: o.context, howToSet: `narrate boundary set --slide ${slide} --${mode === 'before' ? 'before-text' : 'at-text'} ${JSON.stringify(text)} --nth ${k + 1}${wsArg}` }));
    throw new CliError('ambiguous-text', `the text matches ${occurrences.length} places between ${sec(doc, doc.slides[i].startSample)} s and ${sec(doc, doc.slides[i + 1].endSample)} s; choose one with --nth, or give a longer phrase`, { exit: EXIT.USAGE, detail: { occurrences: cands }, result: { occurrences: cands } });
  }
  return { sample: chosen.sample, info: { kind: chosen.kind, silenceSec: Math.round(chosen.silenceSec * 1000) / 1000, phraseSec: Math.round(chosen.phraseSec * 1000) / 1000, occurrence: chosen.occurrence, of: occurrences.length, mode } };
}

export async function run({ ctx, opts, positionals, workspace }) {
  if (!workspace) throw usageError('--workspace is required');
  const sub = positionals[0];
  if (!['show', 'set', 'confirm', 'review'].includes(sub)) throw usageError('usage: boundary show | boundary review | boundary set --slide <id> (--at <sec> | --at-text "<phrase>") | boundary confirm --slide <id>');
  const { file, doc } = await load(workspace);

  if (sub === 'review') return review({ ctx, opts, workspace, file, doc });

  if (sub === 'show') {
    const p = pending(doc);
    return { result: { boundaries: file, sampleRate: doc.sampleRate, audioSec: sec(doc, doc.audio.samples), counts: { slides: doc.slides.length, auto: doc.slides.filter((s) => s.status === 'auto').length, confirmed: doc.slides.filter((s) => s.status === 'confirmed').length, needsDecision: p.length }, slides: rows(doc), needsDecision: p, table: table(doc) } };
  }

  if (!opts.slide) throw usageError('--slide is required');
  const i = findSlide(doc, opts.slide);
  const s = doc.slides[i];

  if (sub === 'confirm') {
    rememberPrevious(s, 'confirm');
    s.status = 'confirmed';
    await writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
    return { result: { slideId: s.slideId, status: s.status, boundaryAfterSec: sec(doc, s.endSample), previous: s.previous, remainingNeedsDecision: pending(doc) } };
  }

  // set
  const given = ['at', 'at-text', 'before-text'].filter((k) => opts[k] !== undefined);
  if (given.length === 0) throw usageError('--at <seconds> or --at-text "<phrase>" is required');
  if (given.length > 1) throw usageError('give only one of --at, --at-text, --before-text');
  if (opts.exact && opts.snap) throw usageError('--exact and --snap cannot be used together');
  if (opts.at !== undefined && (!Number.isFinite(Number(opts.at)) || Number(opts.at) < 0)) throw usageError('--at must be a number of seconds (>= 0)', { value: opts.at });
  if (i === doc.slides.length - 1) throw new CliError('last-slide', `the end of the last slide (${s.slideId}) is the end of the audio; set the boundary after the previous slide instead`, { exit: EXIT.USAGE });
  let sample;
  let snapped = null;
  let via = 'at';
  let textInfo = null;
  if (opts.at !== undefined) {
    const at = Number(opts.at);
    sample = Math.round(at * doc.sampleRate);
    if (!opts.exact) {
      const audio = audioPathOf(workspace, doc);
      if (!(await fileExists(audio))) throw new CliError('cannot-read', `cannot snap: no such audio file ${audio} (use --exact to set the time as given)`);
      const radius = floatOption(opts, 'snap-radius', 1.0, { min: 0, max: 30 });
      const r = await runSpeechPython(ctx, 'snap.py', ['--audio', audio, '--at', String(at), '--radius', String(radius)], { timeoutMs: 300000 });
      if (r.code !== 0 || !r.out || r.out.ok !== true) throw pythonFailure(r, 'snap');
      sample = r.out.sample;
      snapped = { fromSec: at, toSec: sec(doc, sample), silenceSec: Math.round(r.out.silenceSec * 1000) / 1000, kind: r.out.kind };
      if (r.out.kind === 'none') ctx.warn('no-silence-near', `no quiet stretch of 0.2 s or more within ${radius} s of ${at}; the time is used as given`);
    }
  } else {
    via = opts['before-text'] !== undefined ? 'before-text' : 'at-text';
    const t = await locateText({ ctx, opts, workspace, doc, i });
    textInfo = t.info;
    sample = t.sample;
    if (opts.exact) sample = Math.round(t.info.phraseSec * doc.sampleRate);
    else if (t.info.kind === 'none') ctx.warn('no-silence-near', `no quiet stretch of 0.2 s or more right ${t.info.mode === 'before' ? 'before' : 'after'} the phrase (within 1.5 s); the phrase's own ${t.info.mode === 'before' ? 'start' : 'end'} (${t.info.phraseSec} s) is used`);
    snapped = { fromSec: t.info.phraseSec, toSec: sec(doc, sample), silenceSec: t.info.silenceSec, kind: opts.exact ? 'exact' : t.info.kind };
  }
  const next = doc.slides[i + 1];
  if (!(sample > s.startSample && sample < next.endSample)) {
    throw new CliError('boundary-order', `the boundary after ${s.slideId} must be between ${sec(doc, s.startSample)} s (start of ${s.slideId}) and ${sec(doc, next.endSample)} s (end of ${next.slideId}); got ${sec(doc, sample)} s`, { exit: EXIT.USAGE, detail: { slideId: s.slideId, sample, min: s.startSample, max: next.endSample } });
  }
  const before = s.endSample;
  rememberPrevious(s, via);
  s.endSample = sample;
  next.startSample = sample;
  s.status = 'confirmed';
  s.method = 'manual';
  s.confidence = 1;
  checkBoundaries(doc); // 書く前に、もう一度
  await writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  return { result: { slideId: s.slideId, boundaryAfterSec: sec(doc, sample), sample, previousSec: sec(doc, before), previous: s.previous, via, text: textInfo, snapped, status: s.status, method: s.method, remainingNeedsDecision: pending(doc) } };
}
