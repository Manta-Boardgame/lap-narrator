// ネイティブ版（Capacitor の APK）の実機の試験（担当 K）。npm run test:native-device:run（npm test には入れない）。
// 担当 F の test/device の道具（CDP、標本の注入、解析）を流用し、アプリは自作の APK（io.github.lapnarrator）を相手にする。
//
// 前提：デバッグ APK が実機に入っていて（インストールはまとめ役）、WebView の遠隔デバッグが有効（debuggable の APK）、
//       スマホが USB でつながり、USB デバッグが許可済みで、ロックが解けていること。
//       マイクと通知の許可の画面、画面ロックの解除、システムの保存画面は、利用者がスマホで操作する（案内を出して、最大 180 秒待つ）。
// 流れ（括弧は、まとめ役の指示の項目）：
//   0    起動、WebView でアプリが出るか、OPFS（createSyncAccessHandle）、INTERNET なしで動くか、権限、橋渡し     （1）
//   abc  約 60 秒の録音（OK、次へ、印、撮り直し）。取得数と書き込み数、欠落、events.jsonl                           （2）
//   e1   録音中に電源キーでロック → 約 30 秒 → 画面を起こす。サービス、通知、AudioWorklet、pause('hidden')         （3）
//   h    録音中に HOME（ほかのアプリが前面の代わり）→ 約 30 秒 → アプリを前面に戻す                               （4）
//   d    録音中に am force-stop → 起動し直し → 復旧（耐久位置までの音声が残るか）                                  （5）
//   g    書き出し（全記録と完成版）を CDP で PC に取り出し、narrate import → status → render                      （6）
//   saf  システムの保存画面での保存（利用者が操作）                                                                （6）
// 結果は work/K/native-device-results.json。環境変数：NATIVE_STAGES（例 "0,abc,e1"。既定は全部）、NATIVE_SCALE（録音の時間の倍率）、
//   NATIVE_UNLOCK_WAIT_SEC（利用者の操作を待つ秒数。既定 180）、DEVICE_SERIAL NATIVE_LOCK_SEC（e1 でロックしておく秒数。既定 30）、
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { readZipDirectory, readZipEntry } from '../../core/zip.js';
import { reduceEvents } from '../../core/reduce.js';
import { NativePhone, ROOT, WORK, KEYS, PKG, sleep } from './helpers/phone.js';
import { injectSource } from '../device/helpers/inject.js';
import { analyzeClock, analyzeWrite, trailingZeroRun, rmsOf } from '../device/helpers/analyze.js';

const SCALE = Number(process.env.NATIVE_SCALE || 1);
const WAIT_MS = Number(process.env.NATIVE_UNLOCK_WAIT_SEC || 180) * 1000;
const NO_BRIDGE = process.env.NATIVE_NO_BRIDGE === '1'; // 橋渡し（Capacitor、lapNative）が無いビルドでの対照の試験
const STAGES = new Set((process.env.NATIVE_STAGES || '0,abc,e1,h,d,g,saf,c').split(',').map((s) => s.trim()));
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const NARRATE = path.join(ROOT, 'cli', 'narrate.js');
const RESULTS = path.join(WORK, 'native-device-results.json');
const APP_URL = 'https://localhost/app/index.html?lapdev=1&countdown=0&nosw=1';
const NOW = () => new Date().toISOString();
const say = (m) => process.stderr.write(`[K ${NOW().slice(11, 19)}] ${m}\n`);

const R = { startedAt: NOW(), scale: SCALE, steps: {}, notes: [] };
const save = () => { fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(RESULTS, JSON.stringify(R, null, 2) + '\n'); };
const S = { skip: null, phone: null, cdp: null, samples: [], pollTimer: null, pollBusy: false, sessionId: null, projectId: null, rate: null, stepsFailed: [], pageEpoch: 0, clockOffsetMs: 0, pid: null };
const lap = (expr, o) => S.cdp.eval(expr, o);
const press = (name, arg) => lap(`__lap.press(${JSON.stringify(name)}, ${JSON.stringify(arg ?? null)})`, { userGesture: true, timeoutMs: 60000 });
const ms = (t0) => Math.round(performance.now() - t0);

// ---- 標本の採取（ページの中で 400 ミリ秒ごとに採り、PC が取りに行く）
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

