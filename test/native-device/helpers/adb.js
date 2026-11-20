// ネイティブ版（担当 K）の実機の試験で使う adb の入口。許可された操作だけを通す（まとめ役の指示）。
//   devices、forward（9222〜9229 を webview_devtools_remote_<pid> へ、--remove、--list）、
//   shell am start -n io.github.lapnarrator/.MainActivity、shell am force-stop io.github.lapnarrator、shell pidof io.github.lapnarrator、
//   shell input keyevent（HOME、POWER、WAKEUP、SLEEP だけ）、shell dumpsys（読むだけ）、shell getprop、
//   shell logcat -d（自作アプリの pid、または自作アプリに関わる行だけを残す）。
// 禁止：install、uninstall、pm、push、pull、rm、root、reboot、settings、svc、ほかのアプリの操作、スマホの中のファイルを読むこと。
// どの呼び出しも、時間の上限を付け、標準入力を切り離し、出力はファイルへ向ける。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADB_EXE, ROOT } from '../../device/helpers/adb.js';

export { ROOT };
export const PKG = 'io.github.lapnarrator';
export const ACTIVITY = `${PKG}/.MainActivity`;
export const WORK = path.join(ROOT, 'work', 'K');
const TMP = path.join(WORK, 'adb-out');
export const KEYS = { HOME: 3, POWER: 26, SLEEP: 223, WAKEUP: 224 };
const KEY_OK = new Set(Object.values(KEYS).map(String));
const CDP_MIN = 9222;
const CDP_MAX = 9229;
const cdpPort = (s) => /^tcp:[0-9]{4}$/.test(s) && Number(s.slice(4)) >= CDP_MIN && Number(s.slice(4)) <= CDP_MAX;
// dumpsys：自作アプリの確認と、画面・電源の状態だけ（package と activity は自作アプリに絞る）
const DUMPSYS_PLAIN = new Set(['window', 'power', 'audio', 'battery', 'trust', 'deviceidle']);
// 診断（K2）：自作の debug APK の入れ直し（install -r。パスは自作のビルド出力か work/K の .apk だけ）、am start の extra（デバッグ用の旗だけ）
const APK_OK = (p) => { const n = String(p).split(String.fromCharCode(92)).join('/'); const root = ROOT.split(String.fromCharCode(92)).join('/'); return n.endsWith('.apk') && (n.startsWith(`${root}/android/app/build/outputs/apk/debug/`) || n.startsWith(`${root}/work/K/`)) && !n.includes('..'); };
const START_EXTRA_RE = /^start -n io\.github\.lapnarrator\/\.MainActivity((?: --ez lap_show_when_locked (?:true|false))?(?: --es lap_renderer_priority (?:important|default))?)$/;

export function checkAllowed(args) {
  const a = args;
  const deny = (why) => { throw new Error(`adb-not-allowed: ${a.join(' ')} (${why})`); };
  if (!a.length) deny('empty');
  const [cmd, ...r] = a;
  switch (cmd) {
    case 'devices': return r.length === 0 || (r.length === 1 && r[0] === '-l') || deny('devices args');
    case 'forward':
      if (r.length === 1 && r[0] === '--list') return true;
      if (r.length === 2 && r[0] === '--remove' && cdpPort(r[1])) return true;
      if (r.length === 2 && cdpPort(r[0]) && /^localabstract:webview_devtools_remote_[0-9]{1,8}$/.test(r[1])) return true;
      return deny('forward: only tcp:9222-9229 to webview_devtools_remote_<pid>');
    case 'install': return (r.length === 2 && r[0] === '-r' && APK_OK(r[1])) || deny('install: -r <own debug apk> only');
    case 'logcat':
      // logcat -d -t 200 --pid=<pid>、または logcat -d（出力は呼び出し側で自作アプリの行だけに絞る）
      if (r.length === 1 && r[0] === '-d') return true;
      if (r.length === 4 && r[0] === '-d' && r[1] === '-t' && /^[0-9]{1,4}$/.test(r[2]) && /^--pid=[0-9]{1,8}$/.test(r[3])) return true;
      return deny('logcat: -d only');
    case 'shell': {
      const [sub, ...q] = r;
      if (sub === 'am' && START_EXTRA_RE.test(q.join(' '))) return true;
      if (sub === 'am' && q.join(' ') === `force-stop ${PKG}`) return true;
      if (sub === 'pidof' && q.length === 1 && q[0] === PKG) return true;
      if (sub === 'input' && q[0] === 'keyevent' && q.length === 2 && KEY_OK.has(q[1])) return true;
      if (sub === 'getprop' && q.length === 1 && /^ro\.(product|build)\.[a-z._]+$/.test(q[0])) return true;
      if (sub === 'dumpsys') {
        if (q.length === 1 && DUMPSYS_PLAIN.has(q[0])) return true;
        if (q.length === 2 && q[0] === 'package' && q[1] === PKG) return true;
        if (q.length === 2 && q[0] === 'activity' && q[1] === 'activities') return true;
        if (q.length === 3 && q[0] === 'activity' && q[1] === 'services' && q[2] === PKG) return true;
        if (q.length === 2 && q[0] === 'activity' && (q[1] === 'processes' || q[1] === 'p')) return true;
        if (q.length === 3 && q[0] === 'activity' && q[1] === 'p' && q[2] === PKG) return true;
        return deny('dumpsys: restricted');
      }
      return deny('shell: not in the allowed list');
    }
    default: return deny('command');
  }
}

let seq = 0;
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
