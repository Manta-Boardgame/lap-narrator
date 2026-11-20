// 書き出し（設計書 4.6、CONTRACTS.md 1.2、1.3、0.6、0.7）。
//   全記録（kind: full）：README.txt、manifest.json、script.json、events.jsonl、segments.json、edits.json、raw/rec-NNNNNN.wav
//   完成版（kind: final）：manifest.json、script.json、final/<slideId>.wav（分割したときは .p001.wav …）
// - 計算は core/ を使う（ZIP：zip.js、ハッシュ：sha256.js、WAV：wav.js、区間：reduce.js、音声の作成：render.js、検証：validate.js）。
// - ZIP は OPFS に少しずつ書いてからダウンロードさせる。全体をメモリに載せない（録音ファイルは 512KB ずつ読む）。
// - 大きい場合は巻に分ける。1 巻を作り → 端末への保存を確かめ → 次の巻を作る（必要な空きは 1 巻分）。
// - 全巻の ZIP のハッシュは巻の中に入れず、書き出しのあとに <exportId>_index.json として作る（任意）。

import { createZipWriter } from '../../core/zip.js';
import { createSha256, sha256Hex } from '../../core/sha256.js';
import { wavHeader, planWavParts } from '../../core/wav.js';
import { reduceEvents } from '../../core/reduce.js';
import { renderTake, planRender, defaultRenderSpec } from '../../core/render.js';
import { validate } from '../../core/validate.js';
import { APP_VERSION } from './config.js';
import { randomId } from './util.js';
import { eventsToText } from './events-io.js';
import * as opfs from './opfs.js';

const enc = new TextEncoder();
const READ_SAMPLES = 1 << 18;
const EDIT_VERSION = 1; // 編集の版（edits.json の editVersion。完成版の manifest にも必ず書く：CONTRACTS 7.4）
const EXPORT_RENDER_SPEC = { ...defaultRenderSpec(), preserveFileRotations: true };
const DOCS_MARGIN = 4096; // export の操作記録 1 行（約 200 バイト）と、README の桁の増えに足りる余白
const ENTRY_OVERHEAD = 120; // 局所ヘッダー + 中央ディレクトリ + データ記述子の概算（名前の 2 倍を別に足す）

/** アプリの録音の台本（free の 1 枚）か。 */
function isContinuous(script) {
  return !!script && script.slides.length === 1 && script.slides[0].slideId === 'free';
}

export class ExportError extends Error {
  constructor(code, message) { super(message || code); this.name = 'ExportError'; this.code = code; }
}

const readme = (kind, ctx) => `lap-narrator ${kind === 'full' ? 'full record / 全記録' : 'final audio / 完成版'}
projectId: ${ctx.projectId}
sessionId: ${ctx.sessionId}
exportId : ${ctx.exportId}
volumes  : ${ctx.volumes}

[ja]
- manifest.json   形式の版、台本のハッシュ、各ファイルの大きさと SHA-256（巻ごと）
- script.json     台本（台本パックの script.json の写し）
- events.jsonl    操作記録（正本。1 行に 1 操作）
- segments.json   区間とテイクの一覧（events.jsonl から作ったもの。食い違ったら events.jsonl が正）
- edits.json      編集の記録
- raw/rec-NNNNNN.wav  録音したままの音声（16 ビット、モノラル。撮り直した声も含みます）
巻が複数ある場合、各巻は単独で開けます。第 2 巻以降は manifest.json と録音ファイルだけです。
全巻の ZIP のハッシュは ${ctx.exportId}_index.json にあります（任意）。

[en]
- manifest.json   format version, script hash, size and SHA-256 of each file (per volume)
- script.json     the script (a copy of the script pack's script.json)
- events.jsonl    operation log (the source of truth; one operation per line)
- segments.json   segments and takes (derived from events.jsonl; events.jsonl wins on mismatch)
- edits.json      edit record
- raw/rec-NNNNNN.wav  audio as captured (16-bit, mono; includes retaken voice)
Each volume opens on its own. Volumes 2 and later hold only manifest.json and raw files.
The SHA-256 of every volume's ZIP is in ${ctx.exportId}_index.json (optional).
`;

export function volumeName(projectId, sessionId, kind, n) {
  return `${projectId}_${sessionId}_${kind}_v${String(n).padStart(3, '0')}.zip`;
}

