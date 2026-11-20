// 偽のマイクに WAV を流し込み、予定表（plan.json）どおりに録音アプリを実時間で操作する道具（担当 E）。
// 既存の helpers/e2e.js は変えない（そこから startServer、openApp、openPackAndStart、exportAll などを使う）。
// ブラウザは、呼び出し側が指定した専用のプロフィールで起動する（利用者のプロフィールは使わない）。スピーカーからは鳴らさない（--mute-audio）。
//
// クロックの合わせ方：WAV の先頭には、合図の音（1kHz、0.15 秒）が入っている。録音を始めてから、最初に取り込まれた音の中の合図の位置を測り、
// 「WAV の時刻 ↔ 録音の位置」を決める。そのあとは、予定表の時刻に、画面の操作と同じ働き（window.__lap.press）を、ページの中で行う
// （録音中は音声の位置で、録音していない間は壁の時計で時刻を決める）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { waitUntil, forceKill, sleep, chromeFound } from './e2e.js';

export { chromeFound };
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p));

/**
 * 偽のマイクに wav（48kHz、モノラル、16 ビット）を流す Chrome を起動する。wav は 1 回だけ流れる（繰り返さない）。
 * @param {{profile:string, port:number, wav:string}} o
 */
export async function launchChromeWithWav({ profile, port, wav }) {
  if (!CHROME) throw new Error('chrome-not-found');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-default-apps', '--disable-sync', '--disable-component-update', '--disable-background-networking',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.resolve(wav)}%noloop`,
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
    '--headless=new', 'about:blank',
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  let exited = false;
  child.on('exit', () => { exited = true; });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, { timeoutMs: 20000, what: `chrome on ${port}` });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return {
    port, pid, profile, browser, context: browser.contexts()[0],
    async close() {
      if (!exited) {
        await Promise.race([(async () => { const s = await browser.newBrowserCDPSession(); await s.send('Browser.close').catch(() => {}); })().catch(() => {}), sleep(3000)]);
      }
      const t0 = Date.now();
      while (!exited && Date.now() - t0 < 5000) await sleep(100);
      forceKill(pid);
      exited = true;
    },
  };
}

/**
 * 予定表を、ページの中で実時間で実行する。最初の操作（record）を押してから、合図の音でクロックを合わせ、残りの操作を時刻どおりに押す。
 * @returns {Promise<{ok:boolean, error?:string, calibration:object, log:object[]}>}
 */