// ---- アプリを起動してつなぎ、開発用の入口が出るページを開く
async function openApp({ fresh = false, label = 'open' } = {}) {
  const t0 = performance.now();
  const att = await S.phone.launchAndAttach({ fresh });
  S.cdp = att.cdp;
  S.pid = att.pid;
  S.pageEpoch++;
  await att.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource({ dropVisibility: false }) });
  await att.cdp.send('Page.navigate', { url: APP_URL });
  for (let i = 0; i < 200; i++) {
    if (await att.cdp.eval('!!window.__lap && !!window.__f').catch(() => false)) break;
    await sleep(100);
  }
  const navToLapMs = ms(t0);
  assert.ok(await att.cdp.eval('!!window.__lap'), 'window.__lap が出ない（アプリが表示されていない、または ?lapdev=1 が効いていない）');
  await att.cdp.eval('window.__f.start(400)');
  startPoll();
  await sleep(300);
  const probe = await att.cdp.eval('window.__opfsProbe');
  return { label, pid: att.pid, targetUrlAtAttach: att.target.url, attachMs: att.ms, navToLapMs, firstGetDirectoryMs: probe.calls[0] ? Math.round(probe.calls[0].ms) : probe.calls[0]?.err ?? null, getDirectoryCalls: probe.calls.length };
}

async function waitUnlocked(why) {
  const u = await S.phone.ensureUnlocked({ waitMs: WAIT_MS, say });
  if (!u.unlocked) throw new Error(`phone-locked: ${why}。スマホのロックが解けませんでした（${Math.round(u.waitedMs / 1000)} 秒待った）`);
  return u;
}

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

/** logcat から、自作アプリに関わる行だけを短く残す（原因の切り分け用）。 */
async function logTail(label) {
  try {
    const pid = (await S.phone.pid()) || S.pid;
    if (!pid) return;
    const txt = await S.phone.logcat(pid, 400);
    R.logcat = R.logcat || {};
    R.logcat[label] = txt.split(/\r?\n/).filter((l) => /(chromium|CONSOLE|AudioRecord|RecorderService|LapRecorder|Capacitor|FATAL|AndroidRuntime)/i.test(l)).slice(-60).map((l) => l.slice(0, 260));
  } catch { /* 無視 */ }
}

/**
 * 後始末。利用者の目の前でアプリを force-stop しない（利用者の操作と重なって「アプリが落ちた」ように見えるため）。
 * アプリの中でセッションを閉じてマイクとサービスを止め、アプリは開いたまま、画面に「試験は終わりました」を出して残す。
 * 録音データは消さない（次の実行の冒頭で消す）。force-stop は d の段（強制終了の試験）だけで使う。
 */
async function cleanup() {
  stopPoll();
  if (S.phone) S.phone.stopKeepAlive();
  try {
    if (S.cdp && !S.cdp.closed) {
      R.cleanupPageData = await S.cdp.eval(`(async () => {
        try { await window.__lap.closeSession(); } catch (e) { /* 無視 */ }
        const d = document.createElement('div');
        d.setAttribute('role', 'status');
        d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#14213d;color:#fff;padding:16px;font:16px/1.5 system-ui,sans-serif;text-align:center';
        d.textContent = '試験は終わりました（試験が止めたもので、アプリの不具合ではありません）。 / The test run has finished (stopped by the test, not an app crash).';
        document.body.append(d);
        return { closed: true, serviceOn: window.lapNative ? window.lapNative.state().serviceOn : null };
      })()`, { timeoutMs: 20000 }).catch((e) => `error:${e.message}`);
      say('これは試験が止めたものです。セッションを閉じ、マイクとサービスを止めました。アプリは開いたままです（強制終了していません）。');
    }
  } catch { /* 無視 */ }
  try { if (S.cdp) S.cdp.close(); } catch { /* 無視 */ }
  if (S.phone && S.started) {
    try { await S.phone.cleanup(); } catch { /* 無視 */ }
  }
  R.finishedAt = NOW();
  save();
}

const step = (name) => ({ name, t0: performance.now() });
const fin = (st, extra = {}) => { R.steps[st.name] = { ...(R.steps[st.name] || {}), ms: ms(st.t0), ...extra }; save(); };
const need = (t, flag, ...deps) => {
  if (S.skip) { t.skip(S.skip); return false; }
  if (!STAGES.has(flag)) { t.skip(`NATIVE_STAGES に ${flag} がない`); return false; }
  for (const f of deps) if (S.stepsFailed.includes(f)) { t.skip(`前の段 ${f} が通っていない`); return false; }
  return true;
};
const failStep = (flag, e) => { S.stepsFailed.push(flag); R.steps[flag] = { ...(R.steps[flag] || {}), failed: String((e && e.message) || e) }; save(); };

