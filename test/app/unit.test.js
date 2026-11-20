// 録音アプリの、ブラウザなしで試せる部分（操作記録の読み取り、画面の状態の追跡、位置の対応、文言、設定）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseEventsBytes, encodeEventLine } from '../../app/src/events-io.js';
import { track, computeInvalid, retakeTarget, pendingSamples, undoTarget, redoTarget, lastCheckpoint, keptSamples, slideSummary } from '../../app/src/tracker.js';
import { posToRaw, splitPosRange, totalSamples, baseOf } from '../../app/src/posmap.js';
import { lastPieces } from '../../app/src/player.js';
import { readConfig } from '../../app/src/config.js';
import { STRINGS, t, setLang, applyI18n } from '../../app/src/strings.js';
import { keyAction } from '../../app/src/ui.js';
import { basicScriptCheck } from '../../app/src/script-pack.js';
import { describeMic, micConstraints } from '../../app/src/capture.js';
import { fmtClock, fmtSamples, randomId, takeIdOf, checkpointIdOf, rawNameOf } from '../../app/src/util.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');

// ---- 操作記録の組み立て（試験用）
function Log() {
  const events = [];
  let seq = 0;
  const raws = [];
  const add = (type, fields = {}, at = null) => {
    const e = { seq, eventId: `e${seq}`, type, wall: '2026-01-01T00:00:00.000Z', mono: seq * 10, ...fields };
    if (at !== null) e.at = at;
    events.push(e);
    seq++;
    return e;
  };
  const pos = (n) => ({ raw: 'rec-000001', sample: n, pos: n });
  return { events, add, pos, raws };
}

describe('events-io：操作記録の読み取り', () => {
  const line = (o) => encodeEventLine(o);
  const ev = (seq, type = 'durable') => ({ seq, eventId: `e${seq}`, type, wall: 'w', mono: 0 });

  test('完全な行だけが読まれ、末尾が途切れた行は捨てられる', () => {
    const a = line(ev(0, 'session-start')); const b = line(ev(1)); const c = line(ev(2));
    const bytes = new Uint8Array([...a, ...b, ...c.subarray(0, c.length - 7)]);
    const r = parseEventsBytes(bytes);
    assert.equal(r.events.length, 2);
    assert.equal(r.validBytes, a.length + b.length);
    assert.equal(r.droppedBytes, c.length - 7);
  });
  test('改行のない最終行は、JSON として読めても捨てられる（書き終わりを確かめられない）', () => {
    const a = line(ev(0, 'session-start'));
    const b = line(ev(1));
    const r = parseEventsBytes(new Uint8Array([...a, ...b.subarray(0, b.length - 1)]));
    assert.equal(r.events.length, 1);
    assert.ok(r.droppedBytes > 0);
  });
  test('壊れた行より後ろは捨てる。空行は無視する', () => {
    const a = line(ev(0, 'session-start'));
    const bad = new TextEncoder().encode('{not json}\n');
    const c = line(ev(2));
    const r = parseEventsBytes(new Uint8Array([...a, 10, ...bad, ...c]));
    assert.equal(r.events.length, 1);
    assert.equal(r.validBytes, a.length + 1);
  });
  test('日本語を含む行を途中で切っても壊れた文字を作らない', () => {
    const e = { ...ev(0, 'mark'), note: 'ここは要確認です' };
    const full = line(e);
    for (let cut = 1; cut < full.length; cut++) {
      const r = parseEventsBytes(full.subarray(0, cut));
      assert.equal(r.events.length, 0, `cut=${cut}`);
      assert.equal(r.validBytes, 0);
    }
    assert.equal(parseEventsBytes(full).events[0].note, 'ここは要確認です');
  });
  test('空の入力', () => {
    assert.deepEqual(parseEventsBytes(new Uint8Array(0)), { events: [], validBytes: 0, droppedBytes: 0 });
  });
});

