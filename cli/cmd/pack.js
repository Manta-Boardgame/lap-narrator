// pack：台本パック（script.json と slides/）を作る（設計書 5.1、CONTRACTS.md 1.1、3.2）。
//   --from-json <dir|file>                  台本の元データ（script.json）と画像
//   --from-markdown <file> --images <dir>   Markdown の台本と画像
//   --from-pptx <pptx>                      builder/export-slides.ps1 でノートと絵を取り出す（PowerPoint が要る）
// textHash と scriptHash は core の関数で計算する。projectId は指定がなければ内容から決定的に作る。
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkScript } from '../../core/index.js';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { intOption, requireOption } from '../lib/args.js';
import { assembleScript, derivedProjectId, isPng, isValidProjectId, isValidSlideId, pad4, writePackZip } from '../lib/scriptpack.js';
import { builderDir, powershellCommand, runProcess, tail, toolExists } from '../lib/exec.js';

export const options = {
  'from-json': 'string', 'from-markdown': 'string', 'from-pptx': 'string', images: 'string', out: 'string',
  'project-id': 'string', title: 'string', 'work-dir': 'string', 'timeout-sec': 'string',
};

const insideDir = (dir, p) => { const r = path.relative(dir, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

async function readIfFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? new Uint8Array(await fsp.readFile(p)) : null;
  } catch { return null; }
}

async function loadPng(abs, label) {
  const data = await readIfFile(abs);
  if (!data) return null;
  if (!isPng(data)) throw new CliError('unsupported-image', `${label}: ${abs} is not a PNG file`);
  return data;
}

/** スライドの画像を探す：明示の指定、次に NNNN.png などの規則 */
async function findImage(dir, slide, order, explicit, warnings) {
  const tries = [];
  if (explicit) {
    const abs = path.resolve(dir, explicit);
    if (!insideDir(dir, abs)) throw new CliError('bad-image-path', `image path leaves the image folder: ${explicit}`);
    tries.push(abs);
  }
  for (const n of [`slides/${pad4(order)}.png`, `${pad4(order)}.png`, `${order}.png`, `slides/${order}.png`, `${slide.slideId}.png`, `slides/${slide.slideId}.png`]) tries.push(path.join(dir, n));
  for (const abs of tries) {
    const data = await loadPng(abs, slide.slideId);
    if (data) return data;
  }
  warnings.push({ code: 'image-missing', message: `no picture found for slide ${slide.slideId} (order ${order}) in ${dir}` });
  return null;
}

function normalizeText(s) {
  return String(s).replace(/\r\n?/g, '\n').trim();
}

const defaultRecordable = (text) => text.trim() !== '';

/** 元データの JSON から、正規化したスライドの並びを作る */
function slidesFromJson(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.slides) || doc.slides.length === 0) throw new CliError('bad-input', 'script.json needs a non-empty "slides" array');
  let list = doc.slides.map((s, i) => ({ s, i }));
  if (list.every(({ s }) => s && Number.isInteger(s.order))) list = list.sort((a, b) => (a.s.order - b.s.order) || (a.i - b.i));
  return list.map(({ s }, idx) => {
    if (!s || typeof s !== 'object' || typeof s.text !== 'string') throw new CliError('bad-input', `slide ${idx + 1}: "text" must be a string`);
    const text = normalizeText(s.text);
    const slideId = s.slideId !== undefined ? s.slideId : `s${pad4(idx + 1)}`;
    if (typeof slideId !== 'string' || !isValidSlideId(slideId)) throw new CliError('bad-input', `slide ${idx + 1}: bad slideId ${JSON.stringify(slideId)}`);
    const out = { slideId, text, recordable: s.recordable !== undefined ? s.recordable : defaultRecordable(text), image: s.image };
    if (typeof out.recordable !== 'boolean') throw new CliError('bad-input', `slide ${slideId}: "recordable" must be true or false`);
    if (s.title !== undefined) { if (typeof s.title !== 'string') throw new CliError('bad-input', `slide ${slideId}: "title" must be a string`); out.title = s.title; }
    if (s.speaker !== undefined) { if (typeof s.speaker !== 'string') throw new CliError('bad-input', `slide ${slideId}: "speaker" must be a string`); out.speaker = s.speaker; }
    if (s.targetSec !== undefined) { if (typeof s.targetSec !== 'number' || !(s.targetSec >= 0)) throw new CliError('bad-input', `slide ${slideId}: "targetSec" must be a number >= 0`); out.targetSec = s.targetSec; }
    return out;
  });
}

