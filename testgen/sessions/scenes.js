// 録音セッションの見本の場面。
//
// 各場面は、(1) 操作の列 events と、(2) 手で導いた期待値 expected を持つ。
// expected は CONTRACTS.md 1.5 の規則を 1 行ずつ読んで人が導いた値を、そのまま書いたもの。コードからは作らない。
// （G()、T() などの関数は、書き写しの手間を減らすだけで、規則の計算はしない。startSec は start / 48000 の単純な割り算。）
//
// 読み方の決め事（曖昧な点の自分の読み方）は dev/proposals/E-001.md にある。要点：
//  - segmentId は、断片が「待ち行列（pending）から出た」順につける。ok で出る断片（採用）は ok の時点、
//    retake で破棄される待ち行列の断片は retake の時点、テイクを閉じるときに残る断片は閉じる時点。
//    あとで撮り直しで破棄される採用の区間は、番号を変えずに状態だけを discarded にする。
//  - 撮り直しで捨てた区間の理由は "retake"、閉じたときに残った断片の理由は "abandoned"、
//    復旧を経た断片は "uncommitted-after-recovery"（status は uncommitted）。採用の区間は理由なし。
//  - endSeq：テイクを閉じたイベントの seq。セッションの終わりで閉じたときは最後のイベントの seq。
//  - recoverable.lastCheckpointId：撮り直しで取り除かれずに残っているチェックポイントのうち、eventSeq が最大のもの。
import { DUR, EXPORT, GOTO, MARK, NEXT, OK, PAUSE, RECOVERED, REDO, RESUME, RETAKE, ROT, RS, SEQ, SS, TESTREC, UNDO, RATE, toneInto } from './builder.js';
import { makeRng } from '../lib/rng.js';

const pad = (n, w) => String(n).padStart(w, '0');
const R = (n) => 'rec-' + pad(n, 6);

/** 区間。status は kept / discarded / uncommitted。kept 以外は理由を付ける。 */
const G = (n, take, slide, rawIdx, start, end, status, order, reason) => {
  const o = {
    segmentId: 'g' + pad(n, 5),
    takeId: 't' + pad(take, 4),
    slideId: 's' + pad(slide, 4),
    raw: R(rawIdx),
    start,
    end,
    startSec: start / RATE,
    endSec: end / RATE,
    status,
  };
  if (reason !== undefined) o.reason = reason;
  o.order = order;
  return o;
};
const T = (take, slide, startSeq, endSeq, segNums, samples, candidate) => ({
  takeId: 't' + pad(take, 4),
  slideId: 's' + pad(slide, 4),
  status: 'closed',
  startSeq,
  endSeq,
  segments: segNums.map((n) => 'g' + pad(n, 5)),
  samples,
  candidate,
});
const REC = (pos, rawIdx, sample, lastCp) => ({ pos, raw: R(rawIdx), sample, lastCheckpointId: lastCp });
const I = (code, seq, message) => ({ code, seq, message });
const DT = (pairs) => Object.fromEntries(pairs.map(([s, t]) => ['s' + pad(s, 4), 't' + pad(t, 4)]));

export const scenes = [];
const add = (s) => scenes.push(s);

// ---------------------------------------------------------------------------
add({
  name: 'basic',
  ja: '基本：1 枚を録って OK、一時停止して次のスライドへ。',
  en: 'Basic: record one slide, OK, pause, go to the next slide.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    DUR(1, 19200), // 3
    OK(1, 1, 24000), // 4  → g1 = [0,24000)
    DUR(1, 24000), // 5
    PAUSE(1, 24000), // 6
    NEXT(2, 1, 24000, 2), // 7  c0002 は空（長さ 0 を捨てる）。テイクを閉じる
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 24000, 'kept', 1)],
    takes: [T(1, 1, 1, 7, [1], 24000, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(24000, 1, 24000, 'c0002'),
  },
});

add({
  name: 'retake',
  ja: '撮り直し：直前の OK 点まで戻って録り直す。',
  en: 'Retake: go back to the last OK point and record again.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    OK(1, 1, 14400), // 3  → g1 = [0,14400)
    DUR(1, 19200), // 4
    DUR(1, 24000), // 5
    RETAKE(1, 1, 28800), // 6  待ち行列 [14400,28800) を破棄 → g2
    RESUME(1, 33600), // 7
    DUR(1, 38400), // 8
    OK(2, 1, 43200), // 9  → g3 = [33600,43200)
    DUR(1, 43200), // 10
    PAUSE(1, 43200), // 11
    NEXT(3, 1, 43200, 2), // 12
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 14400, 'kept', 1),
      G(2, 1, 1, 1, 14400, 28800, 'discarded', null, 'retake'),
      G(3, 1, 1, 1, 33600, 43200, 'kept', 2),
    ],
    takes: [T(1, 1, 1, 12, [1, 3], 24000, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(43200, 1, 43200, 'c0003'),
  },
});

add({
  name: 'retake-twice',
  ja: '2 回連続の撮り直し：続けて押すと、さらに前の OK 点へ戻る。',
  en: 'Two consecutive retakes: the second goes back to the earlier OK point.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    OK(1, 1, 9600), // 2  → g1 = [0,9600)
    DUR(1, 14400), // 3
    OK(2, 1, 19200), // 4  → g2 = [9600,19200)
    DUR(1, 24000), // 5
    RETAKE(2, 1, 28800), // 6  待ち行列 [19200,28800) を破棄 → g3
    RETAKE(1, 1, 28800), // 7  c0002 を取り除く → g2 が破棄になる
    RESUME(1, 33600), // 8
    DUR(1, 38400), // 9
    OK(3, 1, 43200), // 10 → g4 = [33600,43200)
    DUR(1, 43200), // 11
    PAUSE(1, 43200), // 12
    NEXT(4, 1, 43200, 2), // 13
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 9600, 'kept', 1),
      G(2, 1, 1, 1, 9600, 19200, 'discarded', null, 'retake'),
      G(3, 1, 1, 1, 19200, 28800, 'discarded', null, 'retake'),
      G(4, 1, 1, 1, 33600, 43200, 'kept', 2),
    ],
    takes: [T(1, 1, 1, 13, [1, 4], 19200, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(43200, 1, 43200, 'c0004'),
  },
});

