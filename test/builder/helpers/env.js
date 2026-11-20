// Shared helpers for the builder tests (owner: D). Everything the tests write goes under work/D/test/.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PY = process.platform === 'win32'
  ? join(ROOT, '.venv', 'Scripts', 'python.exe')
  : join(ROOT, '.venv', 'bin', 'python');
export const WORK = join(ROOT, 'work', 'D', 'test');

export function freshDir(name) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Runs the venv python in isolated mode (-I). */
export function py(args, { timeout = 120000 } = {}) {
  const r = spawnSync(PY, ['-I', ...args], { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Last non-empty stdout line parsed as JSON. */
export function lastJson(stdout) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/** Runs one of our PowerShell scripts with -NoProfile and a process-only execution policy. */
export function ps(scriptPathFromRoot, args, { timeout = 300000 } = {}) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, scriptPathFromRoot), ...args],
    { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** make_fixture.py: 3 slides with tones/colours/PNG/WAV and a timeline. Returns the folder. */
export function makeSynth(name, extra = []) {
  const out = freshDir(name);
  const r = py([join(ROOT, 'test', 'builder', 'helpers', 'make_fixture.py'), '--out', out, ...extra]);
  if (r.status !== 0) throw new Error('make_fixture failed: ' + r.stdout + r.stderr);
  return out;
}

/** make-pptx.mjs: variant 'simple' (3 slides) or 'mixed' (5 slides). Returns the pptx path. */
export function makeDeck(name, variant) {
  const dir = freshDir(name);
  const out = join(dir, variant + '.pptx');
  const r = spawnSync(process.execPath,
    [join(ROOT, 'test', 'builder', 'helpers', 'make-pptx.mjs'), '--variant', variant, '--out', out],
    { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error('make-pptx failed: ' + r.stdout + r.stderr);
  return out;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

// ---- PowerPoint availability --------------------------------------------------------------

function powershellOut(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return (r.stdout ?? '').trim();
}

export function powerPointRunning() {
  if (process.platform !== 'win32') return false;
  return powershellOut('@(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count') !== '0';
}

/** Returns null when PowerPoint tests may run, otherwise the reason to skip. */
export function powerPointSkipReason() {
  if (process.platform !== 'win32') return 'not Windows';
  const reg = spawnSync('reg.exe', ['query', 'HKCR\\PowerPoint.Application'], { encoding: 'utf8', windowsHide: true });
  if (reg.status !== 0) return 'PowerPoint is not installed (no PowerPoint.Application COM class)';
  if (powerPointRunning()) return 'PowerPoint is already running; not touching it (dev/RULES.md 2.7)';
  return null;
}

/** Kills a PowerPoint that is still alive after a test; only call when none was running before. */
export function killLeftoverPowerPoint() {
  if (process.platform !== 'win32') return;
  powershellOut('Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force');
}

export function pngSize(path) {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export { existsSync };
