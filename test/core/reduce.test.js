import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvents } from '../../core/reduce.js';
import { validate } from '../../core/validate.js';
import { RAWS, build, segView, takeView, issueView, deepFreeze } from './helpers/events.js';

const SS = ['session-start', { sessionId: 'sess-0001', projectId: 'proj-001', scriptHash: 'a'.repeat(64), sampleRate: 48000, appVersion: '0.0.0' }];
const run = (list, opts, raws = RAWS) => reduceEvents(build(list, raws), raws, opts);
const forSchema = (r) => { const { state, ...rest } = r; return rest; };

// ---------------------------------------------------------------- 基本の場面

test('基本：OK、撮り直し（OK 点まで）、再開、次のスライド。区間の ID は作った順、順番はテイクの中で 1 から', () => {
  const r = run([
    SS,
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['durable', { at: [1, 48000] }],
    ['ok', { checkpointId: 'c0001', at: [1, 96000] }],
    ['durable', { at: [1, 120000] }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 144000] }],
    ['resume', { at: [1, 144000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 192000] }],
    ['next-slide', { checkpointId: 'c0003', at: [1, 240000], nextSlideId: 's2' }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 96000, 'kept', null, 1],
    ['g00002', 'rec-000001', 96000, 144000, 'discarded', 'retake', null],
    ['g00003', 'rec-000001', 144000, 192000, 'kept', null, 2],
    ['g00004', 'rec-000001', 192000, 240000, 'kept', null, 3],
  ]);
  assert.deepEqual(takeView(r), [['t0001', 's1', 'closed', ['g00001', 'g00003', 'g00004'], 192000, true]]);
  assert.equal(r.takes[0].startSeq, 1);
  assert.equal(r.takes[0].endSeq, 8);
  assert.deepEqual(r.defaultTakes, { s1: 't0001' });
  assert.deepEqual(r.recoverable, { pos: 120000, raw: 'rec-000001', sample: 120000, lastCheckpointId: 'c0003' });
  assert.deepEqual(issueView(r), [['orphan-audio', 8]]);
  assert.equal(r.sessionId, 'sess-0001');
  assert.equal(r.format, 'lap-narrator/segments');
  assert.equal(r.version, 1);
  assert.deepEqual(r.state, { slideId: 's2', takeId: null, recording: true, pending: [], durablePos: 120000 });
  assert.deepEqual(r.segments[0], { segmentId: 'g00001', takeId: 't0001', slideId: 's1', raw: 'rec-000001', start: 0, end: 96000, startSec: 0, endSec: 2, status: 'kept', order: 1 });
  // segments.json としてスキーマに合う
  assert.deepEqual(validate('segments', forSchema(r)), { ok: true, errors: [] });
});

test('空の入力：例外を投げず、空の結果', () => {
  for (const args of [[[], []], [undefined, undefined], [null, null], [[], undefined]]) {
    const r = reduceEvents(...args);
    assert.deepEqual(r.segments, []);
    assert.deepEqual(r.takes, []);
    assert.deepEqual(r.defaultTakes, {});
    assert.equal(r.recoverable, null);
    assert.deepEqual(r.marks, []);
    assert.deepEqual(r.issues, []);
    assert.equal(r.sessionId, null);
    assert.deepEqual(r.state, { slideId: null, takeId: null, recording: false, pending: [], durablePos: null });
  }
  assert.equal(run([SS]).sessionId, 'sess-0001');
  assert.equal(reduceEvents([], [], { sessionId: 'fallback-id' }).sessionId, 'fallback-id');
});

