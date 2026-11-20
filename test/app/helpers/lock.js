// ブラウザを使う試験ファイルを、1 つずつ動かすための排他（node --test はファイルを並列に動かすため）。
// 並列だと Chrome が何台も同時に動き、時間に敏感な試験（実時間の録音、強制終了の狙い）が不安定になる。
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './static-server.js';

const LOCK = path.join(REPO_ROOT, 'work', 'B', '.browser-lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function acquireBrowserLock({ timeoutMs = 600000 } = {}) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 持ち主が死んでいれば、古い鍵を外す
      try {
        const pid = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'));
        if (!pidAlive(pid)) fs.rmSync(LOCK, { recursive: true, force: true });
      } catch { /* 書き込み中。もう一度 */ }
      if (Date.now() - t0 > timeoutMs) throw new Error('browser lock timeout');
      await sleep(500);
    }
  }
}

export function releaseBrowserLock() {
  try {
    const pid = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'));
    if (pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true });
  } catch { /* 無視 */ }
}
