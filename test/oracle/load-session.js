// examples/sessions/<名前>/ を読み込む（oracle と試験の共通の道具）。core/ は使わない。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SESSIONS_DIR = join(REPO_ROOT, 'examples', 'sessions');

export function listSessions(dir = SESSIONS_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** events.jsonl を読む。空行は読み飛ばす。 */
export function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/**
 * @returns {{dir:string, name:string, events:object[], rawFiles:{name:string,sampleRate:number,samples:number,durableSamples?:number}[], expected:object, manifest:object}}
 */
export function loadSession(name, dir = SESSIONS_DIR) {
  const d = join(dir, name);
  const manifest = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
  const events = readJsonl(join(d, 'events.jsonl'));
  const rawFiles = manifest.rawFiles.map((r) => ({
    name: basename(r.file, '.wav'),
    sampleRate: r.sampleRate,
    samples: r.samples,
    durableSamples: r.durableSamples,
  }));
  const expected = JSON.parse(readFileSync(join(d, 'expected.segments.json'), 'utf8'));
  const renderPath = join(d, 'expected.render.json');
  const expectedRender = existsSync(renderPath) ? JSON.parse(readFileSync(renderPath, 'utf8')) : null;
  return { dir: d, name, events, rawFiles, expected, expectedRender, manifest };
}