test('同じ入力から同じ出力、入力を書き換えない、順序を入れ替えても同じ', () => {
  const list = [
    SS,
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['durable', { at: [1, 1000] }],
    ['ok', { checkpointId: 'c0001', at: [1, 2000] }],
    ['mark', { at: [1, 2100], note: 'x' }],
    ['ok', { checkpointId: 'c0002', at: [1, 3000] }],
    ['undo', { target: 'e5' }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 4000] }],
    ['resume', { at: [1, 4000] }],
    ['ok', { checkpointId: 'c0003', at: [1, 5000] }],
    ['next-slide', { checkpointId: 'c0004', at: [1, 6000], nextSlideId: 's2' }],
    ['rec-start', { slideId: 's2', takeId: 't0002', at: [2, 0] }],
    ['pause', { reason: 'hidden', at: [2, 900] }],
  ];
  const events = deepFreeze(build(list));
  const raws = deepFreeze(RAWS.map((x) => ({ ...x })));
  const a = reduceEvents(events, raws);
  const b = reduceEvents(events, raws);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  for (let trial = 0; trial < 50; trial++) {
    const sh = [...events];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    assert.equal(JSON.stringify(reduceEvents(sh, raws)), JSON.stringify(a));
  }
  // 録音ファイルの並びを入れ替えても同じ
  assert.equal(JSON.stringify(reduceEvents(events, [...raws].reverse())), JSON.stringify(a));
});

// ---------------------------------------------------------------- 1. 取り消し

test('undo：OK を取り消すと、その OK は無かったことになり、断片は次の OK にまとまる。redo で戻る', () => {
  const base = [
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }], // e1
    ['ok', { checkpointId: 'c0002', at: [1, 3000] }],
  ];
  let r = run([...base, ['undo', { target: 'e1' }], ['pause', { reason: 'user', at: [1, 4000] }]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 3000, 'kept', null, 1],
    ['g00002', 'rec-000001', 3000, 4000, 'discarded', 'abandoned', null],
  ]);
  r = run([...base, ['undo', { target: 'e1' }], ['redo', { target: 'e1' }], ['pause', { reason: 'user', at: [1, 4000] }]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 3000, 'kept', null, 2],
    ['g00003', 'rec-000001', 3000, 4000, 'discarded', 'abandoned', null],
  ]);
  // undo → redo → undo
  r = run([...base, ['undo', { target: 'e1' }], ['redo', { target: 'e1' }], ['undo', { target: 'e1' }]]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 3000, 'kept', null, 1]]);
  assert.deepEqual(r.issues, []);
});

test('undo：撮り直しを取り消すと、撮り直しは無かったことになる', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 2000] }], // e2
    ['undo', { target: 'e2' }],
    ['pause', { reason: 'user', at: [1, 3000] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 3000, 'discarded', 'abandoned', null],
  ]);
  assert.equal(r.state.recording, false);
});

test('undo：撮り直し（全部戻る）を取り消すと、チェックポイントが残る', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['retake', { toCheckpoint: null, at: [1, 1500] }], // e2
    ['undo', { target: 'e2' }],
  ]);
  assert.deepEqual(takeView(r), [['t0001', 's1', 'closed', ['g00001'], 1000, true]]);
});

test('undo：次のスライドと goto を取り消す。取り消した次のスライドの後も、テイクは開いたまま', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }], // e1
    ['undo', { target: 'e1' }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],
  ], { closeAtEnd: false });
  assert.equal(r.state.slideId, 's1');
  assert.equal(r.state.takeId, 't0001');
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 2000, 'kept', null, 1]]);
  assert.deepEqual(r.issues, []); // 取り消した next-slide は orphan-audio を出さない

  r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['pause', { at: [1, 500] }],
    ['goto-slide', { slideId: 's9' }], // e2
    ['undo', { target: 'e2' }],
  ], { closeAtEnd: false });
  assert.equal(r.state.slideId, 's1');
  assert.equal(r.state.takeId, 't0001');
});

test('undo：mark を取り消すと marks に残らない。残るときは {seq, at, note?}', () => {
  const list = [
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['mark', { at: [1, 100], note: '要確認' }],
    ['mark', { at: [1, 200] }],
  ];
  const r = run(list);
  assert.deepEqual(r.marks, [
    { seq: 1, at: { raw: 'rec-000001', sample: 100, pos: 100 }, note: '要確認' },
    { seq: 2, at: { raw: 'rec-000001', sample: 200, pos: 200 } },
  ]);
  assert.deepEqual(run([...list, ['undo', { target: 'e1' }]]).marks.map((m) => m.seq), [2]);
});