/** 通しの音声を、決まった数のサンプルずつ取り出す読み手。 */
async function* sliceStream(iterable, skip, count) {
  let toSkip = skip;
  let left = count;
  for await (const chunk of iterable) {
    let c = chunk;
    if (toSkip > 0) {
      if (c.length <= toSkip) { toSkip -= c.length; continue; }
      c = c.subarray(toSkip);
      toSkip = 0;
    }
    if (c.length > left) c = c.subarray(0, left);
    left -= c.length;
    if (c.length) yield c;
    if (left === 0) return;
  }
}

const asBytes = (i16) => new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);

export class Exporter {
  /**
   * @param {{app:any, session:any, kind:'full'|'final', volumeMaxBytes:number, finalMaxBytes:number, speaker?:string}} o
   */
  constructor({ app, session, kind, volumeMaxBytes, finalMaxBytes, speaker }) {
    if (kind !== 'full' && kind !== 'final') throw new ExportError('bad-kind', `kind ${kind}`);
    this.app = app;
    this.session = session;
    this.kind = kind;
    this.volumeMaxBytes = volumeMaxBytes;
    this.finalMaxBytes = finalMaxBytes;
    this.speaker = speaker || (app.meta && app.meta.speaker) || undefined;
    this.exportId = randomId(12);
    this.volumes = [];
    this.built = new Map(); // 巻の番号 → {file, bytes, sha256, path}
    this.saved = new Set();
    this.nextToBuild = 1;
    this.prepared = false;
  }

  get backend() { return this.session.backend; }

  // ------------------------------------------------------------ 準備

  async prepare() {
    const s = this.session;
    if (s.ts.recording) throw new ExportError('recording', 'recording in progress');
    if (s.recovery || s.ts.unresolved) throw new ExportError('recovery', 'resolve the recovery first');
    await s.refresh();
    this.rawInfos = s.rawFiles.map((r) => ({ ...r }));
    this.projectId = s.script.projectId;
    this.sessionId = s.sessionId;
    if (!this.rawInfos.length) throw new ExportError('no-audio', 'nothing recorded');

    // 巻の数を、1 回だけ決める（export の操作記録に巻の数を書くため、書く前に決める）。
    // 小さなファイル（第 1 巻）の大きさは、書き出す前の中身を測り、export の 1 行と README の桁の増えに足りる余白を足した「予算」とする。
    // 計画はこの予算だけで立て、あとから中身を測り直して計画を作り直さない（境目で巻の数が食い違うのを防ぐ）。
    const entries = await this._bigEntries();
    const docsBudget = this._docsCost(this._makeDocs(1)) + DOCS_MARGIN;
    const volumes = this._planVolumes(docsBudget, entries);
    // 書き出した事実を操作記録に残す（位置は持たない）。この行は書き出す events.jsonl に含まれる
    await this.backend.appendEvent('export', { exportId: this.exportId, kind: this.kind, volumes: volumes.length }, false);
    await s.refresh();
    // 台本・操作記録など（小さなファイル）を、最終の中身で作る。予算に収まっていなければ、計画の前提が崩れたので止める
    this.docs = this._makeDocs(volumes.length);
    if (this._docsCost(this.docs) > docsBudget) throw new ExportError('plan-changed', 'the small files grew beyond the planned budget');
    this.entries = entries;
    this.volumes = volumes;
    // 巻の中身が決まったので、ハッシュを先に求める（manifest が全体の一覧を持つため）
    for (const e of entries) if (!e.sha256) e.sha256 = await this._hashEntry(e);
    this.prepared = true;
    return this.summary();
  }

  summary() {
    return {
      exportId: this.exportId,
      kind: this.kind,
      volumes: this.volumes.length,
      volumeMaxBytes: this.volumeMaxBytes,
      plan: this.volumes.map((v, i) => ({ volume: i + 1, files: v.map((e) => e.path), bytes: v.reduce((n, e) => n + e.size, 0) })),
      names: this.volumes.map((_, i) => volumeName(this.projectId, this.sessionId, this.kind, i + 1)),
    };
  }

  /** 録音ファイル（全記録）、または完成した音声（完成版）の一覧。 */
  async _bigEntries() {
    return this.kind === 'full' ? this._rawEntries() : this._finalEntries();
  }

  _rawEntries() {
    const s = this.session;
    return this.rawInfos.map((r) => ({
      path: `raw/${r.name}.wav`,
      size: 44 + r.samples * 2,
      raw: r,
      iter: () => this._rawIter(r),
    }));
  }

