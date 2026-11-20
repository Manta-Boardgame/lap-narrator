// T3 (2)：Chrome の偽のマイク入力（--use-fake-device-for-media-stream、--use-file-for-fake-audio-capture）で、
// 本物の経路（getUserMedia → AudioWorklet → Worker → OPFS）の実時間の録音を試す。実際のマイクは使わない。音は出さない（--mute-audio）。
// あわせて、本物の経路で録音中に強制終了し、復旧できることを確かめる。
// ブラウザ：work/B/profile-mic*。ポート 8104〜8107。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { startStaticServer } from './helpers/static-server.js';
import { launchChrome, chromePath, waitUntil, sleep, WORK } from './helpers/chrome.js';
import { openApp } from './helpers/app-page.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { makeScript, makePcm, writeWavFile } from './helpers/fixtures.js';
import { validate } from '../../core/validate.js';
import { reduceEvents } from '../../core/reduce.js';

const skip = chromePath() ? false : 'Chrome がない';
const RATE = 48000;
const rms = (i16) => { let s = 0; for (const v of i16) s += v * v; return Math.sqrt(s / Math.max(1, i16.length)); };

describe('偽のマイク入力（本物の経路）', { skip }, () => {
  let server; let wav; const browsers = [];
  const source = makePcm(RATE * 30, { seed: 3, amp: 0.4 });
  before(async () => {
    await acquireBrowserLock(); // ブラウザを使う試験ファイルは 1 つずつ動かす
    server = await startStaticServer({ port: 8104 });
    wav = writeWavFile(path.join(WORK, 'fake-mic.wav'), source, RATE);
  });
  after(async () => {
    for (const b of browsers) { try { await b.close(); } catch { /* 無視 */ } }
    if (server) await server.close();
    releaseBrowserLock();
  });

  test('実時間で録音でき、保存される：取得した数と書き込んだ数が一致し、欠落がなく、音が入っている', async () => {
    const chrome = await launchChrome({ name: 'mic', port: 8105, fakeWav: wav });
    browsers.push(chrome);
    const app = await openApp(chrome, server.origin, '?lapdev=1&durableMs=1000&testMs=1500');
    const projectId = await app.loadScript(makeScript({ slides: 3, projectId: 'proj-mic001' }));
    const sessionId = await app.newSession(projectId);
    const page = app.page;
    await page.waitForSelector('#view-record:not([hidden])');

    const before = await app.state();
    assert.equal(before.sourceKind, 'mic');
    // 要求した値と実際の値が別々に記録される。echoCancellation と autoGainControl は切ることを要求
    assert.equal(before.mic.requested.echoCancellation, false);
    assert.equal(before.mic.requested.autoGainControl, false);
    assert.ok('sampleRate' in before.mic.actual);
    assert.ok(before.mic.actual.contextSampleRate >= 8000);

    // 画面のボタンで操作する。カウントダウンは無く、押したらすぐ（マイクの準備のぶんだけ待って）録音が始まる
    const t0 = Date.now();
    await page.click('#btn-record');
    assert.equal(await page.$('#countdown'), null, '画面にカウントダウンの要素が無い');
    await waitUntil(async () => (await app.state()).recording, { timeoutMs: 8000, what: '録音の開始' });
    const startedAfter = Date.now() - t0;
    assert.ok(startedAfter < 2500, `押してすぐに始まる（実際 ${startedAfter} ms。以前のカウントダウンの 3 秒は無い）`);
    const tRec = Date.now();
    await sleep(4000);
    await page.click('#btn-ok');
    await waitUntil(async () => (await app.state()).checkpoints.length === 1, { what: 'OK' });
    // 音量計が動いている
    const level = await page.evaluate(() => getComputedStyle(document.getElementById('meter-fill')).getPropertyValue('--level'));
    assert.ok(Number(level) > 0, `音量計が動く（--level=${level}）`);
    await sleep(1500);
    await page.click('#btn-pause');
    await waitUntil(async () => !(await app.state()).recording, { what: '一時停止' });
    const wallSec = (Date.now() - tRec) / 1000;

    const st = await app.state();
    assert.equal(st.rawFiles.length, 1);
    const samples = st.rawFiles[0].samples;
    const sec = samples / st.sampleRate;
    assert.ok(Math.abs(sec - wallSec) < 0.8, `録れた長さ ${sec.toFixed(2)} 秒 ≒ 実時間 ${wallSec.toFixed(2)} 秒`);
    assert.equal(st.stats.captured, st.stats.written, '取得したサンプル数 = 書き込んだサンプル数');
    assert.equal(st.stats.captured, samples);
    assert.equal(st.stats.gaps, 0, 'フレームの欠落がない');
    assert.equal(st.stats.dropped, 0);

    // 音が入っている（偽のマイクの音の大きさに近い）
    const pcm = new Int16Array((await app.readRaw('rec-000001')).buffer.slice(0));
    assert.equal(pcm.length, samples);
    const ratio = rms(pcm) / rms(source.subarray(0, samples));
    assert.ok(ratio > 0.5 && ratio < 1.5, `音の大きさが入力に近い（比 ${ratio.toFixed(2)}）`);
    assert.ok(pcm.some((v) => Math.abs(v) > 3000));

    // 操作記録：durable が約 1 秒ごと、OK、一時停止。各行がスキーマに通り、core の解釈に通る
    const events = await app.events();
    events.forEach((e) => assert.deepEqual(validate('events', e).errors, [], `seq ${e.seq}`));
    const durables = events.filter((e) => e.type === 'durable');
    assert.ok(durables.length >= 5, `約 1 秒ごとの durable（${durables.length} 件）`);
    const gaps = durables.slice(1).map((d, i) => (d.at.pos - durables[i].at.pos) / st.sampleRate);
    assert.ok(gaps.slice(0, -1).every((g) => g > 0.9 && g < 1.3), `間隔 ${gaps.map((g) => g.toFixed(2))}`);
    assert.deepEqual(events.map((e) => e.type).filter((t) => t !== 'durable'), ['session-start', 'rec-start', 'ok', 'pause']);
    const ok = events.find((e) => e.type === 'ok');
    assert.ok(Math.abs(ok.at.sample / st.sampleRate - 4) < 0.6, 'OK の位置が押した時刻に近い');
    const reduced = reduceEvents(events, st.rawFiles.map((r) => ({ ...r })));
    assert.deepEqual(reduced.issues, []);
    assert.equal(reduced.takes[0].samples, ok.at.sample, '採用は OK の位置まで');
    assert.equal(sessionId.length, 12);

    // 試し録り（本物の経路）：音量が出る。録音ファイルは変わらない
    const tr = await app.press('test', { speed: 16 });
    assert.equal(tr.ok, true);
    assert.ok(Math.abs(tr.durationMs - 1500) < 300, `試し録りの長さ ${tr.durationMs} ms`);
    assert.ok(tr.rmsDb > -30 && tr.clipped === 0, JSON.stringify(tr));
    assert.deepEqual((await app.state()).rawFiles.map((r) => r.samples), [samples]);
    assert.equal(await page.evaluate((id) => window.__lap.testTempExists(id), sessionId), false);
    assert.equal((await app.events()).at(-1).type, 'test-rec');
    assert.deepEqual(app.errors, []);
    await page.close();
  });

  test('本物の経路で録音中に強制終了：開き直すと、保存されていた音声の終わりまで復旧し、再生できる', async () => {
    const c1 = await launchChrome({ name: 'micCrash', port: 8106, fakeWav: wav });
    browsers.push(c1);
    const a1 = await openApp(c1, server.origin, '?lapdev=1&countdown=0&durableMs=500');
    const projectId = await a1.loadScript(makeScript({ slides: 3, projectId: 'proj-mic002' }));
    const sessionId = await a1.newSession(projectId);
    await a1.press('record');
    await sleep(1800);
    await a1.press('ok');
    await sleep(2200);
    c1.kill(); // 録音中に強制終了（自分が起動した pid だけ）
    assert.equal(c1.exited, true);

    const c2 = await launchChrome({ name: 'micCrash', port: 8107, fakeWav: wav, fresh: false });
    browsers.push(c2);
    const a2 = await openApp(c2, server.origin, '?lapdev=1&countdown=0');
    const diskBefore = await a2.rawSizesOnDisk(sessionId);
    const logBefore = await a2.eventsOnDisk(sessionId);
    const diskSamples = Object.values(diskBefore).reduce((n, b) => n + b / 2, 0);
    const opened = await a2.openSession(sessionId);
    const r = opened.recovery;
    assert.ok(r, '復旧の手順に入った');
    assert.ok(diskSamples > RATE * 3, `強制終了の前に ${(diskSamples / RATE).toFixed(1)} 秒が保存されていた`);
    assert.equal(r.recoveredPos, diskSamples);
    const lastDurable = logBefore.events.filter((e) => e.type === 'durable').at(-1);
    assert.ok(lastDurable.at.pos <= r.recoveredPos);
    assert.ok(r.lastOkPos !== null && r.lastOkPos < r.recoveredPos);
    const played = await a2.page.evaluate(() => window.__lap.playRecovered({ speed: 16 }));
    assert.equal(played.samples, r.continuationSamples);
    assert.equal(played.requested.at(-1).end, r.recoveredPos);
    // マイクは自動で再開していない
    const st = await a2.state();
    assert.equal(st.recording, false);
    assert.equal(st.mic, null);
    await a2.press('adopt');
    const reduced = reduceEvents(await a2.events(), (await a2.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, []);
    assert.equal(reduced.takes[0].samples, r.recoveredPos);
  });
});
