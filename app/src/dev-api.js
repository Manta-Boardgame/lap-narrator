// 開発・試験用の入口 window.__lap（?devinput=1 または ?lapdev=1 のときだけ公開する）。
// 画面のボタンの代わりに操作でき、内部の状態（保存位置、取得した数、書き込んだ数）を読める。
// 通常の利用では公開しない。

import { base64ToBytes, bytesToBase64 } from './util.js';
import * as opfs from './opfs.js';
import { parseEventsBytes } from './events-io.js';
import { Exporter } from './export.js';

export function installDevApi(app) {
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile });
  });

  let exporter = null;
  const need = () => {
    if (!app.session) throw new Error('no-session');
    return app.session;
  };

  const api = {
    config: app.config,
    violations,

    /** 台本を端末に保存して返す。script は script.json の中身。 */
    async loadScript(script, images) {
      const imgs = {};
      for (const [k, v] of Object.entries(images || {})) imgs[k] = typeof v === 'string' ? base64ToBytes(v) : v;
      return app.saveProject(script, imgs);
    },
    async projects() { return app.listProjects(); },

    // 試験用の入口は、既定でスライド区切り（従来の録り方）。通しは { mode: 'continuous' } を渡す
    async newSession(projectId, opts) {
      const s = await app.newSession(projectId, { mode: 'per-slide', ...(opts || {}) });
      return s.sessionId;
    },
    async openSession(sessionId) {
      const s = await app.openSession(sessionId);
      return { sessionId: s.sessionId, recovery: s.view().recovery };
    },
    async closeSession() { await app.closeSession(); return true; },
    async sessions() { return app.backend.listSessions(); },
    async deleteSession(id) { await app.deleteSession(id); return true; },

    /** 画面の操作と同じ働き。name：record, ok, retake, next, pause, mark, undo, redo, listen, goto, adopt, retake-recovery */
    async press(name, arg) {
      const s = need();
      switch (name) {
        case 'record': return s.record();
        case 'listen-slide': return s.listenSlide(arg || {});
        case 'test': return s.testRec(arg || {});
        case 'ok': return s.ok();
        case 'retake': return s.retake();
        case 'next': return s.next();
        case 'pause': return s.pause(arg || 'user');
        case 'mark': return s.mark(arg);
        case 'undo': return s.undo();
        case 'redo': return s.redo();
        case 'listen': return s.listenLast(arg || {});
        case 'goto': return s.gotoSlide(arg);
        case 'adopt': return s.adoptRecovered();
        case 'retake-recovery': return s.retakeFromLastOk();
        default: throw new Error(`unknown-press:${name}`);
      }
    },

    /** 内部の状態（直前の値を取り直して返す）。 */
    async state() {
      const s = need();
      await s.refresh();
      const v = s.view();
      return {
        ...v,
        slides: v.slides.map(({ slideId, state, keptSamples }) => ({ slideId, state, keptSamples })),
        recording: s.ts.recording,
        eventCount: s.events.length,
        rawFiles: s.rawFiles.map((r) => ({ ...r })),
        stats: s.backend.lastStats,
        durable: s.backend.durable(),
        sourceKind: s.source.kind,
        sampleRate: s.rate,
        mic: s.source.info ? s.source.info() : null,
        droppedTailBytes: s.droppedTailBytes,
        checkpoints: s.ts.take ? s.ts.take.checkpoints.map((c) => ({ id: c.checkpointId, pos: c.pos })) : [],
        pending: s.ts.pending.map((p) => ({ ...p })),
        invalid: [...s.ts.invalid],
      };
    },
    durable() { return app.backend.durable(); },
    async events() { const s = need(); return s.events.map((e) => ({ ...e })); },
    recovery() { return app.session ? app.session.view().recovery : null; },
    async sync() { await app.backend.sync(); return app.backend.lastStats; },

    /** 既知の PCM を流す。pcm：Int16Array、または little-endian の Int16 の base64。speed：実時間の何倍か。 */
    async feed(pcm, opts) {
      const s = need();
      if (!s.source.feed) throw new Error('feed-needs-devinput');
      const data = typeof pcm === 'string' ? new Int16Array(base64ToBytes(pcm).buffer) : pcm;
      const r = await s.source.feed(data, opts || {});
      await s.refresh();
      return r;
    },

    /** セッションの録音ファイルの中身（生の PCM）を、そのまま base64 で返す。 */
    async readRawBase64(rawName) {
      const s = need();
      await s.refresh();
      const info = s.rawFiles.find((r) => r.name === rawName);
      if (!info) throw new Error('unknown-raw');
      const parts = [];
      const step = 1 << 18;
      for (let off = 0; off < info.samples; off += step) {
        const pcm = await app.backend.readRaw(rawName, off, Math.min(info.samples, off + step));
        parts.push(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      }
      let n = 0;
      for (const p of parts) n += p.length;
      const all = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      return bytesToBase64(all);
    },

    /** 端末内（OPFS）の録音ファイルの実際の大きさ（バイト）。保存されていた音声の長さの確認用。 */
    async rawSizesOnDisk(sessionId) {
      const out = {};
      for (const e of await opfs.listDir(['sessions', sessionId, 'raw'])) {
        if (e.kind === 'file' && e.name.endsWith('.pcm')) {
          out[e.name.slice(0, -4)] = (await opfs.readFile(['sessions', sessionId, 'raw', e.name])).size;
        }
      }
      return out;
    },
    async eventsOnDisk(sessionId) {
      const f = await opfs.readFile(['sessions', sessionId, 'events.jsonl']);
      if (!f) return null;
      const bytes = new Uint8Array(await f.arrayBuffer());
      return { ...parseEventsBytes(bytes), totalBytes: bytes.length };
    },

    /** 試し録りの一時ファイルが残っているか。 */
    async testTempExists(sessionId) { return !!(await opfs.readFile(['sessions', sessionId, 'test-rec.pcm'])); },

    /** 復旧した続きを聞く（試験では speed で早送りできる）。 */
    async playRecovered(opts) { return need().listenRecovered(opts || {}); },

    async waitForHook(timeoutMs = 20000) {
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) {
        if (app.backend.hookHit) return app.backend.hookHit;
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    },
    hookHit() { return app.backend.hookHit; },

    // ---- 書き出し（画面の「書き出し」と同じ働き。1 巻ずつ）
    async exportStart({ kind = 'full', speaker } = {}) {
      exporter = new Exporter({ app, session: need(), kind, volumeMaxBytes: app.config.volumeMaxBytes, finalMaxBytes: app.config.finalMaxBytes, speaker });
      return exporter.prepare();
    },
    async exportBuild(n) { return exporter.buildVolume(n); },
    async exportDownload(n) { return exporter.downloadVolume(n); },
    async exportConfirm(n) { return exporter.confirmSaved(n); },
    exportIndex() { return exporter.indexJson(); },
    exportDownloadIndex() { return exporter.downloadIndex(); },
    async exportFilesInOpfs() {
      const out = [];
      for (const d of await opfs.listDir(['exports'])) {
        for (const f of await opfs.listDir(['exports', d.name])) out.push(d.name + '/' + f.name);
      }
      return out;
    },
    /** 作った巻の一部を base64 で返す（ダウンロードを使わない検証用）。 */
    async exportReadVolume(n, start, end) {
      const info = exporter.built.get(n);
      const f = await opfs.readFile(info.path);
      return bytesToBase64(new Uint8Array(await f.slice(start, end).arrayBuffer()));
    },
    heapUsed() { return performance.memory ? performance.memory.usedJSHeapSize : null; },

    app,
  };
  window.__lap = api;
  return api;
}