describe('tracker：画面の状態の追跡', () => {
  test('録音開始 → durable → OK → 一時停止', () => {
    const L = Log();
    L.add('session-start', { sessionId: 'sess01' });
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('durable', {}, L.pos(48000));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(60000));
    const mid = track(L.events);
    assert.equal(mid.recording, true);
    assert.equal(mid.take.takeId, 't0001');
    assert.equal(mid.take.checkpoints.length, 1);
    assert.equal(mid.durable.pos, 48000);
    assert.equal(pendingSamples(mid, 70000), 10000);
    L.add('pause', { reason: 'user' }, L.pos(80000));
    const st = track(L.events);
    assert.equal(st.recording, false);
    assert.equal(pendingSamples(st, 80000), 20000);
    assert.equal(st.nextTakeNo, 2);
    assert.equal(st.nextCheckpointNo, 2);
  });

  test('撮り直し：最後の OK 点へ。続けて押すと、さらに前の OK 点へ。最後は null（テイクの最初）', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(1000));
    L.add('ok', { checkpointId: 'c0002' }, L.pos(2000));
    L.add('ok', { checkpointId: 'c0003' }, L.pos(3000));
    L.add('pause', { reason: 'user' }, L.pos(3500));
    let st = track(L.events);
    // OK 点より後に録った音声があれば、最後の OK 点（c0003）へ
    assert.deepEqual(retakeTarget(st, 3500), { ok: true, to: 'c0003' });
    L.add('retake', { toCheckpoint: 'c0003' }, L.pos(3500));
    st = track(L.events);
    assert.equal(st.recording, false);
    assert.equal(pendingSamples(st, 3500), 0);
    // 続けて押す：さらに前
    assert.deepEqual(retakeTarget(st, 3500), { ok: true, to: 'c0002' });
    L.add('retake', { toCheckpoint: 'c0002' }, L.pos(3500));
    st = track(L.events);
    assert.deepEqual(st.take.checkpoints.map((c) => c.checkpointId), ['c0001', 'c0002']);
    assert.deepEqual(retakeTarget(st, 3500), { ok: true, to: 'c0001' });
    L.add('retake', { toCheckpoint: 'c0001' }, L.pos(3500));
    st = track(L.events);
    assert.deepEqual(retakeTarget(st, 3500), { ok: true, to: null });
    L.add('retake', { toCheckpoint: null }, L.pos(3500));
    st = track(L.events);
    assert.equal(st.take.checkpoints.length, 0);
    assert.deepEqual(retakeTarget(st, 3500), { ok: false });
  });

  test('取り消しとやり直し：undo した ok は無かったことになり、redo で戻る。新しい操作でやり直しの列は空になる', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    const ok1 = L.add('ok', { checkpointId: 'c0001' }, L.pos(1000));
    const ok2 = L.add('ok', { checkpointId: 'c0002' }, L.pos(2000));
    let st = track(L.events);
    assert.equal(undoTarget(st).eventId, ok2.eventId);
    L.add('undo', { target: ok2.eventId });
    st = track(L.events);
    assert.deepEqual(st.take.checkpoints.map((c) => c.checkpointId), ['c0001']);
    assert.equal(redoTarget(st), ok2.eventId);
    assert.equal(undoTarget(st).eventId, ok1.eventId);
    // undo した ok の区間は、次の ok にまとめられる（音声は失われない）
    assert.equal(pendingSamples(st, 2500), 1500);
    L.add('redo', { target: ok2.eventId });
    st = track(L.events);
    assert.deepEqual(st.take.checkpoints.map((c) => c.checkpointId), ['c0001', 'c0002']);
    assert.equal(redoTarget(st), null);
    // 新しい操作でやり直しの列が空になる
    L.add('undo', { target: ok2.eventId });
    L.add('ok', { checkpointId: 'c0003' }, L.pos(2600));
    st = track(L.events);
    assert.equal(redoTarget(st), null);
    assert.equal(st.nextCheckpointNo, 4); // 無効になった c0002 の番号は再利用しない
  });

  test('undo の対象にできない種類（rec-start など）は無視される', () => {
    const L = Log();
    const rs = L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('undo', { target: rs.eventId });
    assert.equal(computeInvalid(L.events).size, 0);
    assert.equal(track(L.events).take.takeId, 't0001');
  });

  test('retake の undo：撮り直しを取り消すと、捨てた分が戻る', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(1000));
    L.add('pause', { reason: 'user' }, L.pos(1800));
    const rt = L.add('retake', { toCheckpoint: 'c0001' }, L.pos(1800));
    assert.equal(pendingSamples(track(L.events), 1800), 0);
    L.add('undo', { target: rt.eventId });
    const st = track(L.events);
    assert.equal(pendingSamples(st, 1800), 800);
    assert.equal(st.recording, false);
  });

  test('次のスライドへ：OK を含み、テイクを閉じ、スライドを進める。録音は止まったまま次を待つ', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('next-slide', { checkpointId: 'c0001', nextSlideId: 's0002' }, L.pos(5000));
    L.add('pause', { reason: 'user' }, L.pos(5000));
    const st = track(L.events);
    assert.equal(st.slideId, 's0002');
    assert.equal(st.take, null);
    assert.equal(st.recording, false);
    assert.equal(slideSummary(st, 's0001').state, 'done');
    assert.equal(slideSummary(st, 's0001').keptSamples, 5000);
    assert.equal(slideSummary(st, 's0002').state, 'todo');
    // 次の rec-start では takeId が進む
    assert.equal(st.nextTakeNo, 2);
  });

  test('ラップ式の次へ：next-slide のあと同じ位置の rec-start。録音は続き、次のテイクが始まる。取り消しの対象は、それより後の操作だけ', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(2000));
    L.add('next-slide', { checkpointId: 'c0002', nextSlideId: 's0002' }, L.pos(5000));
    L.add('rec-start', { slideId: 's0002', takeId: 't0002' }, L.pos(5000));
    let st = track(L.events);
    assert.equal(st.recording, true);
    assert.equal(st.slideId, 's0002');
    assert.equal(st.take.takeId, 't0002');
    assert.equal(pendingSamples(st, 6000), 1000);
    assert.equal(slideSummary(st, 's0001').keptSamples, 5000);
    assert.equal(undoTarget(st), null, '次のテイクが始まったあとは、前の操作を取り消せない');
    // 次のテイクの撮り直しは、テイクの最初まで
    L.add('pause', { reason: 'user' }, L.pos(6000));
    st = track(L.events);
    assert.deepEqual(retakeTarget(st, 6000), { ok: true, to: null });
  });

  test('next-slide を undo し、そのあと pause だけが残っても、同じテイクの続きとして扱える', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    const ns = L.add('next-slide', { checkpointId: 'c0001', nextSlideId: 's0002' }, L.pos(5000));
    L.add('pause', { reason: 'user' }, L.pos(5000));
    L.add('undo', { target: ns.eventId });
    const st = track(L.events);
    assert.equal(st.slideId, 's0001');
    assert.equal(st.take.takeId, 't0001');
    assert.equal(st.take.closed, false);
    assert.equal(pendingSamples(st, 5000), 5000);
  });

  test('復旧：recording のまま途切れた記録は録音中と読める。recovered のあとは未解決になり、OK／撮り直しで解決する', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(2000));
    L.add('durable', {}, L.pos(3000));
    let st = track(L.events);
    assert.equal(st.recording, true);
    L.add('recovered', { lastCheckpointId: 'c0001', notes: 'x' }, L.pos(4200));
    st = track(L.events);
    assert.equal(st.recording, false);
    assert.equal(st.unresolved.at.pos, 4200);
    assert.equal(pendingSamples(st, 4200), 2200); // c0001 のあと、復旧できた位置まで
    assert.equal(lastCheckpoint(st).pos, 2000);
    const ok = { ...L };
    L.add('ok', { checkpointId: 'c0002' }, L.pos(4200));
    st = track(L.events);
    assert.equal(st.unresolved, null);
    assert.equal(keptSamples(st.take), 4200);
    assert.ok(ok);
  });

  test('一度も OK を押さずに途切れた場合：最後の OK はなく、続きはテイクの最初から', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('durable', {}, L.pos(48000));
    L.add('recovered', { lastCheckpointId: null, notes: '' }, L.pos(50000));
    const st = track(L.events);
    assert.equal(lastCheckpoint(st), null);
    assert.equal(st.unresolved.at.pos, 50000);
    assert.equal(pendingSamples(st, 50000), 50000);
  });

  test('一時停止のあとの再開：断片が分かれ、間は数えない（録音ファイルが変わっても通しの位置は続く）', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('pause', { reason: 'user' }, L.pos(1000));
    L.add('resume', {}, { raw: 'rec-000002', sample: 0, pos: 1000 });
    L.add('ok', { checkpointId: 'c0001' }, { raw: 'rec-000002', sample: 500, pos: 1500 });
    const st = track(L.events);
    assert.equal(keptSamples(st.take), 1500);
    assert.deepEqual(st.take.checkpoints[0].pieces, [{ start: 0, end: 1000 }, { start: 1000, end: 1500 }]);
  });

  test('goto-slide：テイクを閉じてスライドを変える。undo の対象になる', () => {
    const L = Log();
    L.add('goto-slide', { slideId: 's0003' });
    let st = track(L.events);
    assert.equal(st.slideId, 's0003');
    L.add('undo', { target: 'e0' });
    st = track(L.events);
    assert.equal(st.slideId, null);
  });

  test('印（mark）：スライドごとの「要確認」になる', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(1000));
    L.add('mark', {}, L.pos(1100));
    assert.equal(slideSummary(track(L.events), 's0001').state, 'review');
  });

  test('取り消しできる範囲：新しい rec-start より前の操作は対象にしない', () => {
    const L = Log();
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, L.pos(0));
    L.add('ok', { checkpointId: 'c0001' }, L.pos(1000));
    L.add('pause', { reason: 'user' }, L.pos(1100));
    L.add('goto-slide', { slideId: 's0002' });
    L.add('rec-start', { slideId: 's0002', takeId: 't0002' }, L.pos(1100));
    assert.equal(undoTarget(track(L.events)), null);
  });
});

