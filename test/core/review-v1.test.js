import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvents } from '../../core/reduce.js';
import { ISSUE_CODES } from '../../core/constants.js';
import { validate } from '../../core/validate.js';
import { planRender } from '../../core/render.js';
import { receiveVolume, ImportError } from '../../core/importer.js';
import { sha256Hex } from '../../core/sha256.js';
import { RAWS, build, segView, issueView } from './helpers/events.js';
import { createMemStore } from './helpers/memstore.js';
import { zipOf, json, makeSession, exportFull, asVolume } from './helpers/exports.js';
import { sampleManifest, sampleEvent, sampleSegments } from './helpers/samples.js';

// 検査役 V1 を受けた裁定（CONTRACTS.md 7.7）に対する試験
const run = (list, opts) => reduceEvents(build(list, RAWS), RAWS, opts);
const rs = (slideId, takeId, n, s) => ['rec-start', { slideId, takeId, at: [n, s] }];

test('ISSUE_CODES に bad-event がある', () => assert.ok(ISSUE_CODES.includes('bad-event')));

// ---- 7.7 の 1, 2：recovered
test('recovered：同じ録音ファイルの断片をすべて min(終わり, at.sample) に切り詰め、長さ 0 は捨て、後ろの録音ファイルの断片は捨て、前は変えない', () => {
  const r = run([
    rs('s1', 't0001', 1, 100),
    ['pause', { at: [1, 200] }],
    ['resume', { at: [1, 300] }],
    ['pause', { at: [1, 400] }],
    ['resume', { at: [1, 500] }],
    ['file-rotate', { from: 1, to: 2, at: [1, 600], toAt: [2, 0] }],
    ['durable', { at: [2, 50] }],
    ['recovered', { at: [1, 350] }],
  ]);
  // 断片 [100,200) [300,400) [500,600) rec-2:[0,50) → at = rec-1:350 → [100,200) [300,350)、残りは捨てる
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 100, 200, 'uncommitted', 'uncommitted-after-recovery', null],
    ['g00002', 'rec-000001', 300, 350, 'uncommitted', 'uncommitted-after-recovery', null],
  ]);
  // 切り詰めて長さ 0 になる断片は捨てる
  const r2 = run([rs('s1', 't0001', 1, 100), ['pause', { at: [1, 200] }], ['resume', { at: [1, 300] }], ['pause', { at: [1, 400] }], ['recovered', { at: [1, 300] }]]);
  assert.deepEqual(segView(r2), [['g00001', 'rec-000001', 100, 200, 'uncommitted', 'uncommitted-after-recovery', null]]);
  // 前の録音ファイルの断片は変えない
  const r3 = run([rs('s1', 't0001', 1, 470000), ['file-rotate', { from: 1, to: 2, at: [1, 480000], toAt: [2, 0] }], ['durable', { at: [2, 900] }], ['recovered', { at: [2, 500] }]]);
  assert.deepEqual(segView(r3), [
    ['g00001', 'rec-000001', 470000, 480000, 'uncommitted', 'uncommitted-after-recovery', null],
    ['g00002', 'rec-000002', 0, 500, 'uncommitted', 'uncommitted-after-recovery', null],
  ]);
});

test('recovered：at と断片の録音ファイルが違っても position-mismatch を出さない。recovered 自身の at の不整合は出す', () => {
  const r = run([rs('s1', 't0001', 2, 100), ['recovered', { at: [1, 300] }]]);
  assert.deepEqual(r.issues, []);
  const bad = build([rs('s1', 't0001', 1, 0), ['recovered', { at: [1, 300] }]], RAWS);
  bad[1].at.pos = 301;
  assert.deepEqual(issueView(reduceEvents(bad, RAWS)), [['position-mismatch', 1]]);
});

// ---- 7.7 の 3：resume
test('resume：録音中でも新しい断片を足し、前の断片を伸ばさない', () => {
  const r = run([rs('s1', 't0001', 1, 0), ['durable', { at: [1, 1000] }], ['resume', { at: [1, 5000] }], ['ok', { checkpointId: 'c0001', at: [1, 6000] }]]);
  assert.deepEqual(segView(r), [
    ['g00001', 'rec-000001', 0, 1000, 'kept', null, 1],
    ['g00002', 'rec-000001', 5000, 6000, 'kept', null, 2],
  ]);
  // 前の断片が空なら置き換える
  const r2 = run([rs('s1', 't0001', 1, 0), ['resume', { at: [1, 700] }], ['ok', { checkpointId: 'c0001', at: [1, 900] }]]);
  assert.deepEqual(segView(r2), [['g00001', 'rec-000001', 700, 900, 'kept', null, 1]]);
});

