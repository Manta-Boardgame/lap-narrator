// 「通しで録る」読み上げ：台本の 13 枚を、スライドの切り替えの操作（next）なしで、1 本につなげて読む。
// 操作は record、ok、retake、pause だけ。OK は、各スライドの終わりと、指定したスライドの文の間に打つ。
// 人らしいずれ：読み飛ばし（skip）、言い直し（repeat：同じ文を 2 回）、台本にない一言（adlib）、読み間違い → 撮り直し（retakes）。
import { makeRng } from './lib/rng.js';
import { RATE, DISCARD_RATE, splitSentences } from './narration.js';

/**
 * @param {object} o
 * @param {{slideId:string, text:string, recordable:boolean}[]} o.slides
 * @param {(text:string, rate:number)=>Int16Array} o.audioOf
 * @param {{slideId:string, sentence:number, junkText:string}[]} o.retakes 文 sentence（台本の番号）を読む前に読み間違えて、最後の OK まで戻る
 * @param {string[]} o.okMid 最初の文のあとに OK を打つスライド
 * @param {{slideId:string, sentence:number}[]} [o.skips] 読み飛ばす文
 * @param {{slideId:string, sentence:number}[]} [o.repeats] 2 回読む文
 * @param {{slideId:string, afterSentence:number, text:string}[]} [o.adlibs] 台本にない一言（文 afterSentence のあと）
 */
