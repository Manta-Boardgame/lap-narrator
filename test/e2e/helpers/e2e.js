// 通し試験（test/e2e/flow.test.js）の道具（担当 D）。作業は work/D/e2e/ の下だけ。ポートは 8190〜8199 だけ。
// ブラウザは、work/D/e2e/profile-<名前>/ の専用のプロフィールで起動する（利用者のプロフィールは使わない）。
// 強制終了は、自分が起動した pid（とその子）だけを taskkill /F /T /PID で止める。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const E2E = path.join(ROOT, 'work', 'D', 'e2e');
export const PY = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
export const NARRATE = path.join(ROOT, 'cli', 'narrate.js');
export const RATE = 48000;
export const PORT_MIN = 8190;
export const PORT_MAX = 8199;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ---- 静的サーバー（リポジトリの直下を配る。届いた要求を記録する） -------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav',
};

export function startServer(port) {
  if (port < PORT_MIN || port > PORT_MAX) throw new Error(`port out of range: ${port}`);
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url });
    const done = (status, headers, body) => { res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers }); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return done(405, {}, 'method not allowed'); }
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') return done(302, { Location: '/app/' }, '');
    if (rel.endsWith('/')) rel += 'index.html';
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
      origin: `http://127.0.0.1:${port}`, log,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}

// ---- Chrome -------------------------------------------------------------------------------------------
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p));
export const chromeFound = () => Boolean(CHROME);

export function forceKill(pid) {
  if (pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
}
const pidAlive = (pid) => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(String(pid));

export async function launchChrome({ name, port, fresh = true }) {
  if (!CHROME) throw new Error('chrome-not-found');
  if (port < PORT_MIN || port > PORT_MAX) throw new Error(`port out of range: ${port}`);
  const profile = path.join(E2E, `profile-${name}`);
  if (fresh) fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-default-apps', '--disable-sync', '--disable-component-update', '--disable-background-networking',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
    '--headless=new', 'about:blank',
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  let exited = false;
  child.on('exit', () => { exited = true; });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, { timeoutMs: 20000, what: `chrome on ${port}` });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  return {
    name, port, pid, profile, browser, context,
    get exited() { return exited; },
    kill() { forceKill(pid); exited = true; },
    async close() {
      if (!exited) {
        await Promise.race([(async () => { const s = await browser.newBrowserCDPSession(); await s.send('Browser.close').catch(() => {}); })().catch(() => {}), sleep(3000)]);
      }
      const t0 = Date.now();
      while (!exited && pidAlive(pid) && Date.now() - t0 < 5000) await sleep(100);
      forceKill(pid);
      exited = true;
    },
  };
}

// ---- 録音アプリの画面（window.__lap） --------------------------------------------------------------------
export async function openApp(chrome, origin, query) {
  const page = await chrome.context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`${origin}/app/index.html${query}`);
  await page.waitForFunction(() => window.__lap, null, { timeout: 15000 });
  const toB64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');
  return {
    page, errors,
    press: (name, arg) => page.evaluate(([n, a]) => window.__lap.press(n, a), [name, arg]),
    state: () => page.evaluate(() => window.__lap.state()),
    events: () => page.evaluate(() => window.__lap.events()),
    durable: () => page.evaluate(() => window.__lap.durable()),
    feed: (i16, opts) => page.evaluate(([b, o]) => window.__lap.feed(b, o), [toB64(i16), opts || {}]),
    sessions: () => page.evaluate(() => window.__lap.sessions()),
    openSession: (id) => page.evaluate((i) => window.__lap.openSession(i), id),
  };
}

/** 台本パック（zip）を、画面の「台本を開く」から開き、新しい録音セッションを始める。sessionId を返す。 */
export async function openPackAndStart(app, packZip, projectId, speaker) {
  const page = app.page;
  // スライド区切りモード（従来の録り方）を入れる。既定は通し
  await page.evaluate(() => { localStorage.setItem('lap.recordMode', 'per-slide'); });
  await page.reload();
  await page.waitForFunction(() => window.__lap, null, { timeout: 15000 });
  await page.setInputFiles('#file-pack', packZip);
  await waitUntil(async () => /保存しました/.test(await page.textContent('#open-msg')), { what: '台本を開いたメッセージ' });
  await page.waitForSelector(`[data-act=new-session][data-project=${projectId}]`);
  if (speaker) await page.fill(`#speaker-${projectId}`, speaker);
  await page.click(`[data-act=new-session][data-project=${projectId}]`);
  await page.waitForSelector('#view-record:not([hidden])');
  return (await app.state()).sessionId ?? (await app.sessions()).at(-1).sessionId;
}

/** 偽のマイクの代わりに流す音：周波数 hz の正弦波（位相 0 から始まる）。verify が音の始まりを測れる。 */
export function tone(seconds, hz, amp = 0.4) {
  const n = Math.round(RATE * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / RATE));
  return out;
}

/** 書き出しを 1 巻ずつ（作る → ダウンロード → 保存を確かめる）行い、ZIP を dir に保存する。 */
export async function exportAll(app, opts, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const sum = await app.page.evaluate((o) => window.__lap.exportStart(o), opts);
  const files = [];
  for (let n = 1; n <= sum.volumes; n++) {
    const built = await app.page.evaluate((k) => window.__lap.exportBuild(k), n);
    const dl = app.page.waitForEvent('download', { timeout: 30000 });
    await app.page.evaluate((k) => window.__lap.exportDownload(k), n);
    const download = await dl;
    const file = path.join(dir, download.suggestedFilename());
    await download.saveAs(file);
    const size = fs.statSync(file).size;
    if (size !== built.bytes) throw new Error(`saved size ${size} != built ${built.bytes}`);
    await app.page.evaluate((k) => window.__lap.exportConfirm(k), n);
    files.push(file);
  }
  const index = await app.page.evaluate(() => window.__lap.exportIndex());
  const indexFile = path.join(dir, `${sum.exportId}_index.json`);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
  return { sum, files, index, indexFile };
}

// ---- 子プロセス ---------------------------------------------------------------------------------------
export function runNode(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }); reject(new Error('node child timed out: ' + args.join(' '))); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

/** node cli/narrate.js <args>。標準出力の 1 つの JSON を読んで返す。 */
export async function narrate(args, { timeoutMs = 900000 } = {}) {
  const t0 = performance.now();
  const r = await runNode([NARRATE, ...args], { timeoutMs });
  const ms = Math.round(performance.now() - t0);
  let env = null;
  try { env = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { /* env は null のまま */ }
  return { code: r.code, env, ms, stdout: r.stdout, stderr: r.stderr };
}

export function runPy(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(PY, ['-I', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}
