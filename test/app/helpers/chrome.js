// 試験用のブラウザの起動。利用者のプロフィールを使わず、work/B/profile-<名前>/ の専用のプロフィールで起動する。
// ポートは 8100〜8119 だけ。偽のマイク入力を使い、音は出さない。強制終了は、自分が起動した pid だけを止める。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { REPO_ROOT } from './static-server.js';

export const WORK = path.join(REPO_ROOT, 'work', 'B');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function chromePath() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* まだ */ }
    await sleep(100);
  }
  throw new Error(`chrome did not start on port ${port}`);
}

const alive = (pid) => {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.stdout.includes(String(pid));
};

/** 自分が起動した pid（とその子）だけを強制終了する。 */
export function forceKill(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
}

/**
 * @param {{name:string, port:number, fakeWav?:string, fresh?:boolean, headless?:boolean, extraArgs?:string[]}} o
 */
export async function launchChrome({ name, port, fakeWav, fresh = true, headless = true, extraArgs = [] }) {
  const exe = chromePath();
  if (!exe) throw new Error('chrome-not-found');
  if (port < 8100 || port > 8119) throw new Error(`port out of the allowed range: ${port}`);
  const profile = path.join(WORK, `profile-${name}`);
  if (fresh) fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-networking',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    // 本番の外部通信がないことの保険：自分のホスト以外の名前は引かせない
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
    ...(headless ? ['--headless=new'] : []),
    ...(fakeWav ? [`--use-file-for-fake-audio-capture=${fakeWav}%noloop`] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true, detached: false });
  const pid = child.pid;
  let exited = false;
  child.on('exit', () => { exited = true; });
  await waitForCdp(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];

  const handle = {
    name, port, pid, profile, browser, context,
    get exited() { return exited; },
    /** 強制終了（保存の途中を狙う試験用）。 */
    kill() {
      forceKill(pid);
      exited = true;
    },
    /** ふつうに閉じる。閉じなければ強制終了する。 */
    async close() {
      if (!exited) {
        // 閉じられない（応答がない）ときは待たずに強制終了へ進む
        await Promise.race([
          (async () => { const s = await browser.newBrowserCDPSession(); await s.send('Browser.close').catch(() => {}); })().catch(() => {}),
          sleep(3000),
        ]);
      }
      const t0 = Date.now();
      while (!exited && alive(pid) && Date.now() - t0 < 5000) await sleep(100);
      forceKill(pid);
      exited = true;
    },
  };
  return handle;
}

export async function waitUntil(fn, { timeoutMs = 10000, intervalMs = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export { sleep };
