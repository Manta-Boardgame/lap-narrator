// 取り込み（CONTRACTS.md 1.11、2.2、2.3、設計書 6.6）。保存先は `store`（2.2）で受け取る。実行環境に依存しない。
//
// store の中の配置：
//   receipts.json                         受領の記録 [{exportId, volume, volumes, zipSha256, receivedAt, projectId, sessionId, kind, scriptHash}]
//                                         （キーは (exportId, volume)。projectId 以降は取り込みの検査のために足した欄）
//   staging/<exportId>/v<NNN>/<zip の中のパス>   検証済みで展開した巻（統合したら消す）
//   staging/<exportId>/index.json         <exportId>_index.json の中身（receiveIndex が置く。任意）
//   script.json                           （任意）作業場の台本。あれば、セッションの台本と比べて staleSlides を記録する
//   sessions/<sessionId>/session.json     統合した状態（下記）
//   sessions/<sessionId>/script.json, events.jsonl, segments.json, edits.json, raw/rec-NNNNNN.wav
//   sessions/<sessionId>/finals/<exportId>/final/<slideId>.wav …   完成版の音声（取り込んだ完成版ごと）
//
// 統合は「取り込んだ書き出しの集合」だけで決まる（取り込む順で変わらない）：
//   各部分を、全順序で比べた勝者 1 つに決める（最大／最小を取る）。負けた版は消えるが、どの版があったかは session.json の variants に残る。
//   - script.json … scriptHash の小さい方（同じなら中身の SHA-256 の小さい方）
//   - 録音ファイル … 同じ名前で SHA-256 が違えば、サンプル数が多い方（同じなら SHA-256 の小さい方）
//   - events.jsonl と segments.json（対）… 行数の多い方（同じなら SHA-256 の小さい方）
//   - edits.json … editVersion の大きい方（同じなら SHA-256 の小さい方）
//   - 完成版 … 取り込んだものをすべて残す。編集の版が全記録の edits.json と同じものは role:'verify-only'（検証にだけ使う）、
//     違うもの（または全記録が無いもの）は role:'candidate'（採用の候補。自動では置き換えない）
// 完成版の編集の版は manifest.editVersion から読む。無ければ manifest.renderSpec.editVersion（古い書き出し用。CONTRACTS.md 7.4）。

import { readZipDirectory, readZipEntry } from './zip.js';
import { createSha256 } from './sha256.js';
import { validate } from './validate.js';
import { canonicalJson } from './json.js';

const RECEIPTS = 'receipts.json';
const CHUNK = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8');

/** 取り込みのエラー。`code`：'bad-volume'、'conflicting-volume'、'index-mismatch'、'inconsistent-export'。`detail` に詳細（'bad-volume' では `detail.reason`：'unreadable'（読めない、形が違う）または 'hash-mismatch'（大きさ・SHA-256 が合わない）） */
export class ImportError extends Error {
  /** @param {string} code @param {string} message @param {any} [detail] */
  constructor(code, message, detail) {
    super(`import: ${message}`);
    this.name = 'ImportError';
    this.code = code;
    this.detail = detail;
  }
}

const pad3 = (n) => String(n).padStart(3, '0');
const stagingDir = (exportId) => `staging/${exportId}/`;
const volumeDir = (exportId, volume) => `staging/${exportId}/v${pad3(volume)}/`;

function safePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

async function readWholeEntry(read, entry, limit) {
  if (entry.size > limit) throw new ImportError('bad-volume', `${entry.name} is too large`);
  const out = new Uint8Array(entry.size);
  let o = 0;
  for await (const c of readZipEntry(read, entry)) { out.set(c, o); o += c.length; }
  return out;
}

async function zipSha256(volume) {
  const h = createSha256();
  for (let o = 0; o < volume.size; o += 4 * CHUNK) {
    const u8 = await volume.read(o, Math.min(volume.size, o + 4 * CHUNK));
    h.update(u8);
  }
  return h.digestHex();
}

async function removeAll(store, prefix) {
  for (const p of await store.list(prefix)) await store.remove(p);
}

async function copyFile(store, from, to) {
  const r = await store.openRead(from);
  const w = await store.openWrite(to);
  try {
    for (let o = 0; o < r.size; o += CHUNK) await w.write(await r.read(o, Math.min(r.size, o + CHUNK)));
  } finally {
    await w.close();
  }
}

