// 診断（担当 K2）：画面ロックの約 62 秒後に、ネイティブ版（Capacitor）の録音の取得が止まる原因の切り分け。
// 使い方：  node test/native-device/diag/lock-diag.mjs base,noise,rp,home      （環境変数 DEVICE_SERIAL 必須。条件の名前をコンマ区切りで）
//   DIAG_LOCK_SEC     ロックしておく秒数（既定 200）
//   DIAG_NOISE_DB     noise 条件の雑音のレベル（既定 -90、dBFS）
// 条件（CONDS）：
//   base   ロック。何も足さない（再現と観測）
//   noise  H1：聞こえない雑音（-90 dBFS）を destination につなぎ、実デバイスの出力を生かす。ロック
//   rp     H2：WebView のレンダラーを setRendererPriorityPolicy(IMPORTANT, false) にする。ロック
//   home   H3：画面をつけたまま HOME。キープアライブ（WAKEUP）で画面を点けておく
//   fixed  native-bridge.js の修正が入った APK を、そのまま（診断の追加なしで）試す。ロック
// 1 秒ごとの観測（CDP）：AudioContext.currentTime、process() の回数（AudioWorklet の中を inject で数える）、レベル通知の回数、トラックの muted/readyState、
//   取得数と書き込み数（Worker の stats）、performance.now() の進み、ページのタイマーの拍。
// 止まった時刻の前後（と一定間隔）で adb の snapshot：dumpsys audio / activity processes / deviceidle / power / activity services、logcat（自作アプリの pid とレンダラーの pid に絞る）。
// app/ は変えない（ページの外から inject するだけ）。利用者の操作は不要（最初にロックが解けていること。解けていなければ最大 180 秒待つ）。
import fs from 'node:fs';
import path from 'node:path';
import { readZipDirectory, readZipEntry } from '../../../core/zip.js';
import { NativePhone, ROOT, WORK, KEYS, PKG, sleep } from '../helpers/phone.js';
import { injectSource } from '../../device/helpers/inject.js';

const OUT_DIR = path.join(WORK, 'diag');
fs.mkdirSync(OUT_DIR, { recursive: true });
const LOCK_SEC = Number(process.env.DIAG_LOCK_SEC || 200);
const NOISE_DB = Number(process.env.DIAG_NOISE_DB || -90);
const WAIT_USER_MS = 180000;
const APP_URL = 'https://localhost/app/index.html?lapdev=1&countdown=0&nosw=1';
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const NOW = () => new Date().toISOString();
const say = (m) => process.stderr.write(`[K2 ${NOW().slice(11, 19)}] ${m}\n`);

const CONDS = {
  base: { lock: true },
  noise: { lock: true, noiseDb: NOISE_DB },
  rp: { lock: true, rp: 'important' },
  home: { lock: false, home: true },
  wdog: { lock: false, home: true, noKeep: true }, // 見張りの試験：雑音を止めて凍結を再現し、ネイティブの見張りが検出したか（stallCount）を、戻したあとに読む
  homenoise: { lock: false, home: true, noiseDb: NOISE_DB }, // H1'：実出力が「音あり」と判定される大きさの雑音（DIAG_NOISE_DB）
  homeplain: { lock: false, home: true, plain: true }, // ライフサイクルの記録だけ（worklet の書き換えなし）。ブリッジの雑音は入る
  homelock: { lock: false, home: true, webLock: true }, // H5：Web Locks を握る（ページの凍結の除外条件）
  fixedhome: { lock: false, home: true, plain: true },
  fixed: { lock: true, plain: true }, // 診断の追加（worklet の書き換え、トラックの記録、雑音）を入れず、ページの標本だけ
};

