// 試験の道具：CLI を同じプロセスの中で動かす／子プロセスで動かす、作業用フォルダ、見本のセッションの zip 化。
import { promises as fsp, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createZipWriter } from '../../../core/zip.js';
import { sha256Hex } from '../../../core/sha256.js';
import { stringifyJsonl } from '../../../core/json.js';
import { runCli } from '../../../cli/narrate.js';
import { renderSlidePng } from '../../../testgen/lib/png.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const EXAMPLES = path.join(ROOT, 'examples', 'sessions');
export const NARRATE = path.join(ROOT, 'cli', 'narrate.js');
const TMP_ROOT = path.join(ROOT, 'work', 'C', 'test');

let counter = 0;
/** work/C/test/ の下に、この試験だけの作業用フォルダを作る */
export async function tmpDir(label) {
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now().toString(36)}-${counter++}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}
export async function cleanup(dir) { await fsp.rm(dir, { recursive: true, force: true }); }

/** 同じプロセスの中で動かす。{code, env, stdout, progress[]} */
export async function run(...argv) {
  const args = argv.flat();
  let out = '';
  let err = '';
  const { exitCode, envelope } = await runCli(args, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  const lines = out.split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`stdout must be exactly one JSON line, got ${lines.length}: ${out.slice(0, 300)}`);
  const env = JSON.parse(lines[0]);
  const progress = err.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code: exitCode, env, progress, stdout: out, envelope };
}

/** 子プロセス（本物の `node cli/narrate.js`）で動かす */
export function spawnCli(args, { env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NARRATE, ...args], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

const enc = new TextEncoder();
const json = (v) => enc.encode(JSON.stringify(v, null, 2) + '\n');

/** 台本の元データ（hash なし）と画像を、フォルダに書く。testgen の仕様 tiny3 と同じ文・同じ slideId なので、scriptHash が見本のセッションと一致する */
export async function writeTinySource(dir, { specName = 'tiny3', textOverride = {} } = {}) {
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'testgen', 'specs', `${specName}.json`), 'utf8'));
  await fsp.mkdir(path.join(dir, 'slides'), { recursive: true });
  const slides = spec.slides.map((s, i) => ({
    slideId: `s${String(i + 1).padStart(4, '0')}`,
    title: s.title,
    text: textOverride[i] ?? s.text,
    recordable: s.recordable,
    ...(s.speaker ? { speaker: s.speaker } : {}),
    ...(s.targetSec !== undefined ? { targetSec: s.targetSec } : {}),
  }));
  await fsp.writeFile(path.join(dir, 'script.json'), JSON.stringify({ title: spec.title, projectId: spec.projectId, slides }, null, 2));
  for (let i = 0; i < slides.length; i++) {
    await fsp.writeFile(path.join(dir, 'slides', `${String(i + 1).padStart(4, '0')}.png`), renderSlidePng(i + 1, { width: spec.image.width, height: spec.image.height }));
  }
  return { spec, slides };
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else out.push(r);
  }
  return out;
}

async function zipBytes(files) {
  const chunks = [];
  const w = createZipWriter({ write: (u) => { chunks.push(Buffer.from(u)); } });
  for (const [name, data] of files) await w.addFile(name, data);
  await w.finish();
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * examples/sessions/<name>/ から、書き出しの zip（巻に分けてもよい）と索引を作る。
 * volumeFiles：巻ごとの、manifest.json 以外のファイルの名前の一覧（省略すると 1 巻）。第 1 巻の README などは自由に振り分けてよい。
 * @returns {Promise<{zips:string[], index:string, indexJson:any, exportId:string, sessionId:string}>}
 */
export async function exampleExport(name, outDir, { volumeFiles, exportId, mutate } = {}) {
  const src = path.join(EXAMPLES, name);
  const manifest0 = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const all = listFiles(src).filter((f) => !f.startsWith('expected.') && f !== 'manifest.json');
  const plan = volumeFiles || [all];
  const flat = plan.flat();
  for (const f of flat) if (!all.includes(f)) throw new Error(`no such file in the example: ${f}`);
  const eid = exportId || manifest0.exportId;
  await fsp.mkdir(outDir, { recursive: true });
  const zips = [];
  const zipInfo = [];
  for (let i = 0; i < plan.length; i++) {
    const datas = plan[i].map((f) => [f, new Uint8Array(readFileSync(path.join(src, f)))]);
    const manifest = {
      ...manifest0, exportId: eid, volume: i + 1, volumes: plan.length,
      files: datas.map(([f, d]) => ({ path: f, bytes: d.length, sha256: sha256Hex(d) })),
      rawFiles: manifest0.rawFiles.filter((r) => flat.includes(r.file)),
    };
    const m = mutate ? mutate(manifest, i + 1, datas) : { manifest, datas };
    const bytes = await zipBytes([...m.datas, ['manifest.json', json(m.manifest)]]);
    const file = path.join(outDir, `${manifest0.projectId}_${manifest0.sessionId}_${manifest0.kind}_v${String(i + 1).padStart(3, '0')}.zip`);
    await fsp.writeFile(file, bytes);
    zips.push(file);
    zipInfo.push({ volume: i + 1, file: path.basename(file), bytes: bytes.length, sha256: sha256Hex(bytes) });
  }
  const indexJson = { format: 'lap-narrator/index', version: 1, exportId: eid, kind: manifest0.kind, projectId: manifest0.projectId, sessionId: manifest0.sessionId, volumes: plan.length, zips: zipInfo };
  const index = path.join(outDir, `${eid}_index.json`);
  await fsp.writeFile(index, JSON.stringify(indexJson, null, 2));
  return { zips, index, indexJson, exportId: eid, sessionId: manifest0.sessionId };
}

export { json, zipBytes, existsSync, stringifyJsonl, listFiles };

// ---------------------------------------------------------------- 比べる・加工する道具

/** フォルダの下のすべてのファイルの {相対パス: SHA-256}。prefix で絞れる */
export function snapshotDir(dir, prefix = '') {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of listFiles(dir).sort()) if (f.startsWith(prefix)) out[f] = sha256Hex(new Uint8Array(readFileSync(path.join(dir, f))));
  return out;
}

