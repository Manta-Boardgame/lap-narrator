// align：台本（スライドごとの文）と文字起こしを照合して、スライドの切れ目 boundaries.json を決める（PLAN2、設計書 8.2）。
//   narrate align --workspace <dir> [--transcript <transcript.json>] [--script <script-pack.zip|script.json>] [--audio <wav>]
//                 [--threshold 0.8] [--out <boundaries.json>] [--force] [--timeout-sec N]
// 既定：transcript = <ws>/transcript.json、script = <ws>/script.json、audio = transcript.audio.file（作業場からの相対）、out = <ws>/boundaries.json。
// 自信が閾値以上の切れ目だけ status:"auto"。足りない所は "needs-decision" で、boundaries.json は書いたうえで終了コード 4
// （errors[0].code = "decision-required"、result.needsDecision に候補と前後の文字起こし）。決めるのは `narrate boundary set`。
// すでに人が決めた切れ目（confirmed／manual）がある boundaries.json は、--force なしでは上書きしない。
// 実体は checker/speech/align.py（.venv の Python を -I で呼ぶ）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { fileExists, writeFileAtomic } from '../lib/fsutil.js';
import { intOption } from '../lib/args.js';
import { pythonFailure, runSpeechPython } from './transcribe.js';

export const options = { transcript: 'string', script: 'string', audio: 'string', threshold: 'string', out: 'string', force: 'boolean', 'timeout-sec': 'string' };

const relOrAbs = (workspace, p) => {
  if (workspace) {
    const rel = path.relative(workspace, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return p;
};

export function floatOption(opts, name, def, { min, max }) {
  if (opts[name] === undefined) return def;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n < min || n > max) throw usageError(`--${name} must be a number between ${min} and ${max}`, { option: name, value: opts[name] });
  return n;
}

export async function run({ ctx, opts, workspace }) {
  if (!workspace && !(opts.transcript && opts.script && opts.audio)) throw usageError('--workspace is required (or give --transcript, --script and --audio)');
  const transcript = path.resolve(opts.transcript || path.join(workspace, 'transcript.json'));
  const script = path.resolve(opts.script || path.join(workspace, 'script.json'));
  const threshold = floatOption(opts, 'threshold', 0.8, { min: 0, max: 1 });
  const out = path.resolve(opts.out || (workspace ? path.join(workspace, 'boundaries.json') : 'boundaries.json'));
  if (!(await fileExists(transcript))) throw new CliError('cannot-read', `no such transcript: ${transcript} (run narrate transcribe first)`);
  if (!(await fileExists(script))) throw new CliError('no-script', `no such script: ${script} (give --script <script-pack.zip> or import one into the workspace)`);
  let audio;
  if (opts.audio) audio = path.resolve(opts.audio);
  else {
    let tj;
    try { tj = JSON.parse(await fsp.readFile(transcript, 'utf8')); } catch (e) { throw new CliError('bad-transcript', `cannot read the transcript: ${e.message}`); }
    const f = tj && tj.audio && tj.audio.file;
    if (typeof f !== 'string' || !f) throw new CliError('bad-transcript', 'the transcript has no audio.file; give --audio <wav>');
    audio = path.isAbsolute(f) ? f : path.resolve(workspace || path.dirname(transcript), f);
  }
  if (!(await fileExists(audio))) throw new CliError('cannot-read', `no such audio file: ${audio}`);
  // 人が決めた切れ目を黙って消さない
  if (!opts.force && (await fileExists(out))) {
    let old = null;
    try { old = JSON.parse(await fsp.readFile(out, 'utf8')); } catch { /* 壊れていれば上書きしてよい */ }
    const decided = old && Array.isArray(old.slides) ? old.slides.filter((s) => s.status === 'confirmed' || s.method === 'manual').map((s) => s.slideId) : [];
    if (decided.length) throw new CliError('would-overwrite-decisions', `${out} has ${decided.length} boundary decision(s) made by a person or an LLM (${decided.join(', ')}); pass --force to discard them and align again`, { detail: { slides: decided } });
  }
  const args = ['--transcript', transcript, '--script', script, '--audio', audio, '--threshold', String(threshold),
    '--audio-label', relOrAbs(workspace, audio), '--transcript-label', relOrAbs(workspace, transcript)];
  const r = await runSpeechPython(ctx, 'align.py', args, { timeoutMs: intOption(opts, 'timeout-sec', 1800, { min: 1 }) * 1000 });
  if (r.code !== 0 || !r.out || r.out.ok !== true) throw pythonFailure(r, 'align', { exitFor: { 'transcript-mismatch': EXIT.MISMATCH } });
  const { boundaries, needsDecision, report } = r.out;
  await writeFileAtomic(out, JSON.stringify(boundaries, null, 2) + '\n');
  const rate = boundaries.sampleRate;
  const slides = boundaries.slides.map((s) => ({
    slideId: s.slideId, order: s.order, startSec: Math.round((s.startSample / rate) * 1000) / 1000, endSec: Math.round((s.endSample / rate) * 1000) / 1000,
    confidence: s.confidence, method: s.method, status: s.status,
  }));
  const counts = { slides: slides.length, auto: slides.filter((s) => s.status === 'auto').length, confirmed: 0, needsDecision: needsDecision.length };
  const wsArg = workspace ? ` --workspace ${workspace}` : '';
  const howTo = (e) => `narrate boundary set --slide ${e.slideId} --at <seconds>${wsArg}   (or accept ${e.boundaryAfter}s as it is: narrate boundary confirm --slide ${e.slideId}${wsArg})`;
  for (const e of needsDecision) e.howToSet = howTo(e);
  // 見直しのすすめ：自動で確定した切れ目も、LLM／人が見直せる（boundary review）。確かさが低めのものを数える
  const cutsOnly = boundaries.slides.slice(0, -1);
  const lowAuto = cutsOnly.filter((x) => x.status === 'auto' && x.confidence < 0.9).map((x) => `${x.slideId} ${x.confidence}`);
  const reviewCmd = `narrate boundary review --workspace ${workspace || '<dir>'}`;
  const reviewHint = `判断待ちは ${needsDecision.length} 件です。自動で確定した切れ目 ${cutsOnly.filter((x) => x.status === 'auto').length} 件のうち、確かさが 0.9 未満のものが ${lowAuto.length} 件${lowAuto.length ? `（${lowAuto.join('、')}）` : ''}あります。`
    + `faster-whisper の聞き間違いは、確かさが高くても起こり得ます。切れ目の位置を前後の文字起こしと台本で確かめるには、\`${reviewCmd}\` で全部の切れ目を見直してください（直すのは \`narrate boundary set --slide <id> --at <秒>\` または \`--at-text "語句"\`）。`;
  const result = { boundaries: out, threshold, counts, slides, needsDecision, report, reviewHint };
  if (needsDecision.length) {
    return {
      result,
      errors: [{ code: 'decision-required', message: `${needsDecision.length} slide boundary(ies) need a decision (${needsDecision.map((e) => e.slideId).join(', ')}); see result.needsDecision, then run narrate boundary set / confirm` , detail: { slides: needsDecision.map((e) => e.slideId) } }],
      exit: EXIT.DECISION,
    };
  }
  return { result };
}
