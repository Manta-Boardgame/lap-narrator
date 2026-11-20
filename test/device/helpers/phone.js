// スマホ（adb）と PC の配信、スマホの Chrome の操作（CDP）をまとめた入口（担当 F）。
// 使う adb の操作は helpers/adb.js が許可したものだけ。スマホの中のファイルは読まない。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { adb, parseDevices, ROOT, WORK, KEYS, CHROME_PKG, DEVTOOLS_SOCKET } from './adb.js';
import { Cdp, httpJson, sleep } from './cdp.js';

export { ROOT, WORK, KEYS, sleep };

// ---- PC の配信（録音アプリを adb reverse でスマホの localhost に出す）。配るのは app/、core/、schema/、examples/packs/ だけ。
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const SERVE_DIRS = ['/app/', '/core/', '/schema/'];

export function startServer(port) {
  if (port < 8140 || port > 8149) throw new Error(`port out of range: ${port}`);
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ at: Date.now(), method: req.method, url: req.url });
    const done = (status, headers, body) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return done(405, {}, 'method not allowed'); }
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') return done(302, { Location: '/app/index.html' }, '');
    if (rel.endsWith('/')) rel += 'index.html';
    if (!SERVE_DIRS.some((d) => rel.startsWith(d))) return done(404, {}, 'not found');
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT + path.sep)) return done(403, {}, 'forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return done(404, {}, 'not found');
      fs.readFile(file, (e2, data) => (e2 ? done(500, {}, 'error') : done(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }, data)));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      log, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}

export class Phone {
  constructor({ servePort = 8140, cdpPort = 9222, serial = process.env.DEVICE_SERIAL || null, log = console.log } = {}) {
    this.servePort = servePort;
    this.cdpPort = cdpPort;
    this.serial = serial;
    this.log = log;
    this.origin = `http://localhost:${servePort}`;
    this.keepTimer = null;
    this.keepBusy = false;
    this.madeReverse = false;
    this.madeForward = false;
    this.opened = new Set(); // 自分が開いたタブ（後始末で閉じる）
  }

  async run(args, opts = {}) { return adb(args, { serial: this.serial, ...opts }); }