test('undo／redo の対象が不正なら bad-undo-target を出して無視する', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],  // e0
    ['undo', { target: 'e0' }],     // e1 rec-start は取り消せない
    ['undo', { target: 'e99' }],    // e2 存在しない
    ['undo', { target: 'e4' }],     // e3 後の操作
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }], // e4
    ['undo', { target: 'e5' }],     // e5 自分自身
    ['undo', { target: 'e3' }],     // e6 undo は取り消せない
    ['redo', { target: 'e4' }],     // e7 redo は対象が有効でも問題ない（何も起きない）
    ['undo', {}],                   // e8 target が無い
  ]);
  assert.deepEqual(issueView(r), [['bad-undo-target', 1], ['bad-undo-target', 2], ['bad-undo-target', 3], ['bad-undo-target', 5], ['bad-undo-target', 6], ['bad-undo-target', 8]]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1]]); // ok は有効なまま
});

// ---------------------------------------------------------------- 3. 各イベントの処理

test('rec-start：開いているテイクを閉じ（OK を押していない断片は破棄・abandoned）、新しいテイクを作る', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['pause', { reason: 'user', at: [1, 1500] }],
    ['rec-start', { slideId: 's1', takeId: 't0002', at: [1, 2000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 3000] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1500, 'discarded', 'abandoned', null],
    ['g00003', 'rec-000001', 2000, 3000, 'kept', null, 1],
  ]);
  assert.deepEqual(r.takes.map((t) => [t.takeId, t.startSeq, t.endSeq, t.candidate]), [['t0001', 0, 3, true], ['t0002', 3, 4, true]]);
  assert.deepEqual(r.defaultTakes, { s1: 't0002' }); // startSeq が最大のもの
});

test('file-rotate：断片が録音ファイルをまたぐ。長さ 0 の断片は捨てる', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 400000] }],
    ['file-rotate', { from: 1, to: 2, at: [1, 480000], toAt: [2, 0] }],
    ['ok', { checkpointId: 'c0001', at: [2, 50000] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 400000, 480000, 'kept', null, 1],
    ['g00002', 'rec-000002', 0, 50000, 'kept', null, 2],
  ]);
  assert.equal(r.takes[0].samples, 130000);
  assert.deepEqual(r.issues, []);
  // 切り替えた直後に OK：新しいファイル側の断片は長さ 0 で捨てる
  r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 479000] }],
    ['file-rotate', { from: 1, to: 2, at: [1, 480000], toAt: [2, 0] }],
    ['ok', { checkpointId: 'c0001', at: [2, 0] }],
  ]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 479000, 480000, 'kept', null, 1]]);
});

test('file-rotate をまたぐ OK、2 回の切り替え、OK のあとの切り替え', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 470000] }],
    ['ok', { checkpointId: 'c0001', at: [1, 475000] }],
    ['file-rotate', { from: 1, to: 2, at: [1, 480000], toAt: [2, 0] }],
    ['durable', { at: [2, 30000] }],
    ['file-rotate', { from: 2, to: 3, at: [2, 480000], toAt: [3, 0] }],
    ['ok', { checkpointId: 'c0002', at: [3, 1000] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 470000, 475000, 'kept', null, 1],
    ['g00002', 'rec-000001', 475000, 480000, 'kept', null, 2],
    ['g00003', 'rec-000002', 0, 480000, 'kept', null, 3],
    ['g00004', 'rec-000003', 0, 1000, 'kept', null, 4],
  ]);
  assert.equal(r.takes[0].samples, 5000 + 5000 + 480000 + 1000);
  assert.equal(r.segments[3].endSec, 1000 / 44100);
  assert.deepEqual(r.issues, []);
});

