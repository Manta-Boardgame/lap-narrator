// Android の実機の試験（T4 の一部。担当 F）。npm run test:device（npm test には入れない）。
//
// 前提：スマホが USB でつながり、USB デバッグが許可済みで、ロックが解けていること。マイクの許可の画面（Chrome）が出たら、利用者が許可する。
// 流れ（a〜g は dev/PLAN.md の F の指示の項目）：
//   準備   adb で機器の確認 → ポート転送（reverse 8140、forward 9222）→ PC で配信 → Chrome を開く → CDP でつなぐ
//   a, b   録音を始め、約 90 秒録りながら「取得したサンプル数」「書き込んだサンプル数」を標本にして、時計のずれと欠落を分けて報告する
//   c      録音しながら OK、次のスライド（録音を止めない）、印、撮り直しを行い、events.jsonl の中身（端末内のファイル）を確かめる
//   d      録音中に adb で Chrome を強制終了 → 開き直す → 復旧の画面と内容（耐久位置までの音声が残るか）を確かめる
//   f      OPFS の再オープンの時間（強制終了のあとの最初の getDirectory()、openSession）を測る
//   g      書き出し（全記録と完成版）を、ページから CDP 経由で PC に取り出す（スマホの中のファイルは adb で読まない）。CLI の import → status → render
//   e      画面ロック（input keyevent）をまたいだ録音の挙動（Wake Lock、AudioWorklet）。アプリのまま、診断（visibilitychange を無効）の 2 回
// 結果は work/F/device-results.json に残す。環境変数：DEVICE_SCALE（録音の時間の倍率。既定 1）、DEVICE_SKIP_LOCK=1（e を行わない）、
//   DEVICE_UNLOCK_WAIT_SEC（ロックを解くのを待つ秒数。既定 180）、DEVICE_SERIAL（機器番号）
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { readZipDirectory, readZipEntry } from '../../core/zip.js';
import { reduceEvents } from '../../core/reduce.js';
import { Phone, startServer, ROOT, WORK, KEYS, sleep } from './helpers/phone.js';
import { injectSource } from './helpers/inject.js';
import { analyzeClock, analyzeWrite, trailingZeroRun, rmsOf } from './helpers/analyze.js';

const SCALE = Number(process.env.DEVICE_SCALE || 1);
const UNLOCK_WAIT_MS = Number(process.env.DEVICE_UNLOCK_WAIT_SEC || 180) * 1000;
const SKIP_LOCK = process.env.DEVICE_SKIP_LOCK === '1';
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const NARRATE = path.join(ROOT, 'cli', 'narrate.js');
const RESULTS = path.join(WORK, 'device-results.json');
const APP_QUERY = '?lapdev=1&countdown=0&nosw=1';
const NOW = () => new Date().toISOString();
const say = (m) => process.stderr.write(`[F ${NOW().slice(11, 19)}] ${m}\n`);

const R = { startedAt: NOW(), scale: SCALE, steps: {}, notes: [] };
const save = () => { fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(RESULTS, JSON.stringify(R, null, 2) + '\n'); };
const S = {
  skip: null, phone: null, srv: null, cdp: null, samples: [], pollTimer: null, pollBusy: false,
  sessionId: null, projectId: null, rate: null, stepsFailed: [], pageEpoch: 0, clockOffsetMs: 0, killedAt: null, unlockedAfterLock: false,
};
const lap = (expr, o) => S.cdp.eval(expr, o);
const press = (name, arg) => lap(`__lap.press(${JSON.stringify(name)}, ${JSON.stringify(arg ?? null)})`, { userGesture: true, timeoutMs: 60000 });
const ms = (t0) => Math.round(performance.now() - t0);

// ---- 標本の採取（ページの中で 400 ミリ秒ごとに採り、PC が取りに行く。ページが殺されても、PC に残る） ------------------------
async function drainOnce() {
  const a = await S.cdp.eval('window.__f ? window.__f.take() : []', { timeoutMs: 4000 });
  const pcAt = Date.now();
  for (const x of a) S.samples.push({ ...x, pcAt, epoch: S.pageEpoch });
}
function startPoll(everyMs = 350) {
  stopPoll();
  S.pollTimer = setInterval(async () => {
    if (S.pollBusy || !S.cdp || S.cdp.closed) return;
    S.pollBusy = true;
    try { await drainOnce(); } catch { /* ページが無い間は無視 */ } finally { S.pollBusy = false; }
  }, everyMs);
}
function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
async function drain() { try { await drainOnce(); } catch { /* 無視 */ } }
const lastSample = () => S.samples.filter((s) => s.epoch === S.pageEpoch && !s.err).at(-1);
/** 同じ epoch の標本を、取得数が戻る所（録音の開始）で分ける。 */
function splitArms(samples) {
  const arms = [];
  let cur = null;
  for (const s of samples) {
    if (s.err || s.captured === undefined) continue;
    if (!cur || s.epoch !== cur.epoch || s.captured < cur.last) { cur = { epoch: s.epoch, last: 0, samples: [] }; arms.push(cur); }
    cur.samples.push(s);
    cur.last = s.captured;
  }
  return arms.filter((a) => a.samples.some((s) => s.captured > 0));
}