/** exampleExport の mutate 用：ファイルの中身を差し替え、manifest.files と rawFiles を合わせる */
export function replaceFile(m, name, data) {
  const datas = m.datas.map(([n, d]) => (n === name ? [n, data] : [n, d]));
  const files = m.manifest.files.map((f) => (f.path === name ? { path: name, bytes: data.length, sha256: sha256Hex(data) } : f));
  const rawFiles = m.manifest.rawFiles.map((r) => (r.file === name ? { ...r, sha256: sha256Hex(data) } : r));
  return { manifest: { ...m.manifest, files, rawFiles }, datas };
}

/**
 * render の出力（<out>/final/*.wav）から、完成版の書き出し（kind: final）の zip と索引を作る。
 * @param {{renderResult:any, renderOut:string, sessionDir:string, outDir:string, editVersion:number, exportId:string}} a
 */
export async function finalExport(a) {
  const manifest0 = JSON.parse(readFileSync(path.join(a.sessionDir, 'manifest.json'), 'utf8'));
  const datas = [['script.json', new Uint8Array(readFileSync(path.join(a.sessionDir, 'script.json')))]];
  const finals = [];
  for (const f of a.renderResult.finals) {
    for (const p of f.parts) datas.push([p.file, new Uint8Array(readFileSync(path.join(a.renderOut, ...p.file.split('/'))))]);
    finals.push({ slideId: f.slideId, takeId: f.takeId, parts: f.parts, samples: f.samples, sampleRate: f.sampleRate, applied: f.applied });
  }
  const manifest = {
    format: 'lap-narrator/manifest', version: 1, kind: 'final', projectId: manifest0.projectId, scriptHash: manifest0.scriptHash,
    sessionId: manifest0.sessionId, exportId: a.exportId, volume: 1, volumes: 1, appVersion: '0.0.0-test', editVersion: a.editVersion,
    renderSpec: { version: 1, sampleRate: 48000, fadeSamples: 384, fadeShape: 'raised-cosine', resampler: 'none', targetLufs: null, ceilingDb: -1.5, limiter: 'none', rounding: 'round-half-even', dither: 'none' },
    finals, files: datas.map(([n, d]) => ({ path: n, bytes: d.length, sha256: sha256Hex(d) })), createdAt: '2026-11-16T08:00:00.000Z',
  };
  const bytes = await zipBytes([...datas, ['manifest.json', json(manifest)]]);
  await fsp.mkdir(a.outDir, { recursive: true });
  const file = path.join(a.outDir, `${manifest0.projectId}_${manifest0.sessionId}_final_v001.zip`);
  await fsp.writeFile(file, bytes);
  const indexJson = { format: 'lap-narrator/index', version: 1, exportId: a.exportId, kind: 'final', projectId: manifest0.projectId, sessionId: manifest0.sessionId, volumes: 1, zips: [{ volume: 1, file: path.basename(file), bytes: bytes.length, sha256: sha256Hex(bytes) }] };
  const index = path.join(a.outDir, `${a.exportId}_index.json`);
  await fsp.writeFile(index, JSON.stringify(indexJson, null, 2));
  return { zips: [file], index, indexJson, exportId: a.exportId };
}

/** WAV ファイルの PCM 部分（44 バイトのヘッダーの後ろ）の SHA-256 とサンプル数 */
export function wavPcm(file) {
  const buf = readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 36, 40) !== 'data') throw new Error(`not a standard 44-byte-header WAV: ${file}`);
  const pcm = new Uint8Array(buf.buffer, buf.byteOffset + 44, buf.length - 44);
  return { samples: pcm.length / 2, sha256: sha256Hex(pcm), sampleRate: buf.readUInt32LE(24), bytes: buf.length };
}

export const permutations = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));

/** 任意のプログラムを動かして、終了コードと出力を返す（試験の補助。時間の上限つき） */
export function runProcessForTest(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('process timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}
