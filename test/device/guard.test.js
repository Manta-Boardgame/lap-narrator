// adb の入口が、許可された操作だけを通すことの試験（実機は要らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAllowed, parseDevices } from './helpers/adb.js';

const ok = (...a) => assert.equal(checkAllowed(a), true, a.join(' '));
const ng = (...a) => assert.throws(() => checkAllowed(a), /adb-not-allowed/, a.join(' '));

test('許可された操作', () => {
  ok('devices'); ok('devices', '-l');
  ok('reverse', 'tcp:8140', 'tcp:8140'); ok('reverse', '--remove', 'tcp:8149');
  ok('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote'); ok('forward', '--remove', 'tcp:9229');
  ok('shell', 'input', 'keyevent', '223'); ok('shell', 'input', 'keyevent', '3');
  ok('shell', 'am', 'force-stop', 'com.android.chrome');
  ok('shell', 'dumpsys', 'window'); ok('shell', 'dumpsys', 'power'); ok('shell', 'dumpsys', 'package', 'com.android.chrome');
  ok('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'http://localhost:8140/app/index.html?lapdev=1&countdown=0'", 'com.android.chrome');
  ok('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'about:blank'", 'com.android.chrome');
  ok('shell', 'getprop', 'ro.product.model');
});

test('許可されない操作（してはいけない操作と、範囲の外）', () => {
  ng(); ng('install', 'a.apk'); ng('uninstall', 'com.android.chrome'); ng('push', 'a', '/sdcard/a'); ng('pull', '/sdcard/a');
  ng('root'); ng('reboot'); ng('kill-server'); ng('tcpip', '5555');
  ng('shell', 'pm', 'clear', 'com.android.chrome'); ng('shell', 'rm', '-rf', '/sdcard');
  ng('shell', 'settings', 'put', 'global', 'x', '1'); ng('shell', 'svc', 'power', 'stayon', 'true');
  ng('shell', 'cat', '/sdcard/a'); ng('shell', 'ls'); ng('shell', 'sh', '-c', 'id');
  ng('shell', 'am', 'force-stop', 'com.android.settings');
  ng('shell', 'am', 'start', '-n', 'com.android.settings/.Settings');
  ng('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'http://example.com/'", 'com.android.chrome');
  ng('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'http://localhost:8200/'", 'com.android.chrome');
  ng('shell', 'input', 'tap', '1', '1'); ng('shell', 'input', 'text', 'a'); ng('shell', 'input', 'keyevent', '66'); ng('shell', 'input', 'keyevent', '223', '224');
  ng('shell', 'dumpsys', 'package', 'com.android.settings'); ng('shell', 'dumpsys', 'window', '>', '/sdcard/x');
  ng('shell', 'getprop', 'persist.sys.x'); ng('shell', 'getprop');
  ng('reverse', '--remove-all'); ng('reverse', 'tcp:8100', 'tcp:8100'); ng('reverse', 'tcp:8140', 'tcp:80'); ng('reverse', 'tcp:8150', 'tcp:8150');
  ng('forward', 'tcp:9230', 'localabstract:chrome_devtools_remote'); ng('forward', 'tcp:9222', 'tcp:8080'); ng('forward', '--remove-all');
});

test('devices の結果の読み取り', () => {
  const out = 'List of devices attached\n0123456789ABCDEF        device product:testproduct model:TESTMODEL device:testdevice transport_id:1\n\n';
  assert.deepEqual(parseDevices(out), [{ serial: '0123456789ABCDEF', state: 'device', model: 'TESTMODEL' }]);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  assert.equal(parseDevices('List of devices attached\nABC unauthorized transport_id:2\n')[0].state, 'unauthorized');
});