/** 空でない行の数（改行で数える。ファイル全体を読み込まない） */
async function countLines(store, path) {
  const r = await store.openRead(path);
  let n = 0;
  let lineHasContent = false;
  for (let o = 0; o < r.size; o += CHUNK) {
    const u8 = await r.read(o, Math.min(r.size, o + CHUNK));
    for (let i = 0; i < u8.length; i++) {
      const c = u8[i];
      if (c === 10) { if (lineHasContent) n++; lineHasContent = false; } else if (c !== 13 && c !== 32 && c !== 9) lineHasContent = true;
    }
  }
  return lineHasContent ? n + 1 : n;
}

// ---------------------------------------------------------------- 巻を受け取る

/**
 * 1 つの巻（ZIP）を受け取る（CONTRACTS.md 2.3）。
 * 1. ZIP の `manifest.json` を読み、`files[]` の大きさと SHA-256 を照合する（合わなければ ImportError 'bad-volume'。何も残さない）。
 * 2. `(exportId, volume)` がすでに受領済みなら、ZIP 全体のハッシュが同じなら何もせず `{status:'duplicate'}`、違えば ImportError 'conflicting-volume'。
 * 3. `staging/<exportId>/v<NNN>/` に展開し、受領の記録（receipts.json）に書く。
 * `<exportId>_index.json` を先に `receiveIndex` で渡してあれば、ZIP 全体のハッシュも照合する。
 * 統合は `commitIfComplete` が行う（この関数は統合しない）。
 * @param {import('./types.js').Store} store
 * @param {{name:string, read:(s:number,e:number)=>Promise<Uint8Array>, size:number}} volume
 * @param {{now?: () => string}} [opts] `now`：受領の時刻（ISO 8601）を返す関数。既定は現在時刻。結果の再現性には使わない
 * @returns {Promise<{status:'received'|'duplicate', exportId:string, volume:number, volumes:number}>}
 */
export async function receiveVolume(store, volume, opts) {
  const bad = (msg, detail, reason = 'unreadable') => new ImportError('bad-volume', `${volume.name || 'volume'}: ${msg}`, { ...detail, reason });
  let entries;
  try {
    entries = await readZipDirectory(volume.read, volume.size);
  } catch (e) {
    throw bad(`not a readable ZIP (${e.message})`);
  }
  for (const e of entries) if (!safePath(e.name)) throw bad(`unsafe entry name ${JSON.stringify(e.name)}`);
  const byName = new Map();
  for (const e of entries) {
    if (byName.has(e.name)) throw bad(`duplicate entry ${JSON.stringify(e.name)}`);
    byName.set(e.name, e);
  }
  const me = byName.get('manifest.json');
  if (!me) throw bad('manifest.json is missing');
  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(await readWholeEntry(volume.read, me, MAX_MANIFEST_BYTES)));
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw bad(`manifest.json is not readable (${e.message})`);
  }
  const vr = validate('manifest', manifest);
  if (!vr.ok) throw bad(`manifest.json is invalid: ${vr.errors.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`, { errors: vr.errors });
  if (manifest.volume > manifest.volumes) throw bad(`volume ${manifest.volume} is greater than volumes ${manifest.volumes}`);
  const listed = new Map();
  for (const f of manifest.files) {
    if (!safePath(f.path) || f.path === 'manifest.json') throw bad(`bad path in manifest.files: ${JSON.stringify(f.path)}`);
    if (listed.has(f.path)) throw bad(`duplicate path in manifest.files: ${f.path}`);
    listed.set(f.path, f);
  }
  for (const name of byName.keys()) if (name !== 'manifest.json' && !listed.has(name)) throw bad(`${name} is not listed in manifest.files`);
  for (const p of listed.keys()) if (!byName.has(p)) throw bad(`${p} is listed in manifest.files but missing from the ZIP`);

  const { exportId } = manifest;
  const zipHash = await zipSha256(volume);
  const receipts = (await store.readJson(RECEIPTS)) ?? [];
  const same = receipts.filter((r) => r.exportId === exportId);
  const existing = same.find((r) => r.volume === manifest.volume);
  if (existing) {
    if (existing.zipSha256 === zipHash) return { status: 'duplicate', exportId, volume: manifest.volume, volumes: manifest.volumes };
    throw new ImportError('conflicting-volume', `volume ${manifest.volume} of ${exportId} was already received with different content`, { exportId, volume: manifest.volume });
  }
  for (const r of same) {
    for (const k of ['volumes', 'projectId', 'sessionId', 'kind', 'scriptHash']) {
      if (r[k] !== manifest[k]) throw bad(`${k} differs from the other volumes of ${exportId}`, { key: k });
    }
  }
  const index = await store.readJson(`${stagingDir(exportId)}index.json`);
  if (index) {
    const z = (index.zips || []).find((x) => x.volume === manifest.volume);
    if (z && z.sha256 !== zipHash) throw bad(`ZIP hash differs from the index (${exportId}_index.json)`, { expected: z.sha256, actual: zipHash }, 'hash-mismatch');
  }

  // 展開しながら、大きさと SHA-256 を照合する
  const dir = volumeDir(exportId, manifest.volume);
  const written = [];
  try {
    for (const e of entries) {
      const target = dir + e.name;
      const w = await store.openWrite(target);
      written.push(target);
      const h = createSha256();
      let n = 0;
      try {
        for await (const c of readZipEntry(volume.read, e, { chunkBytes: CHUNK })) {
          h.update(c);
          n += c.length;
          await w.write(c);
        }
      } finally {
        await w.close();
      }
      if (e.name === 'manifest.json') continue;
      const f = listed.get(e.name);
      if (n !== f.bytes) throw bad(`${e.name}: size ${n} differs from the manifest (${f.bytes})`, { path: e.name }, 'hash-mismatch');
      if (h.digestHex() !== f.sha256) throw bad(`${e.name}: SHA-256 differs from the manifest`, { path: e.name }, 'hash-mismatch');
    }
  } catch (err) {
    for (const p of written) { try { await store.remove(p); } catch { /* 後始末 */ } }
    if (err instanceof ImportError) throw err;
    throw bad(`cannot read the ZIP (${err.message})`);
  }
  const now = opts && opts.now ? opts.now() : new Date().toISOString();
  receipts.push({
    exportId, volume: manifest.volume, volumes: manifest.volumes, zipSha256: zipHash, receivedAt: now,
    projectId: manifest.projectId, sessionId: manifest.sessionId, kind: manifest.kind, scriptHash: manifest.scriptHash,
  });
  await store.writeJson(RECEIPTS, receipts);
  return { status: 'received', exportId, volume: manifest.volume, volumes: manifest.volumes };
}

