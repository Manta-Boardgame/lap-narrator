// 録音の保存を受け持つ専用の Worker（録音バックエンドの Web 版。CONTRACTS.md 5 章、設計書 4.4）。
//
// - OPFS の FileSystemSyncAccessHandle で、録音ファイル（生の PCM、Int16、モノラル）に追記する。
// - 書き込みの順序：音声を書いて flush → 「durable」の操作記録を events.jsonl に書いて flush → 画面へ通知。
// - 録音ファイルは、録音の開始ごと、および rawMaxBytes を超える前（file-rotate）に切り替える。
// - events.jsonl の seq・時刻・位置は、この Worker だけが付ける（順序を 1 か所で決めるため）。
//
// 保存の構成（OPFS）：
//   lap/sessions/<sessionId>/events.jsonl
//   lap/sessions/<sessionId>/meta.json
//   lap/sessions/<sessionId>/raw/rec-000001.pcm   （生の PCM。WAV にするのは書き出しのとき）
//   lap/sessions/<sessionId>/raw/rec-000001.json  （サンプリング周波数）
//   lap/projects/<projectId>/..., lap/exports/<exportId>/...

import { parseEventsBytes, encodeEventLine } from '../events-io.js';
import { track } from '../tracker.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

let rootDir = null;
/** 開いているセッション（なければ null） */
let S = null;
let queue = Promise.resolve();
let sessionScope = 0;
let sink = null;

const post = (msg, transfer) => self.postMessage({ scope: sessionScope, ...msg }, transfer || []);

/** 録音の書き込みと RPC を、届いた順に 1 つずつ処理する。 */
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

async function lapRoot() {
  if (!rootDir) {
    const r = await navigator.storage.getDirectory();
    rootDir = await r.getDirectoryHandle('lap', { create: true });
  }
  return rootDir;
}

