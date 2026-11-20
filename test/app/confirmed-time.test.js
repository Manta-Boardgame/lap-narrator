// 録音中の画面の「確定した録音時間」（OK まで採用した音声の合計）と、録音開始のカウントダウンが無いことの試験（担当 B3）。
//   (1) 確定の数字（tracker.confirmedSamples）が、操作の一つ一つのあとで、core の reduceEvents の結果（既定の採用の区間の合計）と一致する（ブラウザなし）
//   (2) 画面：OK、撮り直し、取り消し／やり直し、通しとスライド区切り、強制終了からの復旧のたびに、「確定」と「未確定」の表示が正しく変わる
//   (3) 録音を押したら待たずに始まる（URL パラメーター countdown=3 を付けても。リリースでは無視されるが、開発用の版でも効かない）。録音の位置（events.jsonl の at）は変わらない
// ブラウザ：work/B/profile-confirmed の専用のプロフィール。ポート 8116〜8118。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startStaticServer } from './helpers/static-server.js';
import { launchChrome, chromePath, waitUntil } from './helpers/chrome.js';
import { openApp } from './helpers/app-page.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { makeScript, makePcm } from './helpers/fixtures.js';
import { reduceEvents } from '../../core/reduce.js';
import { track, confirmedSamples, pendingSamples } from '../../app/src/tracker.js';
import { readConfig } from '../../app/src/config.js';
import { STRINGS, t, setLang } from '../../app/src/strings.js';

const skip = chromePath() ? false : 'Chrome がない';
const RATE = 48000;

// ---------------------------------------------------------------- (1) reduceEvents との一致（ブラウザなし）

function Log() {
  const events = [];
  const add = (type, fields = {}, pos = null) => {
    const seq = events.length;
    const e = { seq, eventId: `e${seq}`, type, wall: '2026-01-01T00:00:00.000Z', mono: seq * 10, ...fields };
    if (pos !== null) e.at = { raw: 'rec-000001', sample: pos, pos };
    events.push(e);
    return e;
  };
  return { events, add };
}

/** reduceEvents の結果から、既定の採用（defaultTakes）の区間の合計を求める。 */
function reducedConfirmed(events) {
  const r = reduceEvents(events, [{ name: 'rec-000001', sampleRate: RATE, samples: 10_000_000 }]);
  return { sum: r.takes.filter((tk) => r.defaultTakes[tk.slideId] === tk.takeId).reduce((n, tk) => n + tk.samples, 0), issues: r.issues };
}

/** 操作の一つ一つのあとで、tracker の確定の数字が reduceEvents と一致する。 */
function assertMatchesEveryPrefix(events) {
  const seen = [];
  for (let i = 0; i < events.length; i++) {
    const prefix = events.slice(0, i + 1);
    const got = confirmedSamples(track(prefix));
    const want = reducedConfirmed(prefix).sum;
    assert.equal(got, want, `seq ${i} (${events[i].type}) のあと：tracker ${got} と reduceEvents ${want} が一致する`);
    seen.push(got);
  }
  assert.deepEqual(reducedConfirmed(events).issues, [], '試験の操作記録そのものが core の検査に通る');
  return seen;
}