add({
  name: 'retake-null',
  ja: 'toCheckpoint が null の撮り直し：テイクの最初まで戻る。',
  en: 'Retake with toCheckpoint = null: go back to the start of the take.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    OK(1, 1, 9600), // 2  → g1
    OK(2, 1, 19200), // 3  → g2
    DUR(1, 24000), // 4
    RETAKE(null, 1, 28800), // 5  待ち行列 [19200,28800) → g3。c0001、c0002 も破棄
    RESUME(1, 33600), // 6
    DUR(1, 38400), // 7
    OK(3, 1, 43200), // 8  → g4 = [33600,43200)
    DUR(1, 43200), // 9
    PAUSE(1, 43200), // 10
    NEXT(4, 1, 43200, 2), // 11
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 9600, 'discarded', null, 'retake'),
      G(2, 1, 1, 1, 9600, 19200, 'discarded', null, 'retake'),
      G(3, 1, 1, 1, 19200, 28800, 'discarded', null, 'retake'),
      G(4, 1, 1, 1, 33600, 43200, 'kept', 1),
    ],
    takes: [T(1, 1, 1, 11, [4], 9600, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(43200, 1, 43200, 'c0004'),
  },
});

add({
  name: 'undo-ok',
  ja: 'OK の取り消し：取り消した OK は存在しないものとして扱い、その前後の断片が 1 つのチェックポイントになる。',
  en: 'Undo of an OK: the undone OK is treated as absent, so the pieces around it join one checkpoint.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    OK(1, 1, 9600), // 3  → g1 = [0,9600)
    DUR(1, 14400), // 4
    OK(2, 1, 19200), // 5  ← 取り消される
    UNDO(5), // 6
    DUR(1, 24000), // 7
    OK(3, 1, 28800), // 8  → g2 = [9600,28800)
    DUR(1, 28800), // 9
    PAUSE(1, 28800), // 10
    NEXT(4, 1, 28800, 2), // 11
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 1, 1, 1, 9600, 28800, 'kept', 2)],
    takes: [T(1, 1, 1, 11, [1, 2], 28800, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(28800, 1, 28800, 'c0004'),
  },
});

add({
  name: 'undo-retake',
  ja: '撮り直しの取り消し：取り消した撮り直しは存在しないものとして扱い、録音が続いていたことになる。',
  en: 'Undo of a retake: the undone retake is treated as absent, so the recording simply continued.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    OK(1, 1, 9600), // 3  → g1 = [0,9600)
    DUR(1, 14400), // 4
    DUR(1, 19200), // 5
    RETAKE(1, 1, 19200), // 6  ← 取り消される
    UNDO(6), // 7
    RESUME(1, 19200), // 8  待ち行列は [9600,19200)、[19200,19200) の 2 つになる
    DUR(1, 24000), // 9
    OK(2, 1, 28800), // 10 → g2 = [9600,19200)、g3 = [19200,28800)（end == start でもまとめない）
    DUR(1, 28800), // 11
    PAUSE(1, 28800), // 12
    NEXT(3, 1, 28800, 2), // 13
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 1, 1, 1, 9600, 19200, 'kept', 2), G(3, 1, 1, 1, 19200, 28800, 'kept', 3)],
    takes: [T(1, 1, 1, 13, [1, 2, 3], 28800, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(28800, 1, 28800, 'c0003'),
  },
});

add({
  name: 'redo-retake',
  ja: '撮り直しの取り消しと、やり直し（redo）：redo で撮り直しが有効に戻る。',
  en: 'Undo then redo of a retake: the redo makes the retake effective again.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    OK(1, 1, 9600), // 2  → g1 = [0,9600)
    DUR(1, 14400), // 3
    DUR(1, 19200), // 4
    RETAKE(1, 1, 19200), // 5  取り消してからやり直すので有効。[9600,19200) を破棄 → g2
    UNDO(5), // 6
    REDO(5), // 7
    RESUME(1, 24000), // 8
    DUR(1, 28800), // 9
    OK(2, 1, 33600), // 10 → g3 = [24000,33600)
    DUR(1, 33600), // 11
    PAUSE(1, 33600), // 12
    NEXT(3, 1, 33600, 2), // 13
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 9600, 'kept', 1),
      G(2, 1, 1, 1, 9600, 19200, 'discarded', null, 'retake'),
      G(3, 1, 1, 1, 24000, 33600, 'kept', 2),
    ],
    takes: [T(1, 1, 1, 13, [1, 3], 19200, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(33600, 1, 33600, 'c0003'),
  },
});

add({
  name: 'undo-nav',
  ja: '次のスライドへ、と、スライドの移動の取り消し：取り消した操作は存在しない（orphan-audio も goto-while-recording も出ない）。',
  en: 'Undo of next-slide and goto-slide: undone operations do not exist (no orphan-audio, no goto-while-recording).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    NEXT(1, 1, 14400, 2), // 3  ← 取り消される（間違って押した）
    UNDO(3), // 4
    DUR(1, 19200), // 5
    OK(2, 1, 24000), // 6  → g1 = [0,24000)
    GOTO(3), // 7  ← 取り消される
    UNDO(7), // 8
    DUR(1, 28800), // 9
    PAUSE(1, 28800), // 10
    NEXT(3, 1, 28800, 2), // 11 → g2 = [24000,28800)
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 24000, 'kept', 1), G(2, 1, 1, 1, 24000, 28800, 'kept', 2)],
    takes: [T(1, 1, 1, 11, [1, 2], 28800, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(28800, 1, 28800, 'c0003'),
  },
});

add({
  name: 'file-rotate',
  ja: '録音ファイルの切り替え：OK 点をまたいで録音ファイルが切り替わり、1 つのテイクが 2 つのファイルを参照する。',
  en: 'File rotation: the raw file switches mid-take and one take refers to two raw files.',
  rawFiles: [48000, 48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 19200), // 2
    OK(1, 1, 28800), // 3  → g1 = rec-1 [0,28800)
    DUR(1, 38400), // 4
    ROT(1, 2, 48000), // 5  rec-1 の [28800,48000) を閉じ、rec-2 に新しい断片
    DUR(2, 4800), // 6
    OK(2, 2, 9600), // 7  → g2 = rec-1 [28800,48000)、g3 = rec-2 [0,9600)
    DUR(2, 9600), // 8
    PAUSE(2, 9600), // 9
    NEXT(3, 2, 9600, 2), // 10
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 28800, 'kept', 1),
      G(2, 1, 1, 1, 28800, 48000, 'kept', 2),
      G(3, 1, 1, 2, 0, 9600, 'kept', 3),
    ],
    takes: [T(1, 1, 1, 10, [1, 2, 3], 57600, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(57600, 2, 9600, 'c0003'),
  },
});

