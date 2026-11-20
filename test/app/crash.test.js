// T3 (3)：強制終了と復旧。強制終了を 3 か所（音声を書いた直後、記録を書いている途中、録音ファイルの切り替えの直前）と、
// 一度も OK を押さない場合で起こす。開き直して、表示された「復旧できる位置」まで再生でき、
// その位置が実際に保存されていた音声の長さを超えない。
//
// 強制終了は、自分が起動した Chrome の pid だけを taskkill /F /T /PID で止める。書き込みの途中を狙うために、
// 保存の Worker に試験用のフック（?hook=after-audio|mid-event|before-rotate&hookAt=<通しの位置>）がある。
// ブラウザ：work/B/profile-crash-* の専用のプロフィール。ポート 8108〜8119。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startStaticServer } from './helpers/static-server.js';
import { launchChrome, chromePath, waitUntil } from './helpers/chrome.js';
import { openApp } from './helpers/app-page.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { makeScript, makePcm } from './helpers/fixtures.js';
import { validate } from '../../core/validate.js';
import { reduceEvents } from '../../core/reduce.js';

const skip = chromePath() ? false : 'Chrome がない';
const RATE = 48000;

describe('強制終了と復旧', { skip }, () => {
  let server;
  const alive = [];
  const PORTS = [8109, 8110, 8111];
  let portCursor = 0;
  before(async () => {
    await acquireBrowserLock(); // ブラウザを使う試験ファイルは 1 つずつ動かす
    server = await startStaticServer({ port: 8108 });
  });
  after(async () => {
    for (const c of alive) { try { await c.close(); } catch { /* 無視 */ } }
    if (server) await server.close();
    releaseBrowserLock();
  });

  const launch = async (name, fresh) => {
    const used = new Set(alive.filter((c) => !c.exited).map((c) => c.port));
    // 強制終了した直後のポートを避けるため、順に使う
    let port;
    for (let i = 0; i < PORTS.length; i++) { const p = PORTS[(portCursor + i) % PORTS.length]; if (!used.has(p)) { port = p; portCursor = (portCursor + i + 1) % PORTS.length; break; } }
    const c = await launchChrome({ name, port, fresh });
    alive.push(c);
    return c;
  };
  afterEach(async () => {
    while (alive.length) { const c = alive.pop(); try { await c.close(); } catch { /* 無視 */ } }
  });

  /**
   * 強制終了までを行い、開き直して復旧の手順に入ったページを返す。
   * @param {{name:string, query:string, drive:(app:any)=>Promise<void>}} o
   */
  async function crashAndReopen({ name, query, drive }) {
    const c1 = await launch(name, true);
    const a1 = await openApp(c1, server.origin, `?devinput=1&countdown=0&${query}`);
    const projectId = await a1.loadScript(makeScript({ slides: 3, projectId: `proj-${name}` }));
    const sessionId = await a1.newSession(projectId);
    await a1.press('record');
    // 録音の途中で止まる（フックが止める）。feed の完了は待たない。
    const driving = drive(a1).catch(() => {});
    const hit = await a1.page.evaluate(() => window.__lap.waitForHook(20000));
    assert.ok(hit, 'フックに当たった');
    c1.kill(); // 強制終了（自分が起動した pid だけ）
    await driving;
    assert.equal(c1.exited, true);
    // 開き直す（同じプロフィール）
    const c2 = await launch(name, false);
    const a2 = await openApp(c2, server.origin, '?devinput=1&countdown=0');
    const sessions = await a2.sessions();
    const info = sessions.find((s) => s.sessionId === sessionId);
    assert.ok(info, '端末の中に録音セッションが残っている');
    assert.equal(info.interrupted, true, '中断（録音中のまま途切れた）と読める');
    const diskBefore = await a2.rawSizesOnDisk(sessionId); // 復旧の前の、実際に保存されていた音声
    const logBefore = await a2.eventsOnDisk(sessionId);
    const opened = await a2.openSession(sessionId);
    return { c1, c2, a2, sessionId, hit, info, diskBefore, logBefore, recovery: opened.recovery };
  }

  /** 復旧の表示と、再生の検証。 */
  async function verifyRecovery(r, { expectLastOk }) {
    const { a2, diskBefore, logBefore, recovery } = r;
    assert.ok(recovery, '復旧の手順に入った（マイクは自動で再開しない）');
    const names = Object.keys(diskBefore).sort();
    const diskSamples = names.reduce((n, k) => n + diskBefore[k] / 2, 0);
    // 表示された位置は、実際に保存されていた音声の長さを超えない
    assert.ok(recovery.recoveredPos <= diskSamples, `復旧位置 ${recovery.recoveredPos} <= 保存されていた ${diskSamples}`);
    assert.equal(recovery.recoveredPos, diskSamples, '保存されていた音声の終わりまで復旧する');
    // 保存位置（durable）の記録まで戻らず、記録より先の音声も拾う。durable は書いた音声を超えない
    const durables = logBefore.events.filter((e) => e.type === 'durable');
    const lastDurable = durables.at(-1);
    assert.ok(lastDurable, 'durable が書かれていた');
    assert.ok(lastDurable.at.pos <= diskSamples, 'durable の位置は、実際に書かれた音声を超えない');
    assert.ok(recovery.recoveredPos >= lastDurable.at.pos);
    assert.equal(recovery.durablePos, lastDurable.at.pos);
    if (expectLastOk) assert.ok(recovery.lastOkPos !== null && recovery.lastOkPos <= recovery.recoveredPos);
    else assert.equal(recovery.lastOkPos, null, '一度も OK を押していない');

    // 画面の表示（設計書 4.5 の形）
    await waitUntil(async () => (await a2.page.evaluate(() => document.getElementById('dlg-recovery').open)), { what: '復旧の画面' });
    const summary = await a2.page.textContent('#rec-summary');
    assert.match(summary, /^原音は \d+:\d\d まで復旧。最後の OK は (\d+:\d\d|なし)。$/);
    const listen = await a2.page.textContent('#rec-listen');
    assert.match(listen, /^続きの \d+ 秒を聞く$/);
    const shown = summary.match(/原音は (\d+):(\d\d)/);
    assert.equal(Number(shown[1]) * 60 + Number(shown[2]), Math.floor(recovery.recoveredPos / RATE));

    // 表示した位置まで再生できる（続きを、最後の OK 点（なければテイクの最初）から復旧位置まで）
    const total = recovery.continuationSamples;
    assert.ok(total > 0);
    const played = await a2.page.evaluate(() => window.__lap.playRecovered({ speed: 16 }));
    assert.equal(played.ok, true);
    assert.equal(played.samples, total, '続きの全部を再生できた');
    const lastPiece = played.requested.at(-1);
    assert.equal(lastPiece.end, recovery.recoveredPos, '再生の終わりが、表示した復旧位置');
    assert.ok(lastPiece.end <= diskSamples);
    // 再生した音声は、保存されていた音声そのもの（別経路で読み直して照合）
    const st = await a2.state();
    const raws = st.rawFiles;
    let base = 0;
    const startPos = played.requested[0].start;
    for (const rf of raws) base += rf.samples;
    assert.ok(base >= lastPiece.end);
    return { diskSamples, played };
  }

  const drive6s = (extra) => async (a) => {
    const pcm = makePcm(RATE * 8, { seed: 31 });
    await a.feed(pcm.subarray(0, RATE * 1.2));
    if (extra && extra.okFirst) await a.press('ok');
    await a.feed(pcm.subarray(RATE * 1.2), { speed: 8 });
  };

  test('音声を書いた直後に強制終了：OK 点あり。復旧して、続きを聞き、採用できる', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({ name: 'after-audio', query: `hook=after-audio&hookAt=${Math.round(RATE * 3.5)}&durableMs=500`, drive: drive6s({ okFirst: true }) });
    assert.equal(r.hit, 'after-audio');
    const { diskSamples } = await verifyRecovery(r, { expectLastOk: true });
    assert.ok(r.diskBefore['rec-000001'] / 2 >= RATE * 3.5);
    // 音声は書けたが記録がまだ：実際の音声のほうが durable より長い
    const lastDurable = r.logBefore.events.filter((e) => e.type === 'durable').at(-1);
    assert.ok(diskSamples > lastDurable.at.pos, '音声は書けていたが、記録が追いついていなかった');
    assert.equal(r.logBefore.droppedBytes, 0, '記録の末尾は途切れていない');

    // 続きを採用する：その位置で ok を書く
    const adopted = await r.a2.press('adopt');
    assert.equal(adopted.ok, true);
    const events = await r.a2.events();
    const rec = events.find((e) => e.type === 'recovered');
    assert.equal(rec.at.pos, diskSamples);
    assert.equal(rec.lastCheckpointId, 'c0001');
    const ok = events.at(-1);
    assert.deepEqual([ok.type, ok.at.pos], ['ok', diskSamples]);
    const st = await r.a2.state();
    assert.equal(st.mode, 'paused', 'マイクは自動で再開しない');
    assert.equal(st.recording, false);
    assert.equal(st.recoveryNeeded, false);
    events.forEach((e) => assert.deepEqual(validate('events', e).errors, [], `seq ${e.seq}`));
    // core の解釈：テイクの採用は、復旧した位置までの全部
    const reduced = reduceEvents(events, st.rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
    assert.equal(reduced.takes[0].samples, diskSamples);
    assert.equal(reduced.takes[0].candidate, true);
    // 続きから録音を再開できる（新しい録音ファイル）
    assert.equal((await r.a2.press('record')).type, 'resume');
    await r.a2.feed(makePcm(RATE, { seed: 32 }));
    await r.a2.press('pause');
    assert.equal((await r.a2.state()).rawFiles.length, 2);
  });

  test('記録を書いている途中で強制終了：末尾の途切れた行を捨てて復旧する。最後の OK から撮り直せる', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({ name: 'mid-event', query: `hook=mid-event&hookAt=${Math.round(RATE * 3)}&durableMs=500`, drive: drive6s({ okFirst: true }) });
    assert.equal(r.hit, 'mid-event');
    assert.ok(r.logBefore.droppedBytes > 0, '記録の末尾が途中で切れていた');
    const { diskSamples } = await verifyRecovery(r, { expectLastOk: true });
    // 実際の events.jsonl から、途切れた行が捨てられている
    const afterOpen = await r.a2.eventsOnDisk(r.sessionId);
    assert.equal(afterOpen.droppedBytes, 0, '開いたあと、途切れた行は残っていない');
    const st = await r.a2.state();
    assert.ok(st.droppedTailBytes > 0);
    const rec = (await r.a2.events()).find((e) => e.type === 'recovered');
    assert.match(rec.notes, /torn-tail-dropped:\d+/);
    // 最後の OK 点から撮り直す
    const rt = await r.a2.press('retake-recovery');
    assert.deepEqual([rt.ok, rt.to], [true, 'c0001']);
    const events = await r.a2.events();
    const reduced = reduceEvents(events, (await r.a2.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
    const take = reduced.takes[0];
    assert.equal(take.samples, Math.round(RATE * 1.2), '採用は最後の OK 点まで');
    const disc = reduced.segments.filter((s) => s.status === 'discarded').reduce((n, s) => n + s.end - s.start, 0);
    assert.equal(disc, diskSamples - Math.round(RATE * 1.2), '続きは破棄になる（録音ファイルには残る）');
    assert.equal((await r.a2.state()).recoveryNeeded, false);
  });

  test('録音ファイルの切り替えの直前に強制終了：切り替え前のファイルの終わりまで復旧する', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({
      name: 'before-rotate',
      query: 'hook=before-rotate&rawMax=96000&durableMs=250',
      drive: async (a) => { await a.feed(makePcm(RATE * 0.5, { seed: 41 })); await a.press('ok'); await a.feed(makePcm(RATE * 3, { seed: 42 }), { speed: 8 }); },
    });
    assert.equal(r.hit, 'before-rotate');
    assert.deepEqual(Object.keys(r.diskBefore), ['rec-000001'], '次の録音ファイルはまだない');
    assert.equal(r.diskBefore['rec-000001'], 96000, '上限ちょうどまで書けていた');
    assert.equal(r.logBefore.events.some((e) => e.type === 'file-rotate'), false);
    const { diskSamples } = await verifyRecovery(r, { expectLastOk: true });
    assert.equal(diskSamples, 48000);
    // 続きを採用し、そのまま再開すると、新しい録音ファイル（番号 2）に書かれる
    await r.a2.press('adopt');
    await r.a2.press('record');
    await r.a2.feed(makePcm(2000, { seed: 43 }));
    await r.a2.press('pause');
    const st = await r.a2.state();
    assert.deepEqual(st.rawFiles.map((x) => [x.name, x.samples]), [['rec-000001', 48000], ['rec-000002', 2000]]);
    const events = await r.a2.events();
    const resume = events.filter((e) => e.type === 'resume').at(-1);
    assert.deepEqual([resume.at.raw, resume.at.sample, resume.at.pos], ['rec-000002', 0, 48000]);
  });

  test('一度も OK を押さずに強制終了：最後の OK はなく、durable で示した位置まで聞き返せる。テイクの最初から撮り直せる', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({
      name: 'no-ok',
      query: `hook=after-audio&hookAt=${Math.round(RATE * 2.7)}&durableMs=1000`,
      drive: async (a) => { await a.feed(makePcm(RATE * 8, { seed: 51 }), { speed: 8 }); },
    });
    assert.equal(r.logBefore.events.some((e) => e.type === 'ok'), false);
    await verifyRecovery(r, { expectLastOk: false });
    const rt = await r.a2.press('retake-recovery');
    assert.deepEqual([rt.ok, rt.to], [true, null]);
    const events = await r.a2.events();
    const reduced = reduceEvents(events, (await r.a2.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
    assert.equal(reduced.takes[0].samples, 0);
    assert.equal(reduced.takes[0].candidate, false);
  });

  test('復旧の途中でもう一度強制終了しても、続きの選択が残る（recovered を書いたあとの再起動）', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({ name: 'twice', query: `hook=after-audio&hookAt=${Math.round(RATE * 2.2)}&durableMs=500`, drive: drive6s({ okFirst: true }) });
    assert.ok(r.recovery);
    r.c2.kill();
    const c3 = await launch('twice', false);
    const a3 = await openApp(c3, server.origin, '?devinput=1&countdown=0');
    const info = (await a3.sessions()).find((s) => s.sessionId === r.sessionId);
    assert.equal(info.interrupted, true, 'まだ選んでいないので、復旧の対象のまま');
    const opened = await a3.openSession(r.sessionId);
    assert.ok(opened.recovery);
    assert.equal(opened.recovery.recoveredPos, r.recovery.recoveredPos);
    const recoveredEvents = (await a3.events()).filter((e) => e.type === 'recovered');
    assert.equal(recoveredEvents.length, 1, 'recovered を二重に書かない');
  });

  test('ラップ式の次へ（録音を止めない）の直後に強制終了：次のスライドのテイクが続きとして復旧される。issues は空', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({
      name: 'lap-next',
      query: `hook=after-audio&hookAt=${Math.round(RATE * 3.6)}&durableMs=500`,
      drive: async (a) => {
        const pcm = makePcm(RATE * 8, { seed: 81 });
        await a.feed(pcm.subarray(0, RATE * 2)); await a.press('ok');
        await a.feed(pcm.subarray(RATE * 2, RATE * 3));
        const nx = await a.press('next'); // 録音を止めずに、次のスライドへ
        assert.equal(nx.continued, true);
        await a.feed(pcm.subarray(RATE * 3), { speed: 8 });
      },
    });
    assert.equal(r.hit, 'after-audio');
    const types = r.logBefore.events.map((e) => e.type).filter((x) => x !== 'durable');
    assert.deepEqual(types, ['session-start', 'rec-start', 'ok', 'next-slide', 'rec-start']);
    const [ns, rs] = r.logBefore.events.filter((e) => e.type === 'next-slide' || (e.type === 'rec-start' && e.takeId === 't0002'));
    assert.deepEqual(ns.at, rs.at, '同じ位置');
    const { diskSamples } = await verifyRecovery(r, { expectLastOk: false });
    assert.equal(r.recovery.slideId, 's0002');
    assert.equal(r.recovery.continuationSamples, diskSamples - RATE * 3, '続きは、次のスライドに入ってからの音声');
    // 続きを採用する：スライド 2 のテイクが採用になり、スライド 1 は 3 秒のまま
    assert.equal((await r.a2.press('adopt')).ok, true);
    const events = await r.a2.events();
    const reduced = reduceEvents(events, (await r.a2.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
    assert.equal(reduced.takes.find((t) => t.slideId === 's0001').samples, RATE * 3);
    assert.equal(reduced.takes.find((t) => t.slideId === 's0002').samples, diskSamples - RATE * 3);
    events.forEach((e) => assert.deepEqual(validate('events', e).errors, [], `seq ${e.seq}`));
  });

  test('ラップ式の次への、ほんの直後（最初の音声の書き込みの直後）に強制終了：次のテイクの始まりの位置から復旧される', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({
      name: 'lap-next3',
      query: `hook=after-audio&hookAt=${RATE * 2 + 1}&durableMs=500`,
      drive: async (a) => {
        const pcm = makePcm(RATE * 6, { seed: 83 });
        await a.feed(pcm.subarray(0, RATE * 2)); await a.press('ok');
        await a.press('next');
        await a.feed(pcm.subarray(RATE * 2), { speed: 8 });
      },
    });
    assert.equal(r.recovery.slideId, 's0002');
    const { diskSamples } = await verifyRecovery(r, { expectLastOk: false });
    assert.ok(diskSamples > RATE * 2 && diskSamples <= RATE * 2 + 4096);
    await r.a2.press('adopt');
    const reduced = reduceEvents(await r.a2.events(), (await r.a2.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
  });

  test('ラップ式の次へを何度も続けたあとの強制終了（OK を押さない）：最後のスライドの続きが復旧され、issues は空', { timeout: 120000 }, async () => {
    const r = await crashAndReopen({
      name: 'lap-next2',
      query: `hook=after-audio&hookAt=${Math.round(RATE * 3.3)}&durableMs=500`,
      drive: async (a) => {
        const pcm = makePcm(RATE * 6, { seed: 82 });
        await a.feed(pcm.subarray(0, RATE)); await a.press('next');
        await a.feed(pcm.subarray(RATE, RATE * 2)); await a.press('next');
        await a.feed(pcm.subarray(RATE * 2), { speed: 8 });
      },
    });
    assert.equal(r.recovery.slideId, 's0003');
    assert.equal(r.recovery.lastOkPos, null);
    await r.a2.press('retake-recovery');
    const events = await r.a2.events();
    const reduced = reduceEvents(events, (await r.a2.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
    assert.deepEqual(reduced.takes.map((t) => [t.slideId, t.samples]), [['s0001', RATE], ['s0002', RATE], ['s0003', 0]]);
  });

  // V1 項目 1：復旧の「採用」「撮り直し」を取り消すと、復旧の画面が出ないまま録音も書き出しもできなくなった
  for (const choice of ['adopt', 'retake-recovery']) {
    test(`復旧で「${choice === 'adopt' ? '採用' : '撮り直し'}」を選んだあとに Ctrl+Z：復旧の画面が出し直され、選び直せる。録音と書き出しも、選び直せば動く`, { timeout: 120000 }, async () => {
      const r = await crashAndReopen({ name: `undo-${choice}`, query: `hook=after-audio&hookAt=${Math.round(RATE * 2.5)}&durableMs=500`, drive: drive6s({ okFirst: true }) });
      const a = r.a2;
      const dialogOpen = () => a.page.evaluate(() => document.getElementById('dlg-recovery').open);
      await waitUntil(dialogOpen, { what: '復旧の画面' });
      assert.equal((await a.press(choice)).ok, true);
      await waitUntil(async () => !(await dialogOpen()), { what: '選んだあとは閉じる' });
      assert.equal((await a.state()).canUndo, true);
      // Ctrl+Z（画面のキーで）
      await a.page.keyboard.press('Control+z');
      await waitUntil(async () => (await a.state()).invalid.length === 1, { what: '取り消し' });
      // 復旧の画面が、もう一度出る。選ぶまで録音・書き出しは進めない
      await waitUntil(dialogOpen, { what: '復旧の画面の出し直し' });
      let st = await a.state();
      assert.equal(st.recoveryNeeded, true);
      assert.ok(st.recovery && st.recovery.recoveredPos === r.recovery.recoveredPos);
      assert.equal(st.canUndo, false, '選ぶまで、さらに取り消すことはできない');
      assert.equal((await a.press('record')).reason, 'recovery');
      assert.match(await a.page.textContent('#rec-summary'), /^原音は \d+:\d\d まで復旧。/);
      // 続きを聞ける
      assert.equal((await a.page.evaluate(() => window.__lap.playRecovered({ speed: 16 }))).ok, true);
      // 選び直す（もう一方の選択）
      const other = choice === 'adopt' ? 'retake-recovery' : 'adopt';
      assert.equal((await a.press(other)).ok, true);
      await waitUntil(async () => !(await dialogOpen()), { what: '選び直したあとは閉じる' });
      st = await a.state();
      assert.equal(st.recoveryNeeded, false);
      // 録音を再開でき、書き出しもできる
      assert.equal((await a.press('record')).type, 'resume');
      await a.feed(makePcm(RATE, { seed: 91 }));
      await a.press('pause');
      const sum = await a.page.evaluate(() => window.__lap.exportStart({ kind: 'full' }));
      assert.ok(sum.volumes >= 1);
      const events = await a.events();
      const reduced = reduceEvents(events, (await a.state()).rawFiles.map((x) => ({ ...x })));
      assert.deepEqual(reduced.issues, [], JSON.stringify(reduced.issues));
    });
  }
});
