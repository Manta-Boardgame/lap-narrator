// 試験の道具：ASR を使わない模擬の通し録音。台本（架空の文）から、音声（話す所は雑音を包絡で変調した音、ほかは小さな背景雑音）と、
// 模擬の transcript.json（文の時刻を文字数で割って単語に分けたもの。誤りを注入できる）と、正解（スライドごとの話している範囲）を作る。
// 乱数は種で決まる。音声は 16kHz のモノラル（小さく速く）。
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../../../testgen/lib/rng.js';
import { encodeWav } from '../../../testgen/lib/wav.js';
import { scriptHash, textHash } from '../../../core/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RATE = 16000;

// 架空の台本（3 文ずつ前後の 8 枚）。実在の団体・人物・発表の内容ではない。
export const SLIDES = [
  ['みなさん、こんにちは。', 'ひだまり公園の春の清掃活動について、計画をご説明します。'],
  ['最近、公園の落ち葉が増えて、歩きにくいという声が寄せられています。'],
  ['活動は毎月の第三日曜日に、朝九時から十一時まで行います。', '道具は主催者が用意しますので、手ぶらでお越しください。'],
  ['集合場所は公園の南口にある、青い掲示板の前です。', '雨が降ったときは、翌週の同じ時間に延期します。'],
  ['参加者は子どもから高齢の方まで、幅広く募集しています。'],
  ['集めた落ち葉は堆肥にして、花壇の肥料に使います。', '来年の春には、きれいな花が咲くことを目指しています。'],
  ['費用は保険料の三千円だけで、すべて町内会の予算でまかないます。'],
  ['以上が、春の清掃活動の計画です。', 'ご不明な点があれば、お気軽にお尋ねください。'],
];

const sec = (n) => Math.round(n * RATE);

/**
 * @param {object} o
 * @param {number} [o.seed]
 * @param {string[][]} [o.slides] 各スライドの文の並び（既定は SLIDES）
 * @param {number} [o.errorRate] 文字の置き換え・欠落の割合（0..1）
 * @param {{slide:number, sentence:number}[]} [o.skip] 読み飛ばす文
 * @param {{slide:number, sentence:number}[]} [o.repeat] 直後にもう一度言う文
 * @param {{afterSlide:number, seconds:number}[]} [o.adlib] スライドの間に入れる台本にない話（長さ秒）
 * @param {number[]} [o.emptyNotes] 台本のノートが空のスライド（番号は 0 から。音声には話が入っている）
 * @param {{slide:number, sentence:number, rate:number}[]} [o.garble] 意図的に誤認識を入れる文（文字を rate の割合で別のかなに置き換える）
 * @param {number} [o.silence] スライドの間の無音の長さ（秒）
 */