// ---- 7.7 の 5：orphan-audio は next-slide ごと
test('orphan-audio：連続した 2 つの next-slide に音が挟まれば 2 件（それぞれの next-slide の seq）', () => {
  const r = run([
    rs('s1', 't0001', 1, 0),
    ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }], // seq 1
    ['next-slide', { checkpointId: 'c0002', at: [1, 2000], nextSlideId: 's3' }], // seq 2（テイクは無い）
    ['pause', { at: [1, 3000] }],
  ]);
  assert.deepEqual(issueView(r), [['orphan-audio', 1], ['orphan-audio', 2]]);
});

test('orphan-audio：next-slide は「状態を変えるイベント」に数えない。位置が同じなら出ない。goto-slide が次なら出ない。最後まで録音中なら出る', () => {
  // 1 つ目の next-slide と 2 つ目の間に音は無く、次の rec-start は 2 つ目と同じ位置 → 1 つ目は pos 1000 < 2000 で出る
  let r = run([rs('s1', 't0001', 1, 0), ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }], ['next-slide', { checkpointId: 'c0002', at: [1, 2000], nextSlideId: 's3' }], rs('s3', 't0002', 1, 2000)]);
  assert.deepEqual(issueView(r), [['orphan-audio', 1]]);
  r = run([rs('s1', 't0001', 1, 0), ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }], rs('s2', 't0002', 1, 1000)]);
  assert.deepEqual(r.issues, []);
  r = run([rs('s1', 't0001', 1, 0), ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }], ['goto-slide', { slideId: 's5' }]]);
  assert.deepEqual(issueView(r), [['goto-while-recording', 2]]); // orphan-audio は出ない
  r = run([rs('s1', 't0001', 1, 0), ['next-slide', { checkpointId: 'c0001', at: [1, 1000], nextSlideId: 's2' }], ['next-slide', { checkpointId: 'c0002', at: [1, 1000], nextSlideId: 's3' }]]);
  assert.deepEqual(issueView(r), [['orphan-audio', 1], ['orphan-audio', 2]]);
  // 停止中の next-slide は出ない
  r = run([rs('s1', 't0001', 1, 0), ['pause', { at: [1, 500] }], ['next-slide', { checkpointId: 'c0001', at: [1, 500], nextSlideId: 's2' }], ['pause', { at: [1, 900] }]]);
  assert.deepEqual(r.issues, []);
});

// ---- 7.7 の 7：bad-event
test('bad-event：retake に toCheckpoint のキーが無ければ無視する。明示的な null のときだけテイクの最初まで戻る', () => {
  const list = [rs('s1', 't0001', 1, 0), ['ok', { checkpointId: 'c0001', at: [1, 1000] }], ['retake', { at: [1, 1500] }], ['pause', { at: [1, 1600] }]];
  let r = run(list);
  assert.deepEqual(issueView(r), [['bad-event', 2]]);
  // retake は無かったことになる：pending は pause まで伸び、閉じるとき abandoned
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1], ['g00002', 'rec-000001', 1000, 1600, 'discarded', 'abandoned', null]]);
  assert.equal(r.takes[0].endSeq, 3); // 無視したイベントは数えない
  list[2][1].toCheckpoint = null;
  r = run(list);
  assert.deepEqual(r.issues, []);
  assert.equal(r.segments[0].status, 'discarded');
  // 型が違う toCheckpoint も無視
  list[2][1].toCheckpoint = 7;
  assert.deepEqual(issueView(run(list)), [['bad-event', 2]]);
});

test('bad-event：eventId が e<seq> と違う、eventId が無い、seq が整数でないイベントは無視する', () => {
  const events = build([rs('s1', 't0001', 1, 0), ['ok', { checkpointId: 'c0001', at: [1, 1000] }], ['ok', { checkpointId: 'c0002', at: [1, 2000] }], ['ok', { checkpointId: 'c0003', at: [1, 3000] }]], RAWS);
  events[2].eventId = 'e99';
  delete events[3].eventId;
  const r = reduceEvents([...events, { ...events[1], seq: 1.5, eventId: 'e1.5' }, { ...events[1], seq: 'x' }], RAWS);
  assert.deepEqual(issueView(r).sort(), [['bad-event', 1.5], ['bad-event', 2], ['bad-event', 3], ['bad-event', undefined]].sort());
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1]]);
  assert.ok(!r.issues.some((i) => i.code === 'seq-gap'), '無視したイベントも seq の連なりには数える');
});

