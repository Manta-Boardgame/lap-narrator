import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createBackend } from '../../app/src/backend.js';
import { chromePath, launchChrome } from './helpers/chrome.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { openApp } from './helpers/app-page.js';
import { startStaticServer } from './helpers/static-server.js';

test('session changes clear recorder state and ignore late messages', async () => {
  const previousWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(m) {
      this.scope = m.scope;
      queueMicrotask(() => this.onmessage({ data: { id: m.id, ok: true, result: {}, stats: {} } }));
    }
    dispatch(message, scope = this.scope) { this.onmessage({ data: { scope, ...message } }); }
    terminate() { this.terminated = true; }
  };
  try {
    const backend = createBackend();
    await backend.openSession({ sessionId: 'first' });
    const first = workers[0];
    const firstScope = first.scope;
    const events = [];
    const failures = [];
    backend.onEvent((event) => events.push(event));
    backend.onError((error) => failures.push(error));

    first.dispatch({ type: 'durable', durable: { raw: 'rec-000001', sample: 1, pos: 1 } });
    assert.equal(backend.durable().pos, 1);
    await backend.closeSession();
    await backend.openSession({ sessionId: 'second' });
    first.dispatch({ type: 'event', event: { type: 'pause' } }, firstScope);
    first.dispatch({ type: 'durable', durable: { raw: 'rec-000001', sample: 2, pos: 2 } }, firstScope);
    first.dispatch({ type: 'error', where: 'chunk', message: 'old session' }, firstScope);
    assert.equal(backend.durable(), null);
    assert.deepEqual(events, []);
    assert.deepEqual(failures, []);

    const missingAck = backend.waitAck('missing', 10);
    await assert.rejects(missingAck, /recorder-ack-timeout/);
    assert.equal(first.terminated, true);
    assert.equal(failures.length, 1);
    await assert.rejects(backend.stats(), /recorder-ack-timeout/);
    await backend.closeSession();
    await backend.openSession({ sessionId: 'second' });
    first.dispatch({ type: 'event', event: { type: 'pause' } }, workers[1].scope);
    assert.deepEqual(events, []);
  } finally {
    globalThis.Worker = previousWorker;
  }
});

test('Android monitors durable writes during recording and ignores idle progress and mic levels', async () => {
  const calls = [];
  const window = new EventTarget();
  window.Capacitor = {
    isNativePlatform: () => true,
    async nativePromise(_plugin, method, args) { calls.push({ method, args }); },
  };
  window.AudioWorkletNode = class { port = new EventTarget(); };
  const document = new EventTarget();
  document.documentElement = { lang: 'en' };
  const track = new EventTarget();
  track.stop = () => {};
  const navigator = { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }) } };
  const bridge = await readFile(new URL('../../native/web/native-bridge.js', import.meta.url), 'utf8');
  runInNewContext(bridge, {
    window, document, navigator, performance,
    URL: class { static createObjectURL() {} static revokeObjectURL() {} },
    HTMLAnchorElement: class { click() {} },
  });
  await navigator.mediaDevices.getUserMedia({ audio: true });
  calls.length = 0;
  const emit = (detail) => window.dispatchEvent(new CustomEvent('lap:recorder', { detail }));
  const meter = new window.AudioWorkletNode();
  const level = () => meter.port.dispatchEvent(new MessageEvent('message', { data: { kind: 'level' } }));
  level();
  emit('durable');
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);

  emit('recording');
  level();
  await new Promise(setImmediate);
  assert.deepEqual(calls.map((call) => call.method), ['monitorRecording']);
  assert.equal(calls[0].args.active, true);
  emit('durable');
  emit('durable');
  emit('idle');
  emit('durable');
  level();
  await new Promise(setImmediate);
  assert.deepEqual(calls.map((call) => call.method), ['monitorRecording', 'heartbeat', 'monitorRecording']);
  assert.equal(calls[2].args.active, false);
});

test('OPFS zero-byte write stops recording and the reopen button recovers saved audio', { skip: !chromePath() }, async () => {
  await acquireBrowserLock();
  let chrome;
  let server;
  try {
    server = await startStaticServer();
    chrome = await launchChrome({ name: 'recording-storage-fault', port: 8118 });
    let inject = true;
    const workerSource = await readFile(new URL('../../app/src/worker/recorder-worker.js', import.meta.url), 'utf8');
    await chrome.context.route('**/app/src/worker/recorder-worker.js', async (route) => {
      if (!inject) return route.continue();
      inject = false;
      await route.fulfill({ contentType: 'text/javascript', body: `
        const write = FileSystemSyncAccessHandle.prototype.write;
        FileSystemSyncAccessHandle.prototype.write = function (bytes, options) {
          if (bytes.byteLength === 8192 && options.at >= 8192) return 0;
          return write.call(this, bytes, options);
        };
        ${workerSource}
      ` });
    });
    const app = await openApp(chrome, server.origin, '?devinput=1&durableMs=50&nosw=1&lang=en');
    await app.newSession(null, { mode: 'continuous' });
    await app.press('record');
    await app.feed(new Int16Array(4096));
    const durable = await app.durable();
    assert.equal(durable.pos, 4096);
    await assert.rejects(app.feed(new Int16Array(4096)), /storage-write-made-no-progress/);
    await app.page.waitForSelector('#recording-fault:not([hidden])');
    assert.match(await app.page.textContent('#recording-fault-text'), /Reopen it to check the audio saved so far/);
    assert.equal(await app.page.isDisabled('#btn-record'), true);
    assert.equal((await app.events()).some((event) => event.type === 'pause'), false);

    await app.page.click('#btn-reopen-recording');
    await app.page.waitForSelector('#dlg-recovery[open]');
    const recovery = await app.page.evaluate(() => window.__lap.recovery());
    assert.equal(recovery.recoveredPos, 4096);
    assert.equal(recovery.durablePos, 4096);
    await app.page.click('#rec-adopt');
    await app.page.waitForSelector('#dlg-recovery:not([open])', { state: 'attached' });
    await app.newSession(null, { mode: 'continuous' });
    assert.equal(await app.durable(), null);
  } finally {
    await chrome?.close();
    await server?.close();
    releaseBrowserLock();
  }
});