  /** 接続の確認。`device` の機器が 1 台なければ null。 */
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
    const [model, maker, release, sdk, name] = await Promise.all(['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.name'].map((k) => this.prop(k)));
    const pk = (await this.run(['shell', 'dumpsys', 'package', CHROME_PKG], { timeoutMs: 30000 })).out;
    const chromePackage = (pk.match(/versionName=(\S+)/) || [])[1] || null;
    return { serial: this.serial, model, maker, android: release, sdk: Number(sdk), product: name, chromePackage };
  }

  /** 画面の状態：起きているか、ロックの画面が出ているか、前面のウィンドウ。 */
  async screen() {
    const [pw, wn] = await Promise.all([
      this.run(['shell', 'dumpsys', 'power'], { timeoutMs: 30000 }),
      this.run(['shell', 'dumpsys', 'window'], { timeoutMs: 30000 }),
    ]);
    const wakefulness = (pw.out.match(/mWakefulness=(\w+)/) || [])[1] || null;
    const ks = (wn.out.match(/isKeyguardShowing=(true|false)/) || [])[1];
    const focus = (wn.out.match(/mCurrentFocus=Window\{[^ ]+ u0 ([^}]+)\}/) || [])[1] || null;
    return { wakefulness, keyguard: ks === undefined ? null : ks === 'true', focus, powerOut: pw.out };
  }

  key(code) { return this.run(['shell', 'input', 'keyevent', String(code)], { timeoutMs: 15000 }); }

  /**
   * 画面が起きていて、ロックが解けているのを待つ。ロックされていれば、起こして、利用者が解くのを待つ（上限あり）。
   * 利用者の操作が要る場面なので、待っていることを標準エラー出力に出す。
   */
  async ensureUnlocked({ waitMs = 180000, say = (m) => process.stderr.write(m + '\n') } = {}) {
    const t0 = Date.now();
    let said = false;
    let lastWake = 0;
    for (;;) {
      const s = await this.screen();
      if (s.wakefulness === 'Awake' && s.keyguard === false) return { unlocked: true, waitedMs: Date.now() - t0, screen: s };
      if (Date.now() - t0 > waitMs) return { unlocked: false, waitedMs: Date.now() - t0, screen: s };
      if (!said) { say(`[F] スマホがロックされています。画面を起こしました。ロックを解いてください（最大 ${Math.round(waitMs / 1000)} 秒待ちます）。`); said = true; }
      if (Date.now() - lastWake > 8000) { await this.key(KEYS.WAKEUP); lastWake = Date.now(); }
      await sleep(2000);
    }
  }

  /** 画面が消えて試験が止まらないよう、一定の間隔で WAKEUP を送る（アプリには届かない）。 */
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

  // ---- ポート転送
  async setupPorts() {
    const r1 = await this.run(['reverse', `tcp:${this.servePort}`, `tcp:${this.servePort}`], { timeoutMs: 20000 });
    if (r1.code !== 0) throw new Error(`reverse failed: ${r1.out.trim()}`);
    this.madeReverse = true;
    const r2 = await this.run(['forward', `tcp:${this.cdpPort}`, DEVTOOLS_SOCKET], { timeoutMs: 20000 });
    if (r2.code !== 0) throw new Error(`forward failed: ${r2.out.trim()}`);
    this.madeForward = true;
  }
  async teardownPorts() {
    if (this.madeReverse) { await this.run(['reverse', '--remove', `tcp:${this.servePort}`], { timeoutMs: 15000 }); this.madeReverse = false; }
    if (this.madeForward) { await this.run(['forward', '--remove', `tcp:${this.cdpPort}`], { timeoutMs: 15000 }); this.madeForward = false; }
  }

  // ---- Chrome
  /** Chrome で url（localhost の試験のページ、または about:blank）を開く。 */
  async openInChrome(url = 'about:blank') {
    return this.run(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, CHROME_PKG], { timeoutMs: 30000 });
  }
  async forceStopChrome() { return this.run(['shell', 'am', 'force-stop', CHROME_PKG], { timeoutMs: 30000 }); }

  get cdpBase() { return `http://127.0.0.1:${this.cdpPort}`; }

  async waitDevtools(timeoutMs = 45000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      try { return { version: await httpJson(`${this.cdpBase}/json/version`, { timeoutMs: 3000 }), ms: Date.now() - t0 }; } catch (e) { last = e; }
      await sleep(250);
    }
    throw new Error(`devtools-not-ready: ${last && last.message}`);
  }
  async targets() {
    const l = await httpJson(`${this.cdpBase}/json/list`, { timeoutMs: 5000 });
    return Array.isArray(l) ? l : [];
  }
  async closeTarget(id) { try { await httpJson(`${this.cdpBase}/json/close/${id}`, { timeoutMs: 5000 }); } catch { /* 無視 */ } }

  /**
   * 前面の、読み込み済みの about:blank のタブ（am start で開いたもの）を探してつなぐ。
   * 見つからなければ、新しい target を作る。
   */
  async attachBlank({ timeoutMs = 20000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const list = (await this.targets()).filter((t) => t.type === 'page');
      const blank = list.filter((t) => t.url === 'about:blank');
      if (blank.length) {
        const t = blank[0];
        this.opened.add(t.id);
        const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        return { cdp, target: t, listed: list.map((x) => ({ id: x.id, url: x.url })) };
      }
      await sleep(400);
    }
    const list = (await this.targets()).map((x) => ({ type: x.type, url: x.url }));
    throw new Error(`no-blank-tab: ${JSON.stringify(list)}`);
  }

  /** Chrome を開き直す：am start（about:blank）→ DevTools → つなぐ。所要時間（ミリ秒）を返す。 */
  async relaunch() {
    const t0 = Date.now();
    const st = await this.openInChrome('about:blank');
    if (st.code !== 0) throw new Error(`am start failed: ${st.out.trim()}`);
    const dev = await this.waitDevtools();
    const att = await this.attachBlank();
    return { ...att, devtools: dev.version, ms: Date.now() - t0, devtoolsMs: dev.ms };
  }

  async cleanupTabs() {
    for (const id of this.opened) await this.closeTarget(id);
    this.opened.clear();
  }
}