add({
  name: 'pause-resume',
  ja: '一時停止と再開：end == 次の start の断片はまとめない。再開位置が離れていてもよい。空の断片は置き換える。',
  en: 'Pause and resume: adjacent pieces are not merged; gaps are allowed; an empty piece is replaced on resume.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    PAUSE(1, 14400, 'user'), // 3  断片 [0,14400)
    RESUME(1, 14400), // 4  すぐ隣（end == start）
    DUR(1, 24000), // 5
    PAUSE(1, 28800, 'hidden'), // 6  断片 [14400,28800)
    RESUME(1, 33600), // 7  離れている
    PAUSE(1, 33600, 'mute'), // 8  断片 [33600,33600) は空
    RESUME(1, 36000), // 9  空の断片を置き換える
    DUR(1, 40800), // 10
    OK(1, 1, 43200), // 11 → g1 = [0,14400)、g2 = [14400,28800)、g3 = [36000,43200)
    DUR(1, 43200), // 12
    PAUSE(1, 43200, 'user'), // 13
    NEXT(2, 1, 43200, 2), // 14
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 14400, 'kept', 1), G(2, 1, 1, 1, 14400, 28800, 'kept', 2), G(3, 1, 1, 1, 36000, 43200, 'kept', 3)],
    takes: [T(1, 1, 1, 14, [1, 2, 3], 36000, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(43200, 1, 43200, 'c0002'),
  },
});

add({
  name: 'goto-slide',
  ja: 'goto-slide で別のスライドを録り直す：同じスライドに候補が 2 つでき、既定は startSeq が大きい（新しい）方。',
  en: 'goto-slide to re-record a slide: two candidates for one slide; the default is the newer one.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1  t0001（s0001）
    DUR(1, 4800), // 2
    OK(1, 1, 9600), // 3  → g1
    PAUSE(1, 9600), // 4
    NEXT(2, 1, 9600, 2), // 5
    RS(2, 2, 1, 9600), // 6  t0002（s0002）
    DUR(1, 14400), // 7
    OK(3, 1, 19200), // 8  → g2
    PAUSE(1, 19200), // 9
    NEXT(4, 1, 19200, 3), // 10
    GOTO(1), // 11 停止中なので問題なし
    RS(1, 3, 1, 19200), // 12 t0003（s0001 を録り直す）
    DUR(1, 24000), // 13
    OK(5, 1, 28800), // 14 → g3
    DUR(1, 28800), // 15
    PAUSE(1, 28800), // 16
    NEXT(6, 1, 28800, 2), // 17
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 2, 2, 1, 9600, 19200, 'kept', 1), G(3, 3, 1, 1, 19200, 28800, 'kept', 1)],
    takes: [T(1, 1, 1, 5, [1], 9600, true), T(2, 2, 6, 10, [2], 9600, true), T(3, 1, 12, 17, [3], 9600, true)],
    defaultTakes: DT([
      [1, 3],
      [2, 2],
    ]),
    recoverable: REC(28800, 1, 28800, 'c0006'),
  },
});

add({
  name: 'goto-while-recording',
  ja: '録音中の goto-slide：問題 goto-while-recording を出し、テイクを閉じる（残った断片は abandoned）。',
  en: 'goto-slide while recording: reports goto-while-recording and closes the take (leftover pieces are abandoned).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    OK(1, 1, 9600), // 2  → g1
    DUR(1, 14400), // 3
    GOTO(3), // 4  録音中。テイクを閉じる。[9600,14400) → g2 abandoned
    DUR(1, 19200), // 5  どのテイクにも属さない
    RS(3, 2, 1, 24000), // 6
    OK(2, 1, 33600), // 7  → g3 = [24000,33600)
    DUR(1, 33600), // 8
    PAUSE(1, 33600), // 9
    NEXT(3, 1, 33600, 1), // 10
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 1, 1, 1, 9600, 14400, 'discarded', null, 'abandoned'), G(3, 2, 3, 1, 24000, 33600, 'kept', 1)],
    takes: [T(1, 1, 1, 4, [1], 9600, true), T(2, 3, 6, 10, [3], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [3, 2],
    ]),
    recoverable: REC(33600, 1, 33600, 'c0003'),
    issues: [I('goto-while-recording', 4, 'goto-slide while recording')],
  },
});

add({
  name: 'recovered',
  ja: 'recovered（OK を 1 度も押さずに強制終了）：保存位置（durable）までが uncommitted になる。',
  en: 'recovered (force-quit without any OK): everything up to the last durable position is uncommitted.',
  rawFiles: [48000],
  durableSamples: [28800],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    DUR(1, 19200), // 3
    DUR(1, 28800), // 4
    RECOVERED(null, 1, 28800, 'recovered after force quit; last durable at 28800'), // 5 → 終わりで閉じる → g1 uncommitted
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 28800, 'uncommitted', null, 'uncommitted-after-recovery')],
    takes: [T(1, 1, 1, 5, [], 0, false)],
    defaultTakes: {},
    recoverable: REC(28800, 1, 28800, null),
  },
});

add({
  name: 'recovered-after-ok',
  ja: 'OK を 1 度押したあとの強制終了：OK までは採用、そのあとの保存位置までが uncommitted。',
  en: 'Force-quit after one OK: up to the OK is kept; the rest up to the last durable is uncommitted.',
  rawFiles: [48000],
  durableSamples: [24000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    OK(1, 1, 14400), // 3  → g1 = [0,14400)
    DUR(1, 19200), // 4
    DUR(1, 24000), // 5
    RECOVERED(1, 1, 24000, 'recovered after force quit; last OK c0001'), // 6 → g2 = [14400,24000) uncommitted
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 14400, 'kept', 1), G(2, 1, 1, 1, 14400, 24000, 'uncommitted', null, 'uncommitted-after-recovery')],
    takes: [T(1, 1, 1, 6, [1], 14400, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(24000, 1, 24000, 'c0001'),
  },
});