test('bad-event：eventId が合わないイベントは undo の対象にできない（bad-undo-target）', () => {
  const events = build([rs('s1', 't0001', 1, 0), ['ok', { checkpointId: 'c0001', at: [1, 1000] }], ['undo', { target: 'e1' }]], RAWS);
  events[1].eventId = 'e9';
  const r = reduceEvents(events, RAWS);
  assert.deepEqual(issueView(r).sort(), [['bad-event', 1], ['bad-undo-target', 2]].sort());
});

// ---- 7.7 の 4：未来を指す undo／redo
test('未来のイベントを指す undo と redo は bad-undo-target（seq 以上）で、無視する', () => {
  const r = run([rs('s1', 't0001', 1, 0), ['undo', { target: 'e2' }], ['redo', { target: 'e3' }], ['ok', { checkpointId: 'c0001', at: [1, 1000] }]]);
  assert.deepEqual(issueView(r), [['bad-undo-target', 1], ['bad-undo-target', 2]]);
  assert.deepEqual(segView(r), [['g00001', 'rec-000001', 0, 1000, 'kept', null, 1]]);
});

// ---- 7.7 の 6：録音ファイルの長さを超える区間
test('録音ファイルの長さを超える区間は切ってから処理し、空になる区間は取り除く（取り除いた区間の前後にフェードはかからない）', () => {
  const seg = (start, end, order) => ({ segmentId: `g${order}`, takeId: 't0001', slideId: 's1', raw: 'rec-000001', start, end, status: 'kept', order });
  const p = planRender({
    segments: [seg(1000, 2000, 1), seg(70000, 71000, 2), seg(5000, 99999, 3)],
    rawRates: { 'rec-000001': 48000 }, rawLengths: { 'rec-000001': 60000 },
  });
  assert.deepEqual(p.pieces.map((x) => [x.start, x.end, x.fadeIn, x.fadeOut]), [[1000, 2000, 0, 384], [5000, 60000, 384, 0]]);
  // 切ったあとで連続になる場合はフェードなし
  const q = planRender({ segments: [seg(1000, 60000, 1), seg(60000, 61000, 2)], rawRates: { 'rec-000001': 48000 }, rawLengths: { 'rec-000001': 60000 } });
  assert.deepEqual(q.pieces.map((x) => [x.start, x.end, x.fadeIn, x.fadeOut]), [[1000, 60000, 0, 0]]);
  const q2 = planRender({ segments: [seg(1000, 50000, 1), seg(50000, 60000, 2), seg(60000, 61000, 3)], rawRates: { 'rec-000001': 48000 }, rawLengths: { 'rec-000001': 60000 } });
  assert.deepEqual(q2.pieces.map((x) => [x.start, x.end, x.fadeIn, x.fadeOut]), [[1000, 50000, 0, 0], [50000, 60000, 0, 0]]);
});

// ---- 7.6 の 9：ImportError の detail.reason
test("ImportError('bad-volume') の detail.reason：読めない形は unreadable、大きさ・SHA-256 の不一致は hash-mismatch", async () => {
  const store = createMemStore();
  const vol = (bytes) => ({ name: 'x.zip', size: bytes.length, read: async (s, e) => bytes.slice(s, e) });
  const reasonOf = async (bytes) => {
    try { await receiveVolume(store, vol(bytes)); } catch (e) { assert.ok(e instanceof ImportError); assert.equal(e.code, 'bad-volume'); return e.detail && e.detail.reason; }
    throw new Error('rejected expected');
  };
  assert.equal(await reasonOf(new Uint8Array(10)), 'unreadable');
  assert.equal(await reasonOf(await zipOf([['a.txt', new Uint8Array(1)]])), 'unreadable'); // manifest が無い
  assert.equal(await reasonOf(await zipOf([['manifest.json', new TextEncoder().encode('{bad')]])), 'unreadable');
  const data = new TextEncoder().encode('hello');
  const m = { format: 'lap-narrator/manifest', version: 1, kind: 'full', projectId: 'proj-001', scriptHash: 'a'.repeat(64), sessionId: 'sess-0001', exportId: 'exp-r-01', volume: 1, volumes: 1, appVersion: '0', files: [{ path: 'a.txt', bytes: 5, sha256: '0'.repeat(64) }], createdAt: 'x' };
  assert.equal(await reasonOf(await zipOf([['a.txt', data], ['manifest.json', json(m)]])), 'hash-mismatch');
  m.files[0].sha256 = sha256Hex(data);
  m.files[0].bytes = 6;
  assert.equal(await reasonOf(await zipOf([['a.txt', data], ['manifest.json', json(m)]])), 'hash-mismatch');
  // 索引と ZIP 全体のハッシュが合わない
  const full = await exportFull(makeSession());
  const wrong = JSON.parse(JSON.stringify(full.index));
  wrong.zips[0].sha256 = 'f'.repeat(64);
  await store.writeJson(`staging/${full.exportId}/index.json`, wrong);
  await assert.rejects(receiveVolume(store, asVolume(full.zips[0])), (e) => e.code === 'bad-volume' && e.detail.reason === 'hash-mismatch');
});