  async *_rawIter(r) {
    yield wavHeader({ sampleRate: r.sampleRate, samples: r.samples });
    for (let off = 0; off < r.samples; off += READ_SAMPLES) {
      const pcm = await this.backend.readRaw(r.name, off, Math.min(r.samples, off + READ_SAMPLES));
      yield asBytes(pcm);
    }
  }

  async _finalEntries() {
    const s = this.session;
    const reduced = reduceEvents(s.events.slice().sort((a, b) => a.seq - b.seq), this._rawInfosForReduce(), { trackFileRotations: true });
    this.reduced = reduced;
    const rawRates = Object.fromEntries(this.rawInfos.map((r) => [r.name, r.sampleRate]));
    const rawLengths = Object.fromEntries(this.rawInfos.map((r) => [r.name, r.samples]));
    const spec = EXPORT_RENDER_SPEC;
    this.finals = [];
    const entries = [];
    for (const slide of s.slides) {
      if (!slide.recordable) continue;
      const takeId = reduced.defaultTakes[slide.slideId];
      if (!takeId) continue; // 録音していないスライドは含まない
      const segments = reduced.segments.filter((g) => g.takeId === takeId && g.status === 'kept').sort((a, b) => a.order - b.order);
      const args = { segments, rawRates, rawLengths, spec, edits: undefined };
      const plan = planRender(args);
      if (plan.totalSamples === 0) continue;
      const parts = planWavParts(plan.totalSamples, this.finalMaxBytes);
      const fin = { slideId: slide.slideId, takeId, samples: plan.totalSamples, sampleRate: plan.sampleRate, applied: plan.applied, parts: [] };
      let skip = 0;
      parts.forEach((n, i) => {
        const file = parts.length === 1 ? `final/${slide.slideId}.wav` : `final/${slide.slideId}.p${String(i + 1).padStart(3, '0')}.wav`;
        const start = skip;
        const sampleRate = plan.sampleRate;
        entries.push({
          path: file,
          size: 44 + n * 2,
          iter: () => this._finalIter(args, sampleRate, start, n),
          finalPart: { fin, file, samples: n },
        });
        fin.parts.push({ file, samples: n, sha256: null });
        skip += n;
      });
      this.finals.push(fin);
    }
    if (!entries.length) throw new ExportError('no-final', 'no slide has an adopted take');
    return entries;
  }

  async *_finalIter(args, sampleRate, skip, count) {
    yield wavHeader({ sampleRate, samples: count });
    const stream = renderTake({ ...args, readSamples: (raw, a, b) => this.backend.readRaw(raw, a, b) });
    for await (const c of sliceStream(stream, skip, count)) yield asBytes(c);
  }

  async _hashEntry(e) {
    const h = createSha256();
    let bytes = 0;
    for await (const c of e.iter()) { h.update(c); bytes += c.length; }
    if (bytes !== e.size) throw new ExportError('size-mismatch', `${e.path}: ${bytes} != ${e.size}`);
    const hex = h.digestHex();
    if (e.finalPart) e.finalPart.fin.parts.find((p) => p.file === e.finalPart.file).sha256 = hex;
    return hex;
  }

  _rawInfosForReduce() {
    const s = this.session;
    return this.rawInfos.map((r) => {
      let durable = 0;
      for (const e of s.events) for (const k of ['at']) if (e[k] && e[k].raw === r.name) durable = Math.max(durable, e[k].sample);
      return { name: r.name, sampleRate: r.sampleRate, samples: r.samples, durableSamples: Math.min(durable, r.samples) };
    });
  }

  _docsCost(docs) { return docs.reduce((n, d) => n + d.size + ENTRY_OVERHEAD + 2 * d.path.length, 0); }

