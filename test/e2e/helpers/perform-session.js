// 1 つのセッション（mic.wav と plan.json）を、PC の Chrome（偽のマイク）と録音アプリで実時間で録り、書き出しを input/ に作る（担当 E）。
//   node test/e2e/helpers/perform-session.js --dir work/N/session1 [--pack examples/packs/jp15.zip] [--pptx examples/pptx/jp15.pptx] [--project jp15_demo] [--ports 8198,8199]
//        [--app-pack <アプリに読ませる台本パック（既定は --pack）>] [--input <入力フォルダー（既定は <dir>/input）>] [--profile-tag Q（work/<tag>/ にプロフィールを作る）]
// 作るもの：<dir>/input/（slides.pptx、script-pack.zip、書き出しの ZIP と *_index.json）、<dir>/run.json（操作の実際の時刻、取り込めた音の確認、アプリの操作記録）。
// 終わったら、起動した Chrome と静的サーバーを止める。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, startServer, openApp, openPackAndStart, exportAll } from './e2e.js';
import { launchChromeWithWav, runPlan } from './fakemic.js';

const a = process.argv.slice(2);
const arg = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };

export async function perform({ dir, pack, pptx, project, ports, appPack = pack, inputDir = path.join(dir, 'input'), profileTag = 'N' }) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const wav = path.join(dir, plan.wav);
  const input = inputDir;
  fs.rmSync(input, { recursive: true, force: true });
  fs.mkdirSync(input, { recursive: true });
  fs.copyFileSync(pptx, path.join(input, 'slides.pptx'));
  fs.copyFileSync(pack, path.join(input, 'script-pack.zip'));
  const server = await startServer(ports[0]);
  let chrome = null;
  const out = { startedAt: new Date().toISOString() };
  try {
    chrome = await launchChromeWithWav({ profile: path.join(ROOT, 'work', profileTag, `profile-s${plan.session}`), port: ports[1], wav });
    const app = await openApp(chrome, server.origin, '?lapdev=1&countdown=0&durableMs=40');
    out.sessionId = await openPackAndStart(app, appPack, project, 'Speaker');
    const t0 = Date.now();
    out.run = await runPlan(app, plan);
    out.runMs = Date.now() - t0;
    if (!out.run.ok) throw new Error('plan failed: ' + out.run.error);
    out.state = await app.state();
    out.events = await app.events();
    out.exports = {};
    for (const kind of ['full', 'final']) {
      const r = await exportAll(app, { kind }, input);
      out.exports[kind] = { files: r.files.map((f) => path.basename(f)), index: path.basename(r.indexFile), volumes: r.sum.volumes };
    }
    out.pageErrors = app.errors;
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.stack ? e.stack : e);
  } finally {
    if (chrome) await chrome.close();
    await server.close();
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(out, null, 1) + '\n');
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(arg('--dir'));
  const ports = arg('--ports', '8198,8199').split(',').map(Number);
  const r = await perform({
    dir, ports,
    pack: path.resolve(arg('--pack', path.join(ROOT, 'examples', 'packs', 'jp15.zip'))),
    pptx: path.resolve(arg('--pptx', path.join(ROOT, 'examples', 'pptx', 'jp15.pptx'))),
    project: arg('--project', 'jp15_demo'),
    appPack: arg('--app-pack') ? path.resolve(arg('--app-pack')) : undefined,
    inputDir: arg('--input') ? path.resolve(arg('--input')) : undefined,
    profileTag: arg('--profile-tag', 'N'),
  });
  console.log(JSON.stringify({ ok: r.ok, error: r.error, runMs: r.runMs, calibration: r.run?.calibration, exports: r.exports }, null, 1));
  process.exit(r.ok ? 0 : 1);
}