// ---------------------------------------------------------------- ページへ差し込む診断
function diagSource(cfg) {
  return `(() => {
  if (window.__diagInstalled) return; window.__diagInstalled = true;
  const cfg = window.__diagCfg = ${JSON.stringify(cfg)};
  const D = window.__D = { lv: 0, beat: 0, pc: null };
  setInterval(() => { D.beat++; D.beatAt = performance.now(); }, 1000);
  D.life = [];
  for (const ev of ['freeze', 'resume']) document.addEventListener(ev, () => D.life.push({ ev, perf: Math.round(performance.now()), vis: document.visibilityState }), true);
  document.addEventListener('visibilitychange', () => D.life.push({ ev: 'vis:' + document.visibilityState, perf: Math.round(performance.now()) }), true);
  if (cfg.webLock && navigator.locks) { navigator.locks.request('k2-keepalive', () => new Promise(() => {})); D.webLock = true; }
  if (cfg.plain) return;
  window.__tracks = [];
  try {
    const md = navigator.mediaDevices; const g = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => { const s = await g(c); s.getAudioTracks().forEach((t) => window.__tracks.push(t)); return s; };
  } catch (e) { D.errGum = String(e); }
  try {
    const Prev = window.AudioContext;
    window.AudioContext = class extends Prev {
      constructor(...a) {
        super(...a);
        if (cfg.noiseDb !== undefined && cfg.noiseDb !== null) {
          const n = this.sampleRate; const buf = this.createBuffer(1, n, n); const d = buf.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
          const src = this.createBufferSource(); src.buffer = buf; src.loop = true;
          const gn = this.createGain(); gn.gain.value = Math.pow(10, cfg.noiseDb / 20);
          src.connect(gn); gn.connect(this.destination); src.start();
          D.noise = cfg.noiseDb;
        }
      }
    };
  } catch (e) { D.errAC = String(e); }
  try {
    const Prev = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Prev {
      constructor(...a) {
        super(...a);
        window.__awn = this;
        this.port.addEventListener('message', (e) => {
          const m = e.data; if (!m) return;
          if (m.kind === '__pc') { D.pc = m.n; D.pcFrame = m.f; D.pcAt = performance.now(); }
          else if (m.kind === 'level') { D.lv++; D.lvAt = performance.now(); D.rms = m.rms; D.peak = m.peak; }
        });
      }
    };
  } catch (e) { D.errAWN = String(e); }
  try {
    const PREFIX = "(function(){const R=registerProcessor;globalThis.registerProcessor=function(n,c){const p=c.prototype.process;let k=0;c.prototype.process=function(i,o,a){k++;if(k%375===0){try{this.port.postMessage({kind:'__pc',n:k,f:currentFrame})}catch(e){}}return p.call(this,i,o,a)};return R.call(this,n,c)}})();\\n";
    const orig = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function (u, o) {
      try {
        const t = await (await fetch(u)).text();
        const b = new Blob([PREFIX + t], { type: 'text/javascript' });
        D.wrapped = true;
        return await orig.call(this, URL.createObjectURL(b), o);
      } catch (e) { D.errWrap = String(e); return orig.call(this, u, o); }
    };
  } catch (e) { D.errAM = String(e); }
})();`;
}

const SAMPLE = `(async () => {
  const D = window.__D || {}; const ac = window.__ac;
  const out = { perf: performance.now(), wall: Date.now(), vis: document.visibilityState, ac: ac ? ac.state : null, ct: ac ? ac.currentTime : null,
    outLat: ac ? ac.outputLatency : null, pc: D.pc ?? null, pcFrame: D.pcFrame ?? null, pcAge: D.pcAt ? Math.round(performance.now() - D.pcAt) : null,
    life: D.life ? D.life.slice(-6) : null, lv: D.lv ?? 0, lvAge: D.lvAt ? Math.round(performance.now() - D.lvAt) : null, rms: D.rms ?? null, peak: D.peak ?? null, beat: D.beat ?? null,
    trk: (window.__tracks || []).map((t) => ({ m: t.muted, r: t.readyState, e: t.enabled })) };
  try {
    const s = window.__lap.app.session; const t0 = performance.now();
    const st = await Promise.race([s.backend.stats(), new Promise((_, rj) => setTimeout(() => rj(new Error('stats-timeout')), 1500))]);
    out.captured = st.captured; out.written = st.written; out.gaps = st.gaps; out.dropped = st.dropped; out.statsMs = Math.round(performance.now() - t0);
  } catch (e) { out.statsErr = String((e && e.message) || e); }
  return out;
})()`;

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

