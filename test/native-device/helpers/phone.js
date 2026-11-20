// ネイティブ版の実機（adb と、WebView の遠隔デバッグ）の入口。使う adb の操作は helpers/adb.js が許可したものだけ。
import { adb, PKG, ACTIVITY, KEYS, ROOT, WORK } from './adb.js';
import { Cdp, httpJson, sleep } from '../../device/helpers/cdp.js';
import { parseDevices } from '../../device/helpers/adb.js';

export { ROOT, WORK, KEYS, PKG, sleep };

export class NativePhone {
  constructor({ cdpPort = 9222, serial = process.env.DEVICE_SERIAL || null } = {}) {
    this.cdpPort = cdpPort;
    this.serial = serial;
    this.madeForward = false;
    this.startExtras = []; // am start に付ける診断用の旗（--ez lap_show_when_locked true など。helpers/adb.js が許す形だけ）
  }

  run(args, opts = {}) { return adb(args, { serial: this.serial, ...opts }); }

  async findDevice() {
    const r = await adb(['devices', '-l'], { timeoutMs: 30000 });
    if (r.timedOut) return { error: 'adb-devices-timeout' };
    const devs = parseDevices(r.out);
    const pick = this.serial ? devs.find((d) => d.serial === this.serial) : devs.find((d) => d.state === 'device');
    if (!pick) return { error: 'no-device', devices: devs };
    if (pick.state !== 'device') return { error: `device-state-${pick.state}`, devices: devs };
    this.serial = pick.serial;
    return { device: pick };
  }

