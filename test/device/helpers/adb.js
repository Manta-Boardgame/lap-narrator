// 実機の試験（担当 F）で使う adb の入口。許可された操作（dev/PLAN.md の F の欄）だけを通す。
//   devices / reverse / forward（ポートは 8140〜8149、9222〜9229 だけ）/ shell input keyevent / shell am force-stop com.android.chrome /
//   shell dumpsys（読むだけ）/ shell am start（Chrome で試験のページを開く）/ shell getprop（読むだけ）
// どれも、時間の上限を付け、標準入力を切り離し、出力はファイルへ向ける（adb が出力のパイプを握ったままハングした事故への対策）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ADB_EXE = path.join(ROOT, 'tools', 'platform-tools', 'adb.exe');
export const WORK = path.join(ROOT, 'work', 'F');
const TMP = path.join(WORK, 'adb-out');

export const CHROME_PKG = 'com.android.chrome';
export const SERVE_PORT_MIN = 8140;
export const SERVE_PORT_MAX = 8149;
export const CDP_PORT_MIN = 9222;
export const CDP_PORT_MAX = 9229;
export const DEVTOOLS_SOCKET = 'localabstract:chrome_devtools_remote';

// input keyevent で使ってよいキー：HOME、POWER、SLEEP、WAKEUP（画面ロックと、ロックの画面を出すための起こし）
export const KEYS = { HOME: 3, POWER: 26, SLEEP: 223, WAKEUP: 224 };
const KEY_OK = new Set(Object.values(KEYS).map(String));
const DUMPSYS_OK = new Set(['window', 'power', 'battery', 'trust', 'audio', 'activity', 'package']);

const inRange = (s, lo, hi) => /^[0-9]{4}$/.test(s) && Number(s) >= lo && Number(s) <= hi;
const tcpPort = (s, lo, hi) => /^tcp:[0-9]{4}$/.test(s) && inRange(s.slice(4), lo, hi);
const testUrl = (s) => s === 'about:blank' || new RegExp(`^http://localhost:(81[4][0-9])/[A-Za-z0-9_./?=&%-]*$`).test(s);

/** 許可された操作かを確かめる。許可されていなければ、理由を持つ Error を投げる。args は、`-s <serial>` を除いた引数。 */
export function checkAllowed(args) {
  const a = args;
  const deny = (why) => { throw new Error(`adb-not-allowed: ${a.join(' ')} (${why})`); };
  if (a.length === 0) deny('empty');
  const [cmd, ...r] = a;
  switch (cmd) {
    case 'devices':
      if (r.length === 0 || (r.length === 1 && r[0] === '-l')) return true;
      return deny('devices args');
    case 'reverse':
      if (r.length === 2 && tcpPort(r[0], SERVE_PORT_MIN, SERVE_PORT_MAX) && r[0] === r[1]) return true;
      if (r.length === 2 && r[0] === '--remove' && tcpPort(r[1], SERVE_PORT_MIN, SERVE_PORT_MAX)) return true;
      return deny('reverse: only tcp:8140-8149 and --remove of the same');
    case 'forward':
      if (r.length === 2 && tcpPort(r[0], CDP_PORT_MIN, CDP_PORT_MAX) && r[1] === DEVTOOLS_SOCKET) return true;
      if (r.length === 2 && r[0] === '--remove' && tcpPort(r[1], CDP_PORT_MIN, CDP_PORT_MAX)) return true;
      return deny('forward: only tcp:9222-9229 to chrome_devtools_remote and --remove of the same');
    case 'shell': {
      const [sub, ...q] = r;
      if (sub === 'input' && q[0] === 'keyevent' && q.length === 2 && KEY_OK.has(q[1])) return true;
      if (sub === 'am' && q[0] === 'force-stop' && q.length === 2 && q[1] === CHROME_PKG) return true;
      if (sub === 'am' && q[0] === 'start') {
        // am start -a android.intent.action.VIEW -d '<url>' com.android.chrome
        const ok = q.length === 6 && q[1] === '-a' && q[2] === 'android.intent.action.VIEW' && q[3] === '-d' && q[5] === CHROME_PKG
          && /^'.*'$/.test(q[4]) && testUrl(q[4].slice(1, -1));
        return ok ? true : deny('am start: only a VIEW intent for the test page in Chrome');
      }
      if (sub === 'dumpsys' && q.length >= 1 && DUMPSYS_OK.has(q[0])) {
        if (q[0] === 'package' && !(q.length === 2 && q[1] === CHROME_PKG)) return deny('dumpsys package: only Chrome');
        if (q[0] === 'activity' && !(q.length === 2 && q[1] === 'activities')) return deny('dumpsys activity: only activities');
        if (q[0] !== 'package' && q[0] !== 'activity' && q.length !== 1) return deny('dumpsys args');
        return true;
      }
      if (sub === 'getprop' && q.length === 1 && /^ro\.(product|build)\.[a-z._]+$/.test(q[0])) return true;
      return deny('shell: not in the allowed list');
    }
    default:
      return deny('command');
  }
}

let seq = 0;
/**
 * adb を実行する。出力はファイルへ。時間の上限を超えたら、木ごと止める。
 * @returns {Promise<{code:number|null, out:string, timedOut:boolean, ms:number}>}
 */
export function adb(args, { serial = null, timeoutMs = 30000 } = {}) {
  checkAllowed(args);
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `o${process.pid}-${++seq}.txt`);
  const fd = fs.openSync(file, 'w');
  const full = serial && args[0] !== 'devices' ? ['-s', serial, ...args] : args;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(ADB_EXE, full, { stdio: ['ignore', fd, fd], windowsHide: true });
    let timedOut = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* 無視 */ }
      let out = '';
      try { out = fs.readFileSync(file, 'utf8'); fs.rmSync(file, { force: true }); } catch { /* 無視 */ }
      resolve({ code, out, timedOut, ms: Math.round(performance.now() - t0) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
      setTimeout(() => finish(null), 500);
    }, timeoutMs);
    child.on('error', () => finish(-1));
    child.on('exit', (code) => finish(code));
  });
}

/** `adb devices -l` の結果から、{serial, state, model} の一覧を作る。 */
export function parseDevices(out) {
  return out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const model = (rest.find((x) => x.startsWith('model:')) || '').slice(6);
    return { serial, state, model };
  });
}