describe('確定した録音時間：tracker.confirmedSamples が reduceEvents（既定の採用）と一致する', () => {
  test('通しの録音：OK、撮り直し（連続を含む）、取り消し、やり直し、復旧（採用／最後の OK から撮り直す）', () => {
    const L = Log();
    L.add('session-start', { sessionId: 'sess0001' });
    L.add('rec-start', { slideId: 'free', takeId: 't0001' }, 0);
    L.add('durable', {}, 30000);
    L.add('ok', { checkpointId: 'c0001' }, 96000); // 確定 2 秒
    L.add('pause', { reason: 'user' }, 150000); // 96000〜150000 は未確定
    L.add('retake', { toCheckpoint: 'c0001' }, 150000); // 捨てる。確定は変わらない
    L.add('resume', {}, 150000);
    const ok2 = L.add('ok', { checkpointId: 'c0002' }, 222000); // +72000
    L.add('undo', { target: ok2.eventId });
    L.add('redo', { target: ok2.eventId });
    L.add('pause', { reason: 'user' }, 250000);
    L.add('retake', { toCheckpoint: 'c0002' }, 250000);
    L.add('retake', { toCheckpoint: 'c0001' }, 250000); // 連続：さらに前の OK へ。c0002 の分は確定でなくなる
    L.add('resume', {}, 250000);
    L.add('durable', {}, 298000); // 実際の録音では、再開のあと保存位置の記録が書かれる（reduceEvents は、それまでを録音の続きとして残す）
    L.add('recovered', { lastCheckpointId: 'c0001', notes: 'actual-end-pos:300000' }, 300000); // 録音中に途切れた
    L.add('ok', { checkpointId: 'c0003' }, 300000); // 続きを採用
    L.add('resume', {}, 300000);
    L.add('durable', {}, 339000);
    L.add('recovered', { lastCheckpointId: 'c0003', notes: 'actual-end-pos:340000' }, 340000);
    L.add('retake', { toCheckpoint: 'c0003' }, 340000); // 最後の OK から撮り直す
    L.add('retake', { toCheckpoint: null }, 340000); // テイクの最初まで
    const seen = assertMatchesEveryPrefix(L.events);
    assert.equal(seen[seen.length - 1], 0, '最後は 0');
    assert.ok(seen.includes(96000) && seen.includes(96000 + 72000), '途中で 2 秒、3.5 秒になった');
    assert.ok(Math.max(...seen) > 150000);
  });

  test('スライド区切り：スライドごとの採用の合計。次へ、前のスライドへ戻って録り直すと、置き換わる', () => {
    const L = Log();
    L.add('session-start', { sessionId: 'sess0002' });
    L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, 0);
    L.add('ok', { checkpointId: 'c0001' }, 48000);
    L.add('next-slide', { checkpointId: 'c0002', nextSlideId: 's0002' }, 96000); // s0001 は 2 秒
    L.add('rec-start', { slideId: 's0002', takeId: 't0002' }, 96000);
    L.add('ok', { checkpointId: 'c0003' }, 144000); // s0002 は 1 秒（合計 3 秒）
    L.add('pause', { reason: 'user' }, 150000);
    L.add('goto-slide', { slideId: 's0001' });
    L.add('rec-start', { slideId: 's0001', takeId: 't0003' }, 150000); // 録り直し。OK までは s0001 は t0001 のまま
    L.add('mark', {}, 160000);
    const okNew = L.add('ok', { checkpointId: 'c0004' }, 170000); // s0001 は 20000 に置き換わる
    L.add('undo', { target: okNew.eventId }); // 元に戻る
    L.add('redo', { target: okNew.eventId });
    L.add('pause', { reason: 'user' }, 175000);
    L.add('retake', { toCheckpoint: null }, 175000); // t0003 を全部撮り直す：s0001 は t0001 に戻る
    const seen = assertMatchesEveryPrefix(L.events);
    assert.ok(seen.includes(144000), '2 スライドで 3 秒');
    assert.equal(seen[seen.length - 1], 144000, '最後は t0001 の 2 秒と s0002 の 1 秒');
  });

  test('未確定は pendingSamples：OK 以降の録音だけ。確定と未確定の和は、撮り直さない限り録音の長さ', () => {
    const L = Log();
    L.add('rec-start', { slideId: 'free', takeId: 't0001' }, 0);
    L.add('ok', { checkpointId: 'c0001' }, 96000);
    const st = track(L.events);
    assert.equal(confirmedSamples(st), 96000);
    assert.equal(pendingSamples(st, 96000 + 12000), 12000);
    assert.equal(confirmedSamples(st) + pendingSamples(st, 96000 + 12000), 108000);
    assert.equal(confirmedSamples(track([])), 0, '空の記録では 0');
  });
});

describe('カウントダウンが無い：設定と文言', () => {
  test('readConfig に countdownSec は無く、URL パラメーター countdown は何もしない（release でも debug でも）', () => {
    for (const q of ['', '?countdown=3', '?devinput=1&countdown=0', '?lapdev=1&countdown=9']) {
      assert.equal('countdownSec' in readConfig(q, false), false, q);
      assert.equal('countdownSec' in readConfig(q, true), false, q);
    }
    assert.deepEqual(readConfig('?lapdev=1&countdown=7', false), readConfig('?lapdev=1', false), 'countdown を付けても設定は同じ');
  });

  test('文言：確定／未確定が ja と en にあり、カウントダウンの文言は無い', () => {
    assert.equal(STRINGS.ja['rec.confirmed'], '確定 {time}');
    assert.equal(STRINGS.ja['rec.unconfirmed'], '＋{time}（未確定）');
    assert.equal(STRINGS.en['rec.confirmed'], 'Saved {time}');
    assert.equal(STRINGS.en['rec.unconfirmed'], '+{time} (not saved yet)');
    for (const lang of ['ja', 'en']) {
      assert.equal('rec.countdown' in STRINGS[lang], false);
      assert.equal('rec.status.counting' in STRINGS[lang], false);
    }
    setLang('ja');
    assert.equal(t('rec.confirmed', { time: '1:58' }), '確定 1:58');
    assert.equal(t('rec.unconfirmed', { time: '0:23' }), '＋0:23（未確定）');
    setLang('en');
    assert.equal(t('rec.confirmed', { time: '1:58' }), 'Saved 1:58');
    assert.equal(t('rec.unconfirmed', { time: '0:23' }), '+0:23 (not saved yet)');
    setLang('ja');
  });
});