add({
  name: 'recovered-retake',
  ja: '復旧のあと、最後の OK 点から撮り直し、新しい録音ファイルで続ける。',
  en: 'After recovery, retake from the last OK point and continue in a new raw file.',
  rawFiles: [48000, 48000],
  durableSamples: [24000, 14400],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    OK(1, 1, 14400), // 3  → g1 = rec-1 [0,14400)
    DUR(1, 24000), // 4
    RECOVERED(1, 1, 24000, 'recovered after force quit'), // 5
    RETAKE(1, 1, 24000), // 6  利用者が撮り直しを選ぶ → [14400,24000) は discarded（reason retake）→ g2
    RESUME(2, 0), // 7  新しい録音ファイル
    DUR(2, 9600), // 8
    OK(2, 2, 14400), // 9  → g3 = rec-2 [0,14400)
    DUR(2, 14400), // 10
    PAUSE(2, 14400), // 11
    NEXT(3, 2, 14400, 2), // 12
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 14400, 'kept', 1),
      G(2, 1, 1, 1, 14400, 24000, 'discarded', null, 'retake'),
      G(3, 1, 1, 2, 0, 14400, 'kept', 2),
    ],
    takes: [T(1, 1, 1, 12, [1, 3], 28800, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(62400, 2, 14400, 'c0003'),
  },
});

add({
  name: 'orphan-audio',
  ja: 'next-slide のあとも録音が続く（recording が真）：問題 orphan-audio。次の rec-start までの音はどのテイクにも属さない。',
  en: 'Recording continues after next-slide: reports orphan-audio; audio until the next rec-start belongs to no take.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    NEXT(1, 1, 9600, 2), // 3  recording が真のまま → orphan-audio。g1 = [0,9600)
    DUR(1, 14400), // 4  どのテイクにも属さない
    RS(2, 2, 1, 19200), // 5
    DUR(1, 24000), // 6
    OK(2, 1, 28800), // 7  → g2 = [19200,28800)
    DUR(1, 28800), // 8
    PAUSE(1, 28800), // 9
    NEXT(3, 1, 28800, 3), // 10
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 2, 2, 1, 19200, 28800, 'kept', 1)],
    takes: [T(1, 1, 1, 3, [1], 9600, true), T(2, 2, 5, 10, [2], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [2, 2],
    ]),
    recoverable: REC(28800, 1, 28800, 'c0003'),
    issues: [I('orphan-audio', 3, 'recording continues after next-slide')],
  },
});

add({
  name: 'next-while-recording',
  ja: '録音を続けたまま次のスライドへ進み、同じ位置で rec-start する（通常の操作）：orphan-audio は出ない（CONTRACTS.md 7 章）。',
  en: 'Go to the next slide while still recording and rec-start at the same position (normal use): no orphan-audio (CONTRACTS.md chapter 7).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    NEXT(1, 1, 9600, 2), // 3  recording は真のまま。g1 = [0,9600)。次の rec-start が同じ pos なので orphan-audio なし
    RS(2, 2, 1, 9600), // 4
    DUR(1, 14400), // 5
    OK(2, 1, 19200), // 6  → g2 = [9600,19200)
    DUR(1, 19200), // 7
    NEXT(3, 1, 19200, 3), // 8  recording は真のまま。c0003 は空。次の rec-start が同じ pos
    RS(3, 3, 1, 19200), // 9
    DUR(1, 24000), // 10
    OK(4, 1, 28800), // 11 → g3 = [19200,28800)
    DUR(1, 28800), // 12
    PAUSE(1, 28800), // 13
    NEXT(5, 1, 28800, 1), // 14 停止中。c0005 は空
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 2, 2, 1, 9600, 19200, 'kept', 1), G(3, 3, 3, 1, 19200, 28800, 'kept', 1)],
    takes: [T(1, 1, 1, 3, [1], 9600, true), T(2, 2, 4, 8, [2], 9600, true), T(3, 3, 9, 14, [3], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    recoverable: REC(28800, 1, 28800, 'c0005'),
  },
});

add({
  name: 'bad-undo-target',
  ja: 'undo／redo の対象が不正：durable、rec-start、存在しない eventId、undo 自身を指すと bad-undo-target。mark は取り消せる。',
  en: 'Invalid undo/redo targets: durable, rec-start, an unknown eventId and an undo event give bad-undo-target. A mark can be undone.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    MARK(1, 7200, 'first mark'), // 3  あとで取り消される
    OK(1, 1, 9600), // 4  → g1 = [0,9600)
    UNDO(2), // 5  durable が対象 → bad-undo-target
    UNDO(1), // 6  rec-start が対象 → bad-undo-target
    REDO(4), // 7  ok が対象（有効な種類）。取り消されていないので何も起きない
    UNDO(99), // 8  存在しない eventId → bad-undo-target
    UNDO(3), // 9  mark が対象（有効）→ first mark は存在しない
    UNDO(9), // 10 undo が対象 → bad-undo-target
    MARK(1, 12000, 'second mark'), // 11
    DUR(1, 14400), // 12
    OK(2, 1, 19200), // 13 → g2 = [9600,19200)
    DUR(1, 19200), // 14
    PAUSE(1, 19200), // 15
    NEXT(3, 1, 19200, 2), // 16
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 1, 1, 1, 9600, 19200, 'kept', 2)],
    takes: [T(1, 1, 1, 16, [1, 2], 19200, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(19200, 1, 19200, 'c0003'),
    marks: [{ seq: 11, at: { raw: R(1), sample: 12000, pos: 12000 }, note: 'second mark' }],
    issues: [
      I('bad-undo-target', 5, 'target is a durable event'),
      I('bad-undo-target', 6, 'target is a rec-start event'),
      I('bad-undo-target', 8, 'target e99 does not exist'),
      I('bad-undo-target', 10, 'target is an undo event'),
    ],
  },
});