// ---------------------------------------------------------------- adb の snapshot
function blocksOf(text) {
  const lines = text.split(/\r?\n/);
  const blocks = []; let cur = null;
  for (const l of lines) {
    if (/^ {2}\*(APP|PERS)\* UID /.test(l)) { cur = [l]; blocks.push(cur); } else if (cur && /^ {0,2}\S/.test(l) && !/^ {2}\*(APP|PERS)\*/.test(l)) { cur = null; } else if (cur) cur.push(l);
  }
  return blocks;
}

class Snap {
  constructor(phone) { this.phone = phone; this.uid = null; this.appPid = null; this.rendPids = new Set(); this.logSeen = new Set(); this.logLines = []; }

  async procs() {
    const r = await this.phone.run(['shell', 'dumpsys', 'activity', 'processes'], { timeoutMs: 60000 });
    const bs = blocksOf(r.out);
    const main = bs.find((b) => b[0].includes(`:${PKG}/`));
    if (main) { const m = main[0].match(/UID (\d+) ProcessRecord\{\S+ (\d+):/); if (m) { this.uid = m[1]; this.appPid = Number(m[2]); } }
    const appId = this.uid ? Number(this.uid) - 10000 : -1;
    const mine = bs.filter((b) => b[0].includes(`:${PKG}/`) || b[0].includes(`/u0a${appId}i`));
    const keep = /(ProcessRecord|pid=|oom adj|mCurSchedGroup|curProcState|cached=|isFrozen|isPendingFreeze|earliestFreezable|ConnectionRecord|foregroundServices|fgServiceTypes|hasShownUi|lastActivityTime|curCapability|mHasForegroundServices|ISOLATED)/;
    const out = [];
    this.rendPids.clear();
    for (const b of mine) {
      const h = b[0].match(/ProcessRecord\{\S+ (\d+):/); if (h && !b[0].includes(`:${PKG}/`)) this.rendPids.add(Number(h[1]));
      for (const l of b) if (keep.test(l)) out.push(l.trim().slice(0, 230));
      out.push('--');
    }
    return out;
  }

  async audio() {
    const r = await this.phone.run(['shell', 'dumpsys', 'audio'], { timeoutMs: 60000 });
    const uid = this.uid;
    const re = new RegExp(`${PKG.replace(/\./g, '\\.')}|[^0-9]${uid}[^0-9]|[^0-9]${uid}$`);
    return r.out.split(/\r?\n/).filter((l) => uid && re.test(l)).map((l) => l.trim().slice(0, 260)).slice(-60);
  }

  async idle() {
    const r = await this.phone.run(['shell', 'dumpsys', 'deviceidle'], { timeoutMs: 40000 });
    return r.out.split(/\r?\n/).filter((l) => /(mState=|mLightState=|mCharging|mScreenOn|mDeepEnabled|mLightEnabled|mForceIdle|mNextAlarmTime|mNextIdleDelay|mLocked|mScreenLocked|lapnarrator)/.test(l) && !/^\s*$/.test(l)).map((l) => l.trim().slice(0, 200)).slice(0, 25);
  }

  async power() {
    const r = await this.phone.run(['shell', 'dumpsys', 'power'], { timeoutMs: 40000 });
    const lines = r.out.split(/\r?\n/);
    const keepRe = new RegExp(`(mWakefulness=|mHoldingWakeLockSuspendBlocker|mHoldingDisplaySuspendBlocker|Wake Locks: size|mWakeLockSummary|mUserActivitySummary|${PKG.replace(/\./g, '\\.')}|uid=${this.uid || 'XXXX'}[ )])`);
    const out = []; let inLocks = false;
    for (const l of lines) {
      if (/^Wake Locks: size=/.test(l)) { inLocks = true; out.push(l.trim()); continue; }
      if (inLocks && /^\S/.test(l)) inLocks = false;
      if (inLocks && /(PARTIAL|FULL|SCREEN|PROXIMITY|DRAW)_?\w*\s+'/.test(l) && (l.includes(PKG) || (this.uid && l.includes(`uid=${this.uid}`)))) out.push(l.trim().slice(0, 220));
      else if (!inLocks && keepRe.test(l) && !/ACQ|REL/.test(l)) out.push(l.trim().slice(0, 200));
    }
    return out.slice(0, 30);
  }

  async logs() {
    const r = await this.phone.run(['logcat', '-d'], { timeoutMs: 60000 });
    const pids = new Set([String(this.appPid), ...[...this.rendPids].map(String)]);
    let added = 0;
    for (const l of r.out.split(/\r?\n/)) {
      if (this.logSeen.has(l)) continue;
      const m = l.match(/^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+(\w)\s+(\S+)\s*:/);
      if (!m) continue;
      const [, pid, , , tag] = m;
      const mine = pids.has(pid);
      const rel = /(AudioRecord|AAudio|AudioTrack|Freezer|freez|lapnarrator|LapDiag|SilentSink|AudioFlinger|AudioPolicy|ActivityManager|libprocessgroup|WindowManager|PowerManager|DeviceIdle|AppOps|audio)/i.test(l) && (/lapnarrator|10473/.test(l) || (this.appPid && l.includes(String(this.appPid))) || [...this.rendPids].some((p) => l.includes(String(p))));
      if (!mine && !rel) continue;
      if (mine && /(Choreographer|Compat|GraphicsEnvironment|nativeloader|QT|ziparchive|DisplayManager|InsetsController)/.test(l) && !/(Audio|chromium|cr_|Capacitor|LapDiag)/i.test(l)) continue;
      this.logSeen.add(l); added++;
      this.logLines.push(l.slice(0, 260));
    }
    return added;
  }

  async all(label, t0) {
    const t = Date.now();
    const procs = await this.procs();
    const [audio, idle, power, service, wake, logAdded] = await Promise.all([this.audio(), this.idle(), this.power(), this.phone.serviceState(), this.phone.screen(), this.logs()]);
    return { label, atSec: Math.round((t - t0) / 100) / 10, tookMs: Date.now() - t, screen: wake, appPid: this.appPid, rendererPids: [...this.rendPids], procs, audio, idle, power, service: { isForeground: service.isForeground, type: service.foregroundServiceType }, logAdded };
  }
}

// ---------------------------------------------------------------- 1 つの条件
async function ready(phone, cond) {
  // 画面を起こし、自作アプリをキーガードの上に出せるか。出せなければ、利用者にロック解除を頼んで最大 180 秒待つ。
  const t0 = Date.now(); let said = false;
  phone.startExtras = ['--ez', 'lap_show_when_locked', 'true'];
  for (;;) {
    await phone.key(KEYS.WAKEUP);
    await phone.start();
    await sleep(1500);
    const s = await phone.screen();
    if (s.wakefulness === 'Awake' && (s.keyguard === false || (s.focus || '').includes(PKG))) return { ok: true, screen: s };
    if (Date.now() - t0 > WAIT_USER_MS) return { ok: false, screen: s };
    if (!said) { say(`[条件 ${cond}] スマホのロックを解いてください（最大 ${WAIT_USER_MS / 1000} 秒待ちます）。`); fs.writeFileSync(path.join(OUT_DIR, 'NEEDS_UNLOCK.txt'), `${NOW()} ${cond}\n`); said = true; }
    await sleep(3000);
  }
}

async function runCond(name, cfg) {
  const R = { cond: name, cfg, startedAt: NOW(), lockSec: LOCK_SEC, samples: [], snaps: [], notes: [] };
  const file = path.join(OUT_DIR, `${name}-${NOW().replace(/[:.]/g, '').slice(0, 15)}.json`);
  const flush = () => fs.writeFileSync(file, JSON.stringify(R, null, 2) + '\n');
  const phone = new NativePhone();
  let cdp = null; let snap = null; let keep = null;
  try {
    const d = await phone.findDevice();
    if (d.error) { R.skipped = `no-device ${d.error}`; flush(); return R; }
    R.device = await phone.info();
    const rd = await ready(phone, name);
    if (!rd.ok) { R.skipped = `phone-locked-no-unlock ${JSON.stringify(rd.screen)}`; flush(); return R; }
    // 新しく起動（旗つき）
    phone.startExtras = ['--ez', 'lap_show_when_locked', 'true', ...(cfg.rp ? ['--es', 'lap_renderer_priority', cfg.rp] : [])];
    const att = await phone.launchAndAttach({ fresh: true });
    cdp = att.cdp; R.pid = att.pid;
    await cdp.send('Page.setBypassCSP', { enabled: true });
    if (cfg.noKeep) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__lapNativeTune = { noKeepAlive: true };' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource({ dropVisibility: false }) });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: diagSource(cfg) });
    await cdp.send('Page.navigate', { url: APP_URL });
    for (let i = 0; i < 200; i++) { if (await cdp.eval('!!window.__lap').catch(() => false)) break; await sleep(100); }
    if (!(await cdp.eval('!!window.__lap'))) throw new Error('__lap が出ない');
    // 前回の録音データがあれば消す
    R.staleData = await cdp.eval(`(async () => { const root = await navigator.storage.getDirectory(); let had = false; for await (const [n] of root.entries()) { if (n === 'lap') had = true; } if (had) { try { await root.removeEntry('lap', { recursive: true }); return 'removed'; } catch (e) { return 'remove-failed:' + e.name; } } return 'none'; })()`).catch((e) => `error:${e.message}`);
    if (R.staleData === 'removed') { await cdp.send('Page.navigate', { url: APP_URL }); for (let i = 0; i < 100; i++) { await sleep(100); if (await cdp.eval('!!window.__lap').catch(() => false)) break; } }
    const { script, images } = await loadPack();
    await cdp.eval(`__lap.loadScript(${JSON.stringify(script)}, ${JSON.stringify(images)})`);
    await cdp.eval(`__lap.newSession(${JSON.stringify(script.projectId)}, { speaker: 'diag' })`, { userGesture: true, timeoutMs: 120000 });
    const rec = await cdp.eval('__lap.press("record")', { userGesture: true, timeoutMs: 60000 });
    if (!rec || rec.ok === false) throw new Error(`録音が始まらない ${JSON.stringify(rec)}`);
    R.diagInstalled = await cdp.eval('({ cfg: window.__diagCfg, err: Object.keys(window.__D||{}).filter(k => k.startsWith("err")).map(k => k + "=" + window.__D[k]), wrapped: !!(window.__D && window.__D.wrapped), noise: window.__D && window.__D.noise })');
    snap = new Snap(phone);
    await sleep(6000);
    const t = await cdp.eval(SAMPLE, { timeoutMs: 5000 });
    R.healthy = t;
    if (!(t.captured > 0)) throw new Error(`録音が進んでいない ${JSON.stringify(t)}`);
    R.snaps.push(await snap.all('pre-lock', Date.now()));
    flush();

    if (cfg.wdog) {
      // 見張りの試験：AudioWorkletNode の出力を切り（process() が呼ばれなくなる）、ネイティブの見張りが「止まった」と判断するかを見る
      const st = (x) => cdp.eval('window.lapNative.status()', { timeoutMs: 5000 }).then((o) => ({ stalled: o.stalled, stallCount: o.stallCount, lastBeatAgeMs: o.lastBeatAgeMs, running: o.running }), (e) => ({ err: e.message }));
      R.wdog = { before: await st() };
      await cdp.eval('window.__awn.disconnect()');
      R.wdog.cutAt = NOW();
      R.wdog.after = [];
      for (let i = 0; i < 8; i++) { await sleep(1000); R.wdog.after.push(await st()); }
      R.wdog.pass = R.wdog.before.stalled === false && R.wdog.after.some((x) => x.stalled === true);
      say(`[${name}] 見張り: ${R.wdog.pass ? '検出した' : '検出しなかった'} ${JSON.stringify(R.wdog.after.map((x) => x.stalled))}`);
      R.cleanup = await cdp.eval(`(async () => { try { await window.__lap.closeSession(); } catch (e) { return 'close-failed:' + e.message; } return 'closed'; })()`, { timeoutMs: 20000 }).catch((e) => `error:${e.message}`);
      flush();
      return R;
    }
    // ---- 操作（ロック、または HOME）
    const tAct = Date.now();
    R.actionAt = NOW();
    if (cfg.lock) {
      await phone.key(KEYS.POWER);
      for (let i = 0; i < 8; i++) { await sleep(1000); const s = await phone.screen(); if (s.wakefulness !== 'Awake') break; if (i === 4) await phone.key(KEYS.SLEEP); }
    } else if (cfg.home) {
      await phone.key(KEYS.HOME);
      phone.startKeepAlive(8000);
    }
    R.afterAction = await phone.screen();
    say(`[${name}] 操作しました（${JSON.stringify(R.afterAction)}）。${LOCK_SEC} 秒観察します。`);

    // ---- 観察ループ
    let lastCaptured = null; let lastIncAt = 0; let stallAt = null; let snapBusy = false; let nextSnap = 15; const stallSnaps = new Set();
    const doSnap = async (label) => { if (snapBusy) return; snapBusy = true; try { R.snaps.push(await snap.all(label, tAct)); flush(); } catch (e) { R.notes.push(`snap ${label}: ${e.message}`); } finally { snapBusy = false; } };
    let bg = Promise.resolve();
    while ((Date.now() - tAct) / 1000 < LOCK_SEC) {
      const tick = Date.now();
      const sec = (tick - tAct) / 1000;
      let s;
      try { s = await cdp.eval(SAMPLE, { timeoutMs: 2500 }); } catch (e) {
        s = { err: String(e.message || e) };
        // 評価できないとき：WebView の DevTools の入口（ブラウザ側＝アプリのプロセス）は生きているか、レンダラーだけが止まっているか
        try { const t1 = Date.now(); await cdp.send('Browser.getVersion', {}, 2000); s.browserAliveMs = Date.now() - t1; } catch (e2) { s.browserErr = String(e2.message || e2).slice(0, 80); }
      }
      s.sec = Math.round(sec * 10) / 10; s.pcWall = tick;
      R.samples.push(s);
      if (s.captured !== undefined) {
        if (lastCaptured === null || s.captured > lastCaptured) { lastIncAt = sec; lastCaptured = s.captured; if (stallAt !== null) { R.resumedAt = sec; stallAt = null; } }
        else if (stallAt === null && sec - lastIncAt >= 3) { stallAt = lastIncAt; R.stallAtSec = Math.round(lastIncAt * 10) / 10; say(`[${name}] 取得が止まりました（最後の増加：操作の ${R.stallAtSec} 秒後）。`); }
      }
      else if (stallAt === null && sec - lastIncAt >= 3) { stallAt = lastIncAt; R.stallAtSec = Math.round(lastIncAt * 10) / 10; R.stallKind = 'eval-unresponsive'; say(`[${name}] ページが応答しません（最後の増加：操作の ${R.stallAtSec} 秒後）。`); }
      if (stallAt !== null) {
        for (const off of [5, 40, 100]) { const key = `stall+${off}`; if (!stallSnaps.has(key) && sec - stallAt >= off) { stallSnaps.add(key); bg = bg.then(() => doSnap(key)); } }
      }
      if (sec >= nextSnap && stallAt === null) { nextSnap += 30; bg = bg.then(() => doSnap(`t+${Math.round(sec)}`)); }
      const wait = 1000 - (Date.now() - tick);
      if (wait > 0) await sleep(wait);
    }
    await bg;
    await doSnap('end-before-wake');

    // ---- 画面を戻す
    phone.stopKeepAlive();
    R.wakeAt = NOW();
    await phone.key(KEYS.WAKEUP);
    await phone.start(); // extra つき（setShowWhenLocked/TurnScreenOn）。キーガードの上に出る
    const tWake = Date.now();
    R.afterWake = [];
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      let s; try { s = await cdp.eval(SAMPLE, { timeoutMs: 4000 }); } catch (e) { s = { err: String(e.message || e) }; }
      s.sec = Math.round((Date.now() - tAct) / 100) / 10; R.afterWake.push(s);
    }
    R.screenAfterWake = await phone.screen();
    R.nativeStatusAfterWake = await cdp.eval('window.lapNative ? Promise.all([window.lapNative.status(), Promise.resolve(window.lapNative.state())]).then(([a, b]) => ({ stalled: a.stalled, stallCount: a.stallCount, lastBeatAgeMs: a.lastBeatAgeMs, beats: b.beats, keepAlive: b.keepAlive })) : null', { timeoutMs: 8000 }).catch((e) => `error:${e.message}`);
    await doSnap('after-wake');
    // 結果の要約
    const smp = R.samples.filter((x) => x.captured !== undefined);
    const first = smp[0]; const last = smp[smp.length - 1];
    const dec = (arr, k) => arr.length ? arr[arr.length - 1][k] : null;
    R.summary = {
      samples: R.samples.length, errSamples: R.samples.filter((x) => x.err || x.statsErr).length,
      stallAtSec: R.stallAtSec ?? null, resumedAtSec: R.resumedAt ?? null,
      capturedFirst: first && first.captured, capturedLast: last && last.captured, writtenLast: last && last.written, gapsLast: last && last.gaps,
      ratio: last && first ? (last.captured - first.captured) / 48000 / (last.sec - first.sec) : null,
      ctAtStall: R.stallAtSec !== undefined ? (R.samples.find((x) => x.sec >= R.stallAtSec) || {}).ct : null,
      ctLast: dec(smp, 'ct'), ctFirst: first && first.ct, pcFirst: first && first.pc, pcLast: dec(smp, 'pc'), lvFirst: first && first.lv, lvLast: dec(smp, 'lv'),
      beatFirst: first && first.beat, beatLast: dec(smp, 'beat'), perfFirst: first && first.perf, perfLast: dec(smp, 'perf'), secLast: last && last.sec,
      acLast: dec(smp, 'ac'), trackLast: dec(smp, 'trk'),
      afterWakeCapturedDelta: R.afterWake.length > 1 && R.afterWake[0].captured !== undefined ? R.afterWake.at(-1).captured - R.afterWake[0].captured : null,
    };
    R.logcat = snap.logLines.slice(-400);
    R.finishedAt = NOW();
    flush();
    // 後始末：セッションを閉じる（マイクとサービスを止める）。録音データはアプリの中から消す。
    R.cleanup = await cdp.eval(`(async () => { try { await window.__lap.closeSession(); } catch (e) { return 'close-failed:' + e.message; } return 'closed'; })()`, { timeoutMs: 20000 }).catch((e) => `error:${e.message}`);
    flush();
  } catch (e) {
    R.error = String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ');
    say(`[${name}] 失敗: ${R.error}`);
    try { if (snap) R.logcat = snap.logLines.slice(-300); } catch { /* 無視 */ }
    flush();
  } finally {
    try { phone.stopKeepAlive(); } catch { /* 無視 */ }
    try { if (cdp) cdp.close(); } catch { /* 無視 */ }
    try { await phone.removeForward(); } catch { /* 無視 */ }
  }
  return R;
}

const names = (process.argv[2] || 'base').split(',').map((s) => s.trim()).filter(Boolean);
const results = [];
for (const n of names) {
  if (!CONDS[n]) { say(`未知の条件 ${n}`); continue; }
  const r = await runCond(n, CONDS[n]);
  results.push({ cond: n, summary: r.summary || null, skipped: r.skipped || null, error: r.error || null });
  say(`[${n}] 要約 ${JSON.stringify(r.summary || r.skipped || r.error)}`);
}
fs.writeFileSync(path.join(OUT_DIR, 'last-run.json'), JSON.stringify(results, null, 2) + '\n');
