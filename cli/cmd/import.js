// import：完成版 zip／全記録 zip（複数の巻）と索引を取り込む（設計書 5.1、6.6、CONTRACTS.md 2.3、3.2、7.4）。
// 取り込みの規則は core（receiveIndex、receiveVolume、commitIfComplete）。このコマンドは、引数の整理と、結果の整形だけをする。
//   narrate import <zip|index.json|folder>... --workspace <dir> [--script <script-pack.zip>]
// 索引（*_index.json）は先に渡す。巻は届く順でよい（順不同、再送、巻の欠けは core が扱う）。
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { receiveVolume, receiveIndex, commitIfComplete, ImportError } from '../../core/index.js';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { openFileVolume } from '../lib/fsutil.js';
import { createFsStore } from '../lib/store.js';
import { installPack, looksLikeScriptPack } from '../lib/scriptpack.js';
import { isContinuousScript, materializeContinuousAudio, recordingOf } from '../lib/continuous.js';
import { prepareWavImport } from '../lib/import-wav.js';

export const options = { script: 'string', audio: 'string' };

const HASH_PROBLEM = /SHA-256 differs|size \d+ differs|ZIP hash differs/;

/** ImportError の終了コード：ハッシュなどの不一致は 3、壊れた ZIP などの入力の不備は 1 */
export function importErrorExit(err) {
  if (err.code === 'conflicting-volume' || err.code === 'index-mismatch' || err.code === 'inconsistent-export') return EXIT.MISMATCH;
  if (err.code === 'bad-volume' && HASH_PROBLEM.test(err.message)) return EXIT.MISMATCH;
  return EXIT.FAIL;
}

async function expand(args) {
  const files = [];
  for (const a of args) {
    const abs = path.resolve(a);
    let st;
    try { st = await fsp.stat(abs); } catch { files.push({ abs, missing: true }); continue; }
    if (st.isDirectory()) {
      const names = (await fsp.readdir(abs)).filter((n) => /\.zip$/i.test(n) || /_index\.json$/i.test(n)).sort();
      for (const n of names) files.push({ abs: path.join(abs, n) });
    } else files.push({ abs });
  }
  return files;
}

export async function run({ ctx, opts, positionals, workspace }) {
  if (!workspace) throw usageError('--workspace is required');
  if (opts.audio !== undefined) {
    if (positionals.length) throw usageError('--audio cannot be combined with archive or folder arguments');
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'narrate-wav-'));
    try {
      const { zipPath, info } = await prepareWavImport(path.resolve(opts.audio), temp);
      const imported = await importArchives({ ctx, opts, positionals: [zipPath], workspace });
      return { ...imported, result: { ...imported.result, audioIntake: info } };
    } finally {
      for (const file of await fsp.readdir(temp)) await fsp.unlink(path.join(temp, file));
      await fsp.rmdir(temp);
    }
  }
  return importArchives({ ctx, opts, positionals, workspace });
}