export function buildContinuous({ slides, audioOf, retakes = [], okMid = [], skips = [], repeats = [], adlibs = [], seed = 'cont', timing = {} }) {
  const rng = makeRng(seed);
  const between = (lo, hi) => lo + rng.float() * (hi - lo);
  const S = (sec) => Math.round(sec * RATE);
  const beepAt = timing.beepAt ?? 1.5;
  const firstSpeechAt = timing.firstSpeechAt ?? 2.7;
  const chunks = [];
  const segs = [];
  const ops = [];
  const unarmed = [];
  let t = 0;
  const silence = (sec) => { t += S(sec); };
  const speak = (text, kind, slideId, extra = {}) => {
    const pcm = audioOf(text, kind === 'discarded' || kind === 'repeat-first' ? DISCARD_RATE : 0);
    chunks.push({ at: t, data: pcm });
    segs.push({ kind, slideId, text, start: t, end: t + pcm.length, ...extra });
    t += pcm.length;
  };
  const op = (name, slideId, note) => { ops.push({ at: t, name, slideId, note }); };

  const beep = new Int16Array(S(0.15));
  for (let i = 0; i < beep.length; i++) beep[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / RATE));

  const rec = slides.filter((s) => s.recordable);
  if (!retakes.some((r) => r.slideId === rec[0].slideId && r.sentence === 0)) throw new Error('the first slide needs a retake before its first sentence (the calibration beep must be discarded)');
  op('record', rec[0].slideId, 'start');
  silence(beepAt);
  chunks.push({ at: t, data: beep });
  segs.push({ kind: 'beep', slideId: rec[0].slideId, text: '(calibration beep)', start: t, end: t + beep.length });
  t += beep.length;
  silence(firstSpeechAt - beepAt - 0.15);

  const slideInfo = [];
  let pieceStart = 0; // 採用する区間の始まり
  const pieces = [];
  for (let k = 0; k < rec.length; k++) {
    const sl = rec[k];
    const sents = splitSentences(sl.text);
    // 読む項目の並び
    const items = [];
    sents.forEach((txt, i) => {
      if (skips.some((x) => x.slideId === sl.slideId && x.sentence === i)) { items.push({ skipped: true, sentence: i, text: txt }); return; }
      if (repeats.some((x) => x.slideId === sl.slideId && x.sentence === i)) items.push({ text: txt, kind: 'repeat-first', sentence: i });
      items.push({ text: txt, kind: 'speech', sentence: i });
      for (const a of adlibs.filter((x) => x.slideId === sl.slideId && x.afterSentence === i)) items.push({ text: a.text, kind: 'adlib', sentence: null });
    });
    const reads = items.filter((x) => !x.skipped);
    const rt = retakes.find((r) => r.slideId === sl.slideId);
    const info = { slideId: sl.slideId, text: sl.text, sentences: sents, skipped: items.filter((x) => x.skipped).map((x) => x.sentence), retake: !!rt };
    slideInfo.push(info);
    // 最後の OK（スライドの最初か、文の間の OK）から、撮り直しの前までに読んだ項目
    const okAfterIdx = okMid.includes(sl.slideId) ? 0 : -1; // reads の添字 0 のあとに OK
    const mid = (kind) => silence(kind);
    let lastOkIdx = 0;
    const readItem = (it, i) => {
      if (i > 0) silence(between(0.3, 1.5));
      speak(it.text, it.kind, sl.slideId, { sentence: it.sentence });
    };
    const doRetake = (upto) => {
      // reads[lastOkIdx..upto-1] を読んでから（あとで捨てる）、読み間違えて、撮り直す
      for (let i = lastOkIdx; i < upto; i++) {
        if (i > lastOkIdx) silence(between(0.3, 1.5));
        speak(reads[i].text, 'discarded', sl.slideId, { sentence: reads[i].sentence, why: 'read-before-misread' });
      }
      if (upto > lastOkIdx) silence(between(0.3, 1.5));
      speak(rt.junkText, 'junk', sl.slideId, { why: 'misread' });
      silence(between(0.4, 0.8));
      op('retake', sl.slideId, `before sentence ${rt.sentence}`);
      const u0 = t;
      silence(between(1.0, 1.6));
      unarmed.push({ start: u0, end: t, slideId: sl.slideId });
      op('record', sl.slideId, 'resume');
      pieceStart = t;
      silence(between(0.3, 0.5));
    };
    const retakeIdx = rt ? reads.findIndex((x) => x.sentence === rt.sentence && x.kind !== 'adlib') : -1;
    for (let i = 0; i < reads.length; i++) {
      if (rt && i === retakeIdx) {
        doRetake(i);
        // やり直し：lastOkIdx から読み直す
        for (let j = lastOkIdx; j < i; j++) { if (j > lastOkIdx) silence(between(0.3, 1.5)); speak(reads[j].text, reads[j].kind, sl.slideId, { sentence: reads[j].sentence }); }
        if (i > lastOkIdx) silence(between(0.3, 1.5));
        speak(reads[i].text, reads[i].kind, sl.slideId, { sentence: reads[i].sentence });
      } else {
        if (i > 0 || (k > 0)) silence(i === 0 ? 0 : between(0.3, 1.5));
        speak(reads[i].text, reads[i].kind, sl.slideId, { sentence: reads[i].sentence });
      }
      if (i === okAfterIdx && reads.length > 1) {
        silence(between(0.35, 0.75));
        op('ok', sl.slideId, 'mid-slide');
        pieces.push({ start: pieceStart, end: t });
        pieceStart = t;
        lastOkIdx = i + 1;
        silence(between(0.3, 0.75));
      }
    }
    if (k < rec.length - 1) {
      // スライドの間：OK を真ん中に打つ
      const g = between(0.7, 1.5);
      silence(g / 2);
      op('ok', sl.slideId, 'slide-end');
      pieces.push({ start: pieceStart, end: t });
      pieceStart = t;
      silence(g / 2);
    }
  }
  silence(between(0.5, 0.8));
  op('ok', rec.at(-1).slideId, 'last');
  pieces.push({ start: pieceStart, end: t });
  silence(0.2);
  op('pause', rec.at(-1).slideId, 'stop');
  silence(4);

  const pcm = new Int16Array(t);
  for (const c of chunks) pcm.set(c.data, c.at);
  const speechSegs = segs.filter((s) => s.kind !== 'beep');
  for (const o of ops) {
    const before = speechSegs.filter((s) => s.end <= o.at).at(-1);
    const after = speechSegs.find((s) => s.start >= o.at);
    o.window = [before ? before.end : 0, after ? after.start : t];
  }
  const plan = { sampleRate: RATE, wavSamples: t, beepAt: S(beepAt), beepSamples: beep.length, ops };
  const truth = { sampleRate: RATE, mode: 'continuous', segments: segs, unarmed, pieces, slides: slideInfo };
  return { pcm, plan, truth };
}