/**
 * `<exportId>_index.json`（schema/index）の中身を受け取る。任意。受領済みの巻の ZIP 全体のハッシュと照合し、
 * 合わなければ ImportError 'index-mismatch'（索引は置かない）。置いた索引は、あとから届く巻の照合にも使われる。
 * すでに統合した書き出しの索引は何もしない。
 * @param {import('./types.js').Store} store
 * @param {any} index
 * @returns {Promise<{status:'stored'|'ignored', exportId:string}>}
 */
export async function receiveIndex(store, index) {
  const r = validate('index', index);
  if (!r.ok) throw new ImportError('index-mismatch', `index is invalid: ${r.errors.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`, r.errors);
  const vols = new Set();
  for (const z of index.zips) {
    if (vols.has(z.volume) || z.volume > index.volumes) throw new ImportError('index-mismatch', `index lists volume ${z.volume} twice or beyond volumes`);
    vols.add(z.volume);
  }
  const receipts = (await store.readJson(RECEIPTS)) ?? [];
  const mine = receipts.filter((x) => x.exportId === index.exportId);
  if (mine.length && (await store.exists(`sessions/${mine[0].sessionId}/session.json`))) {
    const s = await store.readJson(`sessions/${mine[0].sessionId}/session.json`);
    if (s && s.exports.some((e) => e.exportId === index.exportId)) return { status: 'ignored', exportId: index.exportId };
  }
  for (const x of mine) {
    const z = index.zips.find((q) => q.volume === x.volume);
    if (x.volumes !== index.volumes || (z && z.sha256 !== x.zipSha256)) {
      throw new ImportError('index-mismatch', `the received volume ${x.volume} of ${index.exportId} does not match the index`, { exportId: index.exportId, volume: x.volume });
    }
  }
  await store.writeJson(`${stagingDir(index.exportId)}index.json`, index);
  return { status: 'stored', exportId: index.exportId };
}

// ---------------------------------------------------------------- 統合

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortBy = (arr, key) => [...arr].sort((a, b) => cmpStr(key(a), key(b)));
const uniqBy = (arr, key) => { const m = new Map(); for (const x of arr) m.set(key(x), x); return [...m.values()]; };
const plain = (o) => JSON.parse(canonicalJson(o)); // キーを辞書順にそろえた複製（保存する内容を、挿入順によらず同じにする）

