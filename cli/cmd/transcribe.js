// transcribe：通しの音声を文字起こしする（faster-whisper、単語ごとの時刻）。PLAN2 の transcript.json を書く。
//   narrate transcribe (--audio <wav> | --workspace <dir> [--audio-name final/all.wav]) [--model small] [--out transcript.json]
//                      [--models-dir <dir>] [--vad on|off] [--threads N] [--force] [--timeout-sec N]
//   --models-dir：モデルを探すフォルダ（既定 <リポジトリ>/models）。ここに無ければ失敗する（取りに行かない）。
// 実体は checker/speech/transcribe.py（.venv の Python を -I で呼ぶ。verify と同じやり方）。
// 同じ音声（SHA-256）・モデル・設定なら、書き出し先の transcript.json を再利用する（--force で作り直す）。
// モデルが無い、faster-whisper が入っていないときは、インストールもダウンロードもせず、errors[0].code = "speech-unavailable"（終了コード 1）。
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { intOption } from '../lib/args.js';
import { REPO_ROOT, parseJsonOutput, pythonPath, tail, toolExists } from '../lib/exec.js';
import { fileExists } from '../lib/fsutil.js';

export const options = { audio: 'string', 'audio-name': 'string', model: 'string', 'models-dir': 'string', out: 'string', vad: 'string', threads: 'string', force: 'boolean', 'timeout-sec': 'string' };

export const speechDir = () => path.resolve(process.env.NARRATE_SPEECH_DIR || path.join(REPO_ROOT, 'checker', 'speech'));

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch { /* すでに終わっている */ }
}

/**
 * checker/speech の Python を呼ぶ。標準エラー出力の {"progress":...} の行は ctx.progress に流す。標準出力の最後の JSON を返す。
 * @returns {Promise<{code:number|null, out:any, stderrTail:string}>}
 */
export function runSpeechPython(ctx, script, args, { timeoutMs = 3600 * 1000 } = {}) {
  const py = pythonPath();
  if (!toolExists(py)) throw new CliError('speech-unavailable', `Python not found: ${py} (create .venv; see dev/INSTALLED.md)`);
  const scriptPath = path.join(speechDir(), script);
  if (!toolExists(scriptPath)) throw new CliError('tool-missing', `speech script not found: ${scriptPath}`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(py, ['-I', scriptPath, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(new CliError('speech-unavailable', `cannot start ${py} (${e.message})`)); return; }
    const out = [];
    const errTail = [];
    let buf = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line.startsWith('{"progress"')) {
          try { const p = JSON.parse(line).progress; ctx.progress(p.stage, p.done, p.total); continue; } catch { /* ふつうの行として扱う */ }
        }
        errTail.push(line);
        if (errTail.length > 40) errTail.shift();
      }
    });
    child.on('error', (e) => done(() => reject(new CliError('speech-unavailable', `cannot start ${py} (${e.message})`))));
    child.on('close', (code) => done(() => {
      if (timedOut) { reject(new CliError(`${script.replace(/\.py$/, '')}-timeout`, `${script} did not finish in time and was stopped`)); return; }
      resolve({ code, out: parseJsonOutput(Buffer.concat(out).toString('utf8')), stderrTail: tail(errTail.join('\n')) });
    }));
  });
}

/** Python の {"ok":false,"error":{...}} を CliError にする */
export function pythonFailure(r, what, { exitFor = {} } = {}) {
  const e = r.out && r.out.error;
  const code = e && e.code ? e.code : `${what}-failed`;
  const msg = e && e.message ? e.message : `${what} failed (exit ${r.code})`;
  return new CliError(code, msg, { exit: exitFor[code] !== undefined ? exitFor[code] : EXIT.FAIL, detail: { ...(e && e.detail ? { detail: e.detail } : {}), exitCode: r.code, stderr: r.stderrTail } });
}

export async function run({ ctx, opts, workspace }) {
  let audio;
  if (opts.audio) audio = path.resolve(opts.audio);
  else if (workspace) audio = path.join(workspace, ...(opts['audio-name'] || 'final/all.wav').split('/'));
  else throw usageError('--audio <wav> or --workspace <dir> is required');
  const out = opts.out ? path.resolve(opts.out) : (workspace ? path.join(workspace, 'transcript.json') : null);
  if (!out) throw usageError('--out is required when --workspace is not given');
  const model = opts.model || 'small';
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw usageError('--model must be a model name such as small');
  const vad = opts.vad === undefined ? 'on' : opts.vad;
  if (vad !== 'on' && vad !== 'off') throw usageError('--vad must be on or off');
  const threads = intOption(opts, 'threads', 0, { min: 0, max: 256 });
  if (!(await fileExists(audio))) throw new CliError('cannot-read', `no such audio file: ${audio}`);
  // transcript.json の audio.file：作業場の中なら作業場からの相対パス、そうでなければ与えられたパス
  let label = audio;
  if (workspace) {
    const rel = path.relative(workspace, audio);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) label = rel.split(path.sep).join('/');
  }
  const args = ['--audio', audio, '--out', out, '--audio-label', label, '--model', model, '--vad', vad, '--threads', String(threads)];
  if (opts['models-dir']) args.push('--models-dir', path.resolve(opts['models-dir']));
  if (opts.force) args.push('--force');
  const r = await runSpeechPython(ctx, 'transcribe.py', args, { timeoutMs: intOption(opts, 'timeout-sec', 3600, { min: 1 }) * 1000 });
  if (r.code !== 0 || !r.out || r.out.ok !== true) throw pythonFailure(r, 'transcribe');
  const o = r.out;
  const rtf = o.timing && o.timing.audioSec ? Math.round((o.timing.transcribeSec / o.timing.audioSec) * 1000) / 1000 : null;
  return { result: { transcript: out, cached: o.cached === true, model: o.model, audio: label, audioSec: o.audioSec, wordCount: o.wordCount, timing: o.timing || null, rtf } };
}