export function runPlan(app, plan) {
  return app.page.evaluate(async (plan) => {
    const R = plan.sampleRate;
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const log = [];
    const api = window.__lap;
    const ops = plan.ops;
    // 1) 最初の record
    const w1 = performance.now();
    const r1 = await api.press(ops[0].name);
    log.push({ i: 0, name: ops[0].name, planned: ops[0].at, wall: performance.now(), pressMs: performance.now() - w1, res: r1 });
    if (!r1 || r1.ok === false) return { ok: false, error: 'first record failed: ' + JSON.stringify(r1), log };
    // 2) 合図の音の位置を測る（保存位置と時計の対応も取る）
    const pairs = [];
    const needPos = Math.round((plan.beepAt / R + 0.15 + 0.5) * R);
    const tEnd = performance.now() + 15000;
    while (performance.now() < tEnd) {
      const d = api.durable();
      if (d && Number.isFinite(d.pos)) {
        pairs.push([performance.now(), d.pos]);
        if (d.pos >= needPos) break;
      }
      await sleepMs(5);
    }
    if (!pairs.length || pairs.at(-1)[1] < needPos) return { ok: false, error: 'no audio captured for calibration', log };
    const st = await api.state();
    const rawName = st.rawFiles[0].name;
    const b64 = await api.readRawBase64(rawName);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(u8.buffer, 0, u8.length >> 1);
    const scanEnd = Math.min(pcm.length, Math.round((plan.beepAt / R + 0.15) * R) + 4000);
    let mx = 0;
    for (let i = 0; i < scanEnd; i++) mx = Math.max(mx, Math.abs(pcm[i]));
    let onset = -1;
    for (let i = 0; i < scanEnd; i++) if (Math.abs(pcm[i]) > 0.5 * mx) { onset = i; break; }
    // 合図の音かどうか：1kHz の成分の強さ（Goertzel）が、実効値の大部分を占める
    const n = plan.beepSamples - 960;
    const a0 = onset + 480;
    let s1 = 0, s2 = 0, e = 0;
    const cw = 2 * Math.cos((2 * Math.PI * 1000) / R);
    for (let i = 0; i < n; i++) { const v = pcm[a0 + i] / 32768; const s = v + cw * s1 - s2; s2 = s1; s1 = s; e += v * v; }
    const mag = Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2) * 2 / n;
    const purity = mag / (Math.sqrt(e / n) * Math.SQRT2);
    if (onset < 0 || !(purity > 0.8)) return { ok: false, error: `calibration beep not found (onset ${onset}, purity ${purity})`, log };
    const tA1 = plan.beepAt / R - onset / R; // 最初の録音の位置 0 に対応する WAV の時刻（秒）
    let wA1 = Infinity;
    for (const [w, p] of pairs) wA1 = Math.min(wA1, w - (p / R) * 1000);
    const calibration = { onsetSample: onset, purity, armLagSec: tA1, pairs: pairs.length, mx };
    // 3) 残りの操作。録音中の操作（ok、next、retake）は、音声の位置（アプリが数えるサンプル数。マイクの音声の時計）で時刻を決める
    //    （壁の時計とは、数十ミリ秒の揺れがある）。録音していない間（retake から record まで）は、壁の時計で待つ。
    const tracker = { pos: 0, t: performance.now() };
    const poll = () => { const d = api.durable(); if (d && Number.isFinite(d.pos) && d.pos !== tracker.pos) { tracker.pos = d.pos; tracker.t = performance.now(); } };
    const estPos = () => tracker.pos + ((performance.now() - tracker.t) * R) / 1000;
    const LEAD = Math.round(0.005 * R); // 押してから位置が決まるまでの時間（約 5 ミリ秒）
    const lastEvent = async (type) => { const ev = await api.events(); for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === type) return ev[i]; return null; };
    let tA = tA1; // いまの録音区間の位置（posBase）に対応する WAV の時刻（秒）
    let posBase = 0;
    let retakeWall = null; let retakeWav = null; let retakeAt = null;
    for (let i = 1; i < ops.length; i++) {
      const o = ops[i];
      if (o.name === 'record') {
        if (retakeWall === null) return { ok: false, error: 'record without a retake before it', calibration, log };
        const target = retakeWall + ((o.at - retakeAt) / R) * 1000;
        const wait = target - performance.now();
        if (wait > 0) await sleepMs(wait);
        const w = performance.now();
        const res = await api.press('record');
        const done = performance.now();
        log.push({ i, name: o.name, slideId: o.slideId, planned: o.at, wall: w, lateMs: w - target, pressMs: done - w, res });
        if (!res || res.ok === false) return { ok: false, error: `op ${i} record failed: ${JSON.stringify(res)}`, calibration, log };
        const rs = await lastEvent('resume');
        posBase = rs.at.pos;
        tA = retakeWav + (w - retakeWall) / 1000 + 0.005; // 押してから、取り込みが始まるまでの約 5 ミリ秒
        tracker.pos = posBase; tracker.t = performance.now();
        continue;
      }
      const targetPos = posBase + Math.round((o.at / R - tA) * R) - LEAD;
      const tLimit = performance.now() + 60000;
      for (;;) {
        poll();
        const e = estPos();
        if (e >= targetPos) break;
        if (performance.now() > tLimit) return { ok: false, error: `op ${i} ${o.name}: position never reached`, calibration, log };
        await sleepMs(Math.max(1, Math.min(8, ((targetPos - e) / R) * 1000 - 10)));
      }
      const w = performance.now();
      const posAtPress = estPos();
      const res = await api.press(o.name);
      log.push({ i, name: o.name, slideId: o.slideId, planned: o.at, wall: w, lateMs: ((posAtPress - (targetPos + LEAD)) / R) * 1000, pressMs: performance.now() - w, res });
      if (!res || res.ok === false) return { ok: false, error: `op ${i} ${o.name} failed: ${JSON.stringify(res)}`, calibration, log };
      if (o.name === 'retake') {
        const rt = await lastEvent('retake');
        retakeWall = performance.now();
        retakeAt = o.at;
        retakeWav = tA + (rt.at.pos - posBase) / R;
        // 撮り直しの時刻（WAV）は、位置から求めた時刻。予定表の時刻と少しずれていてよい。壁の時計は、押し終わった時刻
        retakeAt = o.at + Math.round((retakeWav - o.at / R) * R);
      }
    }
    return { ok: true, calibration, log };
  }, plan);
}