// ---------------------------------------------------------------- (2)(3) 画面（Chrome）

describe('録音中の画面：確定した録音時間、カウントダウンが無いこと', { skip }, () => {
  let server; let chrome;
  const extra = [];
  before(async () => {
    await acquireBrowserLock(); // ブラウザを使う試験ファイルは 1 つずつ動かす
    server = await startStaticServer({ port: 8116 });
    chrome = await launchChrome({ name: 'confirmed', port: 8117 });
  });
  after(async () => {
    for (const c of [chrome, ...extra]) { try { if (c) await c.close(); } catch { /* 無視 */ } }
    if (server) await server.close();
    releaseBrowserLock();
  });

  const pcm = (sec, seed = 1) => makePcm(Math.round(RATE * sec), { seed });
  /** 画面の「確定」「未確定」の文字（日本語でも英語でも読む）から、秒数を読む。 */
  const shown = async (page) => {
    const conf = await page.textContent('#t-confirmed');
    const pend = await page.textContent('#t-unconfirmed');
    const sec = (s) => { const m = /(\d+):(\d\d)/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    return { conf, pend, confSec: sec(conf), pendSec: sec(pend) };
  };
  const expectShown = async (page, confSec, pendSec, what) => {
    let last;
    await waitUntil(async () => { last = await shown(page); return last.confSec === confSec && last.pendSec === pendSec; }, { what: `${what}（確定 ${confSec} 秒、未確定 ${pendSec} 秒）`, timeoutMs: 8000 })
      .catch((e) => { throw new Error(`${e.message}：実際 ${JSON.stringify(last)}`); });
  };
  /** state() の確定の数字が、操作記録を reduceEvents に通した結果と一致する。 */
  const matchesReduce = async (app) => {
    const st = await app.state();
    const events = await app.events();
    const r = reduceEvents(events, st.rawFiles.map((x) => ({ name: x.name, sampleRate: x.sampleRate, samples: x.samples })));
    const want = r.takes.filter((tk) => r.defaultTakes[tk.slideId] === tk.takeId).reduce((n, tk) => n + tk.samples, 0);
    assert.equal(st.confirmedSamples, want, `画面の確定 ${st.confirmedSamples} = reduceEvents の採用 ${want}`);
    return st;
  };

  test('録音を押したら待たずに始まる（?countdown=3 を付けても）。録音の位置は変わらない（at）', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=3&durableMs=250');
    const sessionId = await app.page.evaluate(() => window.__lap.newSession(null, { mode: 'continuous' }));
    assert.ok(sessionId);
    const t0 = Date.now();
    const r = await app.press('record');
    const took = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.ok(took < 1500, `録音の開始まで ${took} ms（カウントダウンの 3 秒を待たない）`);
    assert.equal((await app.state()).mode, 'recording', '押した直後に録音中（準備の状態を経ない）');
    assert.equal(await app.page.evaluate(() => document.getElementById('countdown')), null, '画面にカウントダウンの要素が無い');
    await app.feed(pcm(1));
    assert.equal((await app.press('pause')).ok, true);
    const t1 = Date.now();
    const r2 = await app.press('record');
    assert.equal(r2.type, 'resume');
    assert.ok(Date.now() - t1 < 1500, '再開も待たない');
    await app.feed(pcm(0.5));
    await app.press('pause');
    const ev = await app.events();
    const rec = ev.find((e) => e.type === 'rec-start');
    const pauses = ev.filter((e) => e.type === 'pause');
    const resume = ev.find((e) => e.type === 'resume');
    assert.deepEqual([rec.at.sample, rec.at.pos], [0, 0], '録音の始まりは録音ファイルの先頭');
    assert.equal(pauses[0].at.pos, RATE, '1 秒流して止めた位置');
    assert.equal(resume.at.pos, pauses[0].at.pos, '再開の位置は、止めた位置のまま');
    assert.equal(pauses[1].at.pos, RATE * 1.5);
    const st = await app.state();
    assert.equal(st.rawFiles.reduce((n, x) => n + x.samples, 0), RATE * 1.5, '入れた音だけが入っている');
    assert.deepEqual(app.errors, []);
    await app.page.close();
  });

  test('通しの録音：OK、撮り直し、取り消し／やり直しのたびに「確定」と「未確定」が正しく変わる', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&durableMs=250');
    await app.page.evaluate(() => window.__lap.newSession(null, { mode: 'continuous' }));
    await expectShown(app.page, 0, 0, '始めたとき');
    assert.match(await app.page.textContent('#t-confirmed'), /^(Saved|確定) 0:00$/);
    assert.match(await app.page.textContent('#t-unconfirmed'), /^(\+0:00 \(not saved yet\)|＋0:00（未確定）)$/);
    await app.press('record');
    await app.feed(pcm(2, 2));
    await expectShown(app.page, 0, 2, '録音中の 2 秒は未確定');
    assert.equal((await app.press('ok')).ok, true);
    await expectShown(app.page, 2, 0, 'OK で確定');
    await app.feed(pcm(1.5, 3));
    await expectShown(app.page, 2, 1, 'OK のあとの 1.5 秒は未確定（表示は切り捨て）');
    assert.equal((await app.press('retake')).to, 'c0001');
    await expectShown(app.page, 2, 0, '撮り直し：最後の OK まで戻る。確定は変わらず、未確定は 0');
    await matchesReduce(app);
    assert.equal((await app.press('record')).type, 'resume');
    await app.feed(pcm(3, 4));
    assert.equal((await app.press('ok')).ok, true);
    await expectShown(app.page, 5, 0, '再開して録り、OK');
    await matchesReduce(app);
    assert.equal((await app.press('undo')).ok, true);
    await expectShown(app.page, 2, 3, '取り消し：確定は 2 秒に戻り、OK 以降の 3 秒が未確定に戻る');
    assert.equal((await app.press('redo')).ok, true);
    await expectShown(app.page, 5, 0, 'やり直し');
    // 続けて 2 回撮り直す：さらに前の OK まで戻る（確定が減るのは、その分を捨てたから）
    await app.feed(pcm(0.5, 5));
    assert.equal((await app.press('retake')).to, 'c0002');
    await expectShown(app.page, 5, 0, '1 回目の撮り直し');
    assert.equal((await app.press('retake')).to, 'c0001');
    await expectShown(app.page, 2, 0, '2 回目の撮り直し：c0002 の分は確定でなくなる');
    const st = await matchesReduce(app);
    assert.equal(st.confirmedSamples, RATE * 2);
    // 画面が狭くても、折り返して収まる（横にあふれない）
    await app.page.setViewportSize({ width: 320, height: 640 });
    const over = await app.page.evaluate(() => {
      const a = document.getElementById('t-confirmed').getBoundingClientRect();
      const b = document.getElementById('t-unconfirmed').getBoundingClientRect();
      return { right: Math.max(a.right, b.right), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
    });
    assert.ok(over.right <= over.vw + 1 && over.sw <= over.vw + 1, `320 px の幅に収まる ${JSON.stringify(over)}`);
    // 既存の「最後の OK」と「復旧できる位置」の表示は残っている
    assert.ok(await app.page.isVisible('#last-ok'));
    assert.ok(await app.page.isVisible('#durable-pos'));
    assert.deepEqual(app.errors, []);
    await app.page.close();
  });

  test('スライド区切りモード：全スライドの確定の合計。次へ、前のスライドへ戻って録り直す', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&durableMs=250');
    const projectId = await app.loadScript(makeScript({ slides: 3, projectId: 'proj-confirmed' }));
    await app.newSession(projectId); // 試験用の入口の既定はスライド区切り
    await app.press('record');
    await app.feed(pcm(1, 6));
    assert.equal((await app.press('ok')).ok, true);
    await expectShown(app.page, 1, 0, 's1 の 1 秒を確定');
    await app.feed(pcm(0.5, 7));
    const nx = await app.press('next'); // 録音中の「次へ」は、止めずに続ける（ラップ式）。0.5 秒も確定する
    assert.equal(nx.ok, true);
    await expectShown(app.page, 1, 0, '次のスライドへ：直前の 0.5 秒も確定（合計 1.5 秒。表示は切り捨て）');
    await app.feed(pcm(2, 8));
    await expectShown(app.page, 1, 2, 's2 の 2 秒は未確定');
    assert.equal((await app.press('ok')).ok, true);
    await expectShown(app.page, 3, 0, 's2 を OK：全スライドの合計 3.5 秒');
    await matchesReduce(app);
    assert.equal((await app.press('undo')).ok, true);
    await expectShown(app.page, 1, 2, '取り消し');
    assert.equal((await app.press('redo')).ok, true);
    await app.press('pause');
    // s1 へ戻って録り直す：最初の OK までは s1 の前のテイクのまま。OK で置き換わる
    assert.equal((await app.press('goto', 's0001')).ok, true);
    await app.press('record');
    await app.feed(pcm(1, 9));
    await expectShown(app.page, 3, 1, '録り直しの途中：確定は変わらない（3.5 秒）');
    await app.press('ok');
    await expectShown(app.page, 3, 0, '録り直しを OK：s1 は 1 秒に置き換わり、合計は 3 秒');
    await matchesReduce(app);
    assert.deepEqual(app.errors, []);
    await app.page.close();
  });

  test('強制終了からの復旧：確定は OK までのまま。続きを採用すると増え、取り消すと戻り、最後の OK から撮り直しても確定は変わらない', async () => {
    const q = '?devinput=1&durableMs=250&nosw=1';
    const c1 = await launchChrome({ name: 'confirmed-crash', port: 8118 });
    extra.push(c1);
    const A = await openApp(c1, server.origin, q);
    const sessionId = await A.page.evaluate(() => window.__lap.newSession(null, { mode: 'continuous' }));
    await A.press('record');
    await A.feed(pcm(2, 10));
    assert.equal((await A.press('ok')).ok, true);
    await A.feed(pcm(1.5, 11)); // OK を押す前に強制終了される分
    await waitUntil(async () => (await A.durable()).pos >= Math.round(RATE * 3.2), { what: '保存位置が進む', timeoutMs: 20000 });
    c1.kill();
    // 同じプロフィールで開き直す（ポートは別）
    const c2 = await launchChrome({ name: 'confirmed-crash', port: 8115, fresh: false });
    extra.push(c2);
    const B = await openApp(c2, server.origin, q);
    const opened = await B.openSession(sessionId);
    assert.ok(opened.recovery, '復旧の手順に入った');
    const st0 = await matchesReduce(B);
    assert.equal(st0.confirmedSamples, RATE * 2, '復旧の直後：確定は OK の位置まで');
    const cont = opened.recovery.continuationSamples;
    assert.ok(cont >= Math.round(RATE * 1.1) && cont <= Math.round(RATE * 1.5), `続きの長さ ${cont}`);
    await waitUntil(async () => (await shown(B.page)).confSec === 2, { what: '復旧後の確定の表示', timeoutMs: 8000 });
    assert.equal((await shown(B.page)).pendSec, Math.floor(cont / RATE), '未確定は続きの長さ（切り捨て）');
    // 続きを採用：確定が増える
    assert.equal((await B.press('adopt')).ok, true);
    const st1 = await matchesReduce(B);
    assert.equal(st1.confirmedSamples, RATE * 2 + cont);
    await expectShown(B.page, Math.floor((RATE * 2 + cont) / RATE), 0, '続きを採用');
    // 取り消す：選択が無かったことになり、確定は OK までに戻る
    assert.equal((await B.press('undo')).ok, true);
    const st2 = await matchesReduce(B);
    assert.equal(st2.confirmedSamples, RATE * 2);
    await expectShown(B.page, 2, Math.floor(cont / RATE), '採用を取り消し');
    // 最後の OK から撮り直す：確定は変わらず、未確定は 0
    assert.equal((await B.press('retake-recovery')).ok, true);
    const st3 = await matchesReduce(B);
    assert.equal(st3.confirmedSamples, RATE * 2);
    await expectShown(B.page, 2, 0, '最後の OK から撮り直す');
    // 録音を再開して録る：復旧のあとでも確定の数字が正しい
    assert.equal((await B.press('record')).type, 'resume');
    await B.feed(pcm(1, 12));
    await expectShown(B.page, 2, 1, '再開');
    await B.press('ok');
    await expectShown(B.page, 3, 0, '再開して OK');
    await matchesReduce(B);
    assert.deepEqual(B.errors, []);
  });
});