test('durable：録音中なら最後の断片を伸ばす。区間の採用と破棄の状態は変えない。保存位置が進む', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['durable', { at: [1, 48000] }],
    ['durable', { at: [1, 96000] }],
    ['durable', { at: [1, 90000] }], // 遅れて届いた古い位置：伸ばさず、保存位置も戻さない
  ], { closeAtEnd: false });
  assert.deepEqual(r.state.pending, [{ raw: 'rec-000001', start: 0, end: 96000 }]);
  assert.equal(r.state.durablePos, 96000);
  assert.deepEqual(segView(r), []);
  assert.equal(r.takes[0].status, 'open');
  assert.deepEqual(r.recoverable, { pos: 96000, raw: 'rec-000001', sample: 96000, lastCheckpointId: null });
});

test('durable：停止中は断片を伸ばさないが、保存位置は進む', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['pause', { at: [1, 1000] }],
    ['durable', { at: [1, 1200] }],
  ], { closeAtEnd: false });
  assert.deepEqual(r.state.pending, [{ raw: 'rec-000001', start: 0, end: 1000 }]);
  assert.equal(r.state.durablePos, 1200);
});

test('ok：録音中なら新しい空の断片、停止中なら空', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
  ], { closeAtEnd: false });
  assert.deepEqual(r.state.pending, [{ raw: 'rec-000001', start: 1000, end: 1000 }]);
  r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['pause', { at: [1, 800] }],
    ['ok', { checkpointId: 'c0001', at: [1, 800] }],
  ], { closeAtEnd: false });
  assert.deepEqual(r.state.pending, []);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 800, 'kept', null, 1]]);
});

test('ok を続けて押す：長さ 0 の断片は捨てるが、チェックポイントは残る（撮り直しの行き先になる）', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0003', at: [1, 2000] }],
    ['retake', { toCheckpoint: 'c0002', at: [1, 2500] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 2000, 'discarded', 'retake', null],
    ['g00003', 'rec-000001', 2000, 2500, 'discarded', 'retake', null],
  ]);
});

test('隣り合う断片（end == 次の start）は 1 つにまとめない', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],
    ['pause', { at: [1, 2500] }],
    ['resume', { at: [1, 2500] }],
    ['ok', { checkpointId: 'c0003', at: [1, 3000] }],
  ]);
  assert.deepEqual(segView(r).map((s) => s.slice(2, 4)), [[0, 1000], [1000, 2000], [2000, 2500], [2500, 3000]]);
});

test('pause と resume：一時停止中の音は断片に入らない。二重の pause は停止中の音を取り込まない', () => {
  for (const extra of [[], [['pause', { reason: 'mute', at: [1, 3000] }]]]) {
    const r = run([
      ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
      ['pause', { reason: 'hidden', at: [1, 1000] }],
      ...extra,
      ['resume', { at: [1, 5000] }],
      ['ok', { checkpointId: 'c0001', at: [1, 6000] }],
    ]);
    assert.deepEqual(segView(r), [
      ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
      ['g00002', 'rec-000001', 5000, 6000, 'kept', null, 2],
    ]);
    assert.equal(r.takes[0].samples, 2000);
  }
});

test('resume：前の断片が空なら置き換える', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['pause', { at: [1, 1000] }],
    ['resume', { at: [1, 1200] }],
  ], { closeAtEnd: false });
  assert.deepEqual(r.state.pending, [{ raw: 'rec-000001', start: 1200, end: 1200 }]);
  assert.equal(r.state.recording, true);
});

test('resume：別の録音ファイルから再開できる', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['pause', { at: [1, 1000] }],
    ['resume', { at: [2, 0] }],
    ['ok', { checkpointId: 'c0001', at: [2, 700] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000002', 0, 700, 'kept', null, 2],
  ]);
});

