// 音声合成（Windows の System.Speech）で、スライドごとの文を WAV にする。ファイルにだけ書く。
// 声：日本語は ja-JP、英語は en-US の、入っている声を選ぶ。日本語の声がなければ、その旨を返す（英語の台本だけ作る）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWav } from './lib/wav.js';
import { sha256Hex } from './lib/hash.js';
import { slideText } from './script-pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 入っている声の一覧 [{name, culture}]。Windows 以外では空。 */
export function listVoices() {
  if (process.platform !== 'win32') return [];
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    'foreach ($v in $s.GetInstalledVoices()) { $v.VoiceInfo.Name + "`t" + $v.VoiceInfo.Culture.Name };',
    '$s.Dispose()',
  ].join(' ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [name, culture] = l.split('\t');
      return { name, culture };
    });
}

export function pickVoice(voices, lang) {
  const prefix = lang === 'ja' ? 'ja' : 'en';
  return voices.find((v) => v.culture.toLowerCase().startsWith(prefix)) ?? null;
}

/**
 * @param {object} spec 台本の指定
 * @param {string} outDir 出力先（<slideId>.wav を書く）
 * @param {string} tmpDir 一時の置き場（work/E の中）
 */
export function synthesizeSpec(spec, outDir, tmpDir) {
  const voices = listVoices();
  const voice = pickVoice(voices, spec.lang);
  if (!voice) return { ok: false, reason: `no ${spec.lang} voice installed`, voices };
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const jobs = [];
  const meta = [];
  spec.slides.forEach((s, i) => {
    const text = slideText(s);
    if (!s.recordable || text.trim() === '') return;
    const slideId = spec.slideIdStyle === 'pptx' ? `s${256 + i}` : `s${String(i + 1).padStart(4, '0')}`;
    jobs.push({ voice: voice.name, text, out: join(tmpDir, `${slideId}.raw.wav`), rate: 0 });
    meta.push({ slideId, text });
  });
  const jobFile = join(tmpDir, 'jobs.json');
  writeFileSync(jobFile, JSON.stringify(jobs), 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'tts', 'synth.ps1'), '-JobFile', jobFile], { encoding: 'utf8', timeout: 600000 });
  const entries = [];
  for (const m of meta) {
    const raw = join(tmpDir, `${m.slideId}.raw.wav`);
    if (!existsSync(raw)) {
      entries.push({ slideId: m.slideId, error: 'not synthesized' });
      continue;
    }
    const n = normalizeWav(new Uint8Array(readFileSync(raw)));
    writeFileSync(join(outDir, `${m.slideId}.wav`), n.bytes);
    entries.push({ slideId: m.slideId, textSha256: sha256Hex(m.text), samples: n.samples, sampleRate: n.sampleRate, sha256: sha256Hex(n.bytes) });
    rmSync(raw, { force: true });
  }
  rmSync(jobFile, { force: true });
  const manifest = { voice: voice.name, culture: voice.culture, format: '48000 Hz, 16-bit, mono', entries };
  writeFileSync(join(outDir, 'tts.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { ok: r.status === 0, voice: voice.name, entries, stdout: r.stdout, stderr: r.stderr };
}
