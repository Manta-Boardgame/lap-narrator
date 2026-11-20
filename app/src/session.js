// 録音セッションの操作（設計書 4.2 の表）。操作記録（events.jsonl）が正本で、ここは
// 「画面の操作を、操作記録の追記と、音の取得の開始・停止に変える」役。区間の計算はしない（core/reduce.js）。
//
// 録音中の操作の流れ：
//   R   ：すぐに（待たずに）録音ファイルを作る → rec-start（またはresume）を書く → 取得を始める
//   OK  ：取得側に残っている分を書き終えてから、その位置で ok を書く
//   撮り直し：取得を止める → pause → retake（最後の OK 点まで戻る。続けて押すとさらに前へ）
//   次へ：取得を止め切ってから next-slide（OK を含む）→ pause。次のスライドは R で録り始める
//   Esc ：取得を止める → pause

import { Emitter, sleep, takeIdOf, checkpointIdOf } from './util.js';
import { APP_VERSION } from './config.js';
import {
  track, pendingSamples, keptSamples, confirmedSamples, retakeTarget, lastCheckpoint, undoTarget, redoTarget, slideSummary,
} from './tracker.js';
import { totalSamples } from './posmap.js';
import { lastPieces } from './player.js';
import { reduceEvents } from '../../core/reduce.js';
import { renderTake, defaultRenderSpec } from '../../core/render.js';

const LISTEN_LAST_SECONDS = 5;

export class Session {
  /**
   * @param {{backend:any, source:any, script:any, config:any, sessionId:string, player:any, mic?:any}} o
   */
  constructor({ backend, source, script, config, sessionId, player }) {
    this.backend = backend;
    this.source = source;
    this.script = script;
    this.config = config;
    this.sessionId = sessionId;
    this.player = player;
    this.slides = [...script.slides].sort((a, b) => a.order - b.order);
    this.events = [];
    this.ts = track([]);
    this.rawFiles = [];
    this.stats = null;
    this.update = new Emitter();
    this._chain = Promise.resolve();
    this._queued = false;
    this.droppedTailBytes = 0;
    this.level = { peak: 0, clipUntil: 0 };
    this.toast = null;
    this.playing = false;
    this.testing = null; // 試し録りの途中：{phase, startedAt, ms}
    this.testResult = null;
    this._cancelTest = false;
    this.lastError = null;
    this.storage = { remainingSec: null, warn: false };
    this._poll = null;
    this._wake = null;
    this.hookHit = null;
    this._offEvent = backend.onEvent((ev) => this._ingest(ev));
    this.recordingFault = null;
    this._watchStartedAt = null;
    this._refreshing = false;
    this._emergencyClose = null;
    this._offDurable = backend.onDurable(() => {
      if (this._watchStartedAt !== null) {
        this._watchStartedAt = performance.now();
        this._notifyRecorder('durable');
      }
      this._changed();
    });
    this._offError = backend.onError((error) => this._backendFailed(error));
  }

  // ------------------------------------------------------------ 状態

  get rate() {
    const last = this.rawFiles[this.rawFiles.length - 1];
    return this.source.sampleRate || (last && last.sampleRate) || 48000;
  }

  /** 通しの録音（台本は free の 1 枚）か。スライド区切りの操作（next-slide／goto-slide）は書かない。 */
  get continuous() { return this.slides.length === 1 && this.slides[0].slideId === 'free'; }

  get slideId() { return this.ts.slideId ?? this.firstSlideId(); }

  firstSlideId() {
    const s = this.slides.find((x) => x.recordable);
    return s ? s.slideId : (this.slides[0] && this.slides[0].slideId) || null;
  }

  slideById(id) { return this.slides.find((s) => s.slideId === id) || null; }

  nextRecordableAfter(id) {
    const i = this.slides.findIndex((s) => s.slideId === id);
    for (let j = i + 1; j < this.slides.length; j++) if (this.slides[j].recordable) return this.slides[j].slideId;
    return null;
  }

  curPos() {
    const c = this.stats && this.stats.cursor;
    if (c) return c.pos;
    return totalSamples(this.rawFiles);
  }

  _ingest(ev) {
    const last = this.events[this.events.length - 1];
    if (!last || ev.seq > last.seq) this.events.push(ev);
    else if (!this.events.some((e) => e.seq === ev.seq)) {
      this.events.push(ev);
      this.events.sort((a, b) => a.seq - b.seq);
    } else return;
    this.ts = track(this.events);
    this._changed();
  }