test('retake：最後の OK 点まで戻る。続けて押すと、さらに前の OK 点へ戻る', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],
    ['ok', { checkpointId: 'c0003', at: [1, 3000] }],
    ['retake', { toCheckpoint: 'c0002', at: [1, 3500] }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 3500] }],
    ['resume', { at: [1, 4000] }],
    ['ok', { checkpointId: 'c0004', at: [1, 5000] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 2000, 'discarded', 'retake', null],
    ['g00003', 'rec-000001', 2000, 3000, 'discarded', 'retake', null],
    ['g00004', 'rec-000001', 3000, 3500, 'discarded', 'retake', null],
    ['g00005', 'rec-000001', 4000, 5000, 'kept', null, 2],
  ]);
  assert.deepEqual(r.takes[0].segments, ['g00001', 'g00005']);
  assert.equal(r.takes[0].samples, 2000);
});

test('retake：null はテイクの最初まで戻る（すべて破棄）。採用が無いテイクは候補にならない', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],
    ['retake', { toCheckpoint: null, at: [1, 2500] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'discarded', 'retake', null],
    ['g00002', 'rec-000001', 1000, 2000, 'discarded', 'retake', null],
    ['g00003', 'rec-000001', 2000, 2500, 'discarded', 'retake', null],
  ]);
  assert.deepEqual(takeView(r), [['t0001', 's1', 'closed', [], 0, false]]);
  assert.deepEqual(r.defaultTakes, {});
});

test('retake：停止中でも働く。戻り先が見つからないときは、待ち行列だけを捨てる', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['pause', { at: [1, 1500] }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 1500] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1500, 'discarded', 'retake', null],
  ]);
  // c0005 は無い：待ち行列だけを捨て、チェックポイントは取り除かない（7.1 の 9）
  r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0007', at: [1, 2000] }],
    ['retake', { toCheckpoint: 'c0005', at: [1, 2200] }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 2000, 'kept', null, 2],
    ['g00003', 'rec-000001', 2000, 2200, 'discarded', 'retake', null],
  ]);
});

test('retake：テイクが無いとき（次のスライドのあと）は何も破棄せず、停止するだけ', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 1200] }],
  ]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1]]);
  assert.equal(r.state.recording, false);
});

test('next-slide：OK と同じ処理をしてテイクを閉じる。録音中なら orphan-audio、停止中なら出ない', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],   // テイクが無い：無視
    ['rec-start', { slideId: 's2', takeId: 't0002', at: [1, 3000] }],
    ['pause', { at: [1, 3500] }],
    ['next-slide', { checkpointId: 'c0003', at: [1, 3500], nextSlideId: 's3' }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 3000, 3500, 'kept', null, 1],
  ]);
  assert.deepEqual(issueView(r), [['orphan-audio', 1]]);
  assert.equal(r.state.slideId, 's3');
  assert.deepEqual(r.takes.map((t) => [t.takeId, t.status, t.endSeq]), [['t0001', 'closed', 1], ['t0002', 'closed', 5]]);
});

test('goto-slide：テイクを閉じ、スライドを変える。録音中なら goto-while-recording', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['goto-slide', { slideId: 's5' }],
  ]);
  assert.deepEqual(issueView(r), [['goto-while-recording', 2]]);
  assert.equal(r.state.slideId, 's5');
  assert.equal(r.takes[0].status, 'closed');
  assert.equal(r.takes[0].endSeq, 2);
  r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['pause', { at: [1, 1200] }],
    ['goto-slide', { slideId: 's5' }],
  ]);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1200, 'discarded', 'abandoned', null],
  ]);
});

test('recovered：未確定（uncommitted）のまま残る。切り詰め、最後の OK は採用のまま', () => {
  const r = run([
    SS,
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['durable', { at: [1, 1800] }],
    ['recovered', { at: [1, 1700], lastCheckpointId: 'c0001', notes: '' }],
  ]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1700, 'uncommitted', 'uncommitted-after-recovery', null],
  ]);
  assert.deepEqual(takeView(r), [['t0001', 's1', 'closed', ['g00001'], 1000, true]]);
  assert.deepEqual(r.recoverable, { pos: 1800, raw: 'rec-000001', sample: 1800, lastCheckpointId: 'c0001' });
  assert.equal(r.state.recording, false);
});

