// 録音バックエンド（CONTRACTS.md 5 章）の Web 版。メインのスレッドから見た入口。
// 実際の保存は worker/recorder-worker.js が OPFS の同期アクセスで行う。ネイティブ版と共通なのは、この形。
//
//   backend = {
//     start({sampleRate, event?}) → Promise<{rawName}>,     // event を渡すと、ファイルを作った直後に記録を書く
//     onChunk(Int16Array),                                  // 内部（開発用の入力が使う）
//     durable() → {rawName, sample, pos},                   // 書き込みが確定した位置
//     rotate() → Promise<{from, to}>,
//     stop(reason, {event?}) → Promise<void>,
//     readRaw(rawName, start, end) → Promise<Int16Array>
//   }

import { Emitter } from './util.js';

export function createBackend({
  workerUrl = new URL('./worker/recorder-worker.js', import.meta.url),
  rpcTimeoutMs = 30000,
} = {}) {
  let worker = null;
  let failure = null;
  let scope = 0;
  let nextId = 1;
  const pending = new Map();
  const acks = new Map();
  const events = new Emitter();
  const durables = new Emitter();
  const errors = new Emitter();
  let lastDurable = null;
  let lastStats = null;
  let hookHit = null;

  function fail(where, cause) {
    if (failure) return failure;
    const message = String(cause?.message || cause || where);
    failure = Object.assign(new Error(message), { code: 'recording-backend-failed', where });
    worker?.terminate();
    worker = null;
    for (const requests of [pending, acks]) {
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.reject(failure);
      }
      requests.clear();
    }
    errors.emit(failure);
    return failure;
  }

  function getWorker() {
    if (failure) throw failure;
    if (worker) return worker;
    const instance = new Worker(workerUrl, { type: 'module' });
    worker = instance;
    instance.onmessage = ({ data: m }) => {
      if (worker !== instance) return;
      if (m.id !== undefined) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) {
          if (p.scope === scope) lastStats = m.stats ?? null;
          p.resolve(m.result);
        } else {
          p.reject(Object.assign(new Error(m.error.message), { name: m.error.name, code: m.error.code }));
        }
        return;
      }
      if (m.scope !== scope) return;
      switch (m.type) {
        case 'event': events.emit(m.event); break;
        case 'durable':
          lastDurable = { rawName: m.durable.raw, sample: m.durable.sample, pos: m.durable.pos };
          durables.emit(lastDurable);
          break;
        case 'ack': {
          const a = acks.get(m.token);
          if (a) { acks.delete(m.token); clearTimeout(a.timer); a.resolve(m); }
          break;
        }
        case 'hook-hit': hookHit = m.name; break;
        case 'error': fail(m.where, m.message); break;
        default: break;
      }
    };
    instance.onerror = (e) => { if (worker === instance) fail('worker', e.message); };
    instance.onmessageerror = () => { if (worker === instance) fail('worker', 'worker-message-error'); };
    return worker;
  }

  function call(op, args, transfer) {
    return new Promise((resolve, reject) => {
      const instance = getWorker();
      const id = nextId++;
      const timer = setTimeout(() => fail(op, 'recorder-response-timeout'), rpcTimeoutMs);
      pending.set(id, { resolve, reject, timer, scope });
      try {
        instance.postMessage({ id, op, args, scope }, transfer || []);
      } catch (error) {
        fail(op, error);
      }
    });
  }

  function resetScope() {
    scope++;
    lastDurable = null;
    lastStats = null;
    hookHit = null;
    for (const request of acks.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('recording-session-changed'));
    }
    acks.clear();
  }

  let tokenSeq = 1;
  function newToken() { return `k${tokenSeq++}`; }
  function waitAck(token, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const timer = setTimeout(() => fail('ack', 'recorder-ack-timeout'), timeoutMs);
      acks.set(token, { resolve, reject, timer });
    });
  }

  return {
    // ---- CONTRACTS.md 5 章のインターフェース
    async start({ sampleRate, event, durableSamples }) {
      lastDurable = null;
      const r = await call('startRaw', { sampleRate, event, durableSamples });
      return { rawName: r.rawName, event: r.event, cursor: r.cursor };
    },
    onChunk(i16) {
      // 呼び出し側の配列を壊さないよう、写しを渡す
      const copy = new Int16Array(i16.length);
      copy.set(i16);
      getWorker().postMessage({ cmd: 'chunk', scope, buf: copy.buffer }, [copy.buffer]);
    },
    durable() { return lastDurable; },
    async rotate() { return call('rotate', {}); },
    async stop(reason, { event } = {}) {
      return call('stopRaw', { event: event || null, reason });
    },
    async readRaw(rawName, start, end) { return call('readRaw', { raw: rawName, start, end }); },

    // ---- セッション
    openSession(args) {
      resetScope();
      return call('openSession', args);
    },
    closeSession() {
      resetScope();
      if (failure) {
        failure = null;
        return Promise.resolve();
      }
      return call('closeSession', {});
    },
    appendEvent(type, fields, withAt) { return call('appendEvent', { type, fields: fields || {}, withAt: !!withAt }); },
    /** list: [{type, fields, withAt}]。位置は、すべて同じ書き込みの区間で決まる（間に音声が入らない）。 */
    appendEvents(list) { return call('appendEvents', { list }); },
    sync() { return call('sync', {}); },
    stats() { return call('stats', {}); },
    listSessions() { return call('listSessions', {}); },
    sessionInfo(sessionId) { return call('sessionInfo', { sessionId }); },
    deleteSession(sessionId) { return call('deleteSession', { sessionId }); },
    call,

    // ---- 取得側とのつなぎ
    attachSink(port) {
      const instance = getWorker();
      const token = newToken();
      instance.postMessage({ cmd: 'sink', port, token }, [port]);
      return () => {
        if (worker === instance) instance.postMessage({ cmd: 'detach-sink', token });
      };
    },
    fail,
    newToken,
    waitAck,

    // ---- 通知
    onEvent: (fn) => events.on(fn),
    onDurable: (fn) => durables.on(fn),
    onError: (fn) => errors.on(fn),
    get lastStats() { return lastStats; },
    get hookHit() { return hookHit; },
    terminate() { fail('worker', 'recorder-terminated'); },
  };
}
