// アプリ全体の状態：台本（プロジェクト）の保存、セッションの作成・再開。画面（ui.js）と試験用の入口（dev-api.js）が使う。

import { createBackend } from './backend.js';
import { createPlayer } from './player.js';
import { createMicSource } from './capture.js';
// @no-release:begin
import { createDevSource } from './devsource.js';
// @no-release:end
import { Session } from './session.js';
import { APP_VERSION } from './config.js';
import { randomId } from './util.js';
import { textHash, scriptHash } from '../../core/script.js';
import * as opfs from './opfs.js';
import { Emitter } from './util.js';

export const FREE_PROJECT_ID = 'free-recording';
export const FREE_SLIDE_ID = 'free';

/**
 * 録音のセッションの台本。常に 1 枚（slideId free、題名「通し録音」、文は空、絵なし）。録音は 1 本の通しで、スライドの区切りを持たない。
 * 読み込んだ台本（画面に表示するだけ）がある場合は、その projectId を使う（書き出しのファイル名と取り込みの照合のため）。
 */
export function makeFreeScript(displayProjectId = null) {
  const slide = { slideId: FREE_SLIDE_ID, order: 1, title: '通し録音', text: '', recordable: true };
  slide.textHash = textHash(slide);
  return {
    format: 'lap-narrator/script', version: 1,
    projectId: displayProjectId || FREE_PROJECT_ID, title: '通し録音',
    scriptHash: scriptHash([slide]), slides: [slide],
  };
}

/** 読み上げ用の本文：全スライドの文を、スライドの区切りなしの 1 本の連続した文章にする（録音の対象のスライドの、空でない文を、空白 1 つでつなぐ）。 */
export function continuousText(script) {
  if (!script || !Array.isArray(script.slides)) return '';
  return [...script.slides].sort((a, b) => a.order - b.order)
    .filter((s) => s.recordable !== false && typeof s.text === 'string' && s.text.trim())
    .map((s) => s.text.trim()).join(' ');
}

export class App {
  constructor(config) {
    this.config = config;
    this.backend = createBackend();
    this.player = createPlayer();
    this.session = null;
    this.script = null; // 録音のセッションの台本（常に free の 1 枚）
    this.displayScript = null; // 画面に表示するだけの台本（読み込んだ台本パック。なければ null）
    this.source = null;
    this.meta = null;
    this.update = new Emitter();
    this.persisted = null;
    this.noiseSuppression = false;
    this._imageUrls = new Map();
    this.levelListeners = new Emitter();
  }

  /** 録り方の設定：'continuous'（既定。通し）か 'per-slide'（スライド区切りモード）。次回起動時も覚える。 */
  get recordMode() {
    try { return localStorage.getItem('lap.recordMode') === 'per-slide' ? 'per-slide' : 'continuous'; } catch { return 'continuous'; }
  }

  set recordMode(v) {
    try { localStorage.setItem('lap.recordMode', v === 'per-slide' ? 'per-slide' : 'continuous'); } catch { /* 保存できなくてもよい */ }
  }

  async init() {
    this.persisted = await opfs.requestPersist();
  }

  // ------------------------------------------------------------ 台本（プロジェクト）

  /** 台本を端末に保存する。images は {パス: Blob|Uint8Array}（なくてもよい）。 */
  async saveProject(script, images = {}) {
    const base = ['projects', script.projectId];
    await opfs.writeJson([...base, 'script.json'], script);
    for (const [path, data] of Object.entries(images)) {
      if (!/^slides\/[A-Za-z0-9_.-]+$/.test(path)) continue;
      await opfs.writeFile([...base, ...path.split('/')], data);
    }
    return script.projectId;
  }

  async listProjects() {
    const out = [];
    for (const e of await opfs.listDir(['projects'])) {
      if (e.kind !== 'directory') continue;
      const script = await opfs.readJson(['projects', e.name, 'script.json']);
      if (script) out.push({ projectId: e.name, title: script.title, slides: script.slides.length, bytes: await opfs.dirSize(['projects', e.name]) });
    }
    return out;
  }

  async loadProject(projectId) {
    const script = await opfs.readJson(['projects', projectId, 'script.json']);
    if (!script) throw new Error('project-not-found');
    return script;
  }

  async deleteProject(projectId) { await opfs.removeEntry(['projects', projectId]); }

  /** スライドの絵の blob URL（表示用）。なければ null。 */
  async slideImageUrl(projectId, imagePath) {
    if (!imagePath) return null;
    const key = `${projectId}/${imagePath}`;
    if (this._imageUrls.has(key)) return this._imageUrls.get(key);
    const f = await opfs.readFile(['projects', projectId, ...imagePath.split('/')]);
    if (!f) return null;
    const url = URL.createObjectURL(f);
    this._imageUrls.set(key, url);
    return url;
  }

  // ------------------------------------------------------------ セッション

