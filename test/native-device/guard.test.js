// 実機がなくても動く試験：ネイティブ版の試験が使う adb の許可リストが、許可した操作だけを通すこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAllowed } from './helpers/adb.js';

const ok = (...a) => assert.equal(checkAllowed(a), true, a.join(' '));
const ng = (...a) => assert.throws(() => checkAllowed(a), /adb-not-allowed/, a.join(' '));

test('許可する操作', () => {
  ok('devices', '-l');
  ok('forward', '--list');
  ok('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_12345');
  ok('forward', '--remove', 'tcp:9229');
  ok('shell', 'am', 'start', '-n', 'io.github.lapnarrator/.MainActivity');
  ok('shell', 'am', 'force-stop', 'io.github.lapnarrator');
  ok('shell', 'pidof', 'io.github.lapnarrator');
  for (const k of ['3', '26', '223', '224']) ok('shell', 'input', 'keyevent', k);
  ok('shell', 'dumpsys', 'power');
  ok('shell', 'dumpsys', 'window');
  ok('shell', 'dumpsys', 'audio');
  ok('shell', 'dumpsys', 'package', 'io.github.lapnarrator');
  ok('shell', 'dumpsys', 'activity', 'services', 'io.github.lapnarrator');
  ok('shell', 'getprop', 'ro.product.model');
  ok('logcat', '-d');
  ok('logcat', '-d', '-t', '200', '--pid=4242');
});

test('禁止する操作', () => {
  ng('install', '-r', 'app.apk');
  ng('uninstall', 'io.github.lapnarrator');
  ng('push', 'a', '/sdcard/a');
  ng('pull', '/sdcard/a');
  ng('reboot');
  ng('root');
  ng('shell', 'pm', 'clear', 'io.github.lapnarrator');
  ng('shell', 'rm', '-rf', '/sdcard');
  ng('shell', 'settings', 'put', 'global', 'x', '1');
  ng('shell', 'svc', 'wifi', 'disable');
  ng('shell', 'am', 'force-stop', 'com.android.chrome');
  ng('shell', 'am', 'start', '-n', 'com.android.chrome/.Main');
  ng('shell', 'pidof', 'com.android.chrome');
  ng('shell', 'input', 'keyevent', '4'); // BACK は許可していない
  ng('shell', 'input', 'tap', '10', '10');
  ng('shell', 'dumpsys', 'package', 'com.android.chrome');
  ng('shell', 'dumpsys', 'notification');
  ng('shell', 'cat', '/sdcard/x');
  ng('forward', 'tcp:8140', 'localabstract:webview_devtools_remote_1');
  ng('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote');
  ng('forward', 'tcp:9222', 'tcp:80');
  ng('forward', '--remove', 'tcp:8140');
  ng('logcat');
  ng('logcat', '-c');
  ng('reverse', 'tcp:8140', 'tcp:8140');
});

test('診断用に足した操作（K2）', () => {
  const root = process.cwd().split(String.fromCharCode(92)).join('/');
  ok('shell', 'am', 'start', '-n', 'io.github.lapnarrator/.MainActivity');
  ok('shell', 'dumpsys', 'activity', 'processes');
  ok('shell', 'dumpsys', 'activity', 'p', 'io.github.lapnarrator');
  ok('shell', 'dumpsys', 'deviceidle');
  ng('shell', 'dumpsys', 'deviceidle', 'force-idle');
  ng('shell', 'dumpsys', 'deviceidle', 'step');
  ng('shell', 'dumpsys', 'activity', 'p', 'com.android.chrome');
  ok('install', '-r', `${root}/android/app/build/outputs/apk/debug/app-debug.apk`);
  ng('install', '-r', 'C:/tmp/other.apk');
  ng('install', `${root}/android/app/build/outputs/apk/debug/app-debug.apk`);
  ng('install', '-r', '-d', `${root}/android/app/build/outputs/apk/debug/app-debug.apk`);
  ng('install', '-r', `${root}/android/app/build/outputs/apk/debug/../../../../x.apk`);
});
