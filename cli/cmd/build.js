// build：動画を作る（設計書 8.3）。builder/ のスクリプトを子プロセスで呼ぶ薄い入口（担当 D のプログラム）。
//   narrate build --method B --workspace <dir> [--out <dir>] [--timeline <json>]
//       .venv\Scripts\python.exe -I builder/build_b.py --timeline <json> --out <dir>
//   narrate build --method A --pptx <pptx> --workspace <dir> [--mode both|linked|embedded] [--grid-ms 33]
//       powershell -NoProfile -ExecutionPolicy Bypass -File builder\build-a.ps1 -Pptx <pptx> -Timeline <json> -OutDir <dir> -Mode <m> -GridMs <n>
// 方式 A は PowerPoint を使う。終了コード 10（PowerPoint に利用者の資料が開いている。何も触っていない）は errors の powerpoint-busy。
// 既定の --out は <workspace>/out。--timeline が無いときは、(a) <out>/timeline.json、(b) <workspace>/out/timeline.json の順に探す（見つけた場所は result.timeline）。
// 成功したら <workspace>/last-build.json に、動画と予定表の場所を書く（verify --workspace が読む。C-001 の 2 章 14）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/index.js';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { intOption } from '../lib/args.js';
import { createFsStore } from '../lib/store.js';
import { builderDir, parseJsonOutput, powershellCommand, pythonCommand, pythonPath, runProcess, tail, toolExists } from '../lib/exec.js';
import { checkPackMatches } from '../lib/packcheck.js';
import { fileExists } from '../lib/fsutil.js';
import { writeLastBuild } from '../lib/lastbuild.js';
import { loadScript, recordableSlides, skippedSlideList } from '../lib/workspace.js';

export const options = { method: 'string', out: 'string', timeline: 'string', pptx: 'string', mode: 'string', 'grid-ms': 'string', 'timeout-sec': 'string', script: 'string', 'allow-missing': 'boolean' };

/** 予定表を読み、指している絵と音声がそろっているか確かめる */
export async function loadTimelineChecked(tlPath) {
  if (await fileExists(`${tlPath}.incomplete`)) {
    throw new CliError('stale-timeline', `render did not complete for ${tlPath}; run render again before building`);
  }
  let tl;
  try { tl = JSON.parse((await fsp.readFile(tlPath, 'utf8')).replace(/^﻿/, '')); } catch (e) {
    throw new CliError('timeline-not-found', `cannot read the timeline ${tlPath} (${e.code || e.message}); run render first`);
  }
  const v = validate('timeline', tl);
  if (!v.ok) throw new CliError('timeline-invalid', `${tlPath} does not match schema/timeline`, { exit: EXIT.MISMATCH, detail: { errors: v.errors.slice(0, 10) } });
  if (tl.slides.length === 0) throw new CliError('timeline-empty', 'the timeline has no slides');
  const base = path.dirname(tlPath);
  const missing = [];
  for (const s of tl.slides) {
    for (const p of [s.image, ...(Array.isArray(s.audio) ? s.audio : [s.audio])]) if (!(await fileExists(path.resolve(base, p)))) missing.push(p);
  }
  if (missing.length) throw new CliError('missing-file', `${missing.length} file(s) named in the timeline are missing next to it`, { detail: { missing: missing.slice(0, 20) } });
  return tl;
}

/** 予定表の場所：--timeline、なければ <out>/timeline.json、<workspace>/out/timeline.json の順 */
async function findTimeline(opts, workspace, outDir) {
  if (opts.timeline) return path.resolve(opts.timeline);
  const candidates = [path.join(outDir, 'timeline.json')];
  if (workspace) candidates.push(path.join(workspace, 'out', 'timeline.json'));
  const uniq = [...new Set(candidates.map((c) => path.resolve(c)))];
  for (const c of uniq) if (await fileExists(c)) return c;
  throw new CliError('timeline-not-found', `no timeline.json found (looked in: ${uniq.join(', ')}); run render first, or pass --timeline <json>`, { detail: { searched: uniq } });
}