  _makeSource() {
    let source;
    const onLevel = (l) => {
      const s = this.session;
      if (this.source !== source || s?.recordingFault) return;
      if (s) {
        s.level.peak = l.peak;
        if (l.peak >= 0.99) s.level.clipUntil = performance.now() + 2000;
      }
      this.levelListeners.emit(l);
    };
    // @no-release:begin
    if (this.config.devinput) {
      source = createDevSource({ backend: this.backend, sampleRate: this.config.devSampleRate, onLevel });
      return source;
    }
    // @no-release:end
    source = createMicSource({
      backend: this.backend,
      noiseSuppression: this.noiseSuppression,
      onLevel,
      onInterrupt: (reason) => {
        if (this.source === source) this.session?.pause(reason).catch(() => {});
      },
    });
    return source;
  }

  async _teardown() {
    if (this.session) { try { await this.session.close(); } catch { /* 無視 */ } }
    if (this.source) { try { await this.source.close(); } catch { /* 無視 */ } }
    this.session = null;
    this.source = null;
  }

  /** 表示用の台本を読む。なければ null（台本が消えていても録音は続けられる）。 */
  async _loadDisplay(projectId) {
    if (!projectId) return null;
    try { return await this.loadProject(projectId); } catch { return null; }
  }

  /**
   * 新しい録音セッションを始める。マイクを使うときは、利用者の操作（クリック）の中で呼ぶ。
   * 既定（通し）：録音のセッションの台本は 1 枚（free）。displayProjectId は、画面に出すだけの台本（なくてもよい）。
   * スライド区切りモード（利用者が設定で入れたときだけ）：displayProjectId の台本のまま、スライドごとに録る（next-slide／goto-slide を書く）。
   */
  async newSession(displayProjectId = null, { speaker, mode } = {}) {
    await this._teardown();
    const display = await this._loadDisplay(displayProjectId);
    const perSlide = (mode || this.recordMode) === 'per-slide';
    if (perSlide && !display) throw new Error('project-not-found'); // スライド区切りモードには台本パックが要る
    const script = perSlide ? display : makeFreeScript(display ? display.projectId : null);
    const sessionId = randomId(12);
    const source = this._makeSource();
    this.source = source;
    try {
      await source.open(); // マイクの許可を求める（失敗したらセッションを作らない）
    } catch (error) {
      await this._teardown();
      throw error;
    }
    this.script = script;
    this.displayScript = display;
    const session = new Session({ backend: this.backend, source, script, config: this.config, sessionId, player: this.player });
    this.session = session;
    this.meta = {
      sessionId,
      projectId: script.projectId,
      scriptHash: script.scriptHash,
      title: script.title,
      recording: perSlide ? 'per-slide' : 'continuous',
      displayProjectId: display ? display.projectId : undefined,
      displayTitle: display ? display.title : undefined,
      createdAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      speaker: speaker || undefined,
      source: source.kind,
      mic: source.info(),
      device: { userAgent: navigator.userAgent, platform: navigator.platform || undefined },
    };
    try {
      await session.open({ create: true });
      await opfs.writeJson(['sessions', sessionId, 'meta.json'], this.meta);
    } catch (e) {
      await this._teardown();
      throw e;
    }
    this.update.emit();
    return session;
  }

  /** 既存のセッションを開く。中断していたら、復旧の手順になる（マイクは開かない）。 */
  async openSession(sessionId) {
    await this._teardown();
    const meta = await opfs.readJson(['sessions', sessionId, 'meta.json']);
    if (!meta) throw new Error('session-meta-not-found');
    // スライド区切りのセッション（と古いセッション）は、その台本のまま開く。通しのものは free の台本
    let script = null;
    if (meta.recording !== 'continuous') script = await this._loadDisplay(meta.projectId);
    const display = meta.recording === 'continuous' ? await this._loadDisplay(meta.displayProjectId) : script;
    if (!script) script = makeFreeScript(meta.recording === 'continuous' ? meta.projectId : null);
    const source = this._makeSource();
    this.source = source;
    this.script = script;
    this.displayScript = display;
    this.meta = meta;
    const session = new Session({ backend: this.backend, source, script, config: this.config, sessionId, player: this.player });
    this.session = session;
    try {
      await session.open({ create: false });
    } catch (error) {
      await this._teardown();
      throw error;
    }
    this.update.emit();
    return session;
  }

  /** 再開のとき、マイクを開く（利用者の操作の中で）。 */
  async openMic() {
    if (!this.source) throw new Error('no-session');
    await this.source.open();
    if (this.meta && this.source.info) {
      this.meta.mic = this.source.info();
      await opfs.writeJson(['sessions', this.meta.sessionId, 'meta.json'], this.meta);
    }
  }

  async closeSession() {
    await this._teardown();
    this.update.emit();
  }

  async deleteSession(sessionId) {
    if (this.session && this.session.sessionId === sessionId) await this._teardown();
    await this.backend.deleteSession(sessionId);
  }
}
