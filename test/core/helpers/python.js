// 独立した読み手として Python（.venv、-I）を呼ぶ補助。試験専用。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const WORK_A = join(root, 'work', 'A');

export function pythonPath() {
  const cands = [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'bin', 'python')];
  return cands.find((p) => existsSync(p)) ?? null;
}

/**
 * Python を -I（隔離モード）で動かす。script は文字列（-c で渡す）。args は引数。
 * @returns {{status:number|null, stdout:string, stderr:string}}
 */
export function runPython(script, args = [], input) {
  const py = pythonPath();
  if (!py) throw new Error('python not found in .venv');
  const r = spawnSync(py, ['-I', '-c', script, ...args], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const hasPython = pythonPath() !== null;