test('recovered：復旧できた位置が記録より先でも伸ばさない（縮めるだけ）。復旧できた位置より後の録音ファイルの断片は捨てる', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['durable', { at: [1, 1000] }],
    ['recovered', { at: [1, 2500] }],
  ]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'uncommitted', 'uncommitted-after-recovery', null]]);
  r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 470000] }],
    ['file-rotate', { from: 1, to: 2, at: [1, 480000], toAt: [2, 0] }],
    ['durable', { at: [2, 10] }],
    ['recovered', { at: [1, 478000] }], // 切り替えの記録が先走った：復旧できたのは rec-000001 の途中まで
  ]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 470000, 478000, 'uncommitted', 'uncommitted-after-recovery', null]]);
});

test('recovered のあと：本人が OK にすれば採用（kept）、撮り直せば retake、新しいテイクを始めれば uncommitted', () => {
  const head = [
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['durable', { at: [1, 1700] }],
    ['recovered', { at: [1, 1700], lastCheckpointId: 'c0001' }],
  ];
  let r = run([...head, ['ok', { checkpointId: 'c0002', at: [1, 1700] }]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1700, 'kept', null, 2],
  ]);
  r = run([...head, ['retake', { toCheckpoint: 'c0001', at: [1, 1700] }]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1700, 'discarded', 'retake', null],
  ]);
  r = run([...head, ['rec-start', { slideId: 's1', takeId: 't0002', at: [2, 0] }], ['ok', { checkpointId: 'c0002', at: [2, 500] }]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1700, 'uncommitted', 'uncommitted-after-recovery', null],
    ['g00003', 'rec-000002', 0, 500, 'kept', null, 1],
  ]);
});

test('一度も OK を押さずに強制終了：recovered があれば uncommitted、無ければ abandoned。復旧の位置は保存位置', () => {
  const head = [
    SS,
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['durable', { at: [1, 48000] }],
    ['durable', { at: [1, 96000] }],
  ];
  let r = run(head);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 96000, 'discarded', 'abandoned', null]]);
  assert.deepEqual(r.recoverable, { pos: 96000, raw: 'rec-000001', sample: 96000, lastCheckpointId: null });
  assert.deepEqual(r.defaultTakes, {});
  r = run([...head, ['recovered', { at: [1, 96000], lastCheckpointId: null }]]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 96000, 'uncommitted', 'uncommitted-after-recovery', null]]);
  assert.deepEqual(takeView(r), [['t0001', 's1', 'closed', [], 0, false]]);
  assert.deepEqual(r.recoverable, { pos: 96000, raw: 'rec-000001', sample: 96000, lastCheckpointId: null });
});

test('mark、test-rec、export は区間に影響しない', () => {
  const core = [
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
  ];
  const noisy = [
    ['test-rec', { durationMs: 10000 }],
    core[0],
    ['mark', { at: [1, 500], note: 'x' }],
    ['export', { exportId: 'exp-0001', kind: 'full', volumes: 1 }],
    core[1],
    ['test-rec', { durationMs: 10000 }],
  ];
  assert.deepEqual(segView(run(noisy)), segView(run(core)));
  assert.equal(run(noisy).marks.length, 1);
});

// ---------------------------------------------------------------- 9. 復旧の表示用

test('recoverable：durable が無ければ最後の ok の位置。どちらも無ければ null', () => {
  let r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [2, 300] }],
  ]);
  assert.deepEqual(r.recoverable, { pos: 480300, raw: 'rec-000002', sample: 300, lastCheckpointId: 'c0002' });
  r = run([['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }]]);
  assert.equal(r.recoverable, null);
  assert.equal(run([SS]).recoverable, null);
});

test('recoverable：取り消した ok は数えない。撮り直しで取り除かれたチェックポイントは lastCheckpointId にならない', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],
    ['undo', { target: 'e2' }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 2500] }],
    ['durable', { at: [1, 2500] }],
  ]);
  assert.deepEqual(r.recoverable, { pos: 2500, raw: 'rec-000001', sample: 2500, lastCheckpointId: 'c0001' });
});