// ---- 7.7 の 8：新しい schema
const get = (o, p) => p.reduce((a, k) => a[k], o);
test('schema（新）：events の整数の上限、eventId の形、toCheckpoint の型', () => {
  const ev = () => ({ ...sampleEvent(), type: 'retake', toCheckpoint: 'c0001' });
  assert.ok(validate('events', ev()).ok);
  assert.ok(validate('events', { ...ev(), toCheckpoint: null }).ok);
  const noKey = ev(); delete noKey.toCheckpoint;
  assert.ok(validate('events', noKey).ok, 'キーが無いことは schema では検出できない（core の bad-event が担う）');
  for (const bad of ['c1', 'x0001', 5, {}, []]) assert.equal(validate('events', { ...ev(), toCheckpoint: bad }).ok, false, JSON.stringify(bad));
  const MAX = Number.MAX_SAFE_INTEGER;
  assert.ok(validate('events', { ...ev(), seq: MAX }).ok);
  for (const big of [MAX + 1, 2 ** 60, 1e300]) {
    assert.equal(validate('events', { ...ev(), seq: big }).ok, false, `seq=${big}`);
    assert.equal(validate('events', { ...ev(), at: { raw: 'rec-000001', sample: big, pos: 0 } }).ok, false, `sample=${big}`);
    assert.equal(validate('events', { ...ev(), at: { raw: 'rec-000001', sample: 0, pos: big } }).ok, false, `pos=${big}`);
  }
  for (const id of ['e', 'e-1', 'E1', '1', 'e1x', '']) assert.equal(validate('events', { ...ev(), eventId: id }).ok, false, id);
});

test('schema（新）：manifest の files[].path と rawFiles[].file に ..、絶対パス、ドライブ文字、\\ を許さない', () => {
  const badPaths = ['../x.txt', 'a/../b.txt', 'a/..', '..', '/abs.txt', '\\abs.txt', 'C:/x.txt', 'c:x.txt', 'a\\b.txt', 'a/b\\c', ''];
  const okPaths = ['events.jsonl', 'raw/rec-000001.wav', 'final/s256.p001.wav', 'a..b.txt', 'dir/..hidden', 'x/y/z.bin', '日本語/ファイル.txt'];
  for (const p of badPaths) {
    const m = sampleManifest(); m.files[0].path = p;
    assert.equal(validate('manifest', m).ok, false, `files path ${JSON.stringify(p)}`);
    const m2 = sampleManifest(); m2.rawFiles[0].file = p;
    assert.equal(validate('manifest', m2).ok, false, `rawFiles file ${JSON.stringify(p)}`);
  }
  for (const p of okPaths) {
    const m = sampleManifest(); m.files[0].path = p; m.rawFiles[0].file = p;
    assert.deepEqual(validate('manifest', m), { ok: true, errors: [] }, p);
  }
  // 完成版の parts[].file も同じ
  const f = { ...sampleManifest(), kind: 'final', finals: [{ slideId: 's1', takeId: 't0001', samples: 1, sampleRate: 48000, parts: [{ file: '../evil.wav', samples: 1, sha256: 'a'.repeat(64) }] }] };
  assert.equal(validate('manifest', f).ok, false);
  f.finals[0].parts[0].file = 'final/s1.wav';
  assert.ok(validate('manifest', f).ok);
});

test('schema（新）：manifest の editVersion（最上位の任意の整数）', () => {
  const m = sampleManifest();
  assert.ok(validate('manifest', { ...m, editVersion: 2 }).ok);
  assert.equal(validate('manifest', { ...m, editVersion: 'x' }).ok, false);
  assert.equal(validate('manifest', { ...m, editVersion: 1.5 }).ok, false);
});

test('schema（新）：サンプル数・大きさの整数の上限（巨大な整数を許さない）', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const m = sampleManifest(); m.files[0].bytes = MAX + 1;
  assert.equal(validate('manifest', m).ok, false);
  const m2 = sampleManifest(); m2.rawFiles[0].samples = 2 ** 60;
  assert.equal(validate('manifest', m2).ok, false);
  const g = sampleSegments(); g.segments[0].end = 2 ** 60;
  assert.equal(validate('segments', g).ok, false);
  assert.ok(get(validate('segments', sampleSegments()), ['ok']));
});