add({
  name: 'position-mismatch',
  ja: '位置の不整合：ok の pos が、(raw, sample) と前の録音ファイルの長さの合計に合わない。',
  en: 'Position mismatch: the pos of an ok does not equal the previous raw files length plus sample.',
  rawFiles: [48000, 48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    OK(1, 1, 9600), // 3  → g1 = rec-1 [0,9600)
    PAUSE(1, 9600), // 4
    NEXT(2, 1, 9600, 2), // 5
    RS(2, 2, 2, 0), // 6  pos 48000
    DUR(2, 4800), // 7  pos 52800
    OK(3, 2, 9600, { pos: 9600 }), // 8  pos は 57600 でなければならない → position-mismatch
    DUR(2, 9600), // 9  pos 57600
    PAUSE(2, 9600), // 10
    NEXT(4, 2, 9600, 3), // 11
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 2, 2, 2, 0, 9600, 'kept', 1)],
    takes: [T(1, 1, 1, 5, [1], 9600, true), T(2, 2, 6, 11, [2], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [2, 2],
    ]),
    recoverable: REC(57600, 2, 9600, 'c0004'),
    issues: [I('position-mismatch', 8, 'pos 9600 does not match rec-000002 sample 9600 (expected 57600)')],
  },
});

add({
  name: 'beyond-raw-length',
  ja: '録音ファイルの長さを超える位置：next-slide の位置が録音ファイルの samples（48000）を超える。',
  en: 'Position beyond the raw file length: the next-slide position exceeds the raw file samples (48000).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 19200), // 2
    OK(1, 1, 36000), // 3  → g1 = [0,36000)
    DUR(1, 43200), // 4
    PAUSE(1, 43200), // 5
    NEXT(2, 1, 52800, 2), // 6  52800 > 48000 → beyond-raw-length。g2 = [36000,52800)（切り詰めない）
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 36000, 'kept', 1), G(2, 1, 1, 1, 36000, 52800, 'kept', 2)],
    takes: [T(1, 1, 1, 6, [1, 2], 52800, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(43200, 1, 43200, 'c0002'),
    issues: [I('beyond-raw-length', 6, 'sample 52800 is beyond rec-000001 length 48000')],
  },
});

add({
  name: 'unknown-raw',
  ja: '知らない録音ファイル：rawFiles にない rec-000003 を指す位置は unknown-raw（位置の整合は確かめられない）。',
  en: 'Unknown raw file: positions in rec-000003, which is not in rawFiles, give unknown-raw (pos cannot be verified).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    OK(1, 1, 19200), // 3  → g1 = rec-1 [0,19200)
    PAUSE(1, 19200), // 4
    NEXT(2, 1, 19200, 2), // 5
    RS(2, 2, 3, 0, { pos: 96000 }), // 6  unknown-raw
    DUR(3, 4800, { pos: 100800 }), // 7  unknown-raw
    OK(3, 3, 9600, { pos: 105600 }), // 8  → g2 = rec-3 [0,9600)。unknown-raw
    PAUSE(3, 9600, 'user', { pos: 105600 }), // 9  unknown-raw
    NEXT(4, 3, 9600, 3, { pos: 105600 }), // 10 unknown-raw
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 19200, 'kept', 1),
      // 録音ファイルが分からない区間は、周波数が分からないので startSec と endSec を持たない
      (() => {
        const g = G(2, 2, 2, 3, 0, 9600, 'kept', 1);
        delete g.startSec;
        delete g.endSec;
        return g;
      })(),
    ],
    takes: [T(1, 1, 1, 5, [1], 19200, true), T(2, 2, 6, 10, [2], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [2, 2],
    ]),
    recoverable: { pos: 100800, raw: R(3), sample: 4800, lastCheckpointId: 'c0004' },
    issues: [
      I('unknown-raw', 6, 'rec-000003 is not in rawFiles'),
      I('unknown-raw', 7, 'rec-000003 is not in rawFiles'),
      I('unknown-raw', 8, 'rec-000003 is not in rawFiles'),
      I('unknown-raw', 9, 'rec-000003 is not in rawFiles'),
      I('unknown-raw', 10, 'rec-000003 is not in rawFiles'),
    ],
  },
});

add({
  name: 'empty-fragment',
  ja: '空の断片（長さ 0）を捨てる：OK のすぐあとの断片、撮り直しの直後の断片など。',
  en: 'Empty fragments (length 0) are dropped: right after an OK, right after a retake, and so on.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    OK(1, 1, 0), // 2  長さ 0 のチェックポイント。区間は作らない
    DUR(1, 9600), // 3
    RETAKE(1, 1, 9600), // 4  待ち行列 [0,9600) を破棄 → g1
    RESUME(1, 9600), // 5
    RETAKE(1, 1, 9600), // 6  待ち行列は [9600,9600) で空。区間は作らない
    RESUME(1, 9600), // 7
    DUR(1, 14400), // 8
    OK(2, 1, 19200), // 9  → g2 = [9600,19200)
    DUR(1, 19200), // 10
    PAUSE(1, 19200), // 11
    NEXT(3, 1, 19200, 2), // 12 c0003 は空
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'discarded', null, 'retake'), G(2, 1, 1, 1, 9600, 19200, 'kept', 1)],
    takes: [T(1, 1, 1, 12, [2], 9600, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(19200, 1, 19200, 'c0003'),
  },
});