// ---- ページを開く ----------------------------------------------------------------------------------------------
async function openApp(att, { dropVisibility = false, label = 'open' } = {}) {
  S.cdp = att.cdp;
  S.pageEpoch++;
  const cdp = att.cdp;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource({ dropVisibility }) });
  const t0 = performance.now();
  await cdp.send('Page.navigate', { url: `${S.phone.origin}/app/index.html${APP_QUERY}` });
  for (let i = 0; i < 150; i++) {
    if (await cdp.eval('!!window.__lap && !!window.__f').catch(() => false)) break;
    await sleep(100);
  }
  const navToLapMs = ms(t0);
  assert.ok(await cdp.eval('!!window.__lap'), 'window.__lap が出ない（?lapdev=1）');
  await cdp.eval('window.__f.start(400)');
  startPoll();
  await sleep(300);
  const probe = await cdp.eval('window.__opfsProbe');
  return { label, navToLapMs, firstGetDirectoryMs: probe.calls[0] ? Math.round(probe.calls[0].ms) : null, getDirectoryCalls: probe.calls.length };
}

async function waitUnlocked(why) {
  const u = await S.phone.ensureUnlocked({ waitMs: UNLOCK_WAIT_MS, say });
  if (!u.unlocked) throw new Error(`phone-locked: ${why}。スマホのロックが解けませんでした（${Math.round(u.waitedMs / 1000)} 秒待った）`);
  return u;
}

const micState = () => lap("navigator.permissions.query({name:'microphone'}).then(r=>r.state).catch(e=>'error:'+e.message)");