/**
 * Markdown の台本を読む。形：
 *   # 題名                       （最初の見出し 1 つ。省略できる）
 *   ## スライドの題名             （## ごとに 1 枚）
 *   <!-- speaker: 名前; targetSec: 20; id: s10; recordable: false; image: a.png -->   （任意。1 行に複数、複数行でもよい）
 *   読む文（空行は段落の区切り）
 */
export function parseMarkdownScript(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let title;
  const slides = [];
  let cur = null;
  for (const line of lines) {
    let m;
    if (!cur && (m = /^#\s+(.*\S)\s*$/.exec(line))) { if (title === undefined) title = m[1]; continue; }
    if ((m = /^##\s+(.*?)\s*$/.exec(line))) { cur = { title: m[1], meta: {}, lines: [] }; slides.push(cur); continue; }
    if (!cur) continue;
    if ((m = /^\s*<!--(.*)-->\s*$/.exec(line))) {
      for (const part of m[1].split(';')) {
        const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(part);
        if (kv) cur.meta[kv[1].toLowerCase()] = kv[2];
      }
      continue;
    }
    cur.lines.push(line);
  }
  if (slides.length === 0) throw new CliError('bad-input', 'the Markdown file has no "## " slide headings');
  const out = slides.map((s, idx) => {
    const body = normalizeText(s.lines.join('\n')).replace(/\n{3,}/g, '\n\n');
    const meta = s.meta;
    const slideId = meta.id || meta.slideid || `s${pad4(idx + 1)}`;
    if (!isValidSlideId(slideId)) throw new CliError('bad-input', `slide ${idx + 1}: bad id ${JSON.stringify(slideId)}`);
    const o = { slideId, title: s.title, text: body, recordable: defaultRecordable(body), image: meta.image };
    if (meta.recordable !== undefined) {
      if (meta.recordable !== 'true' && meta.recordable !== 'false') throw new CliError('bad-input', `slide ${slideId}: recordable must be true or false`);
      o.recordable = meta.recordable === 'true';
    }
    if (meta.speaker !== undefined) o.speaker = meta.speaker;
    if (meta.targetsec !== undefined) {
      const n = Number(meta.targetsec);
      if (!Number.isFinite(n) || n < 0) throw new CliError('bad-input', `slide ${slideId}: targetSec must be a number >= 0`);
      o.targetSec = n;
    }
    return o;
  });
  return { title, slides: out };
}

async function exportPptx(ctx, pptxAbs, opts) {
  const dir = builderDir();
  const script = path.join(dir, 'export-slides.ps1');
  if (!toolExists(script)) throw new CliError('tool-missing', `export-slides.ps1 not found: ${script}`);
  let work;
  let temp = false;
  if (opts['work-dir']) { work = path.resolve(opts['work-dir']); await fsp.mkdir(work, { recursive: true }); } else { work = await fsp.mkdtemp(path.join(os.tmpdir(), 'narrate-pack-')); temp = true; }
  try {
    const copy = path.join(work, 'deck.pptx');
    await fsp.copyFile(pptxAbs, copy); // 元の pptx は開かない。コピーを渡す
    const outDir = path.join(work, 'export');
    ctx.progress('export-slides', 0, 1);
    const { cmd, args } = powershellCommand(script, ['-Pptx', copy, '-OutDir', outDir]);
    const r = await runProcess(cmd, args, { timeoutMs: intOption(opts, 'timeout-sec', 600, { min: 1 }) * 1000 });
    if (r.spawnError) throw new CliError('tool-missing', `cannot start PowerShell (${r.spawnError})`);
    if (r.timedOut) throw new CliError('powerpoint-timeout', 'export-slides.ps1 timed out', { detail: { stderr: tail(r.stderr) } });
    if (r.code === 10) throw new CliError('powerpoint-busy', 'PowerPoint has other presentations open; close them and try again (nothing was touched)', { detail: { exitCode: 10, stdout: tail(r.stdout, 500) } });
    if (r.code === 11) throw new CliError('powerpoint-timeout', 'export-slides.ps1 reported a timeout (exit 11)', { detail: { exitCode: 11, stdout: tail(r.stdout, 500) } });
    if (r.code !== 0) throw new CliError('export-failed', `export-slides.ps1 failed (exit ${r.code})`, { detail: { exitCode: r.code, stdout: tail(r.stdout), stderr: tail(r.stderr) } });
    ctx.progress('export-slides', 1, 1);
    let doc;
    try { doc = JSON.parse(await fsp.readFile(path.join(outDir, 'slides.json'), 'utf8')); } catch (e) {
      throw new CliError('export-failed', `slides.json was not written by export-slides.ps1 (${e.message})`);
    }
    if (!doc || doc.format !== 'lap-narrator/slides-export' || doc.version !== 1 || !Array.isArray(doc.slides) || doc.slides.length === 0) {
      throw new CliError('export-failed', 'slides.json has an unexpected shape');
    }
    for (const w of doc.warnings || []) ctx.warn(w.code || 'export-warning', w.message || String(w));
    // 画像とメモの読み取り（作業用のフォルダが消える前に、すべて読む）
    const slides = [];
    for (const s of doc.slides) {
      const text = normalizeText(s.notes || '');
      const png = await loadPng(path.join(outDir, s.image), `slide ${s.index}`);
      if (!png) throw new CliError('export-failed', `picture ${s.image} was not written by export-slides.ps1`);
      slides.push({
        slideId: `s${s.slideId}`, title: s.title || undefined, text, recordable: !s.hidden && text !== '', imageBytes: png,
        _hidden: !!s.hidden, _mediaShapes: s.mediaShapes || 0, _clickEffects: s.clickEffects || 0,
      });
    }
    return { slides, title: path.basename(pptxAbs, path.extname(pptxAbs)), hiddenCount: slides.filter((s) => s._hidden).length };
  } finally {
    if (temp) await fsp.rm(work, { recursive: true, force: true });
  }
}

export async function run({ ctx, opts }) {
  const sources = ['from-json', 'from-markdown', 'from-pptx'].filter((k) => opts[k] !== undefined);
  if (sources.length !== 1) throw usageError('give exactly one of --from-json, --from-markdown, --from-pptx');
  const outAbs = path.resolve(requireOption(opts, 'out'));
  if (opts['project-id'] !== undefined && !isValidProjectId(opts['project-id'])) throw new CliError('bad-input', '--project-id must match ^[A-Za-z0-9_-]{6,64}$');
  if (opts.images !== undefined && sources[0] !== 'from-markdown') throw usageError('--images is only for --from-markdown');
  const warnings = [];
  let title;
  let slides; // [{slideId, text, recordable, title?, speaker?, targetSec?, imageBytes?}]
  let projectId = opts['project-id'];

  if (sources[0] === 'from-json') {
    let src = path.resolve(opts['from-json']);
    let st;
    try { st = await fsp.stat(src); } catch { throw new CliError('cannot-read', `no such file or folder: ${src}`); }
    const dir = st.isDirectory() ? src : path.dirname(src);
    if (st.isDirectory()) src = path.join(src, 'script.json');
    let doc;
    try { doc = JSON.parse((await fsp.readFile(src, 'utf8')).replace(/^﻿/, '')); } catch (e) { throw new CliError('cannot-read', `cannot read ${src} (${e.message})`); }
    const list = slidesFromJson(doc);
    title = opts.title ?? (typeof doc.title === 'string' ? doc.title : path.basename(dir));
    if (projectId === undefined && typeof doc.projectId === 'string') {
      if (!isValidProjectId(doc.projectId)) throw new CliError('bad-input', 'script.json: projectId must match ^[A-Za-z0-9_-]{6,64}$');
      projectId = doc.projectId;
    }
    slides = [];
    for (let i = 0; i < list.length; i++) {
      const { image, ...rest } = list[i];
      const imageBytes = await findImage(dir, rest, i + 1, image, warnings);
      slides.push(imageBytes ? { ...rest, imageBytes } : rest);
    }
  } else if (sources[0] === 'from-markdown') {
    const mdPath = path.resolve(opts['from-markdown']);
    let text;
    try { text = await fsp.readFile(mdPath, 'utf8'); } catch (e) { throw new CliError('cannot-read', `cannot read ${mdPath} (${e.message})`); }
    const doc = parseMarkdownScript(text);
    title = opts.title ?? doc.title ?? path.basename(mdPath, path.extname(mdPath));
    const imgDir = opts.images ? path.resolve(opts.images) : null;
    if (!imgDir) warnings.push({ code: 'no-images-dir', message: 'no --images folder was given; the pack has no pictures' });
    slides = [];
    for (let i = 0; i < doc.slides.length; i++) {
      const { image, ...rest } = doc.slides[i];
      const imageBytes = imgDir ? await findImage(imgDir, rest, i + 1, image, warnings) : null;
      slides.push(imageBytes ? { ...rest, imageBytes } : rest);
    }
  } else {
    const pptxAbs = path.resolve(opts['from-pptx']);
    if (!(await readIfFile(pptxAbs))) throw new CliError('cannot-read', `no such file: ${pptxAbs}`);
    const r = await exportPptx(ctx, pptxAbs, opts);
    title = opts.title ?? r.title;
    slides = r.slides.map(({ _hidden, _mediaShapes, _clickEffects, ...s }) => s);
    r.slides.forEach((s) => {
      if (s._mediaShapes) warnings.push({ code: 'media-shapes', message: `slide ${s.slideId} already has ${s._mediaShapes} audio/video shape(s)` });
      if (s._clickEffects) warnings.push({ code: 'click-effects', message: `slide ${s.slideId} has ${s._clickEffects} animation(s) that wait for a click` });
    });
    if (r.hiddenCount) warnings.push({ code: 'hidden-slides', message: `${r.hiddenCount} hidden slide(s) are in the pack as recordable:false` });
  }

  const dup = slides.map((s) => s.slideId).filter((id, i, a) => a.indexOf(id) !== i);
  if (dup.length) throw new CliError('bad-input', `duplicate slideId: ${[...new Set(dup)].join(', ')}`);
  if (projectId === undefined) projectId = derivedProjectId(title, slides);
  const { script, images } = assembleScript({ title, projectId, slides });
  const chk = checkScript(script);
  if (!chk.ok) throw new CliError('bad-script', 'the assembled script is invalid', { exit: EXIT.MISMATCH, detail: { errors: chk.errors.slice(0, 20) } });
  if (!script.slides.some((s) => s.recordable)) warnings.push({ code: 'no-recordable-slides', message: 'no slide is recordable (all texts are empty or marked recordable:false)' });
  ctx.progress('pack', 0, 1);
  const written = await writePackZip(outAbs, script, images);
  ctx.progress('pack', 1, 1);
  for (const w of warnings) ctx.warn(w.code, w.message);
  return {
    result: {
      projectId, scriptHash: script.scriptHash, title: script.title, out: outAbs, bytes: written.bytes, sha256: written.sha256,
      slideCount: script.slides.length, recordableCount: script.slides.filter((s) => s.recordable).length,
      slides: script.slides.map((s) => ({ slideId: s.slideId, order: s.order, title: s.title, recordable: s.recordable, textHash: s.textHash, ...(s.image ? { image: s.image } : {}) })),
    },
  };
}