add({
  name: 'public-sample',
  ja: '公開の見本（設計書 6.3）：OK 点をまたいで録音ファイルが分かれ、撮り直しを取り消した例。',
  en: 'Public sample (design 6.3): the raw file rotates across an OK point and a retake is undone.',
  rawFiles: [48000, 48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1  t0001（s0001）
    DUR(1, 9600), // 2
    OK(1, 1, 19200), // 3  → g1 = rec-1 [0,19200)
    DUR(1, 33600), // 4
    DUR(1, 48000), // 5
    ROT(1, 2, 48000), // 6
    DUR(2, 4800), // 7
    DUR(2, 9600), // 8
    RETAKE(1, 2, 9600), // 9  ← 取り消される
    UNDO(9), // 10
    RESUME(2, 9600), // 11 前の断片は空でないので、新しい断片を足す
    DUR(2, 14400), // 12
    OK(2, 2, 19200), // 13 → g2 = rec-1 [19200,48000)、g3 = rec-2 [0,9600)、g4 = rec-2 [9600,19200)
    DUR(2, 19200), // 14
    PAUSE(2, 19200), // 15
    NEXT(3, 2, 19200, 2), // 16
    RS(2, 2, 2, 19200), // 17 t0002（s0002）
    DUR(2, 24000), // 18
    OK(4, 2, 28800), // 19 → g5 = rec-2 [19200,28800)
    DUR(2, 28800), // 20
    PAUSE(2, 28800), // 21
    NEXT(5, 2, 28800, 3), // 22
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 19200, 'kept', 1),
      G(2, 1, 1, 1, 19200, 48000, 'kept', 2),
      G(3, 1, 1, 2, 0, 9600, 'kept', 3),
      G(4, 1, 1, 2, 9600, 19200, 'kept', 4),
      G(5, 2, 2, 2, 19200, 28800, 'kept', 1),
    ],
    takes: [T(1, 1, 1, 16, [1, 2, 3, 4], 67200, true), T(2, 2, 17, 22, [5], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [2, 2],
    ]),
    recoverable: REC(76800, 2, 28800, 'c0005'),
  },
});

// durable-many：durable が多数並んでも、採用と破棄は変わらない
const durableManyEvents = [SS(), RS(1, 1, 1, 0)]; // 0, 1
for (let k = 1; k <= 10; k++) durableManyEvents.push(DUR(1, 2400 * k)); // 2..11（2400〜24000）
durableManyEvents.push(OK(1, 1, 24000)); // 12 → g1 = [0,24000)
for (const s of [26400, 28800, 31200, 33600]) durableManyEvents.push(DUR(1, s)); // 13..16
durableManyEvents.push(RETAKE(1, 1, 36000)); // 17 待ち行列 [24000,36000) を破棄 → g2
durableManyEvents.push(RESUME(1, 36000)); // 18
for (const s of [38400, 40800, 43200, 45600, 48000]) durableManyEvents.push(DUR(1, s)); // 19..23
durableManyEvents.push(OK(2, 1, 48000)); // 24 → g3 = [36000,48000)
durableManyEvents.push(DUR(1, 48000)); // 25
durableManyEvents.push(PAUSE(1, 48000)); // 26
durableManyEvents.push(NEXT(3, 1, 48000, 2)); // 27
add({
  name: 'durable-many',
  ja: 'durable が多数並ぶ場面：保存位置の記録は、採用と破棄を変えない（durable を全部取り除いても区間は同じ）。',
  en: 'Many durable events: they do not change what is kept or discarded (removing all of them leaves the segments unchanged).',
  rawFiles: [48000],
  events: durableManyEvents,
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 24000, 'kept', 1),
      G(2, 1, 1, 1, 24000, 36000, 'discarded', null, 'retake'),
      G(3, 1, 1, 1, 36000, 48000, 'kept', 2),
    ],
    takes: [T(1, 1, 1, 27, [1, 3], 36000, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(48000, 1, 48000, 'c0003'),
  },
});

add({
  name: 'seq-gap',
  ja: 'seq の欠番：seq 3 がない。問題 seq-gap（欠番のあとの最初のイベントの seq を示す）を出し、読める範囲で解釈する。',
  en: 'Sequence gap: seq 3 is missing. Reports seq-gap (at the first event after the gap) and interprets what it can.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    SEQ(4, DUR(1, 19200)), // 4（3 が欠けている）
    OK(1, 1, 24000), // 5  → g1 = [0,24000)
    DUR(1, 24000), // 6
    PAUSE(1, 24000), // 7
    NEXT(2, 1, 24000, 2), // 8
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 24000, 'kept', 1)],
    takes: [T(1, 1, 1, 8, [1], 24000, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(24000, 1, 24000, 'c0002'),
    issues: [I('seq-gap', 4, 'seq jumps from 2 to 4')],
  },
});

add({
  name: 'marks-misc',
  ja: 'mark、test-rec、export は解釈に影響しない。mark だけを marks に記録する。',
  en: 'mark, test-rec and export do not change the interpretation. Only marks are listed in marks.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    TESTREC(10000), // 1
    RS(1, 1, 1, 0), // 2
    MARK(1, 4800, 'slow down'), // 3
    OK(1, 1, 9600), // 4  → g1 = [0,9600)
    MARK(1, 12000), // 5  メモなし
    DUR(1, 14400), // 6
    PAUSE(1, 14400), // 7
    NEXT(2, 1, 14400, 2), // 8  → g2 = [9600,14400)
    EXPORT('exp-marks-0001', 'full', 1), // 9
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 1, 1, 1, 9600, 14400, 'kept', 2)],
    takes: [T(1, 1, 2, 8, [1, 2], 14400, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(14400, 1, 14400, 'c0002'),
    marks: [
      { seq: 3, at: { raw: R(1), sample: 4800, pos: 4800 }, note: 'slow down' },
      { seq: 5, at: { raw: R(1), sample: 12000, pos: 12000 } },
    ],
  },
});