const runNode = (args, { timeoutMs = 300000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  const timer = setTimeout(() => { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }); }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
});
async function narrate(args) {
  const r = await runNode([NARRATE, ...args]);
  let env = null;
  try { env = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { /* 無視 */ }
  return { code: r.code, env, stderr: r.stderr.slice(-2000) };
}

async function loadPack() {
  const buf = fs.readFileSync(PACK);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = async (s, e) => u8.slice(s, e);
  const dir = await readZipDirectory(read, u8.length);
  const get = async (name) => { const e = dir.find((x) => x.name === name); const parts = []; for await (const c of readZipEntry(read, e)) parts.push(c); return Buffer.concat(parts); };
  const script = JSON.parse((await get('script.json')).toString('utf8'));
  const images = {};
  for (const s of script.slides) images[s.image] = (await get(s.image)).toString('base64');
  return { script, images };
}

async function cleanup() {
  stopPoll();
  if (S.phone) S.phone.stopKeepAlive();
  try {
    if (S.cdp && !S.cdp.closed) {
      // この試験が作ったデータ（録音、台本、書き出しの一時ファイル）を、ページから消す。録音の声が端末に残らないように。
      await S.cdp.eval(`(async () => { try { await window.__lap.closeSession(); } catch {} const root = await navigator.storage.getDirectory(); try { await root.removeEntry('lap', { recursive: true }); return 'removed'; } catch (e) { return 'remove-failed:' + e.name; } })()`, { timeoutMs: 20000 })
        .then((r) => { R.cleanupPageData = r; }).catch((e) => { R.cleanupPageData = `error:${e.message}`; });
    }
  } catch { /* 無視 */ }
  try { if (S.cdp) S.cdp.close(); } catch { /* 無視 */ }
  if (S.phone && S.srv) { // 試験を始めていた（配信を立てた）ときだけ、スマホの後始末をする
    try { await S.phone.cleanupTabs(); } catch { /* 無視 */ }
    try { const st = await S.phone.forceStopChrome(); R.cleanupChromeStop = st.code; } catch { /* 無視 */ }
    try { await S.phone.teardownPorts(); } catch { /* 無視 */ }
  }
  if (S.srv) { try { await S.srv.close(); } catch { /* 無視 */ } S.srv = null; }
  R.finishedAt = NOW();
  save();
}

const step = (name) => ({ name, t0: performance.now() });
const fin = (st, extra = {}) => { R.steps[st.name] = { ...(R.steps[st.name] || {}), ms: ms(st.t0), ...extra }; save(); };
const need = (t, ...flags) => {
  if (S.skip) { t.skip(S.skip); return false; }
  for (const f of flags) if (S.stepsFailed.includes(f)) { t.skip(`前の段 ${f} が通っていない`); return false; }
  return true;
};
const failStep = (flag, e) => { S.stepsFailed.push(flag); R.steps[flag] = { ...(R.steps[flag] || {}), failed: String((e && e.message) || e) }; save(); };

describe('Android の実機（T4 の一部）：録音、強制終了と復旧、OPFS の再オープン、書き出し、CLI、画面ロック', { timeout: 3600000 }, () => {
  before(async () => {
    fs.mkdirSync(WORK, { recursive: true });
    const phone = new Phone({ log: say });
    S.phone = phone;
    const d = await phone.findDevice();
    if (d.error) { S.skip = `実機がない（${d.error} ${JSON.stringify(d.devices || [])}）`; R.skipped = S.skip; save(); return; }
    R.device = await phone.info();
    const sc = await phone.screen();
    R.device.screenAtStart = { wakefulness: sc.wakefulness, keyguard: sc.keyguard, focus: sc.focus };
    save();
    try {
      await waitUnlocked('開始');
    } catch (e) { S.skip = e.message; R.skipped = S.skip; save(); return; }
    S.srv = await startServer(phone.servePort);
    await phone.setupPorts();
    phone.startKeepAlive();
  });

  after(async () => { await cleanup(); });

  // ------------------------------------------------------------------------------------------------ 準備
  test('0 準備：Chrome を開き、CDP でつなぐ', async (t) => {
    if (!need(t)) return;
    const st = step('0-setup');
    try {
      const att = await S.phone.relaunch();
      R.chrome = { browser: att.devtools.Browser, protocol: att.devtools['Protocol-Version'], userAgent: att.devtools['User-Agent'], v8: att.devtools['V8-Version'] };
      const o = await openApp(att, { label: 'first-open' });
      R.firstOpen = { ...o, relaunchMs: att.ms, devtoolsMs: att.devtoolsMs };
      const feat = await lap('({ secure: isSecureContext, wakeLock: !!navigator.wakeLock, audioWorklet: !!window.AudioWorklet, syncAccess: typeof FileSystemSyncAccessHandle, cores: navigator.hardwareConcurrency, memGB: navigator.deviceMemory ?? null })');
      feat.persisted = await lap('navigator.storage.persisted()');
      feat.estimate = await lap('navigator.storage.estimate().then(e => ({ quota: e.quota, usage: e.usage }))');
      R.pageFeatures = feat;
      // PC とスマホの時計の差（往復の中間で測る）。標本の時刻の突き合わせに使う
      const offs = [];
      for (let i = 0; i < 5; i++) { const a = Date.now(); const w = await lap('Date.now()'); const b = Date.now(); offs.push(w - (a + b) / 2); }
      offs.sort((x, y) => x - y);
      S.clockOffsetMs = offs[2];
      R.clockOffsetMs = Math.round(S.clockOffsetMs);
      assert.ok(feat.secure && feat.wakeLock && feat.audioWorklet, `機能が足りない: ${JSON.stringify(feat)}`);
      assert.ok(S.srv.log.some((l) => l.url.includes('/app/index.html')), 'PC の配信にスマホから要求が届いていない');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('0', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ a, b, c
  test('a b c 録音（実マイク）、標本、OK、次のスライド、印、撮り直し、events.jsonl', async (t) => {
    if (!need(t, '0')) return;
    const st = step('abc-record');
    try {
      const { script, images } = await loadPack();
      S.projectId = script.projectId;
      await lap(`__lap.loadScript(${JSON.stringify(script)}, ${JSON.stringify(images)})`);
      const perm0 = await micState();
      R.micPermissionBefore = perm0;
      assert.notEqual(perm0, 'denied', 'マイクが拒否されている。Chrome のサイトの設定でマイクを許可してください');
      if (perm0 !== 'granted') say('スマホの Chrome にマイクの許可の画面が出ます。許可してください（最大 3 分待ちます）。');
      const tPrompt = performance.now();
      S.sessionId = await lap(`__lap.newSession(${JSON.stringify(S.projectId)}, { speaker: 'device-test' })`, { userGesture: true, timeoutMs: 190000 });
      R.micPromptWaitMs = ms(tPrompt);
      R.micPermissionAfter = await micState();
      const info = await lap('__lap.state().then(s => ({ rate: s.sampleRate, mic: s.mic, sourceKind: s.sourceKind }))');
      S.rate = info.rate;
      R.mic = info.mic;
      R.sampleRate = info.rate;
      assert.equal(info.sourceKind, 'mic', 'マイクの経路ではない');

      // 録音を始める。時間割（SCALE 倍）。次のスライドは録音を止めない形（next-slide と rec-start が同じ位置）
      const K = (s) => Math.round(s * SCALE * 1000);
      const ops = [];
      const timeline = [[10, 'ok'], [20, 'next'], [30, 'mark'], [45, 'ok'], [60, 'next'], [75, 'ok'], [90, 'retake']];
      console.log('[F] これから約 95 秒録音します。録音中はスマホの画面に触れないでください（画面の操作が OK、次へなどの操作として記録されます）。');
      const rec = await press('record');
      const t0 = Date.now();
      R.recordStart = rec;
      assert.ok(rec && rec.ok, `録音が始まらない: ${JSON.stringify(rec)}`);
      for (const [sec, name] of timeline) {
        const wait = t0 + K(sec) - Date.now();
        if (wait > 0) await sleep(wait);
        const snap = () => lap('__lap.state().then(s => ({ slideId: s.slideId, mode: s.mode, recording: s.recording, events: s.eventCount, vis: document.visibilityState }))').catch((e) => ({ error: e.message }));
        const before = await snap();
        const a = performance.now();
        const r = await press(name, name === 'mark' ? 'device' : undefined);
        const after = await snap();
        ops.push({ atSec: (Date.now() - t0) / 1000, name, result: r, ms: ms(a), before, after });
      }
      R.ops = ops;
      await sleep(600);
      await drain();
      // 失敗の原因を切り分けるための記録（操作記録の全部、可視状態の記録、標本）を、判定の前に残す
      R.trace = {
        events: await lap('__lap.events()'), diag: await lap('window.__diag()'),
        samples: S.samples.filter((x) => x.epoch === S.pageEpoch && !x.err).map((x) => ({ t: Math.round(x.t), captured: x.captured, written: x.written, gaps: x.gaps, rec: x.rec, vis: x.vis, ctx: x.ctx, wake: x.wake })),
      };
      R.opFailures = ops.filter((o) => !(o.result && o.result.ok !== false)).map((o) => ({ name: o.name, atSec: o.atSec, result: o.result, before: o.before }));
      save();
      const finalStats = await lap('__lap.sync()');
      R.longArmFinalStats = finalStats && { captured: finalStats.captured, written: finalStats.written, gaps: finalStats.gaps, dropped: finalStats.dropped };

      // ---- b：時計のずれと欠落
      const arms = splitArms(S.samples.filter((x) => x.epoch === S.pageEpoch));
      const longArm = arms.reduce((a, b) => (b.samples.length > a.samples.length ? b : a));
      const clock = analyzeClock(longArm.samples, S.rate);
      const write = analyzeWrite(longArm.samples);
      const ev = await lap('__lap.events()');
      const recStart = ev.find((e) => e.type === 'rec-start');
      const pauseEv = ev.find((e) => e.type === 'pause');
      const appSpanSec = recStart && pauseEv ? (pauseEv.mono - recStart.mono) / 1000 : null;
      const audioSec = finalStats.captured / S.rate;
      R.b = {
        rate: S.rate, arms: arms.map((a) => ({ samples: a.samples.length, lastCaptured: a.last })),
        clock, write,
        final: { captured: finalStats.captured, written: finalStats.written, lag: finalStats.captured - finalStats.written, gaps: finalStats.gaps, dropped: finalStats.dropped },
        audioSec, appSpanSec, appSpanMinusAudioMs: appSpanSec === null ? null : Math.round((appSpanSec - audioSec) * 1000),
        appClockRatio: appSpanSec ? audioSec / appSpanSec : null,
      };

      // ---- c：events.jsonl（端末内のファイル）と、メモリ上の操作記録
      const disk = await lap(`__lap.eventsOnDisk(${JSON.stringify(S.sessionId)})`);
      const types = (list) => list.filter((e) => e.type !== 'durable').map((e) => e.type);
      const expectTypes = ['session-start', 'rec-start', 'ok', 'next-slide', 'rec-start', 'mark', 'ok', 'next-slide', 'rec-start', 'ok', 'pause', 'retake'];
      const durables = disk.events.filter((e) => e.type === 'durable');
      const durGaps = durables.slice(1).map((e, i) => e.at.pos - durables[i].at.pos).filter((x) => x > 0);
      const rawInfos = (await lap('__lap.state().then(s => s.rawFiles)')).map((r) => ({ name: r.name, sampleRate: r.sampleRate, samples: r.samples }));
      const reduced = reduceEvents(disk.events, rawInfos);
      const kept = reduced.segments.filter((g) => g.status === 'kept');
      const disc = reduced.segments.filter((g) => g.status === 'discarded');
      const okEvents = disk.events.filter((e) => e.type === 'ok' || e.type === 'next-slide');
      const lastOkPos = okEvents.length ? okEvents[okEvents.length - 1].at.pos : null;
      R.c = {
        eventsInMemory: ev.length, eventsOnDisk: disk.events.length, droppedBytes: disk.droppedBytes, validBytes: disk.validBytes, totalBytes: disk.totalBytes,
        typesWithoutDurable: types(disk.events), expectedTypes: expectTypes,
        sameAsMemory: JSON.stringify(ev) === JSON.stringify(disk.events),
        durableCount: durables.length, durableIntervalSamples: { min: Math.min(...durGaps), max: Math.max(...durGaps), nominal: S.rate },
        seqContiguous: disk.events.every((e, i) => e.seq === i && e.eventId === `e${i}`),
        reduce: {
          issues: reduced.issues, keptSegments: kept.length, keptSamples: kept.reduce((n, g) => n + (g.end - g.start), 0),
          discardedSegments: disc.length, discardedSamples: disc.reduce((n, g) => n + (g.end - g.start), 0), discardedReasons: [...new Set(disc.map((g) => g.reason))],
          lastOkPos, defaultTakes: reduced.defaultTakes,
        },
        okPositions: okEvents.map((e) => ({ type: e.type, checkpointId: e.checkpointId, pos: e.at.pos })),
        rawFiles: rawInfos,
      };
      assert.deepEqual(R.opFailures, [], '失敗した操作がある（R.trace に操作記録と標本）');
      assert.deepEqual(types(disk.events), expectTypes, 'events.jsonl の種類の並び');
      assert.equal(R.c.sameAsMemory, true, 'メモリ上の操作記録と、端末内の events.jsonl が違う');
      assert.equal(R.c.seqContiguous, true);
      assert.deepEqual(reduced.issues, [], 'reduce の issues');
      assert.equal(R.c.reduce.keptSamples, lastOkPos, '採用した区間の合計が、最後の OK の位置と合わない');
      assert.ok(R.c.reduce.discardedSamples > 0 && R.c.reduce.discardedReasons.includes('retake'), '撮り直した区間が discarded になっていない');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('abc', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ d
  test('d 録音中に強制終了 → 開き直す → 復旧', async (t) => {
    if (!need(t, '0', 'abc')) return;
    const st = step('d-crash-recovery');
    try {
      // 撮り直しのあと、録音を再開（resume）し、何も OK を押さずに約 12 秒録って強制終了する
      const rec = await press('record');
      assert.ok(rec && rec.ok, `再開できない: ${JSON.stringify(rec)}`);
      await sleep(Math.round(12300 * Math.max(0.3, SCALE)));
      await drain();
      const last = lastSample();
      const diskBefore = await lap(`__lap.rawSizesOnDisk(${JSON.stringify(S.sessionId)}).catch(e => ({ error: String(e) }))`);
      const evBefore = await lap(`__lap.eventsOnDisk(${JSON.stringify(S.sessionId)}).then(d => ({ n: d.events.length, durableMax: d.events.filter(e => e.type === 'durable').reduce((m, e) => Math.max(m, e.at.pos), 0), lastType: d.events.at(-1).type })).catch(e => ({ error: String(e) }))`);
      const stopAt = Date.now();
      stopPoll();
      const fs1 = await S.phone.forceStopChrome();
      S.killedAt = Date.now();
      assert.equal(fs1.code, 0, `force-stop が失敗: ${fs1.out}`);
      await sleep(1500);
      const cdpDead = await S.cdp.eval('1', { timeoutMs: 3000 }).then(() => false).catch(() => true);
      await waitUnlocked('強制終了のあと');
      // 開き直す
      const att = await S.phone.relaunch();
      const o = await openApp(att, { label: 'after-force-stop-recording' });
      const t1 = performance.now();
      const opened = await lap(`__lap.openSession(${JSON.stringify(S.sessionId)})`, { timeoutMs: 120000 });
      const openSessionMs = ms(t1);
      const crash = { ...o, relaunchMs: att.ms, devtoolsMs: att.devtoolsMs, openSessionMs, killToPageMs: Date.now() - S.killedAt };
      R.d = { killedAfterLastSampleMs: S.killedAt - stopAt, cdpDeadAfterStop: cdpDead, lastObserved: last && { captured: last.captured, written: last.written, pos: last.pos, durablePos: last.durablePos, workerDurablePos: last.workerDurablePos, raw: last.raw }, diskBefore, evBefore };
      // 復旧の内容
      const state = await lap('__lap.state()');
      const disk = await lap(`__lap.rawSizesOnDisk(${JSON.stringify(S.sessionId)})`);
      const evDisk = await lap(`__lap.eventsOnDisk(${JSON.stringify(S.sessionId)})`);
      const diskSamples = Object.values(disk).reduce((n, b) => n + b / 2, 0);
      const rec1 = opened.recovery;
      const durableMax = evDisk.events.filter((e) => e.type === 'durable').reduce((m, e) => Math.max(m, e.at.pos), 0);
      const recoveredEv = evDisk.events.filter((e) => e.type === 'recovered').at(-1);
      const dlg = await lap(`(() => { const d = document.getElementById('dlg-recovery'); return { open: !!d && d.open, summary: (document.getElementById('rec-summary') || {}).textContent, extra: (document.getElementById('rec-extra') || {}).textContent, durableUi: (document.getElementById('durable-pos') || {}).textContent, lastOkUi: (document.getElementById('last-ok') || {}).textContent }; })()`);
      fs.mkdirSync(path.join(WORK, 'shots'), { recursive: true });
      try {
        const shot = await S.cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
        fs.writeFileSync(path.join(WORK, 'shots', 'recovery.png'), Buffer.from(shot.data, 'base64'));
      } catch (e) { R.notes.push(`screenshot failed: ${e.message}`); }
      // 復旧位置までの音声が読めるか（再生はしない。スピーカーから音を出さないため、中身を読んで確かめる）
      const lastRaw = state.rawFiles.at(-1);
      const b64 = await lap(`__lap.readRawBase64(${JSON.stringify(lastRaw.name)})`, { timeoutMs: 60000 });
      const nb = Buffer.from(b64, 'base64');
      const pcm = new Int16Array(nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.length));
      const lo = Math.max(0, pcm.length - Math.round(S.rate * 0.5));
      R.d.recovery = {
        recoveredPos: rec1 && rec1.recoveredPos, lastOkPos: rec1 && rec1.lastOkPos, lastOkId: rec1 && rec1.lastOkId, continuationSamples: rec1 && rec1.continuationSamples,
        durablePosFromEvents: rec1 && rec1.durablePos, tornTail: rec1 && rec1.tornTail,
        recoveredEvent: recoveredEv && { at: recoveredEv.at, notes: recoveredEv.notes, lastCheckpointId: recoveredEv.lastCheckpointId },
        diskSamplesNow: diskSamples, diskBytes: disk, durableMaxOnDisk: durableMax, droppedTailBytes: state.droppedTailBytes,
        dialog: dlg, lastRawName: lastRaw.name, lastRawSamples: lastRaw.samples, readableSamples: pcm.length,
        tailRms: rmsOf(pcm, lo), headRms: rmsOf(pcm, 0, Math.round(S.rate * 0.5)), trailingZeroRun: trailingZeroRun(pcm),
      };
      const lo2 = R.d.lastObserved;
      R.d.analysis = {
        // 保存されていた音声（ディスク）と、強制終了の前に最後に観察した書き込み位置の差。負なら、書いたはずの音声が残っていない
        diskMinusLastObservedPos: lo2 ? diskSamples - lo2.pos : null,
        diskMinusLastObservedPosSec: lo2 ? (diskSamples - lo2.pos) / S.rate : null,
        recoveredMinusDiskNow: rec1 ? rec1.recoveredPos - diskSamples : null,
        recoveredMinusDurable: rec1 ? rec1.recoveredPos - durableMax : null,
        recoveredMinusLastOk: rec1 && rec1.lastOkPos !== null ? rec1.recoveredPos - rec1.lastOkPos : null,
        lastObservedDurableMinusDurableOnDisk: lo2 && lo2.durablePos != null ? lo2.durablePos - durableMax : null,
      };
      R.f = { crashes: [crash] };
      save();
      // 表示した復旧位置が、保存されていた音声を超えない（超えれば、存在しない音声を聞かせる）。durable 以上（保存位置までは残る）
      assert.ok(rec1, '復旧の情報が出ない（録音中だったはずの記録が復旧にならなかった）');
      assert.ok(rec1.recoveredPos <= diskSamples, `復旧位置 ${rec1.recoveredPos} が保存されていた音声 ${diskSamples} を超える`);
      assert.ok(rec1.recoveredPos >= durableMax, `復旧位置 ${rec1.recoveredPos} が保存位置 ${durableMax} より短い`);
      assert.equal(pcm.length, lastRaw.samples);
      assert.ok(R.d.recovery.headRms > 0, '録音ファイルが無音（0 だけ）');
      // 続きを採用する（OK にする）
      const adopt = await press('adopt');
      R.d.adopt = adopt;
      assert.ok(adopt && adopt.ok, `続きを採用できない: ${JSON.stringify(adopt)}`);
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('d', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ f
  test('f OPFS の再オープン：強制終了（録音していない）とページの再読み込みを繰り返して時間を測る', async (t) => {
    if (!need(t, '0', 'abc', 'd')) return;
    const st = step('f-opfs-reopen');
    try {
      const rows = [];
      // (1) 録音していない状態での強制終了 × 2（コールドな開き直し）
      for (let i = 1; i <= 2; i++) {
        stopPoll();
        const k0 = Date.now();
        await S.phone.forceStopChrome();
        await sleep(1000);
        await waitUnlocked('強制終了のあと');
        const att = await S.phone.relaunch();
        const o = await openApp(att, { label: `cold-idle-${i}` });
        const t1 = performance.now();
        const opened = await lap(`__lap.openSession(${JSON.stringify(S.sessionId)})`, { timeoutMs: 120000 });
        rows.push({ kind: 'force-stop-idle', ...o, relaunchMs: att.ms, openSessionMs: ms(t1), recoveryShown: !!opened.recovery, killToPageMs: Date.now() - k0 });
      }
      // (2) ページの再読み込み（ブラウザは動いたまま）× 3
      for (let i = 1; i <= 3; i++) {
        const t0 = performance.now();
        S.pageEpoch++;
        await S.cdp.send('Page.reload', { ignoreCache: true });
        for (let j = 0; j < 150; j++) { if (await lap('!!window.__lap && !!window.__f').catch(() => false)) break; await sleep(100); }
        const navToLapMs = ms(t0);
        await lap('window.__f.start(400)');
        const probe = await lap('window.__opfsProbe');
        const t1 = performance.now();
        await lap(`__lap.openSession(${JSON.stringify(S.sessionId)})`, { timeoutMs: 60000 });
        rows.push({ kind: 'reload', label: `reload-${i}`, navToLapMs, firstGetDirectoryMs: probe.calls[0] ? Math.round(probe.calls[0].ms) : null, openSessionMs: ms(t1) });
      }
      // (3) 深いところまで歩く時間（getDirectory → lap → sessions → <id> → raw → getFile）
      const deep = await lap(`(async (sid) => { const T = {}; let t = performance.now(); const root = await navigator.storage.getDirectory(); T.getDirectory = performance.now() - t; t = performance.now(); const lap = await root.getDirectoryHandle('lap'); const ses = await lap.getDirectoryHandle('sessions'); const d = await ses.getDirectoryHandle(sid); const raw = await d.getDirectoryHandle('raw'); T.walk = performance.now() - t; t = performance.now(); let n = 0; for await (const [, h] of raw.entries()) { if (h.kind === 'file') { await h.getFile(); n++; } } T.statRawFiles = performance.now() - t; T.rawFiles = n; return T; })(${JSON.stringify(S.sessionId)})`);
      const firsts = rows.map((r) => r.firstGetDirectoryMs).filter((x) => x !== null);
      const all = [R.f.crashes[0].firstGetDirectoryMs, ...firsts].filter((x) => x !== null);
      R.f = { ...R.f, rows, deep, summary: { coldFirstGetDirectoryMs: [R.f.crashes[0].firstGetDirectoryMs, ...rows.filter((r) => r.kind === 'force-stop-idle').map((r) => r.firstGetDirectoryMs)], maxFirstGetDirectoryMs: Math.max(...all), note: 'V1 項目 3：PC では最大 554 ミリ秒。数分返らなかった例が 2 回' } };
      assert.ok(Math.max(...all) < 30000, `getDirectory が 30 秒以上かかった: ${all}`);
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('f', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ d2：復旧のあとに、録音を続けられるか
  test('d2 復旧のあと、マイクを開き直して録音を続けられる', async (t) => {
    if (!need(t, '0', 'abc', 'd', 'f')) return;
    const st = step('d2-continue');
    try {
      const perm = await micState();
      R.d2 = { micPermission: perm };
      if (perm !== 'granted') say('マイクの許可の画面が出たら、許可してください（最大 3 分待ちます）。');
      const r = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 190000 });
      assert.ok(r && r.ok, `再開できない: ${JSON.stringify(r)}`);
      await sleep(Math.round(8000 * Math.max(0.3, SCALE)));
      const okr = await press('ok');
      const p = await press('pause');
      await drain();
      const s = await lap('__lap.state().then(s => ({ stats: s.stats, rawFiles: s.rawFiles, kept: s.slides.map(x => x.keptSamples) }))');
      R.d2 = { ...R.d2, resume: r, ok: okr, pause: p, finalStats: { captured: s.stats.captured, written: s.stats.written, gaps: s.stats.gaps }, rawFiles: s.rawFiles, keptSamplesBySlide: s.kept };
      assert.equal(s.stats.captured, s.stats.written, '再開した録音で、captured と written が一致しない');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('d2', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ g：書き出し → PC → CLI
  test('g 書き出し（全記録と完成版）を CDP 経由で PC に取り出し、narrate import → status → render', async (t) => {
    if (!need(t, '0', 'abc', 'd')) return;
    const st = step('g-export');
    try {
      const outRoot = path.join(WORK, 'export');
      fs.rmSync(outRoot, { recursive: true, force: true });
      const results = {};
      for (const kind of ['full', 'final']) {
        const dir = path.join(outRoot, kind);
        fs.mkdirSync(dir, { recursive: true });
        const t0 = performance.now();
        const sum = await lap(`__lap.exportStart({ kind: ${JSON.stringify(kind)}, speaker: 'device-test' })`, { timeoutMs: 120000 });
        const files = [];
        for (let n = 1; n <= sum.volumes; n++) {
          const built = await lap(`__lap.exportBuild(${n})`, { timeoutMs: 300000 });
          const file = path.join(dir, built.file);
          const fd = fs.openSync(file, 'w');
          const hash = crypto.createHash('sha256');
          const STEP = 1 << 20;
          let bytes = 0;
          for (let off = 0; off < built.bytes; off += STEP) {
            const b64 = await lap(`__lap.exportReadVolume(${n}, ${off}, ${Math.min(built.bytes, off + STEP)})`, { timeoutMs: 60000 });
            const buf = Buffer.from(b64, 'base64');
            fs.writeSync(fd, buf); hash.update(buf); bytes += buf.length;
          }
          fs.closeSync(fd);
          const digest = hash.digest('hex');
          files.push({ file: built.file, bytes, expectedBytes: built.bytes, sha256: digest, expectedSha256: built.sha256 });
          assert.equal(bytes, built.bytes, `${built.file}: 取り出した大きさが違う`);
          assert.equal(digest, built.sha256, `${built.file}: 取り出した SHA-256 が、スマホが作ったものと違う`);
          await lap(`__lap.exportConfirm(${n})`);
        }
        const index = await lap('__lap.exportIndex()');
        fs.writeFileSync(path.join(dir, `${sum.exportId}_index.json`), JSON.stringify(index, null, 2) + '\n');
        results[kind] = { exportId: sum.exportId, volumes: sum.volumes, files, totalMs: ms(t0) };
      }
      R.g = { export: results };
      save();

      // CLI（PC）：import → status → render
      const ws = path.join(WORK, 'ws');
      fs.rmSync(ws, { recursive: true, force: true });
      const outDir = path.join(WORK, 'render');
      fs.rmSync(outDir, { recursive: true, force: true });
      const imp = await narrate(['import', path.join(outRoot, 'full'), path.join(outRoot, 'final'), '--script', PACK, '--workspace', ws, '--json']);
      const stat = await narrate(['status', '--workspace', ws, '--json']);
      const ren = await narrate(['render', '--workspace', ws, '--out', outDir, '--json']);
      const val = await narrate(['validate', path.join(outRoot, 'full', results.full.files[0].file), '--json']);
      const slim = (r) => ({ code: r.code, ok: r.env && r.env.ok, result: r.env && r.env.result, warnings: r.env && r.env.warnings, errors: r.env && r.env.errors, stderrTail: r.code ? r.stderr : undefined });
      R.g.cli = { import: slim(imp), status: slim(stat), render: slim(ren), validate: slim(val) };
      const finalDir = path.join(outDir, 'final');
      const wavs = fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : [];
      R.g.cli.renderedFiles = wavs.map((f) => ({ file: f, bytes: fs.statSync(path.join(finalDir, f)).size }));
      R.g.cli.timelineExists = fs.existsSync(path.join(outDir, 'timeline.json'));
      save();
      assert.equal(imp.code, 0, `import が失敗: ${JSON.stringify(imp.env && imp.env.errors)} ${imp.stderr}`);
      assert.ok(imp.env.result.committed.length >= 1, '統合されていない');
      assert.equal(stat.code, 0, 'status が失敗');
      assert.equal(ren.code, 0, `render が失敗（終了コード ${ren.code}）: ${JSON.stringify(ren.env && ren.env.errors)}`);
      assert.ok(wavs.length >= 1, 'render が音声を出さない');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('g', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ e：画面ロック
  async function lockRun(label, { dropVisibility }) {
    const phone = S.phone;
    const out = { label, dropVisibility };
    console.log(`[F] 画面ロックの試験（${label}）：これからスマホの画面をロックします。約 25 秒後に画面を起こしますので、ロックを解いてください（最大 ${Math.round(UNLOCK_WAIT_MS / 1000)} 秒待ちます）。`);
    const r = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 190000 });
    assert.ok(r && r.ok, `録音が始まらない: ${JSON.stringify(r)}`);
    await sleep(5000);
    await drain();
    const pre = lastSample();
    const diag0 = await lap('window.__diag()');
    const pw0 = (await phone.run(['shell', 'dumpsys', 'power'], { timeoutMs: 30000 })).out;
    const wlLines = (txt) => txt.split(/\r?\n/).filter((l) => /chrome/i.test(l) && /(WakeLock|SCREEN|PARTIAL|Wake)/i.test(l)).map((l) => l.trim().slice(0, 200));
    out.before = { sample: pre && { captured: pre.captured, written: pre.written, ctx: pre.ctx, wake: pre.wake, vis: pre.vis, rec: pre.rec }, wakeLocksInSystem: wlLines(pw0), wlLog: diag0.wl, acState: diag0.acState };
    // ロック
    phone.stopKeepAlive();
    const lockAt = Date.now();
    const lk = await phone.key(KEYS.SLEEP);
    out.lockKeyCode = lk.code;
    const watch = [];
    let audioDump = null;
    const rel = (w) => Math.round(w - S.clockOffsetMs - lockAt);
    for (let i = 0; i < Math.round(25 * Math.max(0.4, SCALE)); i++) {
      await sleep(1000);
      const d = await lap('({ vis: document.visibilityState })', { timeoutMs: 6000 }).catch(() => null);
      await drain();
      const s = lastSample();
      watch.push({ sec: Math.round((Date.now() - lockAt) / 100) / 10, vis: d && d.vis, captured: s && s.captured, written: s && s.written, rec: s && s.rec, ctx: s && s.ctx, wake: s && s.wake });
      if (i === 8) audioDump = (await phone.run(['shell', 'dumpsys', 'audio'], { timeoutMs: 30000 })).out;
    }
    const scr = await phone.screen();
    out.screenWhileLocked = { wakefulness: scr.wakefulness, keyguard: scr.keyguard };
    out.watch = watch;
    out.audioRecordingLines = audioDump ? audioDump.split(/\r?\n/).filter((l) => /(chrome|AudioRecord|rec(ord)? (client|session)|source:)/i.test(l)).slice(0, 12).map((l) => l.trim().slice(0, 220)) : null;
    const evs = await lap('__lap.events()');
    out.pauseEventsAfterLock = evs.filter((e) => (e.type === 'pause' || e.type === 'resume' || e.type === 'recovered') && Date.parse(e.wall) - S.clockOffsetMs >= lockAt - 2000)
      .map((e) => ({ type: e.type, reason: e.reason, afterLockMs: Math.round(Date.parse(e.wall) - S.clockOffsetMs - lockAt) }));
    const diag1 = await lap('window.__diag()');
    out.diag = {
      vis: diag1.vis.filter((v) => rel(v.wall) > -2000).map((v) => ({ state: v.state, afterLockMs: rel(v.wall) })), visDropped: diag1.visDropped,
      ac: diag1.ac.filter((v) => rel(v.wall) > -2000).map((v) => ({ state: v.state, afterLockMs: rel(v.wall) })),
      track: diag1.track.map((v) => ({ ev: v.ev, afterLockMs: rel(v.wall) })), wl: diag1.wl.filter((v) => rel(v.wall) > -5000).map((v) => ({ ev: v.ev, afterLockMs: rel(v.wall) })), acState: diag1.acState,
    };
    const lastW = watch.at(-1);
    out.capturedAtLockMinusBefore = lastW && pre && lastW.captured !== undefined ? lastW.captured - pre.captured : null;
    out.stillRecordingAtEnd = lastW && lastW.rec;
    // 起こす → 利用者がロックを解く（待つ）
    await phone.key(KEYS.WAKEUP);
    console.log('[F] ロックを解いてください。');
    const u = await phone.ensureUnlocked({ waitMs: UNLOCK_WAIT_MS, say: (m) => console.log(m) });
    out.unlockedAfter = u.unlocked;
    S.unlockedAfterLock = u.unlocked;
    if (u.unlocked) {
      phone.startKeepAlive();
      await sleep(2500);
      await drain();
      const s2 = await lap('__lap.state().then(s => ({ mode: s.mode, recording: s.recording, wake: s.wake, stats: s.stats && { captured: s.stats.captured, written: s.stats.written, gaps: s.stats.gaps }, vis: document.visibilityState }))');
      out.afterUnlock = s2;
      if (!s2.recording) { // 止まっていれば、再開できるか
        const r2 = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 60000 }).catch((e) => ({ error: e.message }));
        out.resumeAfterUnlock = r2;
        await sleep(3000);
        await drain();
        const s3 = lastSample();
        out.resumedSample = s3 && { captured: s3.captured, written: s3.written, ctx: s3.ctx, wake: s3.wake };
      }
      await lap('__lap.press("ok")', { userGesture: true }).catch(() => {});
      await lap('__lap.press("pause")', { userGesture: true }).catch(() => {});
    }
    return out;
  }

  test('e1 画面ロックをまたいだ録音（アプリのまま）：Wake Lock と AudioWorklet の挙動', async (t) => {
    if (!need(t, '0', 'abc', 'd', 'g')) return;
    if (SKIP_LOCK) return t.skip('DEVICE_SKIP_LOCK=1');
    const st = step('e1-lock');
    try {
      await waitUnlocked('画面ロックの試験の前');
      R.e1 = await lockRun('e1-app-as-is', { dropVisibility: false });
      fin(st, { pass: true });
      assert.ok(R.e1.watch.length > 0);
    } catch (e) { fin(st, { pass: false }); failStep('e1', e); throw e; }
  });

  test('e2 画面ロックの診断：アプリの visibilitychange の処理を無効にして、AudioWorklet と Wake Lock の素の挙動を見る', async (t) => {
    if (!need(t, '0', 'abc', 'd', 'g', 'e1')) return;
    if (SKIP_LOCK) return t.skip('DEVICE_SKIP_LOCK=1');
    if (!S.unlockedAfterLock) return t.skip('e1 のあと、利用者がロックを解かなかったため、診断は行わない（ロックのままにしておく）');
    const st = step('e2-lock-diagnostic');
    try {
      await waitUnlocked('診断の前');
      stopPoll();
      await S.phone.forceStopChrome(); // きれいな Chrome で、診断用の差し込みのあるページを開く
      await sleep(800);
      const att = await S.phone.relaunch();
      await openApp(att, { dropVisibility: true, label: 'diagnostic-no-visibility-handler' });
      await lap(`__lap.openSession(${JSON.stringify(S.sessionId)})`, { timeoutMs: 120000 });
      R.e2 = await lockRun('e2-visibility-handler-disabled', { dropVisibility: true });
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('e2', e); throw e; }
  });
});
