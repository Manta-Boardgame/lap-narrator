// 試験の素材を作る入口。同じ指定から、いつも同じ素材ができる（音声合成を除く。声が同じ PC では同じになる）。
//
//   node testgen/cli.js examples            台本パック、pptx、録音セッションの見本を examples/ に作る（音は出ない）
//   node testgen/cli.js packs   [--out dir]   台本パック（zip）と script.json
//   node testgen/cli.js pptx    [--out dir] [--name <表示名>]   pptx
//   node testgen/cli.js sessions [--out dir]  録音セッションの見本（expected を含む）
//   node testgen/cli.js tts <spec> [--out dir]  音声合成で、スライドごとの WAV（work/E/ に作る。ファイルにだけ書く）
//   node testgen/cli.js degrade <in.wav> [--out dir] [--only name,name]  音質を悪くした WAV を作る
//   node testgen/cli.js cues [--out dir]    スライドごとの確認音
//   node testgen/cli.js voices              入っている音声合成の声の一覧
//   node testgen/cli.js fade-tables         フェードの係数の表を test/oracle/fade-tables.js に書く
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScriptPack, loadSpec } from './script-pack.js';
import { buildPptx } from './make-pptx.js';
import { writeAllSessions } from './sessions/make-sessions.js';
import { encodeWav, decodeWav } from './lib/wav.js';
import { slideCue } from './cue.js';
import { DEGRADATIONS, degrade } from './degrade.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const SPEC_DIR = join(HERE, 'specs');
export const SPEC_NAMES = ['tiny3', 'tiny3h', 'jp15', 'edge', 'en'];

const arg = (args, flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};

export function makePacks(outDir) {
  mkdirSync(outDir, { recursive: true });
  const res = {};
  for (const n of SPEC_NAMES) {
    const r = buildScriptPack(loadSpec(join(SPEC_DIR, n + '.json')));
    writeFileSync(join(outDir, n + '.zip'), r.zip);
    res[n] = { scriptHash: r.script.scriptHash, zipSha256: r.zipSha256, slides: r.script.slides.length };
  }
  return res;
}

export async function makePptxFiles(outDir, nameOverride) {
  mkdirSync(outDir, { recursive: true });
  const res = [];
  for (const n of SPEC_NAMES) {
    const bytes = await buildPptx(loadSpec(join(SPEC_DIR, n + '.json')));
    const file = join(outDir, (nameOverride && n === 'edge' ? nameOverride : n) + '.pptx');
    writeFileSync(file, bytes);
    res.push(file);
  }
  return res;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'examples': {
      const ex = join(ROOT, 'examples');
      console.log(JSON.stringify(makePacks(join(ex, 'packs')), null, 2));
      await makePptxFiles(join(ex, 'pptx'));
      const idx = await writeAllSessions(join(ex, 'sessions'), { specDir: SPEC_DIR, freezeRender: true });
      console.log(`sessions: ${idx.length}`);
      break;
    }
    case 'packs':
      console.log(JSON.stringify(makePacks(resolve(arg(args, '--out', join(ROOT, 'work', 'E', 'packs')))), null, 2));
      break;
    case 'pptx':
      console.log((await makePptxFiles(resolve(arg(args, '--out', join(ROOT, 'work', 'E', 'pptx'))), arg(args, '--name'))).join('\n'));
      break;
    case 'sessions': {
      const idx = await writeAllSessions(resolve(arg(args, '--out', join(ROOT, 'work', 'E', 'sessions'))), { specDir: SPEC_DIR, freezeRender: true });
      console.log(`sessions: ${idx.length}`);
      break;
    }
    case 'voices': {
      const { listVoices } = await import('./tts.js');
      console.log(JSON.stringify(listVoices(), null, 2));
      break;
    }
    case 'tts': {
      const { synthesizeSpec } = await import('./tts.js');
      const name = args[0];
      const spec = loadSpec(join(SPEC_DIR, name + '.json'));
      const out = resolve(arg(args, '--out', join(ROOT, 'work', 'E', 'tts', name)));
      const r = synthesizeSpec(spec, out, join(ROOT, 'work', 'E', 'tts-tmp'));
      console.log(JSON.stringify({ ok: r.ok, voice: r.voice, reason: r.reason, count: r.entries?.length }, null, 2));
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'degrade': {
      const input = resolve(args[0]);
      const out = resolve(arg(args, '--out', join(ROOT, 'work', 'E', 'degraded')));
      const only = arg(args, '--only');
      const names = only ? only.split(',') : DEGRADATIONS;
      mkdirSync(out, { recursive: true });
      const w = decodeWav(new Uint8Array(readFileSync(input)));
      for (const n of names) {
        const d = degrade(w.samples, w.sampleRate, n, basename(input) + ':' + n);
        writeFileSync(join(out, `${basename(input, '.wav')}.${n}.wav`), encodeWav(d.pcm, d.sampleRate));
      }
      console.log(`wrote ${names.length} files to ${out}`);
      break;
    }
    case 'cues': {
      const out = resolve(arg(args, '--out', join(ROOT, 'work', 'E', 'cues')));
      mkdirSync(out, { recursive: true });
      for (let n = 1; n <= 15; n++) writeFileSync(join(out, `cue-${String(n).padStart(4, '0')}.wav`), encodeWav(slideCue(n), 48000));
      console.log(`wrote 15 cues to ${out}`);
      break;
    }
    case 'fade-tables':
      await import('./gen-fade-tables.js');
      console.log('run: node testgen/gen-fade-tables.js');
      break;
    default:
      console.error('usage: node testgen/cli.js <examples|packs|pptx|sessions|tts|degrade|cues|voices> [options]');
      process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