// ---------------------------------------------------------------- 5〜8. 終わり、テイク、既定の採用

test('記録の終わりに開いているテイクは閉じる。closeAtEnd:false なら開いたまま', () => {
  const list = [
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['durable', { at: [1, 1500] }],
  ];
  let r = run(list);
  assert.deepEqual(r.takes.map((t) => [t.status, t.endSeq, t.candidate]), [['closed', 2, true]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 1000, 1500, 'discarded', 'abandoned', null],
  ]);
  r = run(list, { closeAtEnd: false });
  assert.deepEqual(r.takes.map((t) => [t.status, t.endSeq, t.candidate]), [['open', null, false]]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1]]);
  assert.deepEqual(r.state.pending, [{ raw: 'rec-000001', start: 1000, end: 1500 }]);
  assert.deepEqual(r.defaultTakes, {});
});

test('既定の採用：候補のうち startSeq が最大。候補でない（採用が無い）テイクは選ばれない', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 100] }],
    ['rec-start', { slideId: 's2', takeId: 't0002', at: [1, 200] }],
    ['ok', { checkpointId: 'c0002', at: [1, 300] }],
    ['rec-start', { slideId: 's1', takeId: 't0003', at: [1, 400] }],
    ['ok', { checkpointId: 'c0003', at: [1, 500] }],
    ['rec-start', { slideId: 's1', takeId: 't0004', at: [1, 600] }],
    ['pause', { at: [1, 700] }],  // OK 無し：採用が無い
    ['rec-start', { slideId: 's3', takeId: 't0005', at: [1, 800] }],
    ['pause', { at: [1, 900] }],
  ]);
  assert.deepEqual(r.takes.map((t) => [t.takeId, t.candidate]), [['t0001', true], ['t0002', true], ['t0003', true], ['t0004', false], ['t0005', false]]);
  assert.deepEqual(r.defaultTakes, { s1: 't0003', s2: 't0002' });
});

test('区間：録音ファイルの周波数から秒を求める（44.1kHz）', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [3, 0] }],
    ['ok', { checkpointId: 'c0001', at: [3, 44100] }],
  ]);
  assert.equal(r.segments[0].startSec, 0);
  assert.equal(r.segments[0].endSec, 1);
});

test('録音ファイルの名前は拡張子やディレクトリが付いていてもよい', () => {
  const raws = RAWS.map((x) => ({ ...x, name: `raw/${x.name}.wav` }));
  const events = build([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [2, 0] }],
    ['ok', { checkpointId: 'c0001', at: [2, 1000] }],
  ]);
  const r = reduceEvents(events, raws);
  assert.deepEqual(segView(r), [['g00001', 'rec-000002', 0, 1000, 'kept', null, 1]]);
  assert.deepEqual(r.issues, []);
});

// ---------------------------------------------------------------- 10. 問題の報告

test('unknown-raw、beyond-raw-length、position-mismatch：出して続ける', () => {
  const list = [
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: { raw: 'rec-000009', sample: 10, pos: 10 } }],    // 知らない録音ファイル
    ['durable', { at: [3, 200000] }],                                                     // rec-000003 は 100000 サンプル
    ['durable', { at: { raw: 'rec-000001', sample: 100, pos: 101 } }],                    // pos が合わない
    ['mark', { at: { raw: 'rec-000002', sample: 5, pos: 480005 } }],                      // 正しい
  ];
  const r = run(list);
  assert.deepEqual(issueView(r), [['unknown-raw', 1], ['beyond-raw-length', 2], ['position-mismatch', 3]]);
  for (const i of r.issues) { assert.equal(typeof i.message, 'string'); assert.ok(i.message.length > 0); }
  assert.equal(r.takes.length, 1); // 解釈は続く
});