describe('posmap：通しの位置と録音ファイルの位置', () => {
  const raws = [{ name: 'rec-000001', samples: 100 }, { name: 'rec-000002', samples: 50 }, { name: 'rec-000003', samples: 0 }];
  test('対応', () => {
    assert.equal(totalSamples(raws), 150);
    assert.deepEqual(posToRaw(raws, 0), { raw: 'rec-000001', sample: 0 });
    assert.deepEqual(posToRaw(raws, 100), { raw: 'rec-000001', sample: 100 });
    assert.deepEqual(posToRaw(raws, 101), { raw: 'rec-000002', sample: 1 });
    assert.equal(posToRaw(raws, 151), null);
    assert.equal(baseOf(raws, 'rec-000002'), 100);
  });
  test('範囲の分割', () => {
    assert.deepEqual(splitPosRange(raws, 90, 120), [{ raw: 'rec-000001', start: 90, end: 100 }, { raw: 'rec-000002', start: 0, end: 20 }]);
    assert.deepEqual(splitPosRange(raws, 100, 100), []);
    assert.deepEqual(splitPosRange(raws, 0, 1000).map((r) => r.end - r.start), [100, 50]);
  });
  test('採用した音声の終わりから、指定の長さだけさかのぼる範囲', () => {
    assert.deepEqual(lastPieces([{ start: 0, end: 100 }, { start: 500, end: 520 }], 50), [{ start: 70, end: 100 }, { start: 500, end: 520 }]);
    assert.deepEqual(lastPieces([{ start: 0, end: 10 }], 50), [{ start: 0, end: 10 }]);
    assert.deepEqual(lastPieces([], 50), []);
  });
});

