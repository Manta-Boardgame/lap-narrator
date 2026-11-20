// 実際に faster-whisper を走らせる試験（遅い。`npm run test:speech`。`npm test` には入れない）。
// 台本パック jp15.zip の最初の 5 枚を Windows の音声合成（ファイルに書くだけ。音は出さない）で読み上げ、スライドの間に無音を入れて通しの 1 本にし、
// 本物の `narrate transcribe` → `narrate align` に通す。モデル small が models/ に無い、音声合成の声が無いときは skip（インストール・ダウンロードはしない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { runCli } from '../../cli/narrate.js';
import { openPack } from '../../cli/lib/scriptpack.js';
import { synthTexts } from '../../testgen/tts-texts.js';
import { encodeWav } from '../../testgen/lib/wav.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const PACK = path.join(ROOT, 'examples', 'packs', 'jp15.zip');
const HAVE_MODEL = existsSync(path.join(ROOT, 'models', 'models--Systran--faster-whisper-small'));
const HAVE_PY = existsSync(path.join(ROOT, '.venv', 'Scripts', 'python.exe'));
const RATE = 48000;

async function cli(...argv) {
  let out = '';
  const { exitCode } = await runCli(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  return { code: exitCode, env: JSON.parse(out.trim().split('\n').at(-1)) };
}

test('実際の faster-whisper：合成音声の通しの 1 本から、スライドの切れ目を決める', { skip: !HAVE_MODEL || !HAVE_PY || process.platform !== 'win32', timeout: 600000 }, async () => {
  const pack = await openPack(PACK);
  const slides = pack.script.slides.filter((s) => s.recordable && s.text).slice(0, 5);
  await pack.close();
  const sentences = slides.map((s) => s.text.split(/(?<=。)/).filter(Boolean));
  const { map } = synthTexts(sentences.flat(), path.join(ROOT, 'work', 'G1', 'tts-cache'));
  const rng = (() => { let x = 12345; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; })();
  const parts = [];
  const truth = []; // 各スライドの話の範囲（サンプル）
  let pos = Math.round(0.8 * RATE);
  parts.push(new Int16Array(pos));
  for (const sents of sentences) {
    const t0 = pos;
    sents.forEach((s, k) => {
      const pcm = map.get(s);
      parts.push(pcm);
      pos += pcm.length;
      if (k < sents.length - 1) { const g = new Int16Array(Math.round((0.3 + rng() * 0.5) * RATE)); parts.push(g); pos += g.length; }
    });
    truth.push({ start: t0, end: pos });
    const gap = new Int16Array(Math.round((0.9 + rng() * 0.5) * RATE));
    parts.push(gap);
    pos += gap.length;
  }
  const all = new Int16Array(pos);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const ws = path.join(ROOT, 'work', 'G1', 'test', `real-${process.pid}`);
  await fsp.mkdir(path.join(ws, 'final'), { recursive: true });
  try {
    await fsp.writeFile(path.join(ws, 'final', 'all.wav'), encodeWav(all, RATE));
    const t = await cli('transcribe', '--workspace', ws);
    assert.equal(t.code, 0, JSON.stringify(t.env.errors));
    assert.equal(t.env.result.cached, false);
    assert.ok(t.env.result.wordCount > 20);
    console.log(`transcribe: audio ${t.env.result.audioSec}s, RTF ${t.env.result.rtf}`);
    const t2 = await cli('transcribe', '--workspace', ws);
    assert.equal(t2.env.result.cached, true, 'the second run reuses transcript.json');
    // 台本は最初の 5 枚だけ（jp15 のほかの枚数は音声にない）：作業場の script.json にその 5 枚を書く
    const sc = { ...(await (async () => { const p = await openPack(PACK); const s = p.script; await p.close(); return s; })()) };
    sc.slides = sc.slides.filter((s) => slides.some((x) => x.slideId === s.slideId));
    await fsp.writeFile(path.join(ws, 'script.json'), JSON.stringify(sc));
    const a = await cli('align', '--workspace', ws);
    assert.ok([0, 4].includes(a.code), JSON.stringify(a.env.errors));
    const b = JSON.parse(await fsp.readFile(path.join(ws, 'boundaries.json'), 'utf8'));
    assert.equal(b.slides.length, 5);
    for (let i = 0; i < 4; i++) {
      const cut = b.slides[i].endSample;
      const inGap = cut >= truth[i].end - 0.05 * RATE && cut <= truth[i + 1].start + 0.05 * RATE;
      console.log(`${b.slides[i].slideId} ${b.slides[i].status} conf ${b.slides[i].confidence} cut ${(cut / RATE).toFixed(2)}s gap ${(truth[i].end / RATE).toFixed(2)}-${(truth[i + 1].start / RATE).toFixed(2)}`);
      assert.ok(inGap, `cut ${i} is inside the silence between the slides`);
    }
  } finally { await fsp.rm(ws, { recursive: true, force: true }); }
});