  async prop(key) { return (await this.run(['shell', 'getprop', key], { timeoutMs: 15000 })).out.trim(); }
  async info() {
    const [model, maker, release, sdk] = await Promise.all(['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'ro.build.version.sdk'].map((k) => this.prop(k)));
    return { serial: this.serial, model, maker, android: release, sdk: Number(sdk) };
  }

  async screen() {
    const [pw, wn] = await Promise.all([this.run(['shell', 'dumpsys', 'power'], { timeoutMs: 30000 }), this.run(['shell', 'dumpsys', 'window'], { timeoutMs: 30000 })]);
    const wakefulness = (pw.out.match(/mWakefulness=(\w+)/) || [])[1] || null;
    const ks = (wn.out.match(/isKeyguardShowing=(true|false)/) || [])[1];
    const focus = (wn.out.match(/mCurrentFocus=Window\{[^ ]+ u0 ([^}]+)\}/) || [])[1] || null;
    return { wakefulness, keyguard: ks === undefined ? null : ks === 'true', focus };
  }

  key(code) { return this.run(['shell', 'input', 'keyevent', String(code)], { timeoutMs: 15000 }); }

  async ensureUnlocked({ waitMs = 180000, say = (m) => process.stderr.write(m + '\n') } = {}) {
    const t0 = Date.now();
    let said = false;
    let lastWake = 0;
    for (;;) {
      const s = await this.screen();
      if (s.wakefulness === 'Awake' && s.keyguard === false) return { unlocked: true, waitedMs: Date.now() - t0, screen: s };
      if (Date.now() - t0 > waitMs) return { unlocked: false, waitedMs: Date.now() - t0, screen: s };
      if (!said) { say(`[K] スマホがロックされています。画面を起こしました。ロックを解いてください（最大 ${Math.round(waitMs / 1000)} 秒待ちます）。`); said = true; }
      if (Date.now() - lastWake > 8000) { await this.key(KEYS.WAKEUP); lastWake = Date.now(); }
      await sleep(2000);
    }
  }

  startKeepAlive(everyMs = 10000) {
    this.stopKeepAlive();
    this.keepTimer = setInterval(async () => {
      if (this.keepBusy) return;
      this.keepBusy = true;
      try { await this.key(KEYS.WAKEUP); } catch { /* 無視 */ } finally { this.keepBusy = false; }
    }, everyMs);
    this.keepTimer.unref?.();
  }
  stopKeepAlive() { if (this.keepTimer) { clearInterval(this.keepTimer); this.keepTimer = null; } }

  async pid() {
    const r = await this.run(['shell', 'pidof', PKG], { timeoutMs: 15000 });
    const m = r.out.trim().match(/^\d+/);
    return m ? Number(m[0]) : null;
  }
  async start() { return this.run(['shell', 'am', 'start', '-n', ACTIVITY, ...this.startExtras], { timeoutMs: 30000 }); }
  async forceStop() { return this.run(['shell', 'am', 'force-stop', PKG], { timeoutMs: 30000 }); }

  async removeForward() {
    if (this.madeForward) { await this.run(['forward', '--remove', `tcp:${this.cdpPort}`], { timeoutMs: 15000 }); this.madeForward = false; }
  }
  async forwardTo(pid) {
    await this.removeForward();
    const r = await this.run(['forward', `tcp:${this.cdpPort}`, `localabstract:webview_devtools_remote_${pid}`], { timeoutMs: 20000 });
    if (r.code !== 0) throw new Error(`forward failed: ${r.out.trim()}`);
    this.madeForward = true;
  }

  get cdpBase() { return `http://127.0.0.1:${this.cdpPort}`; }

  /** アプリを起動（または起動済みを使う）→ pid を待つ → 転送 → WebView のページにつなぐ。 */
  async launchAndAttach({ timeoutMs = 60000, fresh = false } = {}) {
    const t0 = Date.now();
    if (fresh) { await this.forceStop(); await sleep(800); }
    const st = await this.start();
    if (st.code !== 0 || /Error|Exception/i.test(st.out)) throw new Error(`am start failed: ${st.out.trim()}`);
    let pid = null;
    while (Date.now() - t0 < timeoutMs && !(pid = await this.pid())) await sleep(300);
    if (!pid) throw new Error('app-did-not-start (pidof が空)');
    await this.forwardTo(pid);
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const list = await httpJson(`${this.cdpBase}/json/list`, { timeoutMs: 3000 });
        const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && /^https:\/\/localhost/.test(t.url)) : null;
        if (page) {
          const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
          await cdp.send('Page.enable');
          await cdp.send('Runtime.enable');
          return { cdp, pid, target: { id: page.id, url: page.url }, ms: Date.now() - t0 };
        }
        last = `no https://localhost page: ${JSON.stringify((Array.isArray(list) ? list : []).map((t) => t.url))}`;
      } catch (e) { last = e.message; }
      await sleep(400);
    }
    throw new Error(`webview-devtools-not-ready: ${last}（APK が debuggable でない、または webContentsDebuggingEnabled が false の可能性）`);
  }

  /** 自作アプリのサービスの状態（dumpsys activity services <自作アプリ>）。 */
  async serviceState() {
    const r = await this.run(['shell', 'dumpsys', 'activity', 'services', PKG], { timeoutMs: 30000 });
    const t = r.out;
    return {
      hasRecorderService: /RecorderService/.test(t),
      isForeground: /isForeground=true/.test(t),
      foregroundServiceType: (t.match(/foregroundServiceType=(0x[0-9a-f]+|\w+)/i) || [])[1] || null,
      lines: t.split(/\r?\n/).filter((l) => /(ServiceRecord|isForeground|foregroundId|foregroundNoti|foregroundServiceType|startRequested)/.test(l)).map((l) => l.trim().slice(0, 200)).slice(0, 12),
    };
  }

  /** 自作アプリのマイクの使用（dumpsys audio の録音の項目から、自作アプリに関わる行だけ）。 */
  async audioRecordingLines() {
    const r = await this.run(['shell', 'dumpsys', 'audio'], { timeoutMs: 30000 });
    return r.out.split(/\r?\n/).filter((l) => l.includes(PKG)).map((l) => l.trim().slice(0, 240)).slice(0, 12);
  }

  /** 自作アプリの logcat（pid で絞る）。 */
  async logcat(pid, lines = 200) {
    const r = await this.run(['logcat', '-d', '-t', String(lines), `--pid=${pid}`], { timeoutMs: 30000 });
    return r.out;
  }

  /** 前面の状態：フォーカスのウィンドウ、前面のアクティビティ、ロックの状態（dumpsys window / activity activities から、決めた項目だけ取る）。 */
  async frontInfo() {
    const [wn, ac] = await Promise.all([
      this.run(['shell', 'dumpsys', 'window'], { timeoutMs: 30000 }),
      this.run(['shell', 'dumpsys', 'activity', 'activities'], { timeoutMs: 30000 }),
    ]);
    const first = (txt, re) => { const m = txt.match(re); return m ? (m[1] || m[0]).trim().slice(0, 200) : null; };
    return {
      focus: first(wn.out, /mCurrentFocus=Window{[^ ]+ u0 ([^}]+)}/),
      focusedApp: first(wn.out, /mFocusedApp=.*?ActivityRecord{[^ ]+ u0 ([^ ]+)/),
      keyguard: first(wn.out, /isKeyguardShowing=(true|false)/),
      topResumed: first(ac.out, /topResumedActivity=ActivityRecord{[^ ]+ u0 ([^ ]+)/),
      resumed: first(ac.out, /ResumedActivity: ActivityRecord{[^ ]+ u0 ([^ ]+)/),
      documentsUiInStack: /documentsui/i.test(ac.out),
      obscuring: first(wn.out, /mObscuringWindow=(.*)/),
    };
  }

  /** logcat のうち、自作アプリと DocumentsUI、入力の取りこぼしに関わる行だけを残す（ほかのアプリの行は残さない）。 */
  async logcatRelevant(sinceMarker = null) {
    const r = await this.run(['logcat', '-d'], { timeoutMs: 40000 });
    const lines = r.out.split('\n').filter((l) => /(documentsui|io\.github\.lapnarrator|CREATE_DOCUMENT|obscur|Dropping|FLAG_WINDOW_IS_OBSCURED)/i.test(l));
    return lines.slice(-80).map((l) => l.slice(0, 280));
  }

  async cleanup() {
    this.stopKeepAlive();
    await this.removeForward();
  }
}