  /** 小さなファイル。第 1 巻に入る。 */
  _makeDocs(volumeCount) {
    const s = this.session;
    const events = s.events.slice().sort((a, b) => a.seq - b.seq);
    const scriptBytes = enc.encode(JSON.stringify(s.script, null, 2));
    const docs = [];
    const add = (path, bytes) => docs.push({ path, size: bytes.length, bytes, sha256: sha256Hex(bytes) });
    const ctx = { projectId: this.projectId, sessionId: this.sessionId, exportId: this.exportId, volumes: volumeCount };
    if (this.kind === 'full') add('README.txt', enc.encode(readme('full', ctx)));
    add('script.json', scriptBytes);
    if (this.kind === 'full') {
      add('events.jsonl', enc.encode(eventsToText(events)));
      const reduced = reduceEvents(events, this._rawInfosForReduce());
      const { state, ...segments } = reduced;
      const segmentsJson = { ...segments, sessionId: this.sessionId };
      const v = validate('segments', segmentsJson);
      if (!v.ok) throw new ExportError('bad-segments', `segments.json: ${JSON.stringify(v.errors)}`);
      add('segments.json', enc.encode(JSON.stringify(segmentsJson, null, 2)));
      const edits = { format: 'lap-narrator/edits', version: 1, sessionId: this.sessionId, editVersion: EDIT_VERSION, joins: [], fadeSamples: 384, gainDb: {}, selections: {} };
      const ve = validate('edits', edits);
      if (!ve.ok) throw new ExportError('bad-edits', JSON.stringify(ve.errors));
      add('edits.json', enc.encode(JSON.stringify(edits, null, 2)));
    }
    return docs;
  }

  _planVolumes(docsBytes, entries) {
    const cost = (e) => e.size + ENTRY_OVERHEAD + 2 * e.path.length;
    const manifestCost = (n) => 3000 + 500 * n;
    const vols = [[]];
    let cur = docsBytes + manifestCost(entries.length + 5);
    let curCount = 1; // 第 1 巻には小さなファイルが入る
    for (const e of entries) {
      if (curCount > 0 && cur + cost(e) > this.volumeMaxBytes) { vols.push([]); cur = manifestCost(entries.length + 5); curCount = 0; }
      vols[vols.length - 1].push(e);
      cur += cost(e);
      curCount++;
    }
    // 第 1 巻は小さなファイルのために必ず作る。ファイルを持たない巻はない
    return vols;
  }

  // ------------------------------------------------------------ 巻を作る

  /** n 巻目を作って OPFS に書く（1 巻ずつ。前の巻の保存を確かめてから）。 */
  async buildVolume(n, { onProgress } = {}) {
    if (!this.prepared) throw new ExportError('not-prepared', 'call prepare() first');
    if (n < 1 || n > this.volumes.length) throw new ExportError('bad-volume', `volume ${n}`);
    if (n !== this.nextToBuild) throw new ExportError('out-of-order', `volume ${this.nextToBuild} must be built (and saved) first`);
    if (n > 1 && !this.saved.has(n - 1)) throw new ExportError('not-saved', `volume ${n - 1} is not confirmed as saved`);
    const s = this.session;
    const file = volumeName(this.projectId, this.sessionId, this.kind, n);
    const dirParts = ['exports', this.exportId];
    const dir = await opfs.getDir(dirParts, true);
    const fh = await dir.getFileHandle(file, { create: true });
    const writable = await fh.createWritable();
    const whole = createSha256();
    let total = 0;
    const zip = createZipWriter({
      write: async (u8) => { whole.update(u8); total += u8.length; await writable.write(u8); },
    });
    const files = [];
    try {
      const addMem = async (d) => { const r = await zip.addFile(d.path, d.bytes); files.push({ path: d.path, bytes: r.bytes, sha256: r.sha256 }); };
      if (n === 1) for (const d of this.docs) await addMem(d);
      for (const e of this.volumes[n - 1]) {
        const r = await zip.addFile(e.path, e.iter(), { size: e.size });
        if (r.sha256 !== e.sha256 || r.bytes !== e.size) throw new ExportError('changed', `${e.path} changed while exporting`);
        files.push({ path: e.path, bytes: r.bytes, sha256: r.sha256 });
        if (onProgress) onProgress({ volume: n, file: e.path });
      }
      const manifest = this._manifest(n, files);
      const v = validate('manifest', manifest);
      if (!v.ok) throw new ExportError('bad-manifest', JSON.stringify(v.errors));
      await zip.addFile('manifest.json', enc.encode(JSON.stringify(manifest, null, 2)));
      await zip.finish();
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch { /* 無視 */ }
      try { await dir.removeEntry(file); } catch { /* 無視 */ }
      throw e;
    }
    const info = { volume: n, file, bytes: total, sha256: whole.digestHex(), path: [...dirParts, file] };
    this.built.set(n, info);
    this.nextToBuild = n; // 保存を確かめるまで、次へ進まない
    return info;
  }

