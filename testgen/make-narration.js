// 台本（specs/jp15.json）を、合成音声で「実際の録音らしく」読んだ偽のマイクの WAV と、録音アプリへの操作の予定表と、正解を作る。
//   node testgen/make-narration.js --session 1|2 --out <dir>
//   <dir>/mic.wav（48000Hz、モノラル、16 ビット。Chrome の偽のマイクに流す）、<dir>/plan.json（操作の予定表）、<dir>/truth/truth.json（正解）
// セッション 1：きれいな音。撮り直し 3 か所（スライド 1、8、13）、文の間の OK（スライド 4、8）。
// セッション 2：同じ台本を、こもった音・小さい音量・雑音（話している部分に対して SN 比 12dB）で。撮り直しは 1 か所（スライド 1）。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthTexts, textKey } from './tts-texts.js';
import { buildNarration, splitSentences, RATE, DISCARD_RATE } from './narration.js';
import { encodeWav } from './lib/wav.js';
import { muffle, lowVolume, addRoomNoise, rms } from './degrade.js';
import { buildScriptPack, loadSpec } from './script-pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const SESSIONS = {
  1: {
    name: 'clean',
    seed: 'narration-1',
    okMid: ['s0004', 's0008'],
    retakes: [
      { slideId: 's0001', part: 0, junkAfter: 0, junkText: 'みなさん、こんにちは。ほしぞら町の図書館の、えーと、あれ、すみません。' },
      { slideId: 's0008', part: 1, junkAfter: 0, junkText: '電気は少し暗くして、ろうそくふうの、あっ、言い間違えました。' },
      { slideId: 's0013', part: 0, junkAfter: 1, junkText: '全体でおよそ六十分、いえ、ちがいます、ええと、もう一度。' },
    ],
    degrade: null,
  },
  2: {
    name: 'noisy',
    seed: 'narration-2',
    okMid: ['s0004', 's0008'],
    retakes: [
      { slideId: 's0001', part: 0, junkAfter: 0, junkText: 'みなさん、おはようございます。ほしぞら町の、あれ、えっと、やりなおします。' },
    ],
    degrade: { cutoffHz: 2500, gainDb: -15, snrDb: 12 },
  },
};

export function makeNarration(session, outDir, cacheDir) {
  const cfg = SESSIONS[session];
  const spec = loadSpec(join(HERE, 'specs', 'jp15.json'));
  const { script } = buildScriptPack(spec);
  const slides = script.slides.map((s) => ({ slideId: s.slideId, order: s.order, text: s.text, recordable: s.recordable }));
  const texts = [];
  for (const s of slides) if (s.recordable) texts.push(...splitSentences(s.text));
  for (const r of cfg.retakes) {
    texts.push(r.junkText);
    const sl = slides.find((s) => s.slideId === r.slideId);
    for (let i = 0; i < r.junkAfter; i++) texts.push({ text: splitSentences(sl.text)[i], rate: DISCARD_RATE });
  }
  const tts = synthTexts(texts, cacheDir);
  const built = buildNarration({ slides, audioOf: (t, rate) => tts.map.get(textKey(t, rate)), retakes: cfg.retakes, okMid: cfg.okMid, seed: cfg.seed });
  let pcm = built.pcm;
  const info = { voice: tts.voice, culture: tts.culture, degrade: null };
  if (cfg.degrade) {
    const d = cfg.degrade;
    const speechRanges = built.truth.segments.filter((s) => s.kind !== 'beep').map((s) => [s.start, s.end]);
    pcm = muffle(pcm, { cutoffHz: d.cutoffHz });
    pcm = lowVolume(pcm, { gainDb: d.gainDb });
    const r = addRoomNoise(pcm, speechRanges, { snrDb: d.snrDb, seed: cfg.seed });
    pcm = r.pcm;
    info.degrade = { ...d, noise: 'pink 90% + 50Hz hum 10% (power)', speechRms: Math.round(r.sigRms), noiseRms: Math.round(r.noiseRms) };
  }
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  info.peak = peak;
  info.rms = Math.round(rms(pcm));
  mkdirSync(join(outDir, 'truth'), { recursive: true });
  writeFileSync(join(outDir, 'mic.wav'), encodeWav(pcm, RATE));
  writeFileSync(join(outDir, 'plan.json'), JSON.stringify({ session, name: cfg.name, wav: 'mic.wav', ...built.plan }, null, 1) + '\n');
  writeFileSync(join(outDir, 'truth', 'truth.json'), JSON.stringify({ session, name: cfg.name, audio: info, ...built.truth }, null, 1) + '\n');
  return { info, plan: built.plan, truth: built.truth };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const session = Number(arg('--session', '1'));
  const out = resolve(arg('--out', join(ROOT, 'work', 'N', `session${session}`)));
  const r = makeNarration(session, out, join(ROOT, 'work', 'N', 'tts-cache'));
  console.log(JSON.stringify({ out, seconds: +(r.plan.wavSamples / RATE).toFixed(1), ops: r.plan.ops.length, info: r.info }, null, 1));
}