test('seq-gap：欠けた番号と、重複した番号', () => {
  const events = build([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 1000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 2000] }],
    ['ok', { checkpointId: 'c0003', at: [1, 3000] }],
  ]);
  // seq 2 を抜く
  let r = reduceEvents(events.filter((e) => e.seq !== 2), RAWS);
  assert.deepEqual(issueView(r), [['seq-gap', 3]]);
  // 先頭が 0 でない
  r = reduceEvents(events.slice(1), RAWS);
  assert.deepEqual(issueView(r), [['seq-gap', 1]]);
  // 重複：先のものを使う
  const dup = [...events, { ...events[3], type: 'pause', at: events[3].at }];
  r = reduceEvents(dup, RAWS);
  assert.deepEqual(issueView(r), [['seq-gap', 3]]);
  assert.equal(r.segments.length, 3);
  // 連続していれば出ない
  assert.deepEqual(reduceEvents(events, RAWS).issues, []);
});

test('必須の位置が無い操作は無視して position-mismatch を出す（例外にしない）', () => {
  const events = build([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001' }],
    ['ok', { checkpointId: 'c0002', at: [1, 1000] }],
    ['rec-start', { slideId: 's1' }],
    ['frobnicate', {}],
    ['retake', { toCheckpoint: 'c0001', at: 'nonsense' }],
  ]);
  const r = reduceEvents(events, RAWS);
  assert.deepEqual(issueView(r), [['position-mismatch', 1], ['position-mismatch', 3], ['position-mismatch', 5]]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1]]);
});

test('問題は seq の順に並ぶ', () => {
  const r = run([
    ['rec-start', { slideId: 's1', takeId: 't0001', at: [1, 0] }],
    ['undo', { target: 'e99' }],
    ['ok', { checkpointId: 'c0001', at: { raw: 'rec-000009', sample: 1, pos: 1 } }],
    ['goto-slide', { slideId: 's2' }],
    ['undo', { target: 'e0' }],
  ]);
  assert.deepEqual(issueView(r), [['bad-undo-target', 1], ['unknown-raw', 2], ['goto-while-recording', 3], ['bad-undo-target', 4]]);
});

// ---------------------------------------------------------------- 規模

test('大きな記録（6 万件）でも速く、結果が正しい', () => {
  const list = [SS];
  let pos = 0;
  const raws = [{ name: 'rec-000001', sampleRate: 48000, samples: 1_000_000_000 }];
  let take = 0;
  for (let s = 0; s < 300; s++) {
    take++;
    list.push(['rec-start', { slideId: `s${s}`, takeId: `t${String(take).padStart(4, '0')}`, at: { raw: 'rec-000001', sample: pos, pos } }]);
    for (let k = 0; k < 100; k++) {
      pos += 480;
      list.push(['durable', { at: { raw: 'rec-000001', sample: pos, pos } }]);
      pos += 480;
      list.push(['ok', { checkpointId: `c${String(s * 100 + k + 1).padStart(4, '0')}`, at: { raw: 'rec-000001', sample: pos, pos } }]);
    }
    list.push(['next-slide', { checkpointId: `c${String(s * 100 + 101).padStart(4, '0')}`, at: { raw: 'rec-000001', sample: pos, pos }, nextSlideId: `s${s + 1}` }]);
  }
  const events = build(list, raws);
  const t0 = Date.now();
  const r = reduceEvents(events, raws);
  const ms = Date.now() - t0;
  assert.ok(events.length > 60000);
  assert.ok(ms < 3000, `${ms}ms`);
  assert.equal(r.takes.length, 300);
  assert.equal(r.takes[0].segments.length, 100);
  assert.equal(r.takes[299].samples, 100 * 960);
  assert.equal(Object.keys(r.defaultTakes).length, 300);
});