async function importArchives({ ctx, opts, positionals, workspace }) {
  if (positionals.length === 0 && !opts.script) throw usageError('give at least one zip (or --script <script-pack.zip>)');
  await fsp.mkdir(workspace, { recursive: true });
  const store = createFsStore(workspace);
  const errors = [];
  let scriptInfo = null;

  const files = await expand(positionals);
  const scriptPacks = [];
  if (opts.script) scriptPacks.push(path.resolve(opts.script));
  const zips = [];
  const indexes = [];
  for (const f of files) {
    if (f.missing) { errors.push({ code: 'cannot-read', message: `no such file: ${f.abs}`, detail: { file: f.abs }, _exit: EXIT.FAIL }); continue; }
    if (/\.json$/i.test(f.abs)) { indexes.push(f); continue; }
    if (await looksLikeScriptPack(f.abs)) { scriptPacks.push(f.abs); continue; }
    zips.push(f);
  }
  if (scriptPacks.length > 1) throw usageError('more than one script pack was given');
  if (scriptPacks.length === 1) {
    const r = await installPack(store, scriptPacks[0]);
    scriptInfo = { projectId: r.script.projectId, scriptHash: r.script.scriptHash, slides: r.script.slides.length };
    if (r.replaced) ctx.warn('script-replaced', 'the workspace script was replaced by a different version; recorded takes whose text changed are reported as stale', r.replaced);
  }

  const total = indexes.length + zips.length;
  let done = 0;
  const received = [];
  const duplicates = [];
  const touched = new Map(); // exportId -> {newVolume:boolean}
  const note = (exportId, isNew) => { const t = touched.get(exportId) || { isNew: false }; t.isNew = t.isNew || isNew; touched.set(exportId, t); };
  const fail = (err, file) => {
    if (err instanceof ImportError) errors.push({ code: err.code, message: err.message, detail: { file, ...(err.detail && typeof err.detail === 'object' && !Array.isArray(err.detail) ? err.detail : {}) }, _exit: importErrorExit(err) });
    else errors.push({ code: err.code && typeof err.code === 'string' && !/^E[A-Z]+$/.test(err.code) ? err.code : 'cannot-read', message: `${path.basename(file)}: ${err.message}`, detail: { file }, _exit: EXIT.FAIL });
  };

  // 索引を先に（そのあとに届く巻のハッシュを照合できる）
  for (const f of indexes) {
    ctx.progress('import', done++, total);
    try {
      let idx;
      try { idx = JSON.parse((await fsp.readFile(f.abs, 'utf8')).replace(/^﻿/, '')); } catch (e) { throw new CliError('cannot-read', `${path.basename(f.abs)} is not readable JSON (${e.message})`); }
      if (!idx || idx.format !== 'lap-narrator/index') throw usageError(`${path.basename(f.abs)} is not an index (<exportId>_index.json) file`);
      const r = await receiveIndex(store, idx);
      if (r.status === 'stored') note(idx.exportId, false);
    } catch (e) {
      if (e instanceof CliError && e.exit === EXIT.USAGE) throw e;
      fail(e, f.abs);
    }
  }
  for (const f of zips) {
    ctx.progress('import', done++, total);
    let vol;
    try {
      vol = await openFileVolume(f.abs);
      const r = await receiveVolume(store, vol);
      note(r.exportId, r.status === 'received');
      (r.status === 'received' ? received : duplicates).push({ exportId: r.exportId, volume: r.volume, volumes: r.volumes, file: path.basename(f.abs) });
    } catch (e) {
      fail(e, f.abs);
    } finally {
      if (vol) await vol.close();
    }
  }
  ctx.progress('import', total, total);

  // 受け取った書き出しごとに、そろっていれば統合する
  const committed = [];
  const unchanged = [];
  const pending = [];
  const sessionIds = new Set();
  for (const exportId of [...touched.keys()].sort()) {
    const t = touched.get(exportId);
    try {
      const r = await commitIfComplete(store, exportId);
      if (r.committed) {
        sessionIds.add(r.sessionId);
        if (t.isNew) { if (!committed.includes(r.sessionId)) committed.push(r.sessionId); } else if (!unchanged.includes(r.sessionId)) unchanged.push(r.sessionId);
      } else if (r.missing.length) {
        pending.push({ exportId, missing: r.missing });
        ctx.warn('volumes-missing', `export ${exportId} is waiting for volume(s) ${r.missing.join(', ')}`, { exportId, missing: r.missing });
      }
    } catch (e) {
      fail(e, exportId);
    }
  }

  // 台本の版の食い違い（文のハッシュが合わないスライド）を知らせる
  const ws = await store.readJson('script.json');
  const continuousSessions = [];
  for (const sid of [...sessionIds].sort()) {
    const s = await store.readJson(`sessions/${sid}/session.json`);
    if (!s) continue;
    // 通しで録った書き出し（台本が 1 枚だけ）は、作業場の台本と食い違って当然。拒否も、台本の版の食い違いの警告もしない（切れ目で切って使う）
    const sscript = await store.readJson(`sessions/${sid}/script.json`);
    if (ws && isContinuousScript(sscript, ws, recordingOf(s))) {
      const slide = sscript.slides.find((x) => x.recordable === true);
      continuousSessions.push({ sessionId: sid, slideId: slide.slideId });
      ctx.warn('continuous-recording', `session ${sid} is one continuous recording (script of a single slide); it is cut into slides with boundaries: transcribe -> align -> render --boundaries`, { sessionId: sid, slideId: slide.slideId });
      continue;
    }
    if (Array.isArray(s.staleSlides) && s.staleSlides.length) {
      ctx.warn('stale-slides', `session ${sid} was recorded with a different script; ${s.staleSlides.length} slide(s) have different text`, { sessionId: sid, staleSlides: s.staleSlides });
    }
    if (ws && s.projectId !== ws.projectId) ctx.warn('project-mismatch', `session ${sid} belongs to project ${s.projectId}, the workspace script is ${ws.projectId}`, { sessionId: sid });
    if (s.variants && Object.keys(s.variants).length) ctx.warn('variants', `session ${sid} has differing versions of ${Object.keys(s.variants).sort().join(', ')} (the larger/newer one is used; the rest are listed in session.json)`, { sessionId: sid });
  }
  // 通しの書き出しがあれば、通しの完成音声を <workspace>/final/all.wav に書く（transcribe がこれを読む。中身は render が照合する SHA-256 の音声そのもの）
  let continuousAudio = null;
  if (continuousSessions.length) {
    try {
      const m = await materializeContinuousAudio(store, ws);
      continuousAudio = { file: m.file, sha256: m.sha256, samples: m.samples, sampleRate: m.sampleRate, sessionId: m.sessionId, takeId: m.takeId };
    } catch (e) {
      ctx.warn('continuous-audio-not-written', `final/all.wav was not written (${e.message}); it is made again by render, but transcribe needs it`, { code: e.code || 'error' });
    }
  }
  if (!ws && zips.length) ctx.warn('no-script', 'the workspace has no script; pass the script pack with --script so that status and render can match slides');

  const result = {
    received, duplicates, committed, unchanged, pending,
    ...(continuousSessions.length ? { continuous: continuousSessions, ...(continuousAudio ? { continuousAudio } : {}) } : {}),
    warnings: ctx.warnings,
    ...(scriptInfo ? { script: scriptInfo } : {}),
  };
  const outErrors = errors.map(({ _exit, ...e }) => e);
  if (errors.length) {
    const exit = errors.some((e) => e._exit === EXIT.MISMATCH) ? EXIT.MISMATCH : EXIT.FAIL;
    return { result, errors: outErrors, exit };
  }
  return { result };
}