async function dirAt(parts, create = false) {
  let d = await lapRoot();
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

const rawName = (n) => `rec-${String(n).padStart(6, '0')}`;

// ---------------------------------------------------------------- 試験用のフック

function freeze(name) {
  S.hookDone = true;
  post({ type: 'hook-hit', name });
  // 書き込みをこれ以上進めない（強制終了を待つ）。試験用。?hook= を付けたときだけ到達する。
  const end = Date.now() + 120000;
  while (Date.now() < end) { /* 待つ */ }
}

const hookIs = (name) => S.cfg.hook === name && !S.hookDone;

// ---------------------------------------------------------------- 位置・操作記録

function cursor() {
  const last = S.rawFiles[S.rawFiles.length - 1];
  if (!last) return null;
  let base = 0;
  for (let i = 0; i < S.rawFiles.length - 1; i++) base += S.rawFiles[i].samples;
  return { raw: last.name, sample: last.samples, pos: base + last.samples };
}

function baseOf(rf) {
  let base = 0;
  for (const r of S.rawFiles) {
    if (r === rf) return base;
    base += r.samples;
  }
  return base;
}

function mkEvent(type, fields, withAt) {
  const seq = S.seq++;
  const ev = {
    seq,
    eventId: `e${seq}`,
    type,
    wall: new Date().toISOString(),
    mono: Math.max(0, Date.now() - S.startMs),
    ...(fields || {}),
  };
  if (withAt) {
    const at = cursor();
    if (!at) { S.seq--; throw new Error('no-position'); }
    ev.at = at;
  }
  return ev;
}

function writeBytes(handle, bytes, at) {
  let written = 0;
  while (written < bytes.length) {
    const n = handle.write(bytes.subarray(written), { at: at + written });
    if (n <= 0) throw new DOMException('storage-write-made-no-progress', 'QuotaExceededError');
    written += n;
  }
}

function writeEvent(ev) {
  const bytes = encodeEventLine(ev);
  const h = S.eventsHandle;
  if (hookIs('mid-event') && ev.type === 'durable' && ev.at && ev.at.pos >= S.cfg.hookAt) {
    // 記録を書いている途中で止まる（行の半分だけ書く）
    const half = Math.max(1, Math.floor(bytes.length / 2));
    writeBytes(h, bytes.subarray(0, half), S.eventsSize);
    h.flush();
    freeze('mid-event');
    writeBytes(h, bytes.subarray(half), S.eventsSize + half);
  } else {
    writeBytes(h, bytes, S.eventsSize);
  }
  h.flush();
  S.eventsSize += bytes.length;
  post({ type: 'event', event: ev });
}

function doDurable() {
  const c = S.cur;
  if (!c) return null;
  const at = cursor();
  if (at.pos === S.lastDurablePos) return S.lastDurable;
  c.handle.flush(); // 先に音声
  const ev = mkEvent('durable', {}, true);
  writeEvent(ev); // 次に記録
  S.lastDurablePos = at.pos;
  S.lastDurable = at;
  post({ type: 'durable', durable: at });
  return at;
}

// ---------------------------------------------------------------- 録音ファイル

async function writeSmallFile(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const sh = await fh.createSyncAccessHandle();
  try {
    sh.truncate(0);
    writeBytes(sh, bytes, 0);
    sh.flush();
  } finally {
    sh.close();
  }
}

async function createRaw(sampleRate) {
  const last = S.rawFiles[S.rawFiles.length - 1];
  const n = (last ? last.number : 0) + 1;
  const name = rawName(n);
  await writeSmallFile(S.rawDir, `${name}.json`, enc.encode(JSON.stringify({ sampleRate })));
  const fh = await S.rawDir.getFileHandle(`${name}.pcm`, { create: true });
  const handle = await fh.createSyncAccessHandle();
  handle.truncate(0);
  const rf = { name, number: n, samples: 0, sampleRate, handle };
  S.rawFiles.push(rf);
  return rf;
}

function closeCur() {
  const c = S.cur;
  if (!c) return;
  try { c.handle.flush(); } finally { c.handle.close(); c.handle = null; S.cur = null; }
}

/** 録音ファイルの切り替え（file-rotate）。音声を flush → 新しいファイルを作る → 記録を書く。 */
async function rotate() {
  const c = S.cur;
  c.handle.flush();
  if (hookIs('before-rotate')) freeze('before-rotate');
  const atFrom = cursor();
  const next = await createRaw(c.sampleRate);
  const ev = mkEvent('file-rotate', {
    from: c.name,
    to: next.name,
    at: atFrom,
    toAt: { raw: next.name, sample: 0, pos: baseOf(next) },
  }, false);
  c.handle.close();
  c.handle = null;
  S.cur = next;
  writeEvent(ev);
  post({ type: 'rotated', from: c.name, to: next.name });
}

async function appendAudio(samples) {
  let off = 0;
  while (off < samples.length) {
    const c = S.cur;
    if (!c) { S.dropped += samples.length - off; return; }
    const room = (S.cfg.rawMaxBytes - c.samples * 2) >> 1;
    if (room <= 0) { await rotate(); continue; }
    const n = Math.min(room, samples.length - off);
    const view = new Uint8Array(samples.buffer, samples.byteOffset + off * 2, n * 2);
    writeBytes(c.handle, view, c.samples * 2);
    c.samples += n;
    off += n;
    S.armWritten += n;
    const pos = cursor().pos;
    if (hookIs('after-audio') && pos >= S.cfg.hookAt) {
      c.handle.flush();
      freeze('after-audio'); // 音声を書いた直後（記録はまだ）
    }
    if (pos - S.lastDurablePos >= S.cfg.durableSamples) doDurable();
  }
}

// ---------------------------------------------------------------- セッション

async function closeSession() {
  if (!S) return;
  try { if (S.cur) closeCur(); } catch { /* 無視 */ }
  try { await discardTest(); } catch { /* 無視 */ }
  try { S.eventsHandle.flush(); S.eventsHandle.close(); } catch { /* 無視 */ }
  S = null;
}

async function readAll(handle) {
  const size = handle.getSize();
  const buf = new Uint8Array(size);
  let got = 0;
  while (got < size) {
    const n = handle.read(buf.subarray(got), { at: got });
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

async function readText(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch { return null; }
}

async function scanRaw(rawDir, defaultRate) {
  const found = [];
  for await (const [name, h] of rawDir.entries()) {
    const m = /^rec-(\d{6})\.pcm$/.exec(name);
    if (m && h.kind === 'file') found.push({ number: Number(m[1]), name: name.slice(0, -4), fh: h });
  }
  found.sort((a, b) => a.number - b.number);
  const out = [];
  for (const f of found) {
    const sh = await f.fh.createSyncAccessHandle();
    let size = sh.getSize();
    if (size % 2) { sh.truncate(size - 1); sh.flush(); size -= 1; } // 途切れた 1 サンプルを捨てる
    sh.close();
    let rate = defaultRate;
    const side = await readText(rawDir, `${f.name}.json`);
    if (side) { try { rate = JSON.parse(side).sampleRate || rate; } catch { /* 既定値 */ } }
    out.push({ name: f.name, number: f.number, samples: size / 2, sampleRate: rate, handle: null });
  }
  return out;
}

async function openSession({ sessionId, create, rawMaxBytes, durableSamples, hook, hookAt, defaultRate }) {
  await closeSession();
  const sessions = await dirAt(['sessions'], true);
  const dir = await sessions.getDirectoryHandle(sessionId, { create: !!create });
  const rawDir = await dir.getDirectoryHandle('raw', { create: true });
  const efh = await dir.getFileHandle('events.jsonl', { create: true });
  let eventsHandle;
  try {
    eventsHandle = await efh.createSyncAccessHandle();
  } catch (e) {
    if (e && e.name === 'NoModificationAllowedError') throw Object.assign(new Error('locked'), { code: 'locked' });
    throw e;
  }
  const bytes = await readAll(eventsHandle);
  const parsed = parseEventsBytes(bytes);
  if (parsed.droppedBytes > 0) { // 切れた末尾の行を捨てる（設計書 4.5 の 1）
    eventsHandle.truncate(parsed.validBytes);
    eventsHandle.flush();
  }
  try { await dir.removeEntry('test-rec.pcm'); } catch { /* なければよい（強制終了で残った試し録りの一時ファイルを消す） */ }
  const rawFiles = await scanRaw(rawDir, defaultRate || 48000);
  // どの記録からも指されていない末尾の空の録音ファイルを消す（作った直後に止まったもの）
  const referenced = new Set();
  for (const ev of parsed.events) {
    for (const k of ['at', 'toAt']) if (ev[k]?.raw) referenced.add(ev[k].raw);
    if (ev.from) referenced.add(ev.from);
    if (ev.to) referenced.add(ev.to);
  }
  while (rawFiles.length && rawFiles[rawFiles.length - 1].samples === 0 && !referenced.has(rawFiles[rawFiles.length - 1].name)) {
    const dead = rawFiles.pop();
    try { await rawDir.removeEntry(`${dead.name}.pcm`); } catch { /* 無視 */ }
    try { await rawDir.removeEntry(`${dead.name}.json`); } catch { /* 無視 */ }
  }
  const first = parsed.events[0];
  S = {
    id: sessionId,
    dir,
    rawDir,
    eventsHandle,
    eventsSize: parsed.validBytes,
    seq: parsed.events.length ? parsed.events[parsed.events.length - 1].seq + 1 : 0,
    startMs: first && Date.parse(first.wall) ? Date.parse(first.wall) : Date.now(),
    rawFiles,
    cur: null,
    cfg: { rawMaxBytes, durableSamples, hook: hook || null, hookAt: hookAt || 0 },
    hookDone: false,
    lastDurablePos: -1,
    lastDurable: null,
    armWritten: 0,
    armCaptured: 0,
    expectedFrame: 0,
    gaps: 0,
    dropped: 0,
    test: null,
  };
  return {
    events: parsed.events,
    droppedTailBytes: parsed.droppedBytes,
    rawFiles: rawFiles.map(({ name, samples, sampleRate }) => ({ name, samples, sampleRate })),
  };
}

function stats() {
  return {
    written: S ? S.armWritten : 0,
    captured: S ? S.armCaptured : 0,
    gaps: S ? S.gaps : 0,
    dropped: S ? S.dropped : 0,
    cursor: S ? cursor() : null,
    lastDurable: S ? S.lastDurable : null,
    rawFiles: S ? S.rawFiles.map(({ name, samples, sampleRate }) => ({ name, samples, sampleRate })) : [],
    recording: !!(S && S.cur),
    eventsBytes: S ? S.eventsSize : 0,
  };
}

async function startRaw({ sampleRate, event, durableSamples }) {
  if (S.cur) closeCur();
  if (durableSamples) S.cfg.durableSamples = durableSamples;
  const rf = await createRaw(sampleRate);
  S.cur = rf;
  S.lastDurablePos = cursor().pos;
  S.lastDurable = null;
  S.armWritten = 0;
  S.armCaptured = 0;
  S.expectedFrame = 0;
  let ev = null;
  if (event) {
    ev = mkEvent(event.type, event.fields, true);
    writeEvent(ev);
  }
  return { rawName: rf.name, event: ev, cursor: cursor() };
}

async function stopRaw({ event }) {
  if (S.cur) doDurable();
  let ev = null;
  if (event) {
    ev = mkEvent(event.type, event.fields, true);
    writeEvent(ev);
  }
  if (S.cur) closeCur();
  return { event: ev, cursor: cursor() };
}

async function appendEvent({ type, fields, withAt }) {
  if (S.cur) S.cur.handle.flush(); // 位置が指す音声を、先に端末へ
  const ev = mkEvent(type, fields, !!withAt);
  writeEvent(ev);
  return { event: ev };
}

// ---------------------------------------------------------------- 試し録り（設計書 4.2 の T）
// 録った音は、録音ファイルにも操作記録にも入れず、OPFS の一時ファイル（sessions/<id>/test-rec.pcm）に書く。終わったら消す。

async function startTest({ sampleRate }) {
  if (S.cur) throw new Error('recording');
  await discardTest();
  const fh = await S.dir.getFileHandle('test-rec.pcm', { create: true });
  const handle = await fh.createSyncAccessHandle();
  handle.truncate(0);
  S.test = { handle, samples: 0, sampleRate };
  return {};
}

const CLIP_LEVEL = Math.round(32768 * 0.99);

async function stopTest() {
  const t = S.test;
  if (!t) throw new Error('no-test');
  t.handle.flush();
  const pcm = new Int16Array(t.samples);
  const u8 = new Uint8Array(pcm.buffer);
  let got = 0;
  while (got < u8.length) { const r = t.handle.read(u8.subarray(got), { at: got }); if (r <= 0) break; got += r; }
  let peak = 0; let sumSq = 0; let clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (a > peak) peak = a;
    if (a >= CLIP_LEVEL) clipped++;
    sumSq += pcm[i] * pcm[i];
  }
  return { samples: t.samples, sampleRate: t.sampleRate, peak: peak / 32768, rms: pcm.length ? Math.sqrt(sumSq / pcm.length) / 32768 : 0, clipped };
}

async function readTest({ start, end }) {
  const t = S.test;
  if (!t) throw new Error('no-test');
  const hi = Math.min(end, t.samples);
  const out = new Int16Array(Math.max(0, hi - start));
  const u8 = new Uint8Array(out.buffer);
  let got = 0;
  while (got < u8.length) { const r = t.handle.read(u8.subarray(got), { at: start * 2 + got }); if (r <= 0) break; got += r; }
  return { result: out, transfer: [out.buffer] };
}

async function discardTest() {
  if (!S || !S.test) return {};
  const t = S.test;
  S.test = null;
  try { t.handle.close(); } catch { /* 無視 */ }
  try { await S.dir.removeEntry('test-rec.pcm'); } catch { /* 無視 */ }
  return {};
}

async function testExists() {
  try { await S.dir.getFileHandle('test-rec.pcm'); return { exists: true }; } catch { return { exists: false }; }
}

/** 複数の操作を、間に音声の書き込みを挟まずに続けて書く（同じ位置で next-slide と rec-start を書くため）。 */
async function appendEvents({ list }) {
  if (S.cur) S.cur.handle.flush();
  const events = [];
  for (const it of list) {
    const ev = mkEvent(it.type, it.fields, !!it.withAt);
    writeEvent(ev);
    events.push(ev);
  }
  return { events };
}

async function readRaw({ raw, start, end }) {
  const rf = S.rawFiles.find((r) => r.name === raw);
  if (!rf) throw new Error(`unknown-raw:${raw}`);
  const hi = Math.min(end, rf.samples);
  const n = Math.max(0, hi - start);
  const out = new Int16Array(n);
  if (n > 0) {
    let h = rf.handle;
    let temp = false;
    if (!h) {
      h = await (await S.rawDir.getFileHandle(`${raw}.pcm`)).createSyncAccessHandle();
      temp = true;
    }
    try {
      const u8 = new Uint8Array(out.buffer);
      let got = 0;
      while (got < u8.length) {
        const r = h.read(u8.subarray(got), { at: start * 2 + got });
        if (r <= 0) break;
        got += r;
      }
    } finally { if (temp) h.close(); }
  }
  return { result: out, transfer: [out.buffer] };
}

// ---------------------------------------------------------------- セッションの一覧・削除

async function listSessions() {
  const sessions = await dirAt(['sessions'], true);
  const out = [];
  for await (const [name, h] of sessions.entries()) {
    if (h.kind !== 'directory') continue;
    out.push(await sessionInfo({ sessionId: name }));
  }
  return out;
}

async function dirBytes(dir) {
  let total = 0;
  for await (const [, h] of dir.entries()) {
    if (h.kind === 'file') total += (await h.getFile()).size;
    else total += await dirBytes(h);
  }
  return total;
}

async function sessionInfo({ sessionId }) {
  const sessions = await dirAt(['sessions'], true);
  const dir = await sessions.getDirectoryHandle(sessionId);
  let metaText = await readText(dir, 'meta.json');
  let meta = null;
  try { meta = metaText ? JSON.parse(metaText) : null; } catch { meta = null; }
  let bytes;
  if (S && S.id === sessionId) bytes = await readAll(S.eventsHandle);
  else {
    const fh = await dir.getFileHandle('events.jsonl', { create: true });
    bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
  }
  const parsed = parseEventsBytes(bytes);
  const ts = track(parsed.events);
  let rawBytes = 0;
  const rawDir = await dir.getDirectoryHandle('raw', { create: true });
  for await (const [name, h] of rawDir.entries()) {
    if (h.kind === 'file' && name.endsWith('.pcm')) rawBytes += (await h.getFile()).size;
  }
  const last = parsed.events[parsed.events.length - 1];
  return {
    sessionId,
    meta,
    eventCount: parsed.events.length,
    tornTail: parsed.droppedBytes > 0,
    interrupted: ts.recording || !!ts.unresolved,
    rawBytes,
    totalBytes: await dirBytes(dir),
    lastWall: last ? last.wall : null,
  };
}

async function deleteSession({ sessionId }) {
  if (S && S.id === sessionId) await closeSession();
  const sessions = await dirAt(['sessions'], true);
  await sessions.removeEntry(sessionId, { recursive: true });
  return {};
}

// ---------------------------------------------------------------- 入口

const handlers = {
  openSession,
  closeSession: async () => { await closeSession(); return {}; },
  startRaw,
  stopRaw,
  rotate: async () => {
    if (!S || !S.cur) throw new Error('not-recording');
    const from = S.cur.name;
    await rotate();
    return { from, to: S.cur.name };
  },
  appendEvent,
  appendEvents,
  startTest,
  stopTest,
  readTest,
  discardTest,
  testExists,
  readRaw,
  listSessions,
  sessionInfo,
  deleteSession,
  sync: async () => ({}),
  stats: async () => stats(),
};

// 録音の音声は、AudioWorklet から直接このポートに届く（メインのスレッドを通らない）。
function reportSinkFailure(where, err) {
  if (!S || S.failed) return;
  S.failed = true;
  // 確定記録を増やす前に、すでに書けた音声を可能な範囲で端末へ残す。
  try { S.cur?.handle?.flush(); } catch { /* 復旧時に実際のファイルを確認する */ }
  post({ type: 'error', where, message: String(err?.message || err) });
}

function handleSink(m, current) {
  if (m.kind === 'pcm') {
    enqueue(async () => {
      if (!current() || !S || S.failed) return;
      try {
        if (S.test) {
          const u8 = new Uint8Array(m.buf);
          writeBytes(S.test.handle, u8, S.test.samples * 2);
          S.test.samples += u8.length >> 1;
          return;
        }
        if (!S.cur) { S.dropped += m.buf.byteLength >> 1; return; }
        const samples = new Int16Array(m.buf);
        if (typeof m.frame === 'number') {
          if (m.frame !== S.expectedFrame) S.gaps++;
          S.expectedFrame = m.frame + samples.length;
          S.armCaptured = S.expectedFrame;
        }
        await appendAudio(samples);
      } catch (error) {
        reportSinkFailure('chunk', error);
      }
    });
  } else if (m.kind === 'ack') {
    // 取得側が持っていた分を送り終えた合図。ここまでの音声は書き終えている。
    enqueue(async () => {
      if (!current() || !S || S.failed) return;
      try {
        if (S.cur) S.cur.handle.flush();
        if (S.test) S.test.handle.flush();
        if (typeof m.frames === 'number') S.armCaptured = m.frames;
        post({ type: 'ack', token: m.token, captured: m.frames, written: S.armWritten, gaps: S.gaps });
      } catch (error) {
        reportSinkFailure('ack', error);
      }
    });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'sink') {
    sink?.port.close();
    const attached = { port: m.port, token: m.token };
    sink = attached;
    m.port.onmessage = ({ data }) => {
      const scope = sessionScope;
      handleSink(data, () => sink === attached && scope === sessionScope);
    };
    return;
  }
  if (m.cmd === 'detach-sink') {
    if (sink?.token === m.token) { sink.port.close(); sink = null; }
    return;
  }
  if (m.cmd === 'chunk') {
    handleSink({ kind: 'pcm', buf: m.buf }, () => sessionScope === m.scope);
    return;
  }
  const { id, op, args } = m;
  enqueue(async () => {
    if (op === 'openSession' || op === 'closeSession') sessionScope = m.scope;
    else if (S?.failed) throw new Error('recorder-storage-failed');
    const h = handlers[op];
    if (!h) throw new Error(`unknown-op:${op}`);
    try {
      return await h(args || {});
    } catch (error) {
      if (S?.cur && ['appendEvent', 'appendEvents', 'startRaw', 'stopRaw', 'rotate'].includes(op)) {
        reportSinkFailure(op, error);
      }
      throw error;
    }
  }).then((r) => {
    const out = r && r.transfer ? r.result : r;
    post({ id, ok: true, result: out, stats: S ? stats() : null }, r && r.transfer ? r.transfer : []);
  }, (err) => {
    post({ id, ok: false, error: { name: err && err.name, message: String(err && err.message || err), code: err && err.code } });
  });
};
