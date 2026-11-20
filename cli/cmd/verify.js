// verify：作った MP4 を測り、予定表との差を報告する（設計書 8.4、CONTRACTS.md 4、7.3）。checker/video/verify.py を子プロセスで呼ぶ薄い入口（担当 D のプログラム）。
//   narrate verify --workspace <dir> [--out <dir>]
//       動画と予定表の場所：--out があれば <out>/video.mp4 と <out>/timeline.json。なければ <workspace>/last-build.json（build が書く）。それも無ければ <workspace>/out。
//       --out が .json で終わるときは、従来どおり測定結果の書き出し先のファイル（--report <file> でも同じ）。
//   narrate verify --video <mp4> --timeline <json> [--method A|B]
//       .venv\Scripts\python.exe -I checker/video/verify.py --video <mp4> --timeline <json> --method A|B
// 終了コード：許容値の外がなく、測定不能もなければ 0。許容値の外、または測定不能が 1 つでもあれば 3（result に測定の全体）。読めないときは 1。
//   測定不能（verify.py の slides[].status = "unmeasurable"、allMeasured: false）は errors[0].code = "unmeasurable"（許容値の外もあるときは out-of-tolerance が先）、result.pass = false。
//   測れた分だけの合否は result.passMeasuredOnly。--allow-unmeasurable のときだけ、測れた分で合否を決める（警告 unmeasurable）。
// verify.py の出力からは slides[].status／allMeasured だけを読む（項目が増えても壊れない）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { intOption } from '../lib/args.js';
import { parseJsonOutput, pythonCommand, pythonPath, runProcess, tail, toolExists, verifyScript } from '../lib/exec.js';
import { fileExists } from '../lib/fsutil.js';
import { readLastBuild } from '../lib/lastbuild.js';

export const options = { video: 'string', timeline: 'string', method: 'string', 'tolerance-audio-ms': 'string', 'tolerance-show-ms': 'string', out: 'string', report: 'string', 'allow-unmeasurable': 'boolean', 'timeout-sec': 'string' };