  _changed() {
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => { this._queued = false; this.update.emit(); });
  }

  async refresh() {
    await this.backend.stats();
    this.stats = this.backend.lastStats;
    if (this.stats && this.stats.rawFiles) this.rawFiles = this.stats.rawFiles;
    this._changed();
  }

  say(key, params) {
    this.toast = { key, params: params || {}, at: Date.now() };
    this._changed();
  }

  // ------------------------------------------------------------ 開く・閉じる

  /** セッションを開く（なければ作る）。中断していたら復旧の手順に入る（マイクは自動では再開しない）。 */
  async open({ create }) {
    const r = await this.backend.openSession({
      sessionId: this.sessionId,
      create: !!create,
      rawMaxBytes: this.config.rawMaxBytes,
      durableSamples: Math.max(1, Math.round((this.config.durableMs / 1000) * this.rate)),
      hook: this.config.hook,
      hookAt: this.config.hookAt,
      defaultRate: this.rate,
    });
    this.events = r.events;
    this.rawFiles = r.rawFiles;
    this.droppedTailBytes = r.droppedTailBytes;
    this.ts = track(this.events);
    if (this.events.length === 0) {
      await this.backend.appendEvent('session-start', {
        sessionId: this.sessionId,
        projectId: this.script.projectId,
        scriptHash: this.script.scriptHash,
        sampleRate: this.rate,
        appVersion: APP_VERSION,
      }, false);
    }
    await this.refresh();
    if (this.ts.recording || this.ts.unresolved) await this._enterRecovery();
    this._startPoll();
    return this;
  }

  _notifyRecorder(state) {
    if (this.source.kind === 'mic' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lap:recorder', { detail: state }));
    }
  }

  _endWatch() {
    this._watchStartedAt = null;
    this._notifyRecorder('idle');
  }

  _backendFailed(error) {
    if (this.recordingFault) return;
    this.recordingFault = error;
    this.lastError = { message: error.message, at: Date.now() };
    this._cancelTest = true;
    this._endWatch();
    this.level.peak = 0;
    this.level.clipUntil = 0;
    this._changed();
    this._emergencyClose = Promise.allSettled([this.source.close(), this._releaseWake()]);
  }

  _startPoll() {
    if (this._poll) return;
    this._poll = setInterval(() => {
      if (this.recordingFault) return;
      const timeout = Math.max(5000, this.config.durableMs * 3);
      if (this._watchStartedAt !== null && !this.backend.hookHit && performance.now() - this._watchStartedAt >= timeout) {
        this.backend.fail('durable', 'recorder-save-progress-timeout');
        return;
      }
      if (this.ts.recording && !this._refreshing) {
        this._refreshing = true;
        this.refresh().catch(() => {}).finally(() => { this._refreshing = false; });
      }
      this._checkStorage().catch(() => {});
      const hit = this.backend.hookHit;
      if (hit && hit !== this.hookHit) { this.hookHit = hit; this._changed(); }
    }, 250);
  }

  async close() {
    clearInterval(this._poll);
    this._poll = null;
    try { await this.pause('other'); } catch { /* 無視 */ }
    this._offEvent();
    this._offDurable();
    this._offError();
    await this._emergencyClose;
    try { await this._releaseWake(); } catch { /* 無視 */ }
    try { await this.backend.closeSession(); } catch { /* 無視 */ }
  }

  // ------------------------------------------------------------ 操作の直列化

  _run(fn, { internal = false } = {}) {
    if (this.testing && !internal) return Promise.resolve({ ok: false, reason: 'testing' });
    const p = this._chain.then(() => {
      if (this.recordingFault) throw this.recordingFault;
      return fn();
    });
    this._chain = p.catch(() => {});
    return p.catch((e) => {
      this.lastError = { message: String((e && e.message) || e), at: Date.now() };
      this._changed();
      throw e;
    });
  }

  // ------------------------------------------------------------ 録音

  canRecord() {
    const ts = this.ts;
    if (this.recordingFault) return { ok: false, reason: 'backend-failed' };
    if (ts.recording || this.testing) return { ok: false, reason: 'busy' };
    if (ts.unresolved) return { ok: false, reason: 'recovery' };
    const s = this.slideById(this.slideId);
    if (!s) return { ok: false, reason: 'no-slide' };
    if (!s.recordable) return { ok: false, reason: 'not-recordable' };
    return { ok: true };
  }

  /** R：録音開始／再開（待たずにすぐ始める。マイクの準備に要る時間は別）。 */
  async record() {
    const can = this.canRecord();
    if (!can.ok) { if (can.reason === 'not-recordable') this.say('toast.notRecordable'); return can; }
    return this._run(() => this._startRecording());
  }

  async _startRecording() {
    if (this.ts.recording) return { ok: false, reason: 'busy' };
    await this.source.open();
    const ts = this.ts;
    const sid = this.slideId;
    const resume = !!ts.take && !ts.take.closed && ts.take.slideId === sid && !ts.recording;
    const event = resume
      ? { type: 'resume', fields: {} }
      : { type: 'rec-start', fields: { slideId: sid, takeId: takeIdOf(ts.nextTakeNo) } };
    try {
      await this.backend.start({
        sampleRate: this.source.sampleRate,
        event,
        durableSamples: Math.max(1, Math.round((this.config.durableMs / 1000) * this.source.sampleRate)),
      });
      if (this.source.kind === 'mic') {
        this._watchStartedAt = performance.now();
        this._notifyRecorder('recording');
      }
      await this.source.arm();
      await this._acquireWake();
      if (this.recordingFault) { await this._releaseWake(); throw this.recordingFault; }
      await this.refresh();
    } catch (error) {
      throw this.backend.fail('start', error);
    }
    return { ok: true, type: event.type };
  }

  /** Esc：一時停止。 */
  async pause(reason = 'user') {
    if (this.testing) { this._cancelTest = true; return { ok: true, cancelled: true }; }
    return this._run(() => this._pauseInner(reason));
  }

  async _pauseInner(reason) {
    if (!this.ts.recording) return { ok: false, reason: 'not-recording' };
    await this._stopRecording('pause', reason);
    await this.refresh();
    return { ok: true };
  }

  async _stopRecording(operation, reason) {
    try {
      await this.source.disarm(); // 取得側に残っていた分を書き終えてから
      await this.backend.stop(operation, { event: { type: 'pause', fields: { reason } } });
    } catch (error) {
      throw this.backend.fail('stop', error);
    } finally {
      this._endWatch();
      await this._releaseWake();
    }
  }

  // ------------------------------------------------------------ OK・撮り直し・次へ・印・取り消し

  canOk() {
    const ts = this.ts;
    return !!ts.take && !ts.unresolved && (ts.recording || pendingSamples(ts, this.curPos()) > 0);
  }

  async ok() {
    return this._run(async () => {
      const ts = this.ts;
      if (!ts.take || ts.unresolved) return { ok: false, reason: 'no-take' };
      if (ts.recording) await this.source.flush(); // 押した時点までの音を書き終えてから位置を決める
      await this.refresh();
      if (pendingSamples(this.ts, this.curPos()) === 0) return { ok: false, reason: 'nothing-new' };
      const checkpointId = checkpointIdOf(this.ts.nextCheckpointNo);
      await this.backend.appendEvent('ok', { checkpointId }, true);
      await this.refresh();
      return { ok: true, checkpointId };
    });
  }

  async retake() {
    return this._run(async () => {
      if (this.ts.unresolved) return { ok: false, reason: 'recovery' };
      if (!this.ts.take) return { ok: false, reason: 'no-take' };
      if (this.ts.recording) await this._pauseInner('user'); // 撮り直しの前に、取得を止めて位置を確定する
      await this.refresh();
      const tgt = retakeTarget(this.ts, this.curPos());
      if (!tgt.ok) return { ok: false, reason: 'nothing-to-retake' };
      await this.backend.appendEvent('retake', { toCheckpoint: tgt.to }, true);
      await this.refresh();
      return { ok: true, to: tgt.to };
    });
  }

  async next() {
    if (this.continuous) return { ok: false, reason: 'continuous' };
    return this._run(async () => {
      const ts0 = this.ts;
      if (ts0.unresolved) return { ok: false, reason: 'recovery' };
      const sid = this.slideId;
      const nextId = this.nextRecordableAfter(sid);
      await this.refresh();
      const hasAudio = !!ts0.take && (ts0.recording || pendingSamples(ts0, this.curPos()) > 0 || ts0.take.checkpoints.length > 0);
      if (!hasAudio) {
        if (!nextId) { this.say('toast.lastSlide'); return { ok: false, reason: 'last' }; }
        await this.backend.appendEvent('goto-slide', { slideId: nextId }, false);
        return { ok: true, type: 'goto-slide' };
      }
      if (this.ts.recording && nextId) {
        // ラップ式：録音を止めない。押した時点までの音を書き終えてから、同じ位置で next-slide と rec-start（次のスライド、新しいテイク）を
        // 続けて書く。マイクは動かし続ける。next-slide のあと同じ位置の rec-start は、core の reduce が orphan-audio にしない（CONTRACTS 7.7）。
        await this.source.flush();
        const checkpointId = checkpointIdOf(this.ts.nextCheckpointNo);
        const takeId = takeIdOf(this.ts.nextTakeNo);
        await this.backend.appendEvents([
          { type: 'next-slide', fields: { checkpointId, nextSlideId: nextId }, withAt: true },
          { type: 'rec-start', fields: { slideId: nextId, takeId }, withAt: true },
        ]);
        await this.refresh();
        return { ok: true, type: 'next-slide', checkpointId, takeId, continued: true };
      }
      if (this.ts.recording) {
        // 最後のスライド：止め切ってから（言い終わりを切らない）一時停止を書き、そのあとで OK を書く。
        // 録音中のまま next-slide を書くと、次の rec-start までの音がどのテイクにも属さなくなる（orphan-audio）。
        await this._stopRecording('next', 'user');
      }
      const checkpointId = checkpointIdOf(this.ts.nextCheckpointNo);
      if (nextId) {
        await this.backend.appendEvent('next-slide', { checkpointId, nextSlideId: nextId }, true);
      } else {
        await this.backend.appendEvent('ok', { checkpointId }, true);
        this.say('toast.lastSlide');
      }
      await this.refresh();
      return { ok: true, type: nextId ? 'next-slide' : 'ok', checkpointId };
    });
  }

  async mark(note) {
    return this._run(async () => {
      if (!this.rawFiles.length) return { ok: false, reason: 'no-audio' };
      if (this.ts.recording) await this.source.flush();
      await this.backend.appendEvent('mark', note ? { note } : {}, true);
      await this.refresh();
      return { ok: true };
    });
  }

  async gotoSlide(slideId) {
    if (this.continuous) return { ok: false, reason: 'continuous' };
    return this._run(async () => {
      const ts = this.ts;
      if (ts.recording) { this.say('toast.stopFirst'); return { ok: false, reason: 'recording' }; }
      if (ts.unresolved) return { ok: false, reason: 'recovery' };
      if (!this.slideById(slideId)) return { ok: false, reason: 'unknown-slide' };
      if (this.slideId === slideId && !ts.take) return { ok: true, noop: true };
      if (ts.take && pendingSamples(ts, this.curPos()) > 0) { this.say('toast.decideFirst'); return { ok: false, reason: 'pending' }; }
      await this.backend.appendEvent('goto-slide', { slideId }, false);
      return { ok: true };
    });
  }

  async undo() {
    return this._run(async () => {
      const t = undoTarget(this.ts);
      if (!t) return { ok: false, reason: 'nothing' };
      await this.backend.appendEvent('undo', { target: t.eventId }, false);
      return { ok: true, target: t.eventId };
    });
  }

  async redo() {
    return this._run(async () => {
      const t = redoTarget(this.ts);
      if (!t) return { ok: false, reason: 'nothing' };
      await this.backend.appendEvent('redo', { target: t }, false);
      return { ok: true, target: t };
    });
  }

  /** L：最後の OK 点までの 5 秒を再生する。 */
  async listenLast(opts = {}) {
    if (this.ts.recording) { this.say('toast.stopFirst'); return { ok: false, reason: 'recording' }; }
    const take = this.ts.take;
    const all = take ? take.checkpoints.flatMap((c) => c.pieces) : [];
    const pieces = lastPieces(all, Math.round(LISTEN_LAST_SECONDS * this.rate));
    if (!pieces.length) { this.say('toast.nothingToListen'); return { ok: false, reason: 'nothing' }; }
    return this._play(pieces, opts);
  }

  /** P：今のスライドの採用した音声を、つないだ状態（完成した音声と同じ作り方）で再生する。区間の計算と音声の作成は core。 */
  async listenSlide(opts = {}) {
    if (this.ts.recording || this.testing) { this.say('toast.stopFirst'); return { ok: false, reason: 'busy' }; }
    await this.refresh();
    const events = this.events.slice().sort((a, b) => a.seq - b.seq);
    const rawInfos = this.rawFiles.map((r) => ({ name: r.name, sampleRate: r.sampleRate, samples: r.samples }));
    const reduced = reduceEvents(events, rawInfos);
    const takeId = reduced.defaultTakes[this.slideId];
    const segments = takeId ? reduced.segments.filter((g) => g.takeId === takeId && g.status === 'kept').sort((a, b) => a.order - b.order) : [];
    if (!segments.length) { this.say('toast.nothingToListen'); return { ok: false, reason: 'nothing' }; }
    const rawRates = Object.fromEntries(rawInfos.map((r) => [r.name, r.sampleRate]));
    const rawLengths = Object.fromEntries(rawInfos.map((r) => [r.name, r.samples]));
    const parts = [];
    let total = 0;
    for await (const c of renderTake({ segments, rawRates, rawLengths, spec: defaultRenderSpec(), readSamples: (raw, a, b) => this.backend.readRaw(raw, a, b) })) { parts.push(c); total += c.length; }
    const all = new Int16Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    this.playing = true;
    this._changed();
    try {
      const r = await this.player.playPcm(all, rawRates[segments[0].raw], opts);
      return { ok: true, takeId, ...r };
    } finally { this.playing = false; this._changed(); }
  }

  async _play(pieces, opts) {
    this.playing = true;
    this._changed();
    try {
      await this.refresh();
      const r = await this.player.playPieces(this.backend, this.rawFiles, pieces, opts);
      return { ok: true, ...r };
    } finally {
      this.playing = false;
      this._changed();
    }
  }

  stopPlayback() { this.player.stop(); }

  // ------------------------------------------------------------ 試し録り（設計書 4.2 の T）

  canTest() {
    return !this.recordingFault && !this.ts.recording && !this.testing && !this.ts.unresolved && !this.playing;
  }

  /**
   * T：10 秒（?testMs=）録って再生する。音量、音割れ、雑音を本人が確かめる。
   * 録った音は一時ファイルに書き、終わったら消す。録音ファイルにも入らない。操作記録には test-rec（durationMs）だけを残す。
   */
  async testRec(opts = {}) {
    if (!this.canTest()) return { ok: false, reason: 'busy' };
    const ms = this.config.testMs;
    this.testing = { phase: 'recording', startedAt: performance.now(), ms };
    this.testResult = null;
    this._cancelTest = false;
    this._changed();
    let stats = null;
    let cancelled = false;
    try {
      await this.source.open();
      await this._run(async () => {
        await this.backend.call('startTest', { sampleRate: this.source.sampleRate });
        await this.source.arm();
      }, { internal: true });
      const t0 = performance.now();
      while (performance.now() - t0 < ms && !this._cancelTest) {
        await sleep(100);
        this._changed();
      }
      cancelled = this._cancelTest;
      await this._run(async () => {
        await this.source.disarm();
        stats = await this.backend.call('stopTest', {});
      }, { internal: true });
      if (!cancelled && stats.samples > 0) {
        this.testing = { ...this.testing, phase: 'playing' };
        this._changed();
        const pcm = await this.backend.call('readTest', { start: 0, end: stats.samples });
        const r = await this.player.playPcm(pcm, stats.sampleRate, opts);
        this.testPlayedMs = r.playedMs;
      }
    } finally {
      try { await this._run(() => this.backend.call('discardTest', {}), { internal: true }); } catch { /* 無視 */ }
      this.testing = null;
    }
    const durationMs = stats ? Math.round((stats.samples / stats.sampleRate) * 1000) : 0;
    await this._run(() => this.backend.appendEvent('test-rec', { durationMs }, false), { internal: true });
    const db = (x) => (x > 0 ? Math.max(-90, 20 * Math.log10(x)) : -90);
    this.testResult = stats ? {
      durationMs,
      peakDb: Math.round(db(stats.peak) * 10) / 10,
      rmsDb: Math.round(db(stats.rms) * 10) / 10,
      clipped: stats.clipped,
      cancelled,
    } : null;
    this._changed();
    return { ok: true, ...(this.testResult || { durationMs }) };
  }

  // ------------------------------------------------------------ 復旧（設計書 4.5）

  /**
   * 開いたときに、操作記録の途切れた末尾を捨て（Worker が済ませている）、録音ファイルの実際の長さと照らし合わせ、
   * 「recovered」を記録し、本人に選ばせる。マイクは自動で再開しない。
   */
  async _enterRecovery() {
    const ts = this.ts;
    if (ts.recording) {
      const last = this.rawFiles[this.rawFiles.length - 1];
      const at = last ? { raw: last.name, sample: last.samples, pos: totalSamples(this.rawFiles) } : null;
      const cp = lastCheckpoint(ts);
      const notes = [
        this.droppedTailBytes > 0 ? `torn-tail-dropped:${this.droppedTailBytes}` : null,
        ts.durable ? `durable-pos:${ts.durable.pos}` : 'durable-pos:none',
        `actual-end-pos:${at ? at.pos : 0}`,
        ts.durable && at && at.pos < ts.durable.pos ? 'actual-shorter-than-durable' : null,
      ].filter(Boolean).join(';');
      if (!at) throw new Error('recovery-without-raw');
      await this.backend.appendEvent('recovered', {
        at, lastCheckpointId: cp ? cp.checkpointId : null, notes,
      }, false);
      await this.refresh();
    }
    this._changed();
  }

  /** 復旧の選択が済んでいないとき（recovered のあと、有効な ok／retake がまだないとき）の情報。操作記録から毎回求める。
   *  採用や撮り直しを取り消す（undo）と、選択は無かったことになり、ここが再び値を持つ（画面が出し直される）。 */
  get recovery() { return this._recoveryInfo(); }

  _recoveryInfo() {
    const ts = this.ts;
    if (!ts.unresolved) return null;
    const at = ts.unresolved.at;
    const cp = lastCheckpoint(ts);
    const cont = ts.pending.reduce((n, f) => n + (f.end - f.start), 0);
    return {
      recoveredPos: at.pos,
      recoveredAt: at,
      lastOkPos: cp ? cp.pos : null,
      lastOkId: cp ? cp.checkpointId : null,
      continuationSamples: cont,
      pieces: ts.pending.map((f) => ({ ...f })),
      rate: this.rate,
      durablePos: ts.durable ? ts.durable.pos : null,
      tornTail: this.droppedTailBytes > 0,
      slideId: ts.take ? ts.take.slideId : ts.slideId,
    };
  }

  /** 続き（最後の OK 点より後の、復旧できた音声）を聞く。 */
  async listenRecovered(opts = {}) {
    const info = this._recoveryInfo();
    if (!info || !info.pieces.length) return { ok: false, reason: 'nothing' };
    return this._play(info.pieces, opts);
  }

  /** 続きを採用する：復旧できた位置で ok を書く。 */
  async adoptRecovered() {
    return this._run(async () => {
      if (!this.ts.unresolved) return { ok: false, reason: 'no-recovery' };
      const checkpointId = checkpointIdOf(this.ts.nextCheckpointNo);
      await this.backend.appendEvent('ok', { checkpointId }, true);
      await this.refresh();
      this._changed();
      return { ok: true, checkpointId };
    });
  }

  /** 最後の OK 点から撮り直す：続きを破棄にする。OK がなければテイクの最初から。 */
  async retakeFromLastOk() {
    return this._run(async () => {
      if (!this.ts.unresolved) return { ok: false, reason: 'no-recovery' };
      const cp = lastCheckpoint(this.ts);
      await this.backend.appendEvent('retake', { toCheckpoint: cp ? cp.checkpointId : null }, true);
      await this.refresh();
      this._changed();
      return { ok: true, to: cp ? cp.checkpointId : null };
    });
  }

  // ------------------------------------------------------------ 画面を消さない・残りの容量

  async _acquireWake() {
    try {
      if (navigator.wakeLock && !this._wake) {
        this._wake = await navigator.wakeLock.request('screen');
        this._wake.addEventListener('release', () => { this._wake = null; this._changed(); });
      }
    } catch { this._wake = null; }
  }

  async _releaseWake() {
    try { if (this._wake) { await this._wake.release(); } } catch { /* 無視 */ }
    this._wake = null;
  }

  /** 画面の復帰のとき、解除されていたら取り直す（設計書 4.5）。 */
  async reacquireWake() { if (this.ts.recording && !this._wake) await this._acquireWake(); }

  get wakeLockActive() { return !!this._wake; }

  async _checkStorage() {
    if (!this.ts.recording) return;
    const e = await navigator.storage.estimate();
    if (e.quota == null || e.usage == null) return;
    const bytesPerSec = this.rate * 2;
    const remainingSec = Math.max(0, Math.floor((e.quota - e.usage) / bytesPerSec));
    this.storage = { remainingSec, warn: remainingSec < 600 };
    if (remainingSec < 30) {
      this.say('toast.lowStorage');
      this.pause('low-storage').catch(() => {});
    }
    this._changed();
  }

  // ------------------------------------------------------------ 画面用の見え方

  view() {
    const ts = this.ts;
    const cur = this.curPos();
    const cp = lastCheckpoint(ts);
    const pend = pendingSamples(ts, cur);
    const slideId = this.slideId;
    const slide = this.slideById(slideId);
    const rate = this.rate;
    const mode = this.recordingFault ? 'failed' : ts.recording ? 'recording' : (ts.take && !ts.take.closed) ? 'paused' : 'ready';
    const durable = this.backend.durable();
    const durablePos = Math.max(ts.durable ? ts.durable.pos : 0, durable ? durable.pos : 0);
    const rt = retakeTarget(ts, cur);
    const slideViews = this.slides.map((s, i) => {
      const sum = slideSummary(ts, s.slideId);
      return { ...s, index: i, state: s.recordable ? sum.state : 'skip', keptSamples: sum.keptSamples, takes: sum.takes };
    });
    const recordable = this.slides.filter((s) => s.recordable);
    const doneCount = slideViews.filter((s) => s.recordable && s.state === 'done').length;
    return {
      sessionId: this.sessionId,
      title: this.script.title,
      slides: slideViews,
      slideId,
      slideIndex: this.slides.findIndex((s) => s.slideId === slideId),
      slide,
      mode,
      rate,
      cursorPos: cur,
      durable: durablePos ? { pos: durablePos } : null,
      lastOk: cp ? { pos: cp.pos, id: cp.checkpointId } : null,
      take: ts.take ? {
        takeId: ts.take.takeId,
        checkpoints: ts.take.checkpoints.length,
        keptSamples: keptSamples(ts.take),
        pendingSamples: pend,
      } : null,
      pendingSamples: pend,
      confirmedSamples: confirmedSamples(ts), // OK まで採用した音声の合計（画面の「確定」）。pendingSamples が「未確定」
      totalSamples: cur,
      canRecord: this.canRecord().ok,
      canOk: this.canOk(),
      canRetake: rt.ok && !ts.unresolved,
      continuous: this.continuous,
      canNext: !this.continuous && !ts.unresolved && (ts.take ? true : !!this.nextRecordableAfter(slideId)),
      canUndo: !!undoTarget(ts) && !ts.unresolved,
      canRedo: !!redoTarget(ts) && !ts.unresolved,
      canListen: !ts.recording && !!cp,
      canMark: this.rawFiles.length > 0,
      recoveryNeeded: !!this.recovery,
      recovery: this.recovery,
      level: this.level,
      toast: this.toast,
      playing: this.playing,
      testing: this.testing ? { phase: this.testing.phase, elapsedMs: Math.round(performance.now() - this.testing.startedAt), ms: this.testing.ms } : null,
      testResult: this.testResult,
      canTest: this.canTest(),
      canListenSlide: !ts.recording && !this.testing && (slideViews.find((x) => x.slideId === slideId) || {}).keptSamples > 0,
      error: this.lastError,
      recordingFault: this.recordingFault,
      recordableCount: recordable.length,
      doneCount,
      wake: this.wakeLockActive,
      storage: this.storage,
      marks: ts.marks.length,
      hookHit: this.hookHit,
      counters: { captured: this.stats ? this.stats.captured : 0, written: this.stats ? this.stats.written : 0, gaps: this.stats ? this.stats.gaps : 0 },
    };
  }
}