  _manifest(n, files) {
    const s = this.session;
    const meta = this.app.meta || {};
    const m = {
      format: 'lap-narrator/manifest',
      version: 1,
      kind: this.kind,
      projectId: this.projectId,
      scriptHash: s.script.scriptHash,
      sessionId: this.sessionId,
      exportId: this.exportId,
      volume: n,
      volumes: this.volumes.length,
      appVersion: APP_VERSION,
      editVersion: EDIT_VERSION,
      renderSpec: EXPORT_RENDER_SPEC,
      recording: isContinuous(s.script) ? 'continuous' : 'per-slide', // 通し（スライドの区切りなし）か、スライド区切りモード（台本の枚数に関わらず per-slide）
      ...(this.speaker ? { speaker: this.speaker } : {}),
      device: meta.device || {},
      mic: meta.mic || { requested: {}, actual: {} },
      files,
      createdAt: new Date().toISOString(),
    };
    if (this.kind === 'full') {
      const dur = new Map(this._rawInfosForReduce().map((r) => [r.name, r.durableSamples]));
      m.rawFiles = this.rawInfos.map((r) => ({
        file: `raw/${r.name}.wav`,
        sampleRate: r.sampleRate,
        samples: r.samples,
        sha256: this.entries.find((e) => e.raw === r).sha256,
        durableSamples: dur.get(r.name),
      }));
    } else {
      m.finals = this.finals.map((f) => ({ slideId: f.slideId, takeId: f.takeId, parts: f.parts.map((p) => ({ ...p })), samples: f.samples, sampleRate: f.sampleRate, applied: f.applied }));
    }
    return m;
  }

  // ------------------------------------------------------------ 保存

  /** 作った巻を、端末に保存させる（ダウンロード）。ファイルは OPFS から直接渡す（メモリに載せない）。 */
  async downloadVolume(n) {
    const info = this.built.get(n);
    if (!info) throw new ExportError('not-built', `volume ${n}`);
    const f = await opfs.readFile(info.path);
    if (!f || f.size !== info.bytes) throw new ExportError('missing', 'the volume file is missing or changed');
    await triggerDownload(f, info.file);
    return { file: info.file, bytes: info.bytes, sha256: info.sha256 };
  }

  /** 本人が「保存できた」と確かめたら、端末内の一時ファイルを消して、次の巻へ進める。 */
  async confirmSaved(n) {
    const info = this.built.get(n);
    if (!info) throw new ExportError('not-built', `volume ${n}`);
    this.saved.add(n);
    try { await opfs.removeEntry(info.path); } catch { /* 無視 */ }
    this.nextToBuild = n + 1;
    return { next: n < this.volumes.length ? n + 1 : null };
  }

  get done() { return this.saved.size === this.volumes.length; }

  /** 索引（<exportId>_index.json）。全巻を保存したあとに作る。 */
  indexJson() {
    const idx = {
      format: 'lap-narrator/index',
      version: 1,
      exportId: this.exportId,
      kind: this.kind,
      projectId: this.projectId,
      sessionId: this.sessionId,
      volumes: this.volumes.length,
      zips: [...this.built.values()].sort((a, b) => a.volume - b.volume).map((b) => ({ volume: b.volume, file: b.file, bytes: b.bytes, sha256: b.sha256 })),
    };
    const v = validate('index', idx);
    if (!v.ok) throw new ExportError('bad-index', JSON.stringify(v.errors));
    return idx;
  }

  async downloadIndex() {
    const idx = this.indexJson();
    const blob = new Blob([JSON.stringify(idx, null, 2)], { type: 'application/json' });
    await triggerDownload(blob, `${this.exportId}_index.json`);
    return idx;
  }

  async discard() {
    try { await opfs.removeEntry(['exports', this.exportId]); } catch { /* 無視 */ }
  }
}

export async function triggerDownload(blobOrFile, name) {
  if (typeof window.lapSaveBlob === 'function') {
    const result = await window.lapSaveBlob(blobOrFile, name);
    if (result?.ok !== true) {
      throw new ExportError(result?.cancelled ? 'save-cancelled' : 'save-failed', result?.error);
    }
    return;
  }
  const url = URL.createObjectURL(blobOrFile);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

/** 書き出しの前に見せる、含まれるものの一覧（設計書 4.6）。 */
export function describeContents(kind) {
  return kind === 'full'
    ? ['export.includes.audio', 'export.includes.script', 'export.includes.events', 'export.includes.device']
    : ['export.includes.audioFinal', 'export.includes.script', 'export.includes.device'];
}
