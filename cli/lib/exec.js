// 子プロセスの実行と、builder／checker のスクリプトの場所。
// 環境変数（試験で偽のスクリプトを差し込むための入口）：
//   NARRATE_BUILDER_DIR   build-a.ps1、build_b.py、export-slides.ps1 のあるフォルダ（既定：<リポジトリ>/builder）
//   NARRATE_VERIFY_SCRIPT verify.py のパス（既定：<リポジトリ>/checker/video/verify.py）
//   NARRATE_PYTHON        Python の実行ファイル（既定：<リポジトリ>/.venv/Scripts/python.exe）
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const builderDir = () => path.resolve(process.env.NARRATE_BUILDER_DIR || path.join(REPO_ROOT, 'builder'));
export const verifyScript = () => path.resolve(process.env.NARRATE_VERIFY_SCRIPT || path.join(REPO_ROOT, 'checker', 'video', 'verify.py'));
export const pythonPath = () => path.resolve(process.env.NARRATE_PYTHON || path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'));
export const powershellPath = () => 'powershell.exe';

/** Python の呼び出し：必ず -I（環境変数とカレントのモジュールを読まない）を付ける */
export function pythonCommand(scriptPath, args) {
  return { cmd: pythonPath(), args: ['-I', scriptPath, ...args] };
}

/** PowerShell のスクリプトの呼び出し（引数は -名前 値 の並び） */
export function powershellCommand(scriptPath, namedArgs) {
  return { cmd: powershellPath(), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...namedArgs] };
}

export function toolExists(p) { return existsSync(p); }

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch { /* すでに終わっている */ }
}

/**
 * @param {string} cmd @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string, env?: Record<string,string>}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError?: string}>}
 */
export function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: e.message });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024;
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => { if (size < LIMIT) { out.push(d); size += d.length; } });
    child.stderr.on('data', (d) => { if (size < LIMIT) { err.push(d); size += d.length; } });
    child.on('error', (e) => finish({ code: null, stdout: '', stderr: '', timedOut, spawnError: e.message }));
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut }));
  });
}

/** 標準出力の最後の JSON オブジェクト（スクリプトが 1 行の JSON を出す約束）を読む。読めなければ null */
export function parseJsonOutput(text) {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 1 行ずつ後ろから */ }
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('{')) { try { return JSON.parse(l); } catch { /* 次へ */ } }
  }
  return null;
}

export const tail = (s, n = 2000) => (s.length > n ? s.slice(-n) : s);