function emptySession(sessionId, projectId, scriptHash) {
  return {
    format: 'lap-narrator/session', version: 1, sessionId, projectId, scriptHash,
    exports: [], script: null, rawFiles: [], events: null, edits: null, finals: [], staleSlides: null, variants: {},
  };
}

/** 巻の manifest から、書き出し 1 つ分の情報を作る。矛盾があれば ImportError 'inconsistent-export' */
function describeExport(manifests) {
  const bad = (msg) => new ImportError('inconsistent-export', msg);
  const m1 = manifests[0];
  const files = new Map();
  const raws = new Map();
  const finals = new Map();
  for (const m of manifests) {
    for (const k of ['exportId', 'kind', 'projectId', 'sessionId', 'scriptHash', 'volumes']) {
      if (m[k] !== m1[k]) throw bad(`volumes of ${m1.exportId} disagree on ${k}`);
    }
    if ((m.renderSpec?.preserveFileRotations === true) !== (m1.renderSpec?.preserveFileRotations === true)) {
      throw bad(`volumes of ${m1.exportId} disagree on preserveFileRotations`);
    }
    for (const f of m.files) {
      const prev = files.get(f.path);
      if (prev && prev.sha256 !== f.sha256) throw bad(`${f.path} differs between volumes`);
      files.set(f.path, { ...f, volume: m.volume });
    }
    for (const r of m.rawFiles || []) {
      const name = r.file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
      const prev = raws.get(name);
      if (prev && prev.sha256 !== r.sha256) throw bad(`raw file ${name} differs between volumes`);
      raws.set(name, { file: name, sampleRate: r.sampleRate, samples: r.samples, sha256: r.sha256, ...(r.durableSamples !== undefined ? { durableSamples: r.durableSamples } : {}) });
    }
    for (const f of m.finals || []) {
      const key = `${f.slideId}/${f.takeId}`;
      if (finals.has(key) && canonicalJson(finals.get(key)) !== canonicalJson(f)) throw bad(`final ${key} differs between volumes`);
      finals.set(key, f);
    }
  }
  const finalList = sortBy([...finals.values()], (f) => f.slideId);
  if (new Set(finalList.map((f) => f.slideId)).size !== finalList.length) throw bad('more than one final for a slide in one export');
  const info = { exportId: m1.exportId, kind: m1.kind, volumes: m1.volumes, projectId: m1.projectId, sessionId: m1.sessionId, scriptHash: m1.scriptHash, createdAt: m1.createdAt, files, raws, finals: finalList, renderSpec: m1.renderSpec, recording: m1.recording, manifestEditVersion: Number.isInteger(m1.editVersion) ? m1.editVersion : (m1.renderSpec && Number.isInteger(m1.renderSpec.editVersion) ? m1.renderSpec.editVersion : null) };
  if (!files.has('script.json')) throw bad('script.json is missing');
  if (m1.kind === 'full') {
    for (const need of ['events.jsonl', 'segments.json', 'edits.json']) if (!files.has(need)) throw bad(`${need} is missing`);
    for (const r of raws.values()) {
      const f = files.get(`raw/${r.file}.wav`);
      if (!f || f.sha256 !== r.sha256) throw bad(`raw/${r.file}.wav is missing or differs from manifest.rawFiles`);
    }
  } else {
    for (const f of finalList) {
      for (const p of f.parts) {
        const x = files.get(p.file);
        if (!x || x.sha256 !== p.sha256) throw bad(`${p.file} is missing or differs from manifest.finals`);
      }
    }
  }
  return info;
}

/**
 * すべての巻がそろっていれば、`staging/<exportId>/` を `sessions/<sessionId>/` に統合する（CONTRACTS.md 2.3）。
 * 何度呼んでも、どの順で取り込んでも、`sessions/` の中身は同じになる（冒頭の説明を見よ）。
 * - 巻が欠けていれば `{committed:false, missing:[巻の番号]}`。
 * - 索引（receiveIndex）があり、ZIP 全体のハッシュが合わなければ ImportError 'index-mismatch'（統合しない）。
 * - 巻どうしの内容が食い違う、必要なファイルが無い、は ImportError 'inconsistent-export'（統合しない）。
 * - すでに統合済みなら `{committed:true, sessionId, missing:[]}`（何もしない）。
 * - 作業場の `script.json` があり、`scriptHash` が違えば、セッションの台本と比べて `staleSlides`（textHash が違う、または片方にしかないスライド）を記録する。
 * @param {import('./types.js').Store} store
 * @param {string} exportId
 * @returns {Promise<{committed:boolean, sessionId?:string, missing:number[]}>}
 */
