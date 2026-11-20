// 「実際の録音らしい」読み上げの音声（偽のマイクの WAV）と、その間に録音アプリへ行う操作の予定表と、正解を作る。
// 音声の部品（文ごとの合成音声）は呼び出し側が渡す。ここは時刻の計算だけ（乱数は種で決まる）。
//
// 時刻は、偽のマイクの WAV の先頭を 0 とするサンプル数（48000Hz）。
// 操作：record（録音の開始／再開）、ok、next（ラップ式の次のスライド。録音は止めない。最後のスライドでは止める）、retake（録音を止めて、直前の OK まで戻す）。
// 録音アプリが取り込むのは「録音中」の音だけ。retake から次の record までの間（unarmed）の音は、WAV にはあるがアプリには入らない。
import { makeRng } from './lib/rng.js';

export const RATE = 48000;
/** 撮り直しで捨てられる「読んだ文」は、やり直しの読みと別の音にするため、少し速く読ませる。 */
export const DISCARD_RATE = 3;

/** 台本の文を「。」で文に分ける（句点は文の最後に残す）。 */
export function splitSentences(text) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (ch === '。') { out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * @param {object} o
 * @param {{slideId:string, order:number, text:string, recordable:boolean}[]} o.slides
 * @param {(text:string, rate:number)=>Int16Array} o.audioOf 文の合成音声（rate は読む速さ。0 が標準）
 * @param {{slideId:string, part:number, junkAfter:number, junkText:string}[]} o.retakes 読み間違い → 撮り直し。junkAfter：その区間の何文を読んだあとで間違えるか
 * @param {string[]} o.okMid 文の間に OK を打つスライド（2 文以上のスライド。文を半分ずつに分ける）
 * @param {string} o.seed
 * @param {{lead?:number, beepAt?:number, firstSpeechAt?:number, tail?:number}} [o.timing]
 */
export function buildNarration({ slides, audioOf, retakes = [], okMid = [], seed = 'narration', timing = {} }) {
  const rng = makeRng(seed);
  const between = (lo, hi) => lo + rng.float() * (hi - lo); // 秒
  const S = (sec) => Math.round(sec * RATE);
  const beepAt = timing.beepAt ?? 1.5;
  const firstSpeechAt = timing.firstSpeechAt ?? 2.7;
  const tailSec = timing.tail ?? 4;

  const chunks = []; // {at, data}
  let t = 0;
  const segs = []; // 音声の区間（speech / junk / discarded）
  const ops = [];
  const unarmed = [];
  const slideInfo = [];

  const silence = (sec) => { t += S(sec); };
  const speak = (text, kind, slideId, extra = {}) => {
    const pcm = audioOf(text, kind === 'discarded' ? DISCARD_RATE : 0);
    chunks.push({ at: t, data: pcm });
    segs.push({ kind, slideId, text, start: t, end: t + pcm.length, ...extra });
    t += pcm.length;
  };
  const op = (name, slideId, note) => { ops.push({ at: t, name, slideId, note }); };

  // 合図の音（偽のマイクの WAV の先頭から beepAt 秒のところ）。クロックの校正だけに使う。撮り直しで捨てられるように、最初の撮り直しの中に入れる。
  const beep = new Int16Array(S(0.15));
  for (let i = 0; i < beep.length; i++) beep[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / RATE));

  const rec = slides.filter((s) => s.recordable);
  if (!retakes.some((r) => r.slideId === rec[0].slideId && r.part === 0 && r.junkAfter === 0)) throw new Error('the first slide needs a retake at its start (the calibration beep must be discarded)');
  op('record', rec[0].slideId, 'start');
  let first = true;
  let pieceStart = null; // 採用する区間の始まり（WAV の位置）
  for (let k = 0; k < rec.length; k++) {
    const sl = rec[k];
    const sents = splitSentences(sl.text);
    const parts = okMid.includes(sl.slideId) && sents.length >= 2 ? [sents.slice(0, Math.ceil(sents.length / 2)), sents.slice(Math.ceil(sents.length / 2))] : [sents];
    const info = { slideId: sl.slideId, text: sl.text, sentences: sents, parts: parts.map((p) => p.length), pieces: [], oksMid: 0, retakes: 0 };
    slideInfo.push(info);
    if (k === 0) {
      silence(beepAt);
      chunks.push({ at: t, data: beep });
      segs.push({ kind: 'beep', slideId: sl.slideId, text: '(calibration beep)', start: t, end: t + beep.length });
      t += beep.length;
      silence(firstSpeechAt - beepAt - 0.15);
    }
    if (k > 0) pieceStart = ops.at(-1).at; // 直前の next
    for (let p = 0; p < parts.length; p++) {
      const rt = retakes.find((r) => r.slideId === sl.slideId && r.part === p);
      const partSents = parts[p];
      if (rt) {
        for (let i = 0; i < rt.junkAfter; i++) {
          speak(partSents[i], 'discarded', sl.slideId, { sentence: i, why: 'read-before-misread' });
          silence(between(0.3, 1.5));
        }
        speak(rt.junkText, 'junk', sl.slideId, { why: 'misread' });
        silence(between(0.4, 0.8));
        op('retake', sl.slideId, `part ${p}`);
        const u0 = t;
        silence(between(1.0, 1.6)); // 録り直す前の間（アプリには入らない）
        unarmed.push({ start: u0, end: t, slideId: sl.slideId });
        op('record', sl.slideId, 'resume');
        pieceStart = t;
        info.retakes++;
        silence(between(0.3, 0.5));
      } else if (k === 0 && p === 0) {
        pieceStart = t;
      }
      partSents.forEach((s, i) => {
        const gapBefore = i > 0 ? between(0.3, 1.5) : 0;
        silence(gapBefore);
        speak(s, 'speech', sl.slideId, { sentence: (p === 0 ? 0 : parts[0].length) + i, part: p });
      });
      if (p < parts.length - 1) {
        silence(between(0.35, 0.75));
        op('ok', sl.slideId, 'mid-slide');
        info.pieces.push({ start: pieceStart, end: t });
        pieceStart = t;
        info.oksMid++;
        silence(between(0.3, 0.75));
      }
    }
    silence(between(0.35, 0.75));
    op('next', sl.slideId, k === rec.length - 1 ? 'last' : 'lap');
    info.pieces.push({ start: pieceStart, end: t });
    if (k < rec.length - 1) silence(between(0.3, 0.75));
    first = false;
  }
  void first;
  silence(tailSec);

  const pcm = new Int16Array(t);
  for (const c of chunks) pcm.set(c.data, c.at);

  // 操作ごとの「安全な窓」：直前の音声の終わりから、次の音声の始まりまで。操作の位置がこの中なら、音声を切らず、次の音声を食わない。
  const speechSegs = segs.filter((s) => s.kind !== 'beep');
  for (const o of ops) {
    const before = speechSegs.filter((s) => s.end <= o.at).at(-1);
    const after = speechSegs.find((s) => s.start >= o.at);
    o.window = [before ? before.end : 0, after ? after.start : t];
  }
  const plan = { sampleRate: RATE, wavSamples: t, beepAt: S(beepAt), beepSamples: beep.length, ops };
  const truth = {
    sampleRate: RATE,
    segments: segs,
    unarmed,
    slides: slideInfo.map((s) => ({ ...s, plannedSamples: s.pieces.reduce((a, p) => a + (p.end - p.start), 0) })),
  };
  return { pcm, plan, truth };
}
