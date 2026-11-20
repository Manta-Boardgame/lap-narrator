// 任意の文（テキスト）を、Windows の音声合成（ja-JP の声）で 48kHz／16 ビット／モノラルの音声にする。ファイルにだけ書く。
// 同じ声と同じ文は、cacheDir に WAV を残して再利用する。先頭と末尾の無音は、しきい値で切り落とす（音の始まりと終わりの位置を正確にするため）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVoices, pickVoice } from './tts.js';
import { decodeWav } from './lib/wav.js';
import { sha256Hex } from './lib/hash.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 先頭と末尾の無音（絶対値が peak の thresholdRatio 未満が続く部分）を切る。 */
export function trimSilence(pcm, { thresholdRatio = 0.02, keepMs = 15, sampleRate = 48000 } = {}) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const th = Math.max(8, peak * thresholdRatio);
  let a = 0;
  while (a < pcm.length && Math.abs(pcm[a]) < th) a++;
  let b = pcm.length;
  while (b > a && Math.abs(pcm[b - 1]) < th) b--;
  const keep = Math.round((keepMs * sampleRate) / 1000);
  return pcm.slice(Math.max(0, a - keep), Math.min(pcm.length, b + keep));
}

export const textKey = (text, rate = 0) => (rate ? `${rate}|${text}` : text);

/**
 * @param {(string|{text:string, rate?:number})[]} texts
 * @param {string} cacheDir
 * @returns {{voice:string, culture:string, map:Map<string, Int16Array>}}
 */
export function synthTexts(texts, cacheDir, { lang = 'ja' } = {}) {
  const voice = pickVoice(listVoices(), lang);
  if (!voice) throw new Error(`no ${lang} voice installed`);
  mkdirSync(cacheDir, { recursive: true });
  // texts の要素は、文字列、または { text, rate }（読む速さ。-10..10、既定 0）。map のキーは textKey(text, rate)
  const items = [];
  const seen = new Set();
  for (const x of texts) {
    const it = typeof x === 'string' ? { text: x, rate: 0 } : { text: x.text, rate: x.rate ?? 0 };
    const k = textKey(it.text, it.rate);
    if (!seen.has(k)) { seen.add(k); items.push({ ...it, k }); }
  }
  const keyOf = (it) => sha256Hex(`${voice.name}\n${it.rate}\n${it.text}`).slice(0, 24);
  const jobs = [];
  for (const it of items) {
    const raw = join(cacheDir, `${keyOf(it)}.wav`);
    if (!existsSync(raw)) jobs.push({ voice: voice.name, text: it.text, out: raw, rate: it.rate });
  }
  if (jobs.length) {
    const jobFile = join(cacheDir, 'jobs.json');
    writeFileSync(jobFile, JSON.stringify(jobs), 'utf8');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'tts', 'synth.ps1'), '-JobFile', jobFile], { encoding: 'utf8', timeout: 600000 });
    rmSync(jobFile, { force: true });
    if (r.status !== 0) throw new Error('synth failed: ' + r.stdout + r.stderr);
  }
  const map = new Map();
  for (const it of items) {
    const f = join(cacheDir, `${keyOf(it)}.wav`);
    if (!existsSync(f)) throw new Error('not synthesized: ' + it.text);
    const w = decodeWav(new Uint8Array(readFileSync(f)));
    if (w.sampleRate !== 48000) throw new Error('unexpected rate ' + w.sampleRate);
    map.set(it.k, trimSilence(w.samples));
  }
  return { voice: voice.name, culture: voice.culture, map };
}