describe('設定・文言・キー', () => {
  test('URL パラメータ：既定値と、試験用の小さな値', () => {
    const d = readConfig('');
    assert.equal(d.rawMaxBytes, 256 * 1024 * 1024);
    assert.equal(d.volumeMaxBytes, 1_000_000_000);
    assert.equal('countdownSec' in d, false, '録音開始のカウントダウンは無い');
    assert.equal(d.dev, false);
    assert.equal(d.hook, null);
    const c = readConfig('?devinput=1&rawMax=1001&volumeMax=5000&hook=mid-event&hookAt=100&countdown=0');
    assert.equal(c.rawMaxBytes, 1000, '2 バイトの倍数に丸める');
    assert.equal(c.volumeMaxBytes, 5000);
    assert.equal(c.devinput, true);
    assert.equal(c.dev, true);
    assert.equal(c.hook, 'mid-event');
    assert.equal(c.hookAt, 100);
    assert.equal('countdownSec' in c, false, '?countdown= は何もしない');
    assert.equal(readConfig('?lapdev=1').dev, true);
    assert.equal(readConfig('?rawMax=abc').rawMaxBytes, 256 * 1024 * 1024);
  });

  test('文言：ja と en のキーが同じで、空でない', () => {
    const ja = Object.keys(STRINGS.ja).sort();
    const en = Object.keys(STRINGS.en).sort();
    assert.deepEqual(ja, en);
    for (const k of ja) {
      assert.ok(STRINGS.ja[k].length > 0, k);
      assert.ok(STRINGS.en[k].length > 0, k);
    }
  });

  test('文言：ソースと HTML で使うキーが、すべて定義されている', () => {
    const used = new Set();
    const scan = (file) => {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([A-Za-z0-9_.]+)"/g)) used.add(m[1]);
      for (const m of text.matchAll(/(?:key|say)\('?"?(toast\.[A-Za-z0-9_.]+)/g)) used.add(m[1]);
      for (const m of text.matchAll(/'(toast\.[A-Za-z0-9]+)'/g)) used.add(m[1]);
    };
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['i18n', 'organizer'].includes(e.name)) walk(p); } else if (/\.(js|html)$/.test(e.name) && e.name !== 'strings.js') scan(p);
      }
    };
    walk(path.join(ROOT, 'app'));
    // 動的に組み立てるキー
    for (const m of ['ready', 'recording', 'paused']) used.add(`rec.status.${m}`);
    for (const s of ['todo', 'done', 'review', 'skip']) used.add(`rec.state.${s}`);
    const missing = [...used].filter((k) => !(k in STRINGS.ja) || !(k in STRINGS.en));
    assert.deepEqual(missing, []);
  });

  test('文言：置き換えと、言語の切り替え', () => {
    setLang('ja');
    assert.equal(t('recovery.summary', { recovered: '1:42', lastOk: '1:35' }), '原音は 1:42 まで復旧。最後の OK は 1:35。');
    assert.equal(t('recovery.listen', { sec: 7 }), '続きの 7 秒を聞く');
    setLang('en');
    assert.match(t('recovery.summary', { recovered: '1:42', lastOk: '1:35' }), /1:42/);
    assert.equal(t('no.such.key'), 'no.such.key');
    setLang('ja');
  });

  test('プライバシーの文言：「一切通信しません」と書かない', () => {
    for (const lang of ['ja', 'en']) for (const v of Object.values(STRINGS[lang])) assert.doesNotMatch(v, /一切通信しません|never (?:communicates|connects)/i);
    assert.match(STRINGS.ja['privacy.note'], /自動送信しません/);
  });

  test('キーの割り当て（設計書 4.2）', () => {
    const k = (key, o = {}) => keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    assert.equal(k('r'), 'record');
    assert.equal(k(' '), 'ok');
    assert.equal(k('Backspace'), 'retake');
    assert.equal(k('Enter'), 'next');
    assert.equal(k('Escape'), 'pause');
    assert.equal(k('l'), 'listen');
    assert.equal(k('m'), 'mark');
    assert.equal(k('t'), 'test');
    assert.equal(k('p'), 'listen-slide');
    assert.equal(k('z', { ctrlKey: true }), 'undo');
    assert.equal(k('y', { ctrlKey: true }), 'redo');
    assert.equal(k('z', { ctrlKey: true, shiftKey: true }), 'redo');
    assert.equal(k('PageDown'), 'ok');
    assert.equal(k('PageUp'), 'retake');
    assert.equal(k('x'), null);
    assert.equal(k('r', { altKey: true }), null);
  });
});