export async function commitIfComplete(store, exportId) {
  const receipts = (await store.readJson(RECEIPTS)) ?? [];
  const mine = receipts.filter((r) => r.exportId === exportId);
  if (!mine.length) return { committed: false, missing: [] };
  const total = mine[0].volumes;
  const have = new Set(mine.map((r) => r.volume));
  const missing = [];
  for (let v = 1; v <= total; v++) if (!have.has(v)) missing.push(v);
  if (missing.length) return { committed: false, missing };
  const sessionId = mine[0].sessionId;
  const sdir = `sessions/${sessionId}/`;
  const existing = await store.readJson(`${sdir}session.json`);
  if (existing && existing.exports.some((e) => e.exportId === exportId)) {
    await removeAll(store, stagingDir(exportId));
    return { committed: true, sessionId, missing: [] };
  }
  const index = await store.readJson(`${stagingDir(exportId)}index.json`);
  if (index) {
    if (index.volumes !== total) throw new ImportError('index-mismatch', `index says ${index.volumes} volumes, received ${total}`);
    for (const r of mine) {
      const z = index.zips.find((q) => q.volume === r.volume);
      if (!z || z.sha256 !== r.zipSha256) throw new ImportError('index-mismatch', `volume ${r.volume} of ${exportId} does not match the index`);
    }
  }
  const manifests = [];
  for (let v = 1; v <= total; v++) {
    const m = await store.readJson(`${volumeDir(exportId, v)}manifest.json`);
    if (!m) throw new ImportError('inconsistent-export', `staging for volume ${v} of ${exportId} is missing`);
    manifests.push(m);
  }
  const info = describeExport(manifests);
  const src = (p) => `${volumeDir(exportId, info.files.get(p).volume)}${p}`;

  const s = existing ? JSON.parse(JSON.stringify(existing)) : emptySession(sessionId, info.projectId, info.scriptHash);
  const variants = s.variants || {};
  const copies = []; // [from, to]

  /** 食い違った版の一覧（variants）に、版を足す。勝者はすでに一覧に入っているものとして扱う */
  const noteVariant = (group, name, winner, candidate, keyOf) => {
    const holder = name === null ? variants : (variants[group] = variants[group] || {});
    const slot = name === null ? group : name;
    const list = holder[slot] || (winner ? [winner] : []);
    holder[slot] = sortBy(uniqBy([...list, candidate], keyOf), (x) => canonicalJson(x));
  };

  // 同じセッションの別の書き出しとの食い違い
  if (s.projectId !== info.projectId) {
    noteVariant('projectId', null, s.projectId, info.projectId, (x) => x);
    if (info.projectId < s.projectId) s.projectId = info.projectId;
  }

  // 書き出しの記録
  const editsFile = info.kind === 'full' ? await store.readJson(src('edits.json')) : null;
  const editVersion = info.kind === 'full'
    ? (editsFile && Number.isInteger(editsFile.editVersion) ? editsFile.editVersion : null)
    : info.manifestEditVersion;
  const entry = { exportId, kind: info.kind, volumes: info.volumes, createdAt: info.createdAt, scriptHash: info.scriptHash, editVersion, ...(info.recording !== undefined ? { recording: info.recording } : {}) };
  if (info.kind === 'full' && info.renderSpec?.preserveFileRotations === true) entry.preserveFileRotations = true;
  s.exports = sortBy([...s.exports, entry], (e) => e.exportId);

  // 台本
  let scriptSource = `${sdir}script.json`;
  {
    const f = info.files.get('script.json');
    const cand = { scriptHash: info.scriptHash, sha256: f.sha256 };
    const key = (x) => `${x.scriptHash}:${x.sha256}`;
    if (s.script && key(s.script) !== key(cand)) noteVariant('script', null, s.script, cand, key);
    if (!s.script || cmpStr(key(cand), key(s.script)) < 0) {
      s.script = cand;
      s.scriptHash = cand.scriptHash;
      scriptSource = src('script.json');
      copies.push([scriptSource, `${sdir}script.json`]);
    }
  }

  if (info.kind === 'full') {
    // 録音ファイル
    const cur = new Map(s.rawFiles.map((r) => [r.file, r]));
    for (const r of info.raws.values()) {
      const old = cur.get(r.file);
      if (old && old.sha256 === r.sha256) continue;
      if (old) noteVariant('raw', r.file, { sha256: old.sha256, samples: old.samples }, { sha256: r.sha256, samples: r.samples }, (x) => x.sha256);
      if (!old || r.samples > old.samples || (r.samples === old.samples && cmpStr(r.sha256, old.sha256) < 0)) {
        cur.set(r.file, r);
        copies.push([src(`raw/${r.file}.wav`), `${sdir}raw/${r.file}.wav`]);
      }
    }
    s.rawFiles = sortBy([...cur.values()], (r) => r.file);
    // 操作記録と区間の一覧（対）
    const ev = info.files.get('events.jsonl');
    const sg = info.files.get('segments.json');
    const candEv = { count: await countLines(store, src('events.jsonl')), sha256: ev.sha256, segmentsSha256: sg.sha256 };
    const evKey = (x) => `${x.sha256}:${x.segmentsSha256}`;
    if (!s.events || evKey(s.events) !== evKey(candEv)) {
      if (s.events) noteVariant('events', null, { count: s.events.count, sha256: s.events.sha256 }, { count: candEv.count, sha256: candEv.sha256 }, (x) => x.sha256);
      if (!s.events || candEv.count > s.events.count || (candEv.count === s.events.count && cmpStr(evKey(candEv), evKey(s.events)) < 0)) {
        s.events = candEv;
        copies.push([src('events.jsonl'), `${sdir}events.jsonl`], [src('segments.json'), `${sdir}segments.json`]);
      }
    }
    // 編集の記録
    const ed = info.files.get('edits.json');
    const candEd = { editVersion: editVersion ?? 0, sha256: ed.sha256 };
    if (!s.edits || s.edits.sha256 !== candEd.sha256) {
      if (s.edits) noteVariant('edits', null, s.edits, candEd, (x) => x.sha256);
      if (!s.edits || candEd.editVersion > s.edits.editVersion || (candEd.editVersion === s.edits.editVersion && cmpStr(candEd.sha256, s.edits.sha256) < 0)) {
        s.edits = candEd;
        copies.push([src('edits.json'), `${sdir}edits.json`]);
      }
    }
  } else {
    // 完成版：音声を残し、一覧を session.json に書く
    const fin = {
      exportId, editVersion, createdAt: info.createdAt,
      ...(info.renderSpec ? { renderSpec: info.renderSpec } : {}),
      slides: info.finals.map((f) => ({
        slideId: f.slideId, takeId: f.takeId, samples: f.samples, sampleRate: f.sampleRate,
        parts: f.parts.map((p) => ({ file: p.file, samples: p.samples, sha256: p.sha256 })),
        ...(f.applied ? { applied: f.applied } : {}),
      })),
    };
    for (const f of info.finals) for (const p of f.parts) copies.push([src(p.file), `${sdir}finals/${exportId}/${p.file}`]);
    s.finals = sortBy([...s.finals.filter((x) => x.exportId !== exportId), fin], (x) => x.exportId);
  }

  // 完成版の役割：全記録の編集の版と同じなら検証にだけ使う。違う（または全記録が無い）なら採用の候補
  const fullEdit = s.edits ? s.edits.editVersion : null;
  for (const f of s.finals) f.role = fullEdit !== null && f.editVersion !== null && f.editVersion === fullEdit ? 'verify-only' : 'candidate';

  // 台本の版の食い違い（作業場の台本があるとき）
  const ws = await store.readJson('script.json');
  s.staleSlides = null;
  if (ws && Array.isArray(ws.slides) && s.script) {
    if (ws.scriptHash === s.script.scriptHash) s.staleSlides = [];
    else {
      const ss = await store.readJson(scriptSource);
      const a = new Map(((ss && ss.slides) || []).map((x) => [x.slideId, x.textHash]));
      const b = new Map(ws.slides.map((x) => [x.slideId, x.textHash]));
      const ids = new Set([...a.keys(), ...b.keys()]);
      s.staleSlides = sortBy([...ids].filter((id) => a.get(id) !== b.get(id)), (x) => x);
    }
  }

  // 保存：ファイルを先に、session.json を最後に（これが確定の印）。そのあとで staging を消す
  for (const [from, to] of copies) await copyFile(store, from, to);
  s.variants = variants;
  await store.writeJson(`${sdir}session.json`, plain(s));
  await removeAll(store, stagingDir(exportId));
  return { committed: true, sessionId, missing: [] };
}