export async function run({ ctx, opts, workspace }) {
  const method = (opts.method || 'B').toUpperCase();
  if (method !== 'A' && method !== 'B') throw usageError('--method must be A or B');
  if (!workspace && !(opts.out && opts.timeline)) throw usageError('--workspace is required (or give both --out and --timeline)');
  const store = workspace ? createFsStore(workspace) : null;
  if (store && opts.script) await checkPackMatches(store, opts.script);
  const outDir = path.resolve(opts.out || path.join(workspace, 'out'));
  const tlPath = await findTimeline(opts, workspace, outDir);
  const timeoutMs = intOption(opts, 'timeout-sec', method === 'A' ? 1800 : 900, { min: 1 }) * 1000;
  const tl = await loadTimelineChecked(tlPath);
  const workspaceScript = store ? await loadScript(store) : null;
  if (workspaceScript) {
    const included = new Set(tl.slides.map((s) => s.slideId));
    const slides = recordableSlides(workspaceScript).filter((s) => !included.has(s.slideId)).map((s) => s.slideId);
    if (slides.length) {
      if (!opts['allow-missing']) {
        throw new CliError('missing-slides', `the timeline omits ${slides.length} recordable slide(s) (${slides.join(', ')}); run render again or pass --allow-missing to build this subset`, {
          detail: { slides },
        });
      }
      ctx.warn('slide-missing', `${slides.length} recordable slide(s) are left out of the video`, { slides });
    }
  }
  await fsp.mkdir(outDir, { recursive: true });

  let spec;
  if (method === 'B') {
    const script = path.join(builderDir(), 'build_b.py');
    if (!toolExists(script)) throw new CliError('tool-missing', `build_b.py not found: ${script}`);
    if (!toolExists(pythonPath())) throw new CliError('tool-missing', `Python not found: ${pythonPath()} (create .venv and install PyAV; see dev/INSTALLED.md)`);
    spec = pythonCommand(script, ['--timeline', tlPath, '--out', outDir]);
  } else {
    if (!opts.pptx) throw usageError('--method A needs --pptx <the original pptx>');
    const pptx = path.resolve(opts.pptx);
    if (!(await fileExists(pptx))) throw new CliError('cannot-read', `no such file: ${pptx}`);
    const mode = opts.mode || 'both';
    if (!['both', 'linked', 'embedded'].includes(mode)) throw usageError('--mode must be both, linked or embedded');
    const grid = intOption(opts, 'grid-ms', 33, { min: 0, max: 1000 }); // 既定は 33（CONTRACTS.md 7.3 の 5）
    const script = path.join(builderDir(), 'build-a.ps1');
    if (!toolExists(script)) throw new CliError('tool-missing', `build-a.ps1 not found: ${script}`);
    spec = powershellCommand(script, ['-Pptx', pptx, '-Timeline', tlPath, '-OutDir', outDir, '-Mode', mode, '-GridMs', String(grid)]);
  }

  ctx.progress('build', 0, 1);
  const r = await runProcess(spec.cmd, spec.args, { timeoutMs });
  ctx.progress('build', 1, 1);
  if (r.spawnError) throw new CliError('tool-missing', `cannot start ${spec.cmd} (${r.spawnError})`);
  if (r.timedOut) throw new CliError(method === 'A' ? 'powerpoint-timeout' : 'build-timeout', `the build did not finish within ${timeoutMs / 1000} s and was stopped`, { detail: { stderr: tail(r.stderr) } });
  const out = parseJsonOutput(r.stdout);
  if (method === 'A' && r.code === 10) throw new CliError('powerpoint-busy', 'PowerPoint has other presentations open; close them and try again (nothing was touched)', { detail: { exitCode: 10, ...(out ? { script: out } : {}) } });
  if (method === 'A' && r.code === 11) throw new CliError('powerpoint-timeout', 'the PowerPoint export timed out (exit 11)', { detail: { exitCode: 11, ...(out ? { script: out } : {}) } });
  if (r.code !== 0) {
    const first = out && Array.isArray(out.errors) && out.errors[0] ? out.errors[0] : null;
    throw new CliError(first && first.code ? first.code : 'build-failed', first && first.message ? first.message : `the build failed (exit ${r.code})`, { detail: { exitCode: r.code, stdout: tail(r.stdout, 1000), stderr: tail(r.stderr) } });
  }
  if (!out || typeof out !== 'object') throw new CliError('build-failed', 'the build script printed no JSON report', { detail: { stdout: tail(r.stdout, 1000), stderr: tail(r.stderr) } });
  const { ok, ...report } = out;
  const videoPath = path.join(outDir, 'video.mp4');
  if (!(await fileExists(videoPath))) throw new CliError('build-failed', `the build script reported success but ${videoPath} does not exist`, { detail: { report } });
  if (workspace) await writeLastBuild(workspace, { method: report.method || method, video: videoPath, timeline: tlPath, outDir });
  const skipped = workspace ? skippedSlideList(workspaceScript) : null;
  return { result: { ...report, ...(skipped ? { skippedSlides: skipped, skippedSlideIds: skipped.map((s) => s.slideId) } : {}), method: report.method || method, outDir, videoPath, timeline: tlPath, slides: tl.slides.length } };
}