describe('補助', () => {
  test('時間の表示', () => {
    assert.equal(fmtClock(102), '1:42');
    assert.equal(fmtClock(3661), '1:01:01');
    assert.equal(fmtSamples(48000 * 95, 48000), '1:35');
    assert.equal(fmtSamples(5, 0), '0:00');
  });
  test('識別子の形（CONTRACTS.md 0.3）', () => {
    assert.match(randomId(12), /^[A-Za-z0-9_-]{6,64}$/);
    assert.match(takeIdOf(1), /^t[0-9]{4}$/);
    assert.match(checkpointIdOf(12), /^c[0-9]{4}$/);
    assert.match(rawNameOf(3), /^rec-[0-9]{6}$/);
  });
  test('マイクの設定：要求した値と実際の値を別々に持ち、返されない項目は「不明」', () => {
    const req = micConstraints({});
    assert.equal(req.echoCancellation, false);
    assert.equal(req.autoGainControl, false);
    assert.equal(micConstraints({ noiseSuppression: true }).noiseSuppression, true);
    const d = describeMic(req, { echoCancellation: false, sampleRate: 44100 }, 48000);
    assert.equal(d.actual.sampleRate, 44100);
    assert.equal(d.actual.autoGainControl, 'unknown');
    assert.equal(d.actual.contextSampleRate, 48000);
    assert.deepEqual(d.requested, req);
  });
  test('台本の簡易の検査', () => {
    const good = { format: 'lap-narrator/script', version: 1, projectId: 'proj-001', title: 'x', scriptHash: 'a'.repeat(64), slides: [{ slideId: 's1', order: 1, text: 'a', recordable: true, textHash: 'b'.repeat(64) }] };
    assert.equal(basicScriptCheck(good).ok, true);
    assert.equal(basicScriptCheck({ ...good, slides: [] }).ok, false);
    assert.equal(basicScriptCheck({ ...good, projectId: 'x' }).ok, false);
    assert.equal(basicScriptCheck(null).ok, false);
  });
  test('applyI18n は document がなければ呼べない（ブラウザ専用）', () => {
    assert.equal(typeof applyI18n, 'function');
  });
});
