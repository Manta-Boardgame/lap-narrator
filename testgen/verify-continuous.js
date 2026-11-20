// 「通しで録る」流れの確認（担当 E）：入力フォルダー（アプリの書き出し + pptx + 台本パック）を、CLI の
//   import → transcribe → align →（判断待ちを正解の切れ目で boundary set）→ render → build --method B → verify
// に通し、切れ目の誤差を正解と照らす。結果は <dir>/verify-continuous.json。
//   node testgen/verify-continuous.js --dir work/Q/session1 --input work/Q/input1 --workspace work/Q/check1
// 正解の切れ目：完成した通しの音声（<ws>/final/all.wav）の中で、各スライドの最初と最後の文の音を相互相関で見つけ、
// 「スライド k の最後の音の終わり」から「スライド k+1 の最初の音の始まり」までの無音を、正しい切れ目の範囲とする（中点が理想）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from './lib/wav.js';
import { narrate, ROOT } from '../test/e2e/helpers/e2e.js';
import { Correlator, preEmph, snippet } from './verify-narration.js';

const RATE = 48000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

export async function verifyContinuous({ dir, input, workspace }) {
  const out = { dir, steps: {}, ok: true };
  const ws = path.resolve(workspace);
  fs.rmSync(ws, { recursive: true, force: true });
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth', 'truth.json'), 'utf8'));
  const mic = decodeWav(new Uint8Array(fs.readFileSync(path.join(dir, 'mic.wav')))).samples;
  const micE = preEmph(mic);
  const step = async (name, args, opts = {}) => {
    const r = await narrate(args, { timeoutMs: 3600000 });
    out.steps[name] = { code: r.code, sec: +(r.ms / 1000).toFixed(1), errors: r.env?.errors?.map((e) => e.code), warnings: r.env?.warnings?.map((w) => w.code) };
    if (opts.keep) out.steps[name].raw = r.env;
    return r;
  };

  const files = fs.readdirSync(input).filter((f) => (f.endsWith('_index.json') || f.endsWith('.zip')) && f !== 'script-pack.zip').map((f) => path.join(input, f));
  let r = await step('import', ['import', ...files, '--workspace', ws, '--script', path.join(input, 'script-pack.zip')]);
  if (r.code !== 0) { out.ok = false; out.error = 'import ' + (r.stdout || '').slice(0, 600) + (r.stderr || '').slice(-400); return out; }
  r = await step('transcribe', ['transcribe', '--workspace', ws]);
  if (r.code !== 0) { out.ok = false; out.error = 'transcribe ' + (r.stdout || '').slice(0, 600) + (r.stderr || '').slice(-400); return out; }
  out.steps.transcribe.timing = r.env?.result?.timing ?? r.env?.result;
  r = await step('align', ['align', '--workspace', ws], { keep: true });
  const alignCode = r.code;
  if (alignCode !== 0 && alignCode !== 4) { out.ok = false; out.error = 'align ' + (r.stdout || '').slice(0, 600) + (r.stderr || '').slice(-400); return out; }
  const bAuto = JSON.parse(fs.readFileSync(path.join(ws, 'boundaries.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'boundaries.auto.json'), JSON.stringify(bAuto, null, 1) + '\n');
  const allWav = decodeWav(new Uint8Array(fs.readFileSync(path.join(ws, bAuto.audio.file)))).samples;
  out.audioSec = +(allWav.length / RATE).toFixed(2);

  // 正解の切れ目を、完成した通しの音声の中で見つける
  const corr = new Correlator(preEmph(allWav));
  const adopted = truth.segments.filter((s) => ['speech', 'repeat-first', 'adlib'].includes(s.kind));
  const loc = new Map();
  for (const seg of adopted) {
    const sn = snippet(micE, seg.start, seg.end);
    const f = corr.find(sn.t);
    loc.set(seg, { start: f.pos - (sn.off - seg.start), score: f.score });
    loc.get(seg).end = loc.get(seg).start + (seg.end - seg.start);
  }
  const slideIds = bAuto.slides.map((s) => s.slideId);
  const located = [];
  for (let k = 0; k < slideIds.length; k++) {
    const mine = adopted.filter((s) => s.slideId === slideIds[k]);
    const a = loc.get(mine[0]);
    const b = loc.get(mine.at(-1));
    located.push({ slideId: slideIds[k], firstStart: a.start, lastEnd: b.end, minScore: Math.min(...mine.map((m) => loc.get(m).score)) });
  }
  const tb = []; // k 番目の切れ目（スライド k の終わり）
  for (let k = 0; k < located.length - 1; k++) {
    const lo = located[k].lastEnd; const hi = located[k + 1].firstStart;
    tb.push({ slideId: located[k].slideId, nextSlideId: located[k + 1].slideId, lo, hi, mid: Math.round((lo + hi) / 2), loSec: +(lo / RATE).toFixed(3), hiSec: +(hi / RATE).toFixed(3), midSec: +((lo + hi) / 2 / RATE).toFixed(3) });
  }
  const specials = {
    skipped: truth.slides.filter((s) => s.skipped.length).map((s) => ({ slideId: s.slideId, sentences: s.skipped })),
    repeated: adopted.filter((s) => s.kind === 'repeat-first').map((s) => ({ slideId: s.slideId, text: s.text, startSec: +(loc.get(s).start / RATE).toFixed(3), endSec: +(loc.get(s).end / RATE).toFixed(3) })),
    adlib: adopted.filter((s) => s.kind === 'adlib').map((s) => ({ slideId: s.slideId, text: s.text, startSec: +(loc.get(s).start / RATE).toFixed(3), endSec: +(loc.get(s).end / RATE).toFixed(3) })),
    discarded: truth.segments.filter((s) => s.kind === 'junk' || s.kind === 'discarded').map((s) => ({ slideId: s.slideId, kind: s.kind, text: s.text, wavStartSec: +(s.start / RATE).toFixed(3), wavEndSec: +(s.end / RATE).toFixed(3) })),
  };
  fs.writeFileSync(path.join(dir, 'truth', 'located.json'), JSON.stringify({ audioSamples: allWav.length, audioSec: out.audioSec, sampleRate: RATE, boundaries: tb, specials, minLocateScore: Math.min(...located.map((l) => l.minScore)) }, null, 1) + '\n');
  out.minLocateScore = +Math.min(...located.map((l) => l.minScore)).toFixed(4);

  // 自動で確定した切れ目の誤差
  const rows = [];
  for (let k = 0; k < tb.length; k++) {
    const b = bAuto.slides.find((s) => s.slideId === tb[k].slideId);
    const smp = b.endSample;
    const inside = smp >= tb[k].lo && smp <= tb[k].hi;
    const outsideMs = inside ? 0 : ((smp < tb[k].lo ? tb[k].lo - smp : smp - tb[k].hi) / RATE) * 1000;
    rows.push({ slideId: b.slideId, status: b.status, confidence: b.confidence, method: b.method, atSec: +(smp / RATE).toFixed(3), truthLoSec: tb[k].loSec, truthHiSec: tb[k].hiSec, errMidMs: +(((smp - tb[k].mid) / RATE) * 1000).toFixed(0), inside, outsideMs: +outsideMs.toFixed(0), gapMs: +(((tb[k].hi - tb[k].lo) / RATE) * 1000).toFixed(0) });
  }
  out.boundaries = rows;
  const auto = rows.filter((x) => x.status === 'auto');
  out.autoSummary = {
    autoCount: auto.length, needsDecision: rows.filter((x) => x.status === 'needs-decision').map((x) => x.slideId),
    wrongAuto: auto.filter((x) => !x.inside).map((x) => x.slideId),
    errMidMs: { median: median(auto.map((x) => Math.abs(x.errMidMs))), max: auto.length ? Math.max(...auto.map((x) => Math.abs(x.errMidMs))) : null },
    outsideMsMax: auto.length ? Math.max(...auto.map((x) => x.outsideMs)) : null,
  };

  // 判断待ちを、正解の中点で決める
  out.decisions = [];
  for (const x of rows.filter((x) => x.status === 'needs-decision')) {
    const k = tb.findIndex((t) => t.slideId === x.slideId);
    const s = await step(`boundary-set-${x.slideId}`, ['boundary', 'set', '--slide', x.slideId, '--at', String(tb[k].midSec), '--exact', '--workspace', ws]);
    out.decisions.push({ slideId: x.slideId, atSec: tb[k].midSec, code: s.code });
    if (s.code !== 0) { out.ok = false; out.error = `boundary set ${x.slideId}: ${(s.stdout || '').slice(0, 400)}`; return out; }
  }
  const bFinal = JSON.parse(fs.readFileSync(path.join(ws, 'boundaries.json'), 'utf8'));
  out.finalBoundaryStatuses = bFinal.slides.map((s) => `${s.slideId}:${s.status}`);

  r = await step('render', ['render', '--workspace', ws], { keep: true });
  if (r.code !== 0) { out.ok = false; out.error = 'render ' + (r.stdout || '').slice(0, 800) + (r.stderr || '').slice(-300); return out; }
  const finals = r.env?.result?.finals ?? [];
  out.render = finals.map((f) => ({ slideId: f.slideId, sec: f.sec, samples: f.samples }));
  // 各スライドの完成音声の長さが、確定した切れ目の長さと合うか
  const tail = r.env?.result?.tailMarginSamples ?? 0; // render は、各スライドの終わりに余白（既定 100ms）を残して切る
  out.tailMarginSamples = tail;
  out.renderVsBoundaryMax = Math.max(...finals.map((f) => { const b = bFinal.slides.find((s) => s.slideId === f.slideId); return Math.abs(f.samples - (b.endSample - b.startSample - tail)); }));
  r = await step('build', ['build', '--method', 'B', '--workspace', ws], { keep: true });
  if (r.code !== 0) { out.ok = false; out.error = 'build ' + (r.stdout || '').slice(0, 800) + (r.stderr || '').slice(-300); return out; }
  r = await step('verify', ['verify', '--workspace', ws, '--report', path.join(dir, 'video-verify.json')], { keep: true });
  out.verify = { code: r.code, result: r.env?.result, errors: r.env?.errors };
  if (r.code !== 0) out.ok = false;
  fs.writeFileSync(path.join(dir, 'verify-continuous.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const dir = path.resolve(arg('--dir'));
  const r = await verifyContinuous({ dir, input: path.resolve(arg('--input', path.join(dir, 'input'))), workspace: arg('--workspace', path.join(ROOT, 'work', 'Q', 'check')) });
  fs.writeFileSync(path.join(dir, 'verify-continuous.json'), JSON.stringify(r, null, 1) + '\n');
  console.log(JSON.stringify({ ok: r.ok, error: r.error, steps: Object.fromEntries(Object.entries(r.steps).map(([k, v]) => [k, `${v.code} ${v.sec}s`])), autoSummary: r.autoSummary, minLocateScore: r.minLocateScore, verify: r.verify?.result?.summary ?? r.verify?.code }, null, 1));
  process.exit(r.ok ? 0 : 1);
}
