// エミュレーター（emulator-5554）専用の adb の入口（担当 K）。実機には触れない：どの呼び出しにも必ず `-s emulator-5554` を付ける。
// 許可：install -r（work/K の APK）、shell input（tap、text、keyevent）、exec-out screencap -p、shell uiautomator dump /dev/stdout、
//       shell am start/force-stop（自作アプリ）、shell pidof（自作アプリ）、shell pm grant（自作アプリの RECORD_AUDIO と POST_NOTIFICATIONS）、
//       shell getprop、shell dumpsys（window、activity activities、audio）、logcat（-d、-c）、forward（9223〜9229）、emu kill。
// どれも時間の上限を付け、標準入力を切り離し、出力はファイルへ。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ADB_EXE = path.join(ROOT, 'tools', 'platform-tools', 'adb.exe');
export const SERIAL = 'emulator-5554';
export const PKG = 'io.github.lapnarrator';
export const ACTIVITY = `${PKG}/.MainActivity`;
// 作業場所：既定は work/K。環境変数 LAP_EMU_WORK=work/<担当> で変えられる（リポジトリの work/ の下だけ。結果、画面写真、adb の出力、APK の置き場がそこになる）。
const workEnv = process.env.LAP_EMU_WORK ? path.resolve(ROOT, process.env.LAP_EMU_WORK) : null;
if (workEnv && !workEnv.startsWith(path.join(ROOT, 'work') + path.sep)) throw new Error(`LAP_EMU_WORK は work/ の下だけ: ${workEnv}`);
export const WORK_DIR = workEnv || path.join(ROOT, 'work', 'K');
const TMP = path.join(WORK_DIR, 'adb-out');
const WORK_K = WORK_DIR;

export function checkAllowed(args) {
  const a = args;
  const deny = (why) => { throw new Error(`adb-emu-not-allowed: ${a.join(' ')} (${why})`); };
  if (!a.length) deny('empty');
  if (a[0] === '-s') deny('serial is added by the wrapper');
  const [cmd, ...r] = a;
  const cdp = (s) => /^tcp:[0-9]{4}$/.test(s) && Number(s.slice(4)) >= 9223 && Number(s.slice(4)) <= 9229;
  switch (cmd) {
    case 'install': {
      if (r.length === 2 && r[0] === '-r' && path.resolve(r[1]).startsWith(WORK_K + path.sep) && r[1].endsWith('.apk')) return true;
      return deny('install -r <work/K/*.apk（LAP_EMU_WORK のときはその下）> only');
    }
    case 'push': {
      // エミュレーター専用：examples/packs の台本パックを /sdcard/Download/ へ（利用者がスマホに置く操作の代わり）。実機には使わない（SERIAL は emulator-5554 固定）。
      const src = r[0] ? path.resolve(r[0]) : '';
      if (r.length === 2 && src.startsWith(path.join(ROOT, 'examples', 'packs') + path.sep) && src.endsWith('.zip') && /^\/sdcard\/Download\/[A-Za-z0-9_-]+\.zip$/.test(r[1])) return true;
      return deny('push: examples/packs/*.zip to /sdcard/Download/ only');
    }
    case 'exec-out':
      if (r.join(' ') === 'screencap -p' || r.join(' ') === 'cat /data/local/tmp/lapui.xml') return true;
      return deny('exec-out: screencap -p and the uiautomator dump file only');
    case 'forward':
      if (r.length === 2 && cdp(r[0]) && /^localabstract:webview_devtools_remote_[0-9]{1,8}$/.test(r[1])) return true;
      if (r.length === 2 && r[0] === '--remove' && cdp(r[1])) return true;
      return deny('forward');
    case 'logcat':
      if (r.length === 1 && (r[0] === '-d' || r[0] === '-c')) return true;
      return deny('logcat');
    case 'emu':
      if (r.join(' ') === 'kill') return true;
      return deny('emu kill only');
    case 'shell': {
      const [sub, ...q] = r;
      if (sub === 'input') {
        if (q[0] === 'tap' && q.length === 3 && /^[0-9]{1,4}$/.test(q[1]) && /^[0-9]{1,4}$/.test(q[2])) return true;
        if (q[0] === 'keyevent' && q.length === 2 && /^[0-9]{1,3}$/.test(q[1])) return true;
        if (q[0] === 'text' && q.length === 2 && /^[A-Za-z0-9_.-]{1,60}$/.test(q[1])) return true;
        return deny('input');
      }
      if (sub === 'uiautomator' && q.join(' ') === 'dump /data/local/tmp/lapui.xml') return true;
      if (sub === 'am' && q.join(' ') === `start -n ${ACTIVITY}`) return true;
      if (sub === 'am' && q.join(' ') === `force-stop ${PKG}`) return true;
      if (sub === 'pidof' && q.length === 1 && q[0] === PKG) return true;
      if (sub === 'pm' && q[0] === 'grant' && q.length === 3 && q[1] === PKG && /^android\.permission\.(RECORD_AUDIO|POST_NOTIFICATIONS)$/.test(q[2])) return true;
      if (sub === 'getprop' && q.length === 1 && /^(sys\.boot_completed|ro\.(product|build)\.[a-z._]+)$/.test(q[0])) return true;
      if (sub === 'dumpsys' && ((q.length === 1 && (q[0] === 'window' || q[0] === 'audio')) || q.join(' ') === 'activity activities')) return true;
      return deny('shell');
    }
    default: return deny('command');
  }
}

let seq = 0;
/** @returns {Promise<{code:number|null, out:string, buf:Buffer, timedOut:boolean, ms:number}>} */
export function adbEmu(args, { timeoutMs = 30000 } = {}) {
  checkAllowed(args);
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `e${process.pid}-${++seq}.bin`);
  const fd = fs.openSync(file, 'w');
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(ADB_EXE, ['-s', SERIAL, ...args], { stdio: ['ignore', fd, fd], windowsHide: true });
    let timedOut = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* 無視 */ }
      let buf = Buffer.alloc(0);
      try { buf = fs.readFileSync(file); fs.rmSync(file, { force: true }); } catch { /* 無視 */ }
      resolve({ code, out: buf.toString('utf8'), buf, timedOut, ms: Math.round(performance.now() - t0) });
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