// tiny3-full：3 枚を録った、いちばん普通の全記録。録音ファイルの中身は、採用の部分がスライドごとの確認音の周波数。
add({
  name: 'tiny3-full',
  ja: '3 枚（tiny3）を録った全記録。1 枚目に撮り直しが 1 回。録音の中身はスライドごとに固有の周波数の音で、撮り直しで捨てた部分は別の音。',
  en: 'A full record of the 3-slide deck (tiny3) with one retake on slide 1. Kept audio uses a per-slide tone; the discarded part uses a different tone.',
  rawFiles: [48000],
  audio: (fileIdx, samples) => {
    const buf = new Int16Array(samples);
    const rng = makeRng('raw:tiny3-full:1');
    const f = (n) => 400 + 80 * n; // スライド n の周波数（480、560、640 Hz）
    toneInto(buf, 0, 9600, f(1), 8000, rng);
    toneInto(buf, 9600, 14400, 150, 8000, rng); // 撮り直しで捨てる
    toneInto(buf, 14400, 24000, f(1), 8000, rng);
    toneInto(buf, 24000, 33600, f(2), 8000, rng);
    toneInto(buf, 33600, 43200, f(3), 8000, rng);
    toneInto(buf, 43200, samples, 90, 500, rng); // 最後の余韻
    return buf;
  },
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    OK(1, 1, 9600), // 3  → g1 = [0,9600)
    DUR(1, 12000), // 4
    RETAKE(1, 1, 14400), // 5  [9600,14400) を破棄 → g2
    RESUME(1, 14400), // 6
    DUR(1, 19200), // 7
    OK(2, 1, 24000), // 8  → g3 = [14400,24000)
    DUR(1, 24000), // 9
    PAUSE(1, 24000), // 10
    NEXT(3, 1, 24000, 2), // 11
    RS(2, 2, 1, 24000), // 12
    DUR(1, 28800), // 13
    OK(4, 1, 33600), // 14 → g4 = [24000,33600)
    DUR(1, 33600), // 15
    PAUSE(1, 33600), // 16
    NEXT(5, 1, 33600, 3), // 17
    RS(3, 3, 1, 33600), // 18
    DUR(1, 38400), // 19
    OK(6, 1, 43200), // 20 → g5 = [33600,43200)
    DUR(1, 43200), // 21
    PAUSE(1, 43200), // 22
    EXPORT('exp-tiny3-01', 'full', 1), // 23  最後のテイクはセッションの終わりで閉じる
  ],
  expected: {
    segments: [
      G(1, 1, 1, 1, 0, 9600, 'kept', 1),
      G(2, 1, 1, 1, 9600, 14400, 'discarded', null, 'retake'),
      G(3, 1, 1, 1, 14400, 24000, 'kept', 2),
      G(4, 2, 2, 1, 24000, 33600, 'kept', 1),
      G(5, 3, 3, 1, 33600, 43200, 'kept', 1),
    ],
    takes: [T(1, 1, 1, 11, [1, 3], 19200, true), T(2, 2, 12, 17, [4], 9600, true), T(3, 3, 18, 23, [5], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    recoverable: REC(43200, 1, 43200, 'c0006'),
  },
});

// ---------------------------------------------------------------------------
// 第 1 波の検査（V1）を受けた追加の場面（CONTRACTS.md 7.7）。期待値は手で導いた。

add({
  name: 'undo-future',
  ja: '未来のイベントを指す undo／redo：対象の seq が自分の seq 以上なら bad-undo-target（無視する）。',
  en: 'undo/redo that points to a later event: bad-undo-target when the target seq is not smaller than its own seq (ignored).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    UNDO(4), // 1  対象 e4（未来の ok）→ bad-undo-target。ok は取り消されない
    RS(1, 1, 1, 0), // 2
    DUR(1, 4800), // 3
    OK(1, 1, 9600), // 4  → g1 = [0,9600)
    REDO(8), // 5  対象 e8（未来の next-slide）→ bad-undo-target
    DUR(1, 9600), // 6
    PAUSE(1, 9600), // 7
    NEXT(2, 1, 9600, 2), // 8  c0002 は空
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1)],
    takes: [T(1, 1, 2, 8, [1], 9600, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(9600, 1, 9600, 'c0002'),
    issues: [I('bad-undo-target', 1, 'target e4 is later'), I('bad-undo-target', 5, 'target e8 is later')],
  },
});

add({
  name: 'double-next-audio',
  ja: '録音を続けたまま next-slide が 2 回、間にも後にも音がある：orphan-audio は next-slide ごとに 2 件。',
  en: 'Two next-slide events while still recording, with audio after each: one orphan-audio per next-slide (2 issues).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    NEXT(1, 1, 9600, 2), // 3  recording は真。g1 = [0,9600)。次の状態を変えるイベント（pause）の pos 19200 > 9600 → 1 件
    DUR(1, 12000), // 4
    NEXT(2, 1, 14400, 3), // 5  開いているテイクはない。recording は真。19200 > 14400 → 1 件
    DUR(1, 19200), // 6
    PAUSE(1, 19200), // 7
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1)],
    takes: [T(1, 1, 1, 3, [1], 9600, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(19200, 1, 19200, 'c0001'),
    issues: [I('orphan-audio', 3, 'audio after next-slide'), I('orphan-audio', 5, 'audio after next-slide')],
  },
});

add({
  name: 'double-next-silent',
  ja: '録音を続けたまま next-slide が 2 回、間に音がない（同じ位置）で、同じ位置の rec-start：orphan-audio は出ない。',
  en: 'Two next-slide events at the same position while recording, then rec-start at that position: no orphan-audio.',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    NEXT(1, 1, 9600, 2), // 3  g1 = [0,9600)
    NEXT(2, 1, 9600, 3), // 4  開いているテイクはない。同じ位置
    RS(3, 2, 1, 9600), // 5  同じ位置 → どちらの next-slide も 1 件も出ない
    DUR(1, 14400), // 6
    OK(3, 1, 19200), // 7  → g2 = [9600,19200)
    DUR(1, 19200), // 8
    PAUSE(1, 19200), // 9
    NEXT(4, 1, 19200, 1), // 10 停止中。c0004 は空
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 2, 3, 1, 9600, 19200, 'kept', 1)],
    takes: [T(1, 1, 1, 3, [1], 9600, true), T(2, 3, 5, 10, [2], 9600, true)],
    defaultTakes: DT([
      [1, 1],
      [3, 2],
    ]),
    recoverable: REC(19200, 1, 19200, 'c0004'),
  },
});