describe('ネイティブ版（Android）の実機：起動、録音、画面ロック、HOME、強制終了と復旧、書き出し', { timeout: 3600000 }, () => {
  before(async () => {
    fs.mkdirSync(WORK, { recursive: true });
    const phone = new NativePhone();
    S.phone = phone;
    const d = await phone.findDevice();
    if (d.error) { S.skip = `実機がない（${d.error} ${JSON.stringify(d.devices || [])}）`; R.skipped = S.skip; save(); return; }
    R.device = await phone.info();
    try { await waitUnlocked('開始'); } catch (e) { S.skip = e.message; R.skipped = S.skip; save(); return; }
    S.started = true;
    phone.startKeepAlive();
  });
  after(async () => { await cleanup(); });

  // ------------------------------------------------------------------------------------------------ 0 起動
  test('0 起動：WebView でアプリが出る、OPFS、INTERNET なし、権限、橋渡し', async (t) => {
    if (!need(t, '0')) return;
    const st = step('0-launch');
    try {
      // 権限（インストール済みの APK が要求している一覧と、許可の状態）
      const pk = (await S.phone.run(['shell', 'dumpsys', 'package', PKG], { timeoutMs: 30000 })).out;
      R.package = {
        versionName: (pk.match(/versionName=(\S+)/) || [])[1] || null,
        requested: [...new Set((pk.match(/android\.permission\.[A-Z_]+/g) || []))].sort(),
        internetRequested: /android\.permission\.INTERNET/.test(pk),
        debuggable: /DEBUGGABLE/.test(pk),
      };
      const o = await openApp({ fresh: true, label: 'first-launch' });
      R.firstLaunch = o;
      // 前回の試験の録音データが残っていれば消す（アプリ自身の中から。録音の声を端末に残さない）
      R.staleDataBefore = await lap(`(async () => { const root = await navigator.storage.getDirectory(); let had = false; for await (const [n] of root.entries()) { if (n === 'lap') had = true; } if (had) { try { await root.removeEntry('lap', { recursive: true }); return 'removed'; } catch (e) { return 'remove-failed:' + e.name; } } return 'none'; })()`, { timeoutMs: 20000 }).catch((e) => `error:${e.message}`);
      if (R.staleDataBefore === 'removed') { // アプリが控えていた lap ディレクトリの参照が無効になるので、ページを開き直す
        S.pageEpoch++;
        await S.cdp.send('Page.navigate', { url: APP_URL });
        for (let i = 0; i < 100; i++) { await sleep(100); if (await lap('!!window.__lap && !!window.__f').catch(() => false)) break; }
        await lap('window.__f.start(400)');
      }
      const feat = await lap(`({ secure: isSecureContext, origin: location.origin, href: location.href, wakeLock: !!navigator.wakeLock, audioWorklet: !!window.AudioWorklet,
        syncAccess: typeof FileSystemSyncAccessHandle, cores: navigator.hardwareConcurrency, ua: navigator.userAgent, capacitor: !!window.Capacitor && window.Capacitor.getPlatform(),
        lapNative: !!window.lapNative, cspViolations: (window.__lap && window.__lap.violations || []).length, online: navigator.onLine })`);
      feat.estimate = await lap('navigator.storage.estimate().then(e => ({ quota: e.quota, usage: e.usage }))');
      // OPFS の同期アクセスは、abc の実録音（アプリ自身の Worker が createSyncAccessHandle で書く）で確かめる。blob の Worker は CSP（worker-src 'self'）が拒否する。
      // 橋渡しとプラグインの状態
      feat.pluginStatus = await lap('window.lapNative ? window.lapNative.status() : null').catch((e) => ({ error: e.message }));
      feat.originOk = feat.origin === 'https://localhost';
      R.pageFeatures = feat;
      const offs = [];
      for (let i = 0; i < 5; i++) { const a = Date.now(); const w = await lap('Date.now()'); const b = Date.now(); offs.push(w - (a + b) / 2); }
      offs.sort((x, y) => x - y);
      S.clockOffsetMs = offs[2];
      R.clockOffsetMs = Math.round(S.clockOffsetMs);
      R.screenshots = {};
      fs.mkdirSync(path.join(WORK, 'native-shots'), { recursive: true });
      try {
        const shot = await S.cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
        fs.writeFileSync(path.join(WORK, 'native-shots', 'home.png'), Buffer.from(shot.data, 'base64'));
        R.screenshots.home = 'work/K/native-shots/home.png';
      } catch (e) { R.notes.push(`screenshot failed: ${e.message}`); }
      await logTail('after-launch');
      save();
      assert.equal(R.package.internetRequested, false, 'INTERNET が要求されている');
      assert.ok(feat.secure && feat.audioWorklet, `機能が足りない: ${JSON.stringify(feat)}`);
      if (!NO_BRIDGE) assert.ok(feat.capacitor === 'android' && feat.lapNative, `Capacitor の橋渡しが無い（window.Capacitor=${feat.capacitor}, lapNative=${feat.lapNative}）。起動 URL が https://localhost/ でない可能性: ${R.firstLaunch.targetUrlAtAttach}`);
      fin(st, { pass: true });
    } catch (e) { await logTail('launch-failed'); fin(st, { pass: false }); failStep('0', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ 2 録音
  test('abc 録音（実マイク、約 60 秒）：OK、次へ、印、撮り直し、取得数と書き込み数、events.jsonl', async (t) => {
    if (!need(t, 'abc', '0')) return;
    const st = step('abc-record');
    try {
      const { script, images } = await loadPack();
      S.projectId = script.projectId;
      await lap(`__lap.loadScript(${JSON.stringify(script)}, ${JSON.stringify(images)})`);
      say('スマホの画面にマイク（と通知）の許可の画面が出ます。許可してください（最大 3 分待ちます）。');
      const tPrompt = performance.now();
      S.sessionId = await lap(`__lap.newSession(${JSON.stringify(S.projectId)}, { speaker: 'device-test' })`, { userGesture: true, timeoutMs: 190000 });
      R.micPromptWaitMs = ms(tPrompt);
      const info = await lap('__lap.state().then(s => ({ rate: s.sampleRate, mic: s.mic, sourceKind: s.sourceKind }))');
      S.rate = info.rate; R.mic = info.mic; R.sampleRate = info.rate;
      assert.equal(info.sourceKind, 'mic', 'マイクの経路ではない');
      R.afterMicOpen = { lapNative: await lap('window.lapNative ? window.lapNative.state() : null'), service: await S.phone.serviceState(), plugin: await lap('window.lapNative ? window.lapNative.status() : null').catch((e) => ({ error: e.message })) };

      const K = (s) => Math.round(s * SCALE * 1000);
      const ops = [];
      const timeline = [[8, 'ok'], [16, 'next'], [24, 'mark'], [34, 'ok'], [44, 'next'], [52, 'ok'], [58, 'retake']];
      say('これから約 62 秒録音します。録音中はスマホの画面に触れないでください。');
      const rec = await press('record');
      const t0 = Date.now();
      R.recordStart = rec;
      assert.ok(rec && rec.ok, `録音が始まらない: ${JSON.stringify(rec)}`);
      R.serviceWhileRecording = await S.phone.serviceState();
      R.audioWhileRecording = await S.phone.audioRecordingLines();
      for (const [sec, name] of timeline) {
        const wait = t0 + K(sec) - Date.now();
        if (wait > 0) await sleep(wait);
        const a = performance.now();
        const r = await press(name, name === 'mark' ? 'device' : undefined);
        ops.push({ atSec: (Date.now() - t0) / 1000, name, result: r, ms: ms(a) });
      }
      R.ops = ops;
      await sleep(600);
      await drain();
      R.opFailures = ops.filter((o) => !(o.result && o.result.ok !== false)).map((o) => ({ name: o.name, atSec: o.atSec, result: o.result }));
      const finalStats = await lap('__lap.sync()');
      R.longArmFinalStats = finalStats && { captured: finalStats.captured, written: finalStats.written, gaps: finalStats.gaps, dropped: finalStats.dropped };
      const arms = splitArms(S.samples.filter((x) => x.epoch === S.pageEpoch));
      const longArm = arms.reduce((a, b) => (b.samples.length > a.samples.length ? b : a));
      const clock = analyzeClock(longArm.samples, S.rate);
      const write = analyzeWrite(longArm.samples);
      R.b = { rate: S.rate, clock, write, final: { captured: finalStats.captured, written: finalStats.written, lag: finalStats.captured - finalStats.written, gaps: finalStats.gaps, dropped: finalStats.dropped }, audioSec: finalStats.captured / S.rate };
      const disk = await lap(`__lap.eventsOnDisk(${JSON.stringify(S.sessionId)})`);
      const types = (list) => list.filter((e) => e.type !== 'durable').map((e) => e.type);
      const expectTypes = ['session-start', 'rec-start', 'ok', 'next-slide', 'rec-start', 'mark', 'ok', 'next-slide', 'rec-start', 'ok', 'pause', 'retake'];
      const rawInfos = (await lap('__lap.state().then(s => s.rawFiles)')).map((r) => ({ name: r.name, sampleRate: r.sampleRate, samples: r.samples }));
      const reduced = reduceEvents(disk.events, rawInfos);
      const kept = reduced.segments.filter((g) => g.status === 'kept');
      const okEvents = disk.events.filter((e) => e.type === 'ok' || e.type === 'next-slide');
      const lastOkPos = okEvents.length ? okEvents[okEvents.length - 1].at.pos : null;
      const durables = disk.events.filter((e) => e.type === 'durable');
      R.c = {
        eventsOnDisk: disk.events.length, droppedBytes: disk.droppedBytes, typesWithoutDurable: types(disk.events), expectedTypes: expectTypes,
        durableCount: durables.length, seqContiguous: disk.events.every((e, i) => e.seq === i && e.eventId === `e${i}`),
        reduce: { issues: reduced.issues, keptSamples: kept.reduce((n, g) => n + (g.end - g.start), 0), lastOkPos, discardedReasons: [...new Set(reduced.segments.filter((g) => g.status === 'discarded').map((g) => g.reason))] },
      };
      await logTail('after-abc');
      save();
      assert.deepEqual(R.opFailures, [], '失敗した操作がある');
      assert.equal(R.b.final.captured, R.b.final.written, '取得数と書き込み数が違う');
      assert.equal(R.b.final.gaps, 0, `欠落（gaps）が ${R.b.final.gaps}`);
      assert.deepEqual(types(disk.events), expectTypes, 'events.jsonl の種類の並び');
      assert.deepEqual(reduced.issues, [], 'reduce の issues');
      assert.equal(R.c.reduce.keptSamples, lastOkPos, '採用した区間の合計が、最後の OK の位置と合わない');
      fin(st, { pass: true });
    } catch (e) { await logTail('abc-failed'); fin(st, { pass: false }); failStep('abc', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ 3, 4 バックグラウンド
  /** 録音を始め、leave() でアプリを裏に回し、watchSec 秒の間 1 秒ごとに観察し、back() で戻す。 */
  async function backgroundRun(label, { leave, watchSec, back }) {
    const out = { label };
    const r = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 190000 });
    assert.ok(r && r.ok, `録音が始まらない: ${JSON.stringify(r)}`);
    await sleep(4000);
    await drain();
    const pre = lastSample();
    out.before = { sample: pre && { captured: pre.captured, written: pre.written, ctx: pre.ctx, wake: pre.wake, vis: pre.vis, rec: pre.rec }, service: await S.phone.serviceState(), plugin: await lap('window.lapNative ? window.lapNative.state() : null') };
    S.phone.stopKeepAlive();
    const leftAt = Date.now();
    const lk = await leave();
    out.leaveResult = lk;
    const watch = [];
    let served = null;
    let audio = null;
    for (let i = 0; i < Math.round(watchSec * Math.max(0.4, SCALE)); i++) {
      await sleep(1000);
      const d = await lap('({ vis: document.visibilityState })', { timeoutMs: 6000 }).catch((e) => ({ err: e.message }));
      await drain();
      const s = lastSample();
      watch.push({ sec: Math.round((Date.now() - leftAt) / 100) / 10, vis: d && (d.vis || d.err), captured: s && s.captured, written: s && s.written, rec: s && s.rec, ctx: s && s.ctx, gaps: s && s.gaps });
      if (i === 8) { served = await S.phone.serviceState(); audio = await S.phone.audioRecordingLines(); }
    }
    out.screenWhileAway = await S.phone.screen();
    out.watch = watch;
    out.serviceWhileAway = served;
    out.audioWhileAway = audio;
    const evs = await lap('__lap.events()').catch(() => []);
    out.pauseEventsAfterLeave = evs.filter((e) => (e.type === 'pause' || e.type === 'resume' || e.type === 'recovered') && Date.parse(e.wall) - S.clockOffsetMs >= leftAt - 2000)
      .map((e) => ({ type: e.type, reason: e.reason, afterLeaveMs: Math.round(Date.parse(e.wall) - S.clockOffsetMs - leftAt) }));
    const diag = await lap('window.__diag()').catch(() => null);
    const rel = (w) => Math.round(w - S.clockOffsetMs - leftAt);
    out.diag = diag && {
      vis: diag.vis.filter((v) => rel(v.wall) > -2000).map((v) => ({ state: v.state, afterLeaveMs: rel(v.wall) })),
      ac: diag.ac.filter((v) => rel(v.wall) > -2000).map((v) => ({ state: v.state, afterLeaveMs: rel(v.wall) })),
      track: diag.track.map((v) => ({ ev: v.ev, afterLeaveMs: rel(v.wall) })), acState: diag.acState,
    };
    const first = watch.find((w) => w.captured !== undefined);
    const lastW = watch.at(-1);
    out.capturedGrewDuringAway = lastW && first ? lastW.captured - first.captured : null;
    out.capturedGrewSec = out.capturedGrewDuringAway === null ? null : out.capturedGrewDuringAway / S.rate;
    out.stillRecordingAtEnd = lastW && lastW.rec;
    out.wallCoverageRatio = lastW && first && out.capturedGrewSec !== null ? out.capturedGrewSec / Math.max(0.001, lastW.sec - first.sec) : null;
    R.partial = R.partial || {};
    R.partial[label] = out; // 利用者がロックを解かなくても、ここまでの観測値を残す
    save();
    await back(out);
    phoneKeep();
    await sleep(2500);
    await drain();
    out.afterBack = await lap('__lap.state().then(s => ({ mode: s.mode, recording: s.recording, stats: s.stats && { captured: s.stats.captured, written: s.stats.written, gaps: s.stats.gaps }, vis: document.visibilityState }))').catch((e) => ({ error: e.message }));
    if (out.afterBack && out.afterBack.recording === false) {
      out.resumeAfterBack = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 60000 }).catch((e) => ({ error: e.message }));
      await sleep(3000);
      await drain();
      const s3 = lastSample();
      out.resumedSample = s3 && { captured: s3.captured, written: s3.written, ctx: s3.ctx };
    }
    await lap('__lap.press("ok")', { userGesture: true }).catch(() => {});
    await lap('__lap.press("pause")', { userGesture: true }).catch(() => {});
    await logTail(label);
    return out;
  }
  const phoneKeep = () => S.phone.startKeepAlive();

  test('h ほかのアプリが前面（HOME）のときの録音の継続', async (t) => {
    if (!need(t, 'h', '0', 'abc')) return;
    const st = step('h-home');
    try {
      await waitUnlocked('HOME の試験の前');
      say('HOME の試験：スマホをホーム画面にします。約 30 秒後にアプリを前面に戻します。画面に触れないでください。');
      R.h = await backgroundRun('h-home-key', {
        watchSec: 30,
        leave: async () => (await S.phone.key(KEYS.HOME)).code,
        back: async () => { await S.phone.start(); await sleep(1500); },
      });
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('h', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ 5 強制終了と復旧
  test('d 録音中に強制終了 → 起動し直し → 復旧', async (t) => {
    if (!need(t, 'd', '0', 'abc')) return;
    const st = step('d-crash-recovery');
    try {
      const rec = await press('record');
      assert.ok(rec && rec.ok, `再開できない: ${JSON.stringify(rec)}`);
      await sleep(Math.round(12300 * Math.max(0.3, SCALE)));
      await drain();
      const last = lastSample();
      const diskBefore = await lap(`__lap.rawSizesOnDisk(${JSON.stringify(S.sessionId)}).catch(e => ({ error: String(e) }))`);
      stopPoll();
      const killedAt = Date.now();
      const fs1 = await S.phone.forceStop();
      assert.equal(fs1.code, 0, `force-stop が失敗: ${fs1.out}`);
      await sleep(1500);
      R.d = { lastObserved: last && { captured: last.captured, written: last.written, pos: last.pos, durablePos: last.durablePos, raw: last.raw }, diskBefore };
      await waitUnlocked('強制終了のあと');
      const o = await openApp({ fresh: false, label: 'after-force-stop' });
      const t1 = performance.now();
      const opened = await lap(`__lap.openSession(${JSON.stringify(S.sessionId)})`, { timeoutMs: 120000 });
      const openSessionMs = ms(t1);
      const state = await lap('__lap.state()');
      const disk = await lap(`__lap.rawSizesOnDisk(${JSON.stringify(S.sessionId)})`);
      const evDisk = await lap(`__lap.eventsOnDisk(${JSON.stringify(S.sessionId)})`);
      const diskSamples = Object.values(disk).reduce((n, b) => n + b / 2, 0);
      const rec1 = opened.recovery;
      const durableMax = evDisk.events.filter((e) => e.type === 'durable').reduce((m, e) => Math.max(m, e.at.pos), 0);
      const lastRaw = state.rawFiles.at(-1);
      const b64 = await lap(`__lap.readRawBase64(${JSON.stringify(lastRaw.name)})`, { timeoutMs: 60000 });
      const nb = Buffer.from(b64, 'base64');
      const pcm = new Int16Array(nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.length));
      R.d.crash = { ...o, openSessionMs, killToPageMs: Date.now() - killedAt };
      R.d.recovery = {
        recoveredPos: rec1 && rec1.recoveredPos, lastOkPos: rec1 && rec1.lastOkPos, continuationSamples: rec1 && rec1.continuationSamples, tornTail: rec1 && rec1.tornTail,
        diskSamplesNow: diskSamples, durableMaxOnDisk: durableMax, droppedTailBytes: state.droppedTailBytes, readableSamples: pcm.length, lastRawSamples: lastRaw.samples,
        headRms: rmsOf(pcm, 0, Math.round(S.rate * 0.5)), tailRms: rmsOf(pcm, Math.max(0, pcm.length - Math.round(S.rate * 0.5))), trailingZeroRun: trailingZeroRun(pcm),
        diskMinusLastObservedPos: R.d.lastObserved ? diskSamples - R.d.lastObserved.pos : null,
      };
      await logTail('after-crash');
      save();
      assert.ok(rec1, '復旧の情報が出ない');
      assert.ok(rec1.recoveredPos <= diskSamples, `復旧位置 ${rec1.recoveredPos} が保存されていた音声 ${diskSamples} を超える`);
      assert.ok(rec1.recoveredPos >= durableMax, `復旧位置 ${rec1.recoveredPos} が保存位置 ${durableMax} より短い`);
      assert.ok(R.d.recovery.headRms > 0, '録音ファイルが無音');
      const adopt = await press('adopt');
      R.d.adopt = adopt;
      assert.ok(adopt && adopt.ok, `続きを採用できない: ${JSON.stringify(adopt)}`);
      fin(st, { pass: true });
    } catch (e) { await logTail('d-failed'); fin(st, { pass: false }); failStep('d', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ 6 書き出し
  test('g 書き出しを CDP 経由で PC に取り出し、narrate import → status → render', async (t) => {
    if (!need(t, 'g', '0', 'abc', 'd')) return;
    const st = step('g-export');
    try {
      const outRoot = path.join(WORK, 'native-export');
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
          assert.equal(digest, built.sha256, `${built.file}: 取り出した SHA-256 が違う`);
          await lap(`__lap.exportConfirm(${n})`);
        }
        const index = await lap('__lap.exportIndex()');
        fs.writeFileSync(path.join(dir, `${sum.exportId}_index.json`), JSON.stringify(index, null, 2) + '\n');
        results[kind] = { exportId: sum.exportId, volumes: sum.volumes, files, totalMs: ms(t0) };
      }
      R.g = { export: results };
      save();
      const ws = path.join(WORK, 'native-ws');
      fs.rmSync(ws, { recursive: true, force: true });
      const outDir = path.join(WORK, 'native-render');
      fs.rmSync(outDir, { recursive: true, force: true });
      const imp = await narrate(['import', path.join(outRoot, 'full'), path.join(outRoot, 'final'), '--script', PACK, '--workspace', ws, '--json']);
      const stat = await narrate(['status', '--workspace', ws, '--json']);
      const ren = await narrate(['render', '--workspace', ws, '--out', outDir, '--json']);
      const slim = (r) => ({ code: r.code, ok: r.env && r.env.ok, result: r.env && r.env.result, warnings: r.env && r.env.warnings, errors: r.env && r.env.errors, stderrTail: r.code ? r.stderr : undefined });
      R.g.cli = { import: slim(imp), status: slim(stat), render: slim(ren) };
      const finalDir = path.join(outDir, 'final');
      R.g.cli.renderedFiles = (fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : []).map((f) => ({ file: f, bytes: fs.statSync(path.join(finalDir, f)).size }));
      save();
      assert.equal(imp.code, 0, `import が失敗: ${JSON.stringify(imp.env && imp.env.errors)}`);
      assert.ok(imp.env.result.committed.length >= 1, '統合されていない');
      assert.equal(stat.code, 0, 'status が失敗');
      assert.equal(ren.code, 0, `render が失敗: ${JSON.stringify(ren.env && ren.env.errors)}`);
      assert.ok(R.g.cli.renderedFiles.length >= 1, 'render が音声を出さない');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('g', e); throw e; }
  });

  test('saf システムの保存画面での保存（利用者が操作）', async (t) => {
    if (!need(t, 'saf', '0', 'abc', 'd')) return;
    const st = step('saf-save');
    try {
      await waitUnlocked('保存画面の試験の前');
      const sum = await lap('__lap.exportStart({ kind: "full", speaker: "device-test" })', { timeoutMs: 120000 });
      const built = await lap('__lap.exportBuild(1)', { timeoutMs: 300000 });
      const before = await lap('window.lapNative.state()');
      // 診断：保存画面を出した直後から 3 秒おきに、前面のウィンドウとアクティビティを記録する（dumpsys window / activity、読むだけ）
      S.phone.stopKeepAlive(); // 画面を起こすキーを送らない（保存画面の操作を邪魔していないことを確かめる）
      say(`スマホにシステムの保存画面が出ます。保存先を選び『保存』を押してください（ファイル名 ${built.file}、${built.bytes} バイト。最大 3 分待ちます）。`);
      say('保存画面が出ている間は dumpsys で確認しています。画面に触れて構いません。');
      const snaps = [];
      const t0 = Date.now();
      await lap('__lap.exportDownload(1)', { userGesture: true, timeoutMs: 60000 });
      let state = before;
      let nextSnap = 0;
      while (Date.now() - t0 < WAIT_MS) {
        if (Date.now() - t0 >= nextSnap) {
          nextSnap += 3000;
          const f = await S.phone.frontInfo().catch((e) => ({ error: e.message }));
          const ls = await lap('window.lapNative.state()').catch(() => null);
          snaps.push({ atSec: Math.round((Date.now() - t0) / 100) / 10, ...f, bridge: ls && { saves: ls.saves, hiddenIgnored: ls.hiddenIgnored, lastError: ls.lastError } });
          R.safSnaps = snaps; save();
        }
        await sleep(500);
        state = await lap('window.lapNative.state()').catch(() => state);
        if (state.saves > before.saves || (state.lastError && state.lastError !== before.lastError)) break;
      }
      R.safLogcat = await S.phone.logcatRelevant().catch((e) => [`error:${e.message}`]);
      phoneKeep();
      R.saf = { volumes: sum.volumes, file: built.file, bytes: built.bytes, waitedMs: Date.now() - t0, firstDocumentsUiAtSec: (snaps.find((x) => /documentsui/i.test(String(x.focus) + String(x.topResumed) + String(x.resumed))) || {}).atSec ?? null, snapshots: snaps.length, before, after: state, saved: state.saves > before.saves };
      save();
      assert.ok(R.saf.saved, `保存が完了しなかった: ${JSON.stringify(state)}`);
      await lap('__lap.exportConfirm(1)');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('saf', e); throw e; }
  });

  // ------------------------------------------------------------------------------------------------ Chrome 非依存の確認（K3）
  test('c Chrome 非依存：通しの間に com.android.chrome のアクティビティが起動していない', async (t) => {
    if (!need(t, 'c', '0')) return;
    const st = step('c-chrome');
    try {
      const lg = await S.phone.run(['logcat', '-d'], { timeoutMs: 60000 });
      const starts = lg.out.split(/\r?\n/).filter((l) => /ActivityTaskManager: START u0/.test(l) && /(io\.github\.lapnarrator|com\.android\.chrome|documentsui)/.test(l));
      const chromeStarts = starts.filter((l) => /com\.android\.chrome/.test(l));
      const ac = await S.phone.run(['shell', 'dumpsys', 'activity', 'activities'], { timeoutMs: 40000 });
      const wv = ((await S.phone.run(['shell', 'dumpsys', 'package', PKG], { timeoutMs: 30000 })).out.match(/usesLibraries|webview/gi) || []).length;
      R.chrome = { startLinesChecked: starts.length, chromeStarts: chromeStarts.length, chromeInActivityStack: /com\.android\.chrome/.test(ac.out), startTargets: [...new Set(starts.map((l) => (l.match(/cmp=(\S+)/) || [])[1]).filter(Boolean))], note: wv >= 0 ? 'logcat の保持期間内（直近の通し）の START だけを見ている' : '' };
      save();
      assert.equal(chromeStarts.length, 0, `Chrome が起動した: ${chromeStarts[0]}`);
      assert.equal(R.chrome.chromeInActivityStack, false, 'アクティビティの一覧に Chrome がある');
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('c', e); throw e; }
  });

  // 画面ロックの試験は最後に置く：利用者がロックを解くのを待つ必要があり、解かれなくても、ほかの段を先に終わらせるため。
  test('e1 画面ロックをまたいだ録音：サービス、通知、AudioWorklet、pause(hidden)', async (t) => {
    if (!need(t, 'e1', '0', 'abc', 'd')) return;
    const st = step('e1-lock');
    try {
      await waitUnlocked('画面ロックの試験の前');
      say('画面ロックの試験：これからスマホの画面をロックします。約 30 秒後に画面を起こしますので、ロックを解いてください。');
      R.e1 = await backgroundRun('e1-screen-lock', {
        watchSec: Number(process.env.NATIVE_LOCK_SEC || 30),
        leave: async () => (await S.phone.key(KEYS.POWER)).code,
        back: async (out) => {
          await S.phone.key(KEYS.WAKEUP);
          say('ロックを解いてください。');
          const u = await S.phone.ensureUnlocked({ waitMs: WAIT_MS, say });
          out.unlockedAfter = u.unlocked;
          if (!u.unlocked) throw new Error(`phone-locked: ロックが解けませんでした（${Math.round(u.waitedMs / 1000)} 秒）`);
        },
      });
      fin(st, { pass: true });
    } catch (e) { fin(st, { pass: false }); failStep('e1', e); throw e; }
  });

});