export async function run({ ctx, opts, workspace }) {
  if (!workspace && !(opts.video && opts.timeline)) throw usageError('--workspace is required (or give both --video and --timeline)');
  const outIsReport = typeof opts.out === 'string' && /\.json$/i.test(opts.out);
  const reportFile = opts.report || (outIsReport ? opts.out : null);
  const outArg = opts.out && !outIsReport ? path.resolve(opts.out) : null;
  // 探す順：(a) --video／--timeline、(b) --out の下（動画。予定表は --out → last-build.json → <workspace>/out）、(c) <workspace>/last-build.json、(d) <workspace>/out
  // --out は利用者が明示した出力先なので、last-build.json より先に使う（build は動画を --out に、予定表を <workspace>/out に置くことがある）
  const lb = workspace ? await readLastBuild(workspace) : null;
  const wsOut = workspace ? path.join(workspace, 'out') : path.resolve('.');
  const firstExisting = async (list) => { for (const p of list.filter(Boolean)) if (await fileExists(path.resolve(p))) return path.resolve(p); return path.resolve(list.filter(Boolean)[0]); };
  const found = lb || {};
  const video = opts.video ? path.resolve(opts.video) : await firstExisting([outArg && path.join(outArg, 'video.mp4'), found.video, path.join(wsOut, 'video.mp4')]);
  const timeline = opts.timeline ? path.resolve(opts.timeline) : await firstExisting([outArg && path.join(outArg, 'timeline.json'), found.timeline, path.join(wsOut, 'timeline.json'), path.join(path.dirname(video), 'timeline.json')]);
  for (const [what, p] of [['video', video], ['timeline', timeline]]) if (!(await fileExists(p))) throw new CliError('cannot-read', `no such ${what} file: ${p}`);
  let method = opts.method ? opts.method.toUpperCase() : null;
  if (method && method !== 'A' && method !== 'B') throw usageError('--method must be A or B');
  if (!method) {
    if (lb && lb.method && !outArg) method = String(lb.method).startsWith('A') ? 'A' : 'B';
    else {
      // 作ったときの方式を、同じフォルダの build-report.json から読む（なければ B）
      try {
        const rep = JSON.parse(await fsp.readFile(path.join(path.dirname(video), 'build-report.json'), 'utf8'));
        method = typeof rep.method === 'string' && rep.method.startsWith('A') ? 'A' : 'B';
      } catch { method = 'B'; }
    }
  }
  const script = verifyScript();
  if (!toolExists(script)) throw new CliError('tool-missing', `verify.py not found: ${script}`);
  if (!toolExists(pythonPath())) throw new CliError('tool-missing', `Python not found: ${pythonPath()} (create .venv and install PyAV; see dev/INSTALLED.md)`);
  const args = ['--video', video, '--timeline', timeline, '--method', method];
  for (const k of ['tolerance-audio-ms', 'tolerance-show-ms']) if (opts[k] !== undefined) { intOption(opts, k, 0, { min: 0, max: 100000 }); args.push(`--${k}`, String(opts[k])); }
  const spec = pythonCommand(script, args);
  ctx.progress('verify', 0, 1);
  const r = await runProcess(spec.cmd, spec.args, { timeoutMs: intOption(opts, 'timeout-sec', 900, { min: 1 }) * 1000 });
  ctx.progress('verify', 1, 1);
  if (r.spawnError) throw new CliError('tool-missing', `cannot start ${spec.cmd} (${r.spawnError})`);
  if (r.timedOut) throw new CliError('verify-timeout', 'verify did not finish in time and was stopped', { detail: { stderr: tail(r.stderr) } });
  const out = parseJsonOutput(r.stdout);
  if (r.code === 1 || !out || typeof out !== 'object' || !Array.isArray(out.slides)) {
    const msg = out && out.error && out.error.message ? out.error.message : `verify failed (exit ${r.code})`;
    throw new CliError(out && out.error && out.error.code ? out.error.code : 'verify-failed', msg, { detail: { exitCode: r.code, stderr: tail(r.stderr), stdout: tail(r.stdout, 500) } });
  }
  if (r.code !== 0 && r.code !== 3) throw new CliError('verify-failed', `verify exited with ${r.code}`, { detail: { stderr: tail(r.stderr), stdout: tail(r.stdout, 500) } });

  // verify.py の pass は「測れた分だけ」の合否。測定不能の扱いはここで決める。
  const bad = out.slides.filter((s) => s && s.status === 'out-of-tolerance').map((s) => s.slideId);
  const unmeasurable = out.slides.filter((s) => s && s.status === 'unmeasurable').map((s) => s.slideId);
  const passMeasuredOnly = bad.length === 0 && r.code === 0;
  const hasUnmeasurable = unmeasurable.length > 0 || out.allMeasured === false;
  const allow = opts['allow-unmeasurable'] === true;
  // ずれの最大値（verify.py に同じ欄があればそれ、なければスライドごとの diffMs から）
  const maxAbsDiffMs = { show: null, audio: null };
  const worst = { show: null, audio: null };
  for (const s of out.slides) for (const k of ['show', 'audio']) {
    const d = s && s.diffMs ? s.diffMs[k] : null;
    if (typeof d === 'number' && (maxAbsDiffMs[k] === null || Math.abs(d) > maxAbsDiffMs[k])) { maxAbsDiffMs[k] = Math.abs(d); worst[k] = s.slideId; }
  }
  const result = { ...out, maxAbsDiffMs: out.maxAbsDiffMs || maxAbsDiffMs, worst: out.worst || worst, pass: passMeasuredOnly && (!hasUnmeasurable || allow), passMeasuredOnly, allMeasured: !hasUnmeasurable, unmeasurableSlides: unmeasurable, video, timeline };
  if (reportFile) await fsp.writeFile(path.resolve(reportFile), JSON.stringify(result, null, 2) + '\n');
  const errors = [];
  if (!passMeasuredOnly) errors.push({ code: 'out-of-tolerance', message: `${bad.length} slide(s) are outside the tolerance (${bad.join(', ')})`, detail: { slides: bad } });
  if (hasUnmeasurable) {
    const msg = `${unmeasurable.length} slide(s) could not be measured (${unmeasurable.join(', ') || 'see result.slides'}); result.passMeasuredOnly covers only the measured ones`;
    if (allow) ctx.warn('unmeasurable', msg, { slides: unmeasurable });
    else errors.push({ code: 'unmeasurable', message: `${msg}; pass --allow-unmeasurable to accept that`, detail: { slides: unmeasurable } });
  }
  return { result, errors, exit: errors.length ? EXIT.MISMATCH : EXIT.OK };
}