export function buildMock(o = {}) {
  const rng = makeRng(`mock-${o.seed ?? 1}`);
  const slides = o.slides || SLIDES;
  const skip = o.skip || [];
  const repeat = o.repeat || [];
  const adlib = o.adlib || [];
  const slideGap = o.silence ?? 1.1;
  const parts = []; // {start, end, kind, text, slide}
  let t = 0.9 + rng.float() * 0.3; // 録音の先頭の無音
  slides.forEach((sents, si) => {
    sents.forEach((txt, ki) => {
      if (skip.some((x) => x.slide === si && x.sentence === ki)) return;
      const dur = txt.length * 0.14;
      parts.push({ start: t, end: t + dur, kind: 'script', text: txt, slide: si, sentence: ki });
      t += dur;
      if (repeat.some((x) => x.slide === si && x.sentence === ki)) {
        t += 0.7;
        parts.push({ start: t, end: t + dur, kind: 'script', text: txt, slide: si, sentence: ki, copy: 2 });
        t += dur;
      }
      if (ki < sents.length - 1) t += 0.35 + rng.float() * 0.5;
    });
    for (const a of adlib.filter((x) => x.afterSlide === si)) {
      t += 0.6;
      const txt = 'えーと、ここで少し脱線しますが、先日こんなことがありましてね、おもしろい話なんです。'.repeat(3).slice(0, Math.round(a.seconds / 0.14));
      parts.push({ start: t, end: t + a.seconds, kind: 'adlib', text: txt, slide: si });
      t += a.seconds;
    }
    if (si < slides.length - 1) t += slideGap;
  });
  t += 1.2;
  const total = sec(t);
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) pcm[i] = Math.round((rng.float() - 0.5) * 80);
  for (const p of parts) {
    const a = sec(p.start);
    const b = sec(p.end);
    let env = 0.6;
    for (let i = a; i < b; i++) {
      if ((i - a) % 800 === 0) env = 0.35 + rng.float() * 0.65; // 100 ms ごとに強さを変える
      const edge = Math.min(1, (i - a) / 160, (b - i) / 160);
      pcm[i] = Math.round((rng.float() - 0.5) * 2 * 6000 * env * edge);
    }
  }
  // 模擬の単語：文字を 1〜2 文字に区切り、文の時刻を文字数で割る。誤りは文字の置き換えと単語の欠落
  const kana = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ';
  const words = [];
  for (const p of parts) {
    const chars = [...p.text];
    const per = (p.end - p.start) / chars.length;
    let i = 0;
    while (i < chars.length) {
      const n = rng.float() < 0.5 ? 1 : 2;
      const seg = chars.slice(i, i + n);
      const w = { w: seg.join(''), start: +(p.start + i * per).toFixed(3), end: +(p.start + (i + seg.length) * per).toFixed(3), p: +(0.8 + rng.float() * 0.2).toFixed(3) };
      i += n;
      const g = (o.garble || []).find((x) => x.slide === p.slide && x.sentence === p.sentence && p.kind === 'script');
      if (g && rng.float() < g.rate) { w.w = seg.map(() => kana[Math.floor(rng.float() * kana.length)]).join(''); }
      const er = o.errorRate || 0;
      if (er > 0 && rng.float() < er * 0.4) continue;
      if (er > 0 && rng.float() < er) w.w = seg.map(() => kana[Math.floor(rng.float() * kana.length)]).join('');
      words.push(w);
    }
  }
  const truthSlides = slides.map((_, si) => {
    const ps = parts.filter((p) => p.slide === si && p.kind === 'script');
    return { index: si, speechStart: ps.length ? Math.min(...ps.map((p) => p.start)) : null, speechEnd: ps.length ? Math.max(...ps.map((p) => p.end)) : null };
  });
  // 台本
  const empty = new Set(o.emptyNotes || []);
  const sl = slides.map((sents, si) => {
    const s = { slideId: `s${String(si + 1).padStart(4, '0')}`, order: si + 1, title: `スライド${si + 1}`, text: empty.has(si) ? '' : sents.join(''), recordable: true };
    s.textHash = textHash(s);
    return s;
  });
  const script = { format: 'lap-narrator/script', version: 1, projectId: 'mockproj01', title: '模擬', scriptHash: scriptHash(sl), slides: sl };
  return { pcm, words, parts, total, truthSlides, script, rate: RATE };
}

/** 作業場に all.wav（final/all.wav）、transcript.json、script.json を書く */
export async function writeMock(dir, mock, { audioName = 'final/all.wav', transcript = true } = {}) {
  const wavPath = path.join(dir, ...audioName.split('/'));
  await fsp.mkdir(path.dirname(wavPath), { recursive: true });
  const wav = encodeWav(mock.pcm, mock.rate);
  await fsp.writeFile(wavPath, wav);
  const sha = createHash('sha256').update(wav).digest('hex');
  await fsp.writeFile(path.join(dir, 'script.json'), JSON.stringify(mock.script));
  if (transcript) {
    const tr = {
      format: 'lap-narrator/transcript', version: 1,
      audio: { file: audioName, sha256: sha, sampleRate: mock.rate, samples: mock.total },
      model: 'small', language: 'ja', words: mock.words, segments: [],
      params: { vad: true, decode: { beam: 5, conditionOnPreviousText: false, wordTimestamps: true, computeType: 'int8', language: 'ja' } },
      timing: { loadSec: 0, transcribeSec: 0, audioSec: mock.total / mock.rate },
    };
    await fsp.writeFile(path.join(dir, 'transcript.json'), JSON.stringify(tr));
  }
  return { wavPath, sha };
}

/** 切れ目（スライド i の終わり）が、本当の話の間（スライド i の最後の話の終わり〜i+1 の最初の話の始まり）の中にあるか */
export function inGap(mock, sampleCut, i, tolSec = 0.05) {
  const a = mock.truthSlides[i];
  const b = mock.truthSlides[i + 1];
  const x = sampleCut / mock.rate;
  return x >= a.speechEnd - tolSec && x <= b.speechStart + tolSec;
}
