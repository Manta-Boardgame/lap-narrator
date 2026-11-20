// 「通しで録る」流れの入力の素材：台本（jp15、録音の対象 13 枚）を合成音声で、スライドの切り替えの操作なしに通しで読む。
//   node testgen/make-continuous.js --session 1|2 --out <dir>
// <dir>/mic.wav（偽のマイクに流す）、plan.json（操作の予定表：record／ok／retake／pause だけ）、truth/truth.json（正解）
// セッション 1：きれいな音。撮り直し 3 か所、文の間の OK 3 回、読み飛ばし 1、言い直し 1、アドリブ 1。
// セッション 2：こもった音・小さい音量・雑音（話している部分に対して SN 比 12dB）。撮り直し 1 か所。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthTexts, textKey } from './tts-texts.js';
import { splitSentences, RATE, DISCARD_RATE } from './narration.js';
import { buildContinuous } from './narration-continuous.js';
import { encodeWav } from './lib/wav.js';
import { muffle, lowVolume, addRoomNoise, rms } from './degrade.js';
import { buildScriptPack, loadSpec } from './script-pack.js';
import { buildFreePack } from './free-pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const SESSIONS = {
  1: {
    name: 'clean', seed: 'continuous-1',
    okMid: ['s0004', 's0006', 's0008'],
    retakes: [
      { slideId: 's0001', sentence: 0, junkText: 'みなさん、こんにちは。ほしぞら町の図書館の、えーと、あれ、すみません。' },
      { slideId: 's0008', sentence: 1, junkText: '電気は少し暗くして、ろうそくふうの、あっ、言い間違えました。' },
      { slideId: 's0013', sentence: 1, junkText: '全体でおよそ六十分、いえ、ちがいます、ええと、もう一度。' },
    ],
    skips: [{ slideId: 's0007', sentence: 1 }],
    repeats: [{ slideId: 's0011', sentence: 0 }],
    adlibs: [{ slideId: 's0015', afterSentence: 0, text: 'ちなみに、先月の試しの会は、子どもたちが静かに聞いてくれました。' }],
    degrade: null,
  },
  2: {
    name: 'noisy', seed: 'continuous-2',
    okMid: ['s0004', 's0008'],
    retakes: [{ slideId: 's0001', sentence: 0, junkText: 'みなさん、おはようございます。ほしぞら町の、あれ、えっと、やりなおします。' }],
    skips: [], repeats: [], adlibs: [],
    degrade: { cutoffHz: 2500, gainDb: -15, snrDb: 12 },
  },
};

export function makeContinuous(session, outDir, cacheDir) {
  const cfg = SESSIONS[session];
  const { script } = buildScriptPack(loadSpec(join(HERE, 'specs', 'jp15.json')));
  const slides = script.slides.map((s) => ({ slideId: s.slideId, order: s.order, text: s.text, recordable: s.recordable }));
  const texts = [];
  for (const s of slides) if (s.recordable) for (const x of splitSentences(s.text)) { texts.push(x); texts.push({ text: x, rate: DISCARD_RATE }); }
  for (const r of cfg.retakes) texts.push(r.junkText);
  for (const a of cfg.adlibs) texts.push(a.text);
  const tts = synthTexts(texts, cacheDir);
  const built = buildContinuous({ slides, audioOf: (t, rate) => tts.map.get(textKey(t, rate)), ...cfg });
  let pcm = built.pcm;
  const info = { voice: tts.voice, culture: tts.culture, degrade: null };
  if (cfg.degrade) {
    const d = cfg.degrade;
    const ranges = built.truth.segments.filter((s) => s.kind !== 'beep').map((s) => [s.start, s.end]);
    pcm = muffle(pcm, { cutoffHz: d.cutoffHz });
    pcm = lowVolume(pcm, { gainDb: d.gainDb });
    const r = addRoomNoise(pcm, ranges, { snrDb: d.snrDb, seed: cfg.seed });
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
  writeFileSync(join(outDir, 'free-pack.zip'), buildFreePack({ projectId: script.projectId }).zip);
  return { info, plan: built.plan, truth: built.truth };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const session = Number(arg('--session', '1'));
  const out = resolve(arg('--out', join(ROOT, 'work', 'Q', `session${session}`)));
  const r = makeContinuous(session, out, join(ROOT, 'work', 'N', 'tts-cache'));
  console.log(JSON.stringify({ out, seconds: +(r.plan.wavSamples / RATE).toFixed(1), ops: r.plan.ops.map((o) => o.name).join(','), info: r.info }, null, 1));
}
