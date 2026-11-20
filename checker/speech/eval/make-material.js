// 評価の素材：work/N/sessionK の録音から、通しの 1 本の音声（all.wav）と正解の切れ目（truth-cuts.json）を作る。
//   node checker/speech/eval/make-material.js --session work/N/session1 --check work/N/check1 --out work/G1/eval/session1
// --check は、`narrate render` が出した作業場（out/final/*.wav と out/timeline.json、script.json がある）。
// 切れ目の正解 = 完成音声（スライドごと）を timeline の順に連結したときの継ぎ目。
// ついでに、各スライドの「話している範囲」(speechStart/speechEnd) を truth.json の採用した区間から求める
// （継ぎ目が、前の話の終わりと次の話の始まりの間に入っているかを調べるため）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, encodeWav } from '../../../testgen/lib/wav.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');

export function makeMaterial({ sessionDir, checkDir, outDir }) {
  const timeline = JSON.parse(fs.readFileSync(path.join(checkDir, 'out', 'timeline.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(path.join(sessionDir, 'truth', 'truth.json'), 'utf8'));
  const rate = timeline.sampleRate;
  const parts = [];
  const slides = [];
  const sentences = [];
  let pos = 0;
  for (const s of timeline.slides) {
    const files = Array.isArray(s.audio) ? s.audio : [s.audio];
    const chunks = files.map((f) => decodeWav(new Uint8Array(fs.readFileSync(path.join(checkDir, 'out', f)))));
    for (const c of chunks) if (c.sampleRate !== rate) throw new Error('unexpected sample rate in ' + s.audio);
    const len = chunks.reduce((a, c) => a + c.samples.length, 0);
    const ts = truth.slides.find((x) => x.slideId === s.slideId);
    // 話している範囲：採用した区間 (pieces) の中にある speech の区間を、完成音声の時間に写す
    let off = 0;
    let sp0 = null;
    let sp1 = null;
    for (const p of ts.pieces) {
      for (const seg of truth.segments) {
        if (seg.kind !== 'speech' || seg.slideId !== s.slideId) continue;
        if (seg.start >= p.start && seg.end <= p.end + 1) {
          const a = pos + off + (seg.start - p.start);
          const b = pos + off + (seg.end - p.start);
          if (sp0 === null || a < sp0) sp0 = a;
          if (sp1 === null || b > sp1) sp1 = b;
          sentences.push({ slideId: s.slideId, text: seg.text, start: a, end: b });
        }
      }
      off += p.end - p.start;
    }
    slides.push({ slideId: s.slideId, order: s.order, startSample: pos, endSample: pos + len, speechStart: sp0, speechEnd: sp1 });
    for (const c of chunks) parts.push(c.samples);
    pos += len;
  }
  const all = new Int16Array(pos);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'all.wav'), encodeWav(all, rate));
  const cuts = slides.slice(0, -1).map((s) => s.endSample);
  sentences.sort((x, y) => x.start - y.start);
  const out = { sampleRate: rate, samples: pos, slides, cuts, sentences };
  fs.writeFileSync(path.join(outDir, 'truth-cuts.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : null; };
  const r = makeMaterial({ sessionDir: path.resolve(arg('session')), checkDir: path.resolve(arg('check')), outDir: path.resolve(arg('out')) });
  console.log(JSON.stringify({ samples: r.samples, slides: r.slides.length, seconds: +(r.samples / r.sampleRate).toFixed(1) }));
}