add({
  name: 'render-clamp-empty',
  ja: '録音ファイルの長さを超えて空になる区間（描画では取り除く）と、その前後が連続になる区間：描画ではフェードがかからず、録音ファイルの先頭 48000 サンプルと同じになる。',
  en: 'A segment beyond the raw file length becomes empty (dropped when rendering) and its neighbours become continuous: no fade, the output equals the raw file.',
  rawFiles: [48000],
  durableSamples: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 15000), // 2
    OK(1, 1, 30000), // 3  → g1 = [0,30000)
    PAUSE(1, 30000), // 4
    RESUME(1, 60000), // 5  録音ファイルの長さ 48000 を超える → beyond-raw-length。空の断片を置き換える
    OK(2, 1, 62000), // 6  → g2 = [60000,62000)。beyond-raw-length
    PAUSE(1, 62000), // 7  beyond-raw-length
    RESUME(1, 30000), // 8  位置が戻る（描画の試験のための作り物）。空の断片を置き換える
    DUR(1, 40000), // 9
    OK(3, 1, 48000), // 10 → g3 = [30000,48000)
    DUR(1, 48000), // 11
    PAUSE(1, 48000), // 12
    NEXT(4, 1, 48000, 2), // 13 c0004 は空
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 30000, 'kept', 1), G(2, 1, 1, 1, 60000, 62000, 'kept', 2), G(3, 1, 1, 1, 30000, 48000, 'kept', 3)],
    takes: [T(1, 1, 1, 13, [1, 2, 3], 50000, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(48000, 1, 48000, 'c0004'),
    issues: [
      I('beyond-raw-length', 5, 'sample 60000 is beyond rec-000001 length 48000'),
      I('beyond-raw-length', 6, 'sample 62000 is beyond rec-000001 length 48000'),
      I('beyond-raw-length', 7, 'sample 62000 is beyond rec-000001 length 48000'),
    ],
  },
});

add({
  name: 'bad-event-retake',
  ja: 'toCheckpoint のキーがない retake：bad-event を出して無視する（テイクの最初まで戻るのは、明示的な null のときだけ）。',
  en: 'A retake without a toCheckpoint key: bad-event, ignored (only an explicit null goes back to the start of the take).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    OK(1, 1, 9600), // 2  → g1 = [0,9600)
    DUR(1, 14400), // 3
    ['retake', {}, [1, 19200]], // 4  toCheckpoint のキーがない → bad-event。無視する
    DUR(1, 24000), // 5
    OK(2, 1, 28800), // 6  → g2 = [9600,28800)
    DUR(1, 28800), // 7
    PAUSE(1, 28800), // 8
    NEXT(3, 1, 28800, 2), // 9
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 9600, 'kept', 1), G(2, 1, 1, 1, 9600, 28800, 'kept', 2)],
    takes: [T(1, 1, 1, 9, [1, 2], 28800, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(28800, 1, 28800, 'c0003'),
    issues: [I('bad-event', 4, 'retake has no toCheckpoint key')],
  },
});

add({
  name: 'bad-event-id',
  ja: 'eventId が e<seq> と違うイベント：bad-event を出して無視する（この ok は存在しないものとして扱う）。',
  en: 'An event whose eventId differs from e<seq>: bad-event, ignored (this ok does not exist).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2
    ['ok', { checkpointId: 'c0001', eventId: 'e99' }, [1, 9600]], // 3  eventId が e3 でない → bad-event。無視する
    DUR(1, 14400), // 4
    OK(2, 1, 19200), // 5  → g1 = [0,19200)
    DUR(1, 19200), // 6
    PAUSE(1, 19200), // 7
    NEXT(3, 1, 19200, 2), // 8
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 19200, 'kept', 1)],
    takes: [T(1, 1, 1, 8, [1], 19200, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(19200, 1, 19200, 'c0003'),
    issues: [I('bad-event', 3, 'eventId e99 does not match e3')],
  },
});

add({
  name: 'recovered-multi-piece',
  ja: 'recovered で複数の断片を切り詰める：復旧できた位置より手前の断片は切り、位置より後ろにある断片は長さ 0 になるので捨てる。',
  en: 'recovered truncates several pieces: a piece that crosses the recovered position is cut; a piece that starts after it becomes empty and is dropped.',
  rawFiles: [48000],
  durableSamples: [12000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 9600), // 2
    PAUSE(1, 14400), // 3  断片 [0,14400)
    RESUME(1, 14400), // 4  断片 [14400,14400)
    DUR(1, 24000), // 5  断片 [14400,24000)
    RECOVERED(null, 1, 12000, 'recovered; only up to 12000 survived'), // 6  [0,14400) → [0,12000)、[14400,24000) は空になって捨てる
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 12000, 'uncommitted', null, 'uncommitted-after-recovery')],
    takes: [T(1, 1, 1, 6, [], 0, false)],
    defaultTakes: {},
    recoverable: REC(24000, 1, 24000, null),
  },
});

add({
  name: 'recovered-multi-file',
  ja: 'recovered で、復旧できた位置より後ろの録音ファイルの断片を捨てる。',
  en: 'recovered drops pieces in raw files after the recovered position.',
  rawFiles: [48000, 48000],
  durableSamples: [30000, 0],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 24000), // 2
    ROT(1, 2, 48000), // 3  断片 [rec-1 0,48000)、[rec-2 0,0)
    DUR(2, 9600), // 4  [rec-2 0,9600)
    RECOVERED(null, 1, 30000, 'recovered; rec-000002 is lost'), // 5  rec-2 の断片は捨てる。rec-1 の断片は [0,30000)
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 30000, 'uncommitted', null, 'uncommitted-after-recovery')],
    takes: [T(1, 1, 1, 5, [], 0, false)],
    defaultTakes: {},
    recoverable: REC(57600, 2, 9600, null),
  },
});

add({
  name: 'resume-while-recording',
  ja: '録音中の resume：recording が真でも、待ち行列に新しい断片を足す（前の断片は伸ばさない）。',
  en: 'resume while recording: a new piece is added to the queue (the previous piece is not extended).',
  rawFiles: [48000],
  events: [
    SS(), // 0
    RS(1, 1, 1, 0), // 1
    DUR(1, 4800), // 2  断片 [0,4800)
    RESUME(1, 9600), // 3  recording は真。断片 [0,4800)（そのまま）と [9600,9600)
    DUR(1, 14400), // 4  [9600,14400)
    OK(1, 1, 19200), // 5  → g1 = [0,4800)、g2 = [9600,19200)
    DUR(1, 19200), // 6
    PAUSE(1, 19200), // 7
    NEXT(2, 1, 19200, 2), // 8
  ],
  expected: {
    segments: [G(1, 1, 1, 1, 0, 4800, 'kept', 1), G(2, 1, 1, 1, 9600, 19200, 'kept', 2)],
    takes: [T(1, 1, 1, 8, [1, 2], 14400, true)],
    defaultTakes: DT([[1, 1]]),
    recoverable: REC(19200, 1, 19200, 'c0002'),
  },
});
