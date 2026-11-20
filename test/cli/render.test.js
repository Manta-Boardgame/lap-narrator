// status／select／render：候補の数え方、判断が要るとき（終了コード 4）、完成した音声（見本の期待値との照合）、分割、編集の倍率。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import {
  run, tmpDir, cleanup, writeTinySource, exampleExport, replaceFile, finalExport, wavPcm, EXAMPLES,
} from './helpers/cli.js';

const T = { timeout: 180000 };
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ok = (r) => { assert.equal(r.code, 0, r.stdout); assert.equal(r.env.ok, true); assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] }); return r.env.result; };

async function setup(label) {
  const dir = await tmpDir(label);
  await writeTinySource(path.join(dir, 'src'));
  const pack = path.join(dir, 'pack.zip');
  assert.equal((await run('pack', '--from-json', path.join(dir, 'src'), '--out', pack)).code, 0);
  return { dir, pack, ws: path.join(dir, 'ws') };
}
const importScene = async (ctx, name, opts) => {
  const ex = await exampleExport(name, path.join(ctx.dir, `ex-${name}`), opts);
  ok(await run('import', ...ex.zips, '--script', ctx.pack, '--workspace', ctx.ws));
  return ex;
};
const sceneNames = () => rj(path.join(EXAMPLES, 'index.json')).map((s) => s.name);

test('見本 27 場面：import → status → render の結果が、担当 E の期待値（expected.render.json、expected.segments.json）と一致する', T, async () => {
  const ctx = await setup('scenes');
  try {
    for (const name of sceneNames()) {
      const ws = path.join(ctx.dir, `ws-${name}`);
      const ex = await exampleExport(name, path.join(ctx.dir, `ex-${name}`));
      ok(await run('import', ...ex.zips, '--script', ctx.pack, '--workspace', ws));
      const exp = rj(path.join(EXAMPLES, name, 'expected.render.json'));
      const seg = rj(path.join(EXAMPLES, name, 'expected.segments.json'));
      // status：既定のテイクがあるスライドは single で、そのテイクが採用される（同じセッションの別のテイクは alternative）
      const st = ok(await run('status', '--workspace', ws));
      for (const s of st.slides) {
        const def = seg.defaultTakes[s.slideId];
        if (def) {
          assert.equal(s.state, 'single', `${name} ${s.slideId}`);
          assert.equal(s.selected.takeId, def, `${name} ${s.slideId}`);
          assert.equal(s.candidates.filter((c) => !c.alternative).length, 1);
        } else assert.equal(s.state, 'missing', `${name} ${s.slideId}`);
      }
      assert.deepEqual(st.needsDecision, []);
      const r = await run('render', '--workspace', ws, '--allow-missing');
      const out = path.join(ws, 'out');
      if (exp.finals.length === 0) {
        assert.equal(r.code, 1, name);
        assert.equal(r.env.errors[0].code, 'nothing-to-render');
        continue;
      }
      const res = ok(r);
      assert.deepEqual(res.finals.map((f) => f.slideId), exp.finals.map((f) => f.slideId), name);
      for (const f of exp.finals) {
        const w = wavPcm(path.join(out, 'final', `${f.slideId}.wav`));
        assert.equal(w.samples, f.samples, `${name} ${f.slideId} samples`);
        assert.equal(w.sha256, f.sha256, `${name} ${f.slideId} pcm`);
        assert.equal(w.sampleRate, exp.sampleRate);
      }
      assert.deepEqual(readdirSync(path.join(out, 'final')).sort(), exp.finals.map((f) => `${f.slideId}.wav`).sort(), name);
      const tl = rj(path.join(out, 'timeline.json'));
      assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
      assert.deepEqual(tl.slides.map((s) => s.slideId), exp.finals.map((f) => f.slideId));
      for (const s of tl.slides) assert.ok(existsSync(path.join(out, s.image)) && existsSync(path.join(out, s.audio)));
    }
  } finally { await cleanup(ctx.dir); }
});

test('render refuses to omit missing recordings unless --allow-missing is given', T, async () => {
  const ctx = await setup('missing-slides');
  try {
    await importScene(ctx, 'basic');
    const out = path.join(ctx.ws, 'out');
    const refused = await run('render', '--workspace', ctx.ws);
    assert.equal(refused.code, 1);
    assert.equal(refused.env.errors[0].code, 'missing-slides');
    assert.deepEqual(refused.env.errors[0].detail, {
      slides: ['s0002', 's0003'],
      skipped: { missing: ['s0002', 's0003'], stale: [], unrenderable: [] },
    });
    assert.equal(existsSync(out), false);
    const allowed = await run('render', '--workspace', ctx.ws, '--allow-missing');
    assert.deepEqual(ok(allowed).finals.map((f) => f.slideId), ['s0001']);
    assert.ok(allowed.env.warnings.some((w) => w.code === 'slide-missing'));
  } finally { await cleanup(ctx.dir); }
});

test('render preserves uninterrupted samples across a declared storage rotation', T, async () => {
  const ctx = await setup('continuous-rotation');
  try {
    await importScene(ctx, 'file-rotate', {
      mutate: (manifest, volume, datas) => ({ manifest: { ...manifest, renderSpec: { preserveFileRotations: true } }, datas }),
    });
    const rendered = ok(await run('render', '--workspace', ctx.ws, '--allow-missing'));
    const rawRoot = path.join(ctx.ws, 'sessions', 'ex-file-rotate', 'raw');
    const expected = Buffer.concat([
      readFileSync(path.join(rawRoot, 'rec-000001.wav')).subarray(44),
      readFileSync(path.join(rawRoot, 'rec-000002.wav')).subarray(44, 44 + 9600 * 2),
    ]);
    const actual = readFileSync(path.join(rendered.out, 'final', 's0001.wav')).subarray(44);
    assert.ok(actual.equals(expected), 'only a storage file boundary is crossed');
  } finally { await cleanup(ctx.dir); }
});

test('候補が複数（別のセッション）：status は multiple。render は何も書かずに終了コード 4 で選択肢を出す。自動では決めない', T, async () => {
  const ctx = await setup('multi');
  try {
    await importScene(ctx, 'basic');
    await importScene(ctx, 'retake');
    const st = ok(await run('status', '--workspace', ctx.ws));
    assert.equal(st.slides[0].state, 'multiple');
    assert.equal(st.slides[0].needsDecision, true);
    assert.equal(st.slides[0].resolved, false);
    assert.equal(st.slides[0].selected, null);
    assert.deepEqual(st.needsDecision, ['s0001']);
    assert.deepEqual(st.slides[0].candidates.map((c) => c.sessionId).sort(), ['ex-basic', 'ex-retake']);
    assert.equal(st.totalSamples, 0, '決まっていないスライドは合計に入れない');
    const out = path.join(ctx.dir, 'o1');
    const r = await run('render', '--workspace', ctx.ws, '--out', out);
    assert.equal(r.code, 4, r.stdout);
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'decision-required');
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
    const nd = r.env.result.needsDecision;
    assert.equal(nd.length, 1);
    assert.equal(nd[0].slideId, 's0001');
    assert.deepEqual(nd[0].candidates.map((c) => `${c.sessionId}/${c.takeId}`).sort(), ['ex-basic/t0001', 'ex-retake/t0001']);
    assert.match(nd[0].howToSelect, /narrate select --slide s0001/);
    assert.equal(existsSync(out), false, '何も書かない');
    assert.equal(existsSync(path.join(ctx.ws, 'selections.json')), false, '自動で selections.json を書かない');
  } finally { await cleanup(ctx.dir); }
});

test('select：selections.json に書く。選んだあとは render が通り、選んだテイクの音になる。取り込みは選択を変えない', T, async () => {
  const ctx = await setup('select');
  try {
    await importScene(ctx, 'basic');
    await importScene(ctx, 'retake');
    const bad = await run('select', '--slide', 's0001', '--session', 'ex-basic', '--take', 't0099', '--workspace', ctx.ws);
    assert.equal(bad.code, 1);
    assert.equal(bad.env.errors[0].code, 'no-such-candidate');
    assert.equal(bad.env.errors[0].detail.candidates.length, 2);
    assert.equal((await run('select', '--slide', 'nope', '--session', 'ex-basic', '--take', 't0001', '--workspace', ctx.ws)).env.errors[0].code, 'no-such-slide');
    assert.equal((await run('select', '--slide', 's0001', '--workspace', ctx.ws)).code, 2);
    assert.equal(existsSync(path.join(ctx.ws, 'selections.json')), false);

    const res = ok(await run('select', '--slide', 's0001', '--session', 'ex-retake', '--take', 't0001', '--workspace', ctx.ws));
    assert.deepEqual(res.selections, { s0001: { sessionId: 'ex-retake', takeId: 't0001' } });
    assert.deepEqual(rj(path.join(ctx.ws, 'selections.json')), res.selections);
    const st = ok(await run('status', '--workspace', ctx.ws));
    assert.equal(st.slides[0].state, 'multiple');
    assert.equal(st.slides[0].resolved, true);
    assert.equal(st.slides[0].needsDecision, false);
    assert.equal(st.slides[0].selected.sessionId, 'ex-retake');
    assert.deepEqual(st.needsDecision, []);

    const rr = ok(await run('render', '--workspace', ctx.ws, '--allow-missing'));
    assert.equal(rr.finals[0].sessionId, 'ex-retake');
    const expRetake = rj(path.join(EXAMPLES, 'retake', 'expected.render.json'));
    assert.equal(wavPcm(path.join(rr.out, 'final', 's0001.wav')).sha256, expRetake.finals[0].sha256);

    // 別のセッションを取り込んでも、選択は上書きされない
    await importScene(ctx, 'retake-twice');
    assert.deepEqual(rj(path.join(ctx.ws, 'selections.json')), res.selections);
    const st2 = ok(await run('status', '--workspace', ctx.ws));
    assert.equal(st2.slides[0].selected.sessionId, 'ex-retake');
    assert.equal(st2.slides[0].candidates.length, 3);
    // 選び直し、取り消し
    ok(await run('select', '--slide', 's0001', '--session', 'ex-basic', '--take', 't0001', '--workspace', ctx.ws));
    assert.equal(rj(path.join(ctx.ws, 'selections.json')).s0001.sessionId, 'ex-basic');
    const cleared = ok(await run('select', '--slide', 's0001', '--clear', '--workspace', ctx.ws));
    assert.deepEqual(cleared.selections, {});
    assert.equal((await run('render', '--workspace', ctx.ws)).code, 4);
  } finally { await cleanup(ctx.dir); }
});

test('selections.json が候補に合わない（セッションが無い）：render は失敗（終了コード 1）。status は警告', T, async () => {
  const ctx = await setup('badsel');
  try {
    await importScene(ctx, 'basic');
    await fsp.writeFile(path.join(ctx.ws, 'selections.json'), JSON.stringify({ s0001: { sessionId: 'gone', takeId: 't0001' } }));
    const r = await run('render', '--workspace', ctx.ws);
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'selection-not-found');
    const st = await run('status', '--workspace', ctx.ws);
    assert.equal(st.code, 0);
    assert.ok(st.env.warnings.some((w) => w.code === 'bad-selection'));
  } finally { await cleanup(ctx.dir); }
});

test('同じセッションの別のテイク（alternative）：既定は新しいテイク。select で古い方を選べる', T, async () => {
  const ctx = await setup('alt');
  try {
    await importScene(ctx, 'goto-slide');
    const st = ok(await run('status', '--workspace', ctx.ws));
    const s1 = st.slides[0];
    assert.equal(s1.state, 'single');
    assert.equal(s1.candidates.length, 2);
    const def = s1.candidates.find((c) => c.default);
    const alt = s1.candidates.find((c) => c.alternative);
    assert.ok(def && alt && def.takeId !== alt.takeId);
    const r1 = ok(await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o1'), '--allow-missing'));
    assert.equal(r1.finals[0].takeId, def.takeId);
    ok(await run('select', '--slide', 's0001', '--session', alt.sessionId, '--take', alt.takeId, '--workspace', ctx.ws));
    const r2 = ok(await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o2'), '--allow-missing'));
    assert.equal(r2.finals[0].takeId, alt.takeId);
    assert.notEqual(r2.finals[0].parts[0].sha256, r1.finals[0].parts[0].sha256);
    assert.equal(r2.finals[0].samples, alt.samples);
  } finally { await cleanup(ctx.dir); }
});

test('6.6「編集の版が違う完成版」：採用の候補として残す（multiple）。自動では置き換えず、--export で選ぶと完成版の音をそのまま使う。取り込んだ音が壊れていたら終了コード 3', T, async () => {
  const ctx = await setup('finalcand');
  try {
    const ex = await importScene(ctx, 'tiny3-full');
    // 完成版の音声を、別の編集の版（2）として書き出す
    const base = ok(await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o0')));
    // 完成版の音声を少し変える（編集の結果が違う、という想定）：先頭のスライドの音を半分の音量にしたものを用意する
    const ws2 = path.join(ctx.dir, 'ws2');
    const half = await exampleExport('tiny3-full', path.join(ctx.dir, 'ex2'), {
      exportId: 'exp-tiny3-full-g',
      mutate: (manifest, vol, datas) => replaceFile({ manifest, datas }, 'edits.json', new TextEncoder().encode(JSON.stringify({ format: 'lap-narrator/edits', version: 1, sessionId: 'ex-tiny3-full', editVersion: 2, fadeSamples: 384, gainDb: { 話者A: -6 } }, null, 2) + '\n')),
    });
    ok(await run('import', ...half.zips, '--script', ctx.pack, '--workspace', ws2));
    const gained = ok(await run('render', '--workspace', ws2));
    assert.equal(gained.finals[0].applied.gainDb, -6);
    const fin = await finalExport({ renderResult: gained, renderOut: gained.out, sessionDir: path.join(EXAMPLES, 'tiny3-full'), outDir: path.join(ctx.dir, 'fin'), editVersion: 2, exportId: 'exp-tiny3-final-2' });
    const imp = ok(await run('import', fin.index, ...fin.zips, '--workspace', ctx.ws));
    assert.deepEqual(imp.unchanged.concat(imp.committed), ['ex-tiny3-full']);
    const sess = rj(path.join(ctx.ws, 'sessions', 'ex-tiny3-full', 'session.json'));
    assert.equal(sess.finals[0].role, 'candidate');
    const st = ok(await run('status', '--workspace', ctx.ws));
    assert.deepEqual(st.slides.map((s) => s.state), ['multiple', 'multiple', 'multiple']);
    assert.deepEqual(st.slides[0].candidates.map((c) => c.source).sort(), ['final', 'full']);
    assert.deepEqual(st.sessions[0].finals, [{ exportId: 'exp-tiny3-final-2', role: 'candidate', editVersion: 2 }]);
    const r4 = await run('render', '--workspace', ctx.ws);
    assert.equal(r4.code, 4);
    assert.equal(r4.env.result.needsDecision.length, 3);
    // 3 枚とも、完成版の方を選ぶ
    for (const id of ['s0001', 's0002', 's0003']) {
      const take = st.slides.find((s) => s.slideId === id).candidates[0].takeId;
      ok(await run('select', '--slide', id, '--session', 'ex-tiny3-full', '--take', take, '--export', 'exp-tiny3-final-2', '--workspace', ctx.ws));
    }
    assert.equal(rj(path.join(ctx.ws, 'selections.json')).s0001.exportId, 'exp-tiny3-final-2');
    const out = path.join(ctx.dir, 'o3');
    const res = ok(await run('render', '--workspace', ctx.ws, '--out', out));
    assert.deepEqual(res.finals.map((f) => f.source), ['final', 'final', 'final']);
    for (const f of gained.finals) assert.equal(wavPcm(path.join(out, 'final', `${f.slideId}.wav`)).sha256, wavPcm(path.join(gained.out, 'final', `${f.slideId}.wav`)).sha256);
    assert.notEqual(wavPcm(path.join(out, 'final', 's0001.wav')).sha256, wavPcm(path.join(base.out, 'final', 's0001.wav')).sha256);
    // --export なしの選択は全記録の方
    ok(await run('select', '--slide', 's0001', '--session', 'ex-tiny3-full', '--take', 't0001', '--workspace', ctx.ws));
    const res2 = ok(await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o4')));
    assert.deepEqual(res2.finals.map((f) => f.source), ['full', 'final', 'final']);
    // 取り込んだあとで音が壊れた
    const target = path.join(ctx.ws, 'sessions', 'ex-tiny3-full', 'finals', 'exp-tiny3-final-2', 'final', 's0002.wav');
    const buf = readFileSync(target);
    buf[60] ^= 0xff;
    await fsp.writeFile(target, buf);
    const r5 = await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o5'));
    assert.equal(r5.code, 3, r5.stdout);
    assert.equal(r5.env.errors[0].code, 'hash-mismatch');
  } finally { await cleanup(ctx.dir); }
});

test('台本の文が変わったスライド（stale）は render から外れる（警告）。選べば使える（警告つき）', T, async () => {
  const ctx = await setup('stale');
  try {
    const src2 = path.join(ctx.dir, 'src2');
    await writeTinySource(src2, { textOverride: { 1: '会は毎月、第三金曜日に開きます。' } });
    const pack2 = path.join(ctx.dir, 'pack2.zip');
    ok(await run('pack', '--from-json', src2, '--out', pack2));
    const ex = await exampleExport('tiny3-full', path.join(ctx.dir, 'ex'));
    ok(await run('import', ...ex.zips, '--script', pack2, '--workspace', ctx.ws));
    const refused = await run('render', '--workspace', ctx.ws);
    assert.equal(refused.env.errors[0].code, 'missing-slides');
    assert.deepEqual(refused.env.errors[0].detail.skipped.stale, ['s0002']);
    const r = await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o1'), '--allow-missing');
    const res = ok(r);
    assert.deepEqual(res.finals.map((f) => f.slideId), ['s0001', 's0003']);
    assert.deepEqual(res.skipped.stale, ['s0002']);
    assert.ok(r.env.warnings.some((w) => w.code === 'stale-slide-skipped'));
    ok(await run('select', '--slide', 's0002', '--session', 'ex-tiny3-full', '--take', 't0002', '--workspace', ctx.ws));
    const r2 = await run('render', '--workspace', ctx.ws, '--out', path.join(ctx.dir, 'o2'));
    assert.deepEqual(ok(r2).finals.map((f) => f.slideId), ['s0001', 's0002', 's0003']);
    assert.ok(r2.env.warnings.some((w) => w.code === 'stale-take'));
  } finally { await cleanup(ctx.dir); }
});

test('大きな音声は分割する（.p001.wav…）。かたまりの大きさを変えても、出力は同じ。古い出力は片付ける', T, async () => {
  const ctx = await setup('split');
  try {
    await importScene(ctx, 'tiny3-full');
    const exp = rj(path.join(EXAMPLES, 'tiny3-full', 'expected.render.json'));
    const out = path.join(ctx.dir, 'o');
    const a = ok(await run('render', '--workspace', ctx.ws, '--out', out, '--final-max-bytes', '20000', '--chunk-samples', '777'));
    const f1 = a.finals.find((f) => f.slideId === 's0001');
    assert.equal(f1.parts.length, 2, 's0001 は 19200 サンプル = 38444 バイト');
    assert.deepEqual(f1.parts.map((p) => p.file), ['final/s0001.p001.wav', 'final/s0001.p002.wav']);
    assert.deepEqual(f1.parts.map((p) => p.samples), [9978, 9222]);
    for (const p of f1.parts) assert.ok(statSync(path.join(out, p.file)).size <= 20000);
    // 部分の PCM をつなぐと期待値と一致
    const pcm = Buffer.concat(f1.parts.map((p) => readFileSync(path.join(out, p.file)).subarray(44)));
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(pcm).digest('hex'), exp.finals[0].sha256);
    // 各部分のファイルの SHA-256 は報告と一致
    for (const p of f1.parts) assert.equal(createHash('sha256').update(readFileSync(path.join(out, p.file))).digest('hex'), p.sha256);
    const tl = rj(path.join(out, 'timeline.json'));
    assert.deepEqual(tl.slides[0].audio, ['final/s0001.p001.wav', 'final/s0001.p002.wav']);
    assert.equal(tl.slides[0].audioSamples, 19200);
    assert.equal(tl.slides[1].audio, 'final/s0002.wav', '小さい方は分割されない');
    // 分割しない・かたまりを変える：PCM は同じ
    const out2 = path.join(ctx.dir, 'o2');
    ok(await run('render', '--workspace', ctx.ws, '--out', out2, '--chunk-samples', '97'));
    assert.equal(wavPcm(path.join(out2, 'final', 's0001.wav')).sha256, exp.finals[0].sha256);
    // 同じ出力先に作り直すと、前の分割の残りは片付く
    ok(await run('render', '--workspace', ctx.ws, '--out', out));
    assert.deepEqual(readdirSync(path.join(out, 'final')).sort(), ['s0001.wav', 's0002.wav', 's0003.wav']);
    assert.deepEqual(readdirSync(out).sort(), ['final', 'slides', 'timeline.json']);
  } finally { await cleanup(ctx.dir); }
});

test('編集の記録（edits.json）の話す人ごとの倍率が音に反映され、applied.gainDb に記録される', T, async () => {
  const ctx = await setup('gain');
  try {
    const mk = (gain) => new TextEncoder().encode(JSON.stringify({ format: 'lap-narrator/edits', version: 1, sessionId: 'ex-tiny3-full', editVersion: 1, fadeSamples: 384, ...(gain ? { gainDb: { 話者A: gain } } : {}) }, null, 2) + '\n');
    const ws0 = path.join(ctx.dir, 'ws0');
    const ws1 = path.join(ctx.dir, 'ws1');
    const e0 = await exampleExport('tiny3-full', path.join(ctx.dir, 'e0'));
    const e1 = await exampleExport('tiny3-full', path.join(ctx.dir, 'e1'), { mutate: (manifest, vol, datas) => replaceFile({ manifest, datas }, 'edits.json', mk(-6)) });
    ok(await run('import', ...e0.zips, '--script', ctx.pack, '--workspace', ws0));
    ok(await run('import', ...e1.zips, '--script', ctx.pack, '--workspace', ws1));
    const a = ok(await run('render', '--workspace', ws0));
    const b = ok(await run('render', '--workspace', ws1));
    assert.equal(a.finals[0].applied.gainDb, 0);
    assert.equal(b.finals[0].applied.gainDb, -6);
    const wa = readFileSync(path.join(a.out, 'final', 's0002.wav'));
    const wb = readFileSync(path.join(b.out, 'final', 's0002.wav'));
    let peakA = 0;
    let peakB = 0;
    for (let o = 44; o < wa.length; o += 2) { peakA = Math.max(peakA, Math.abs(wa.readInt16LE(o))); peakB = Math.max(peakB, Math.abs(wb.readInt16LE(o))); }
    assert.ok(peakA > 1000);
    assert.ok(Math.abs(peakB / peakA - 0.5012) < 0.01, `ratio ${peakB / peakA}`);
  } finally { await cleanup(ctx.dir); }
});

test('台本パックを --script で渡すと、台本のハッシュで一致を確かめる（status、render）。違えば終了コード 3', T, async () => {
  const ctx = await setup('packcheck');
  try {
    await importScene(ctx, 'basic');
    ok(await run('status', '--workspace', ctx.ws, '--script', ctx.pack));
    const src2 = path.join(ctx.dir, 'src2');
    await writeTinySource(src2, { textOverride: { 0: '別の文。' } });
    const pack2 = path.join(ctx.dir, 'pack2.zip');
    ok(await run('pack', '--from-json', src2, '--out', pack2));
    for (const cmd of ['status', 'render']) {
      const r = await run(cmd, '--workspace', ctx.ws, '--script', pack2);
      assert.equal(r.code, 3, cmd);
      assert.equal(r.env.errors[0].code, 'script-mismatch');
    }
  } finally { await cleanup(ctx.dir); }
});

test('録音ファイルの周波数が出力と違う（第 1 波は変換なし）：選んだテイクなら unsupported-rate で失敗、自動で決まったテイクなら除いて警告', T, async () => {
  const ctx = await setup('rate');
  try {
    const ex = await exampleExport('basic', path.join(ctx.dir, 'ex'), {
      mutate: (manifest, vol, datas) => {
        // 録音ファイルを 44100 Hz として申告する（ヘッダーも書き換える）
        const raw = datas.find(([n]) => n === 'raw/rec-000001.wav')[1].slice();
        new DataView(raw.buffer).setUint32(24, 44100, true);
        new DataView(raw.buffer).setUint32(28, 88200, true);
        const m = replaceFile({ manifest, datas }, 'raw/rec-000001.wav', raw);
        m.manifest.rawFiles = m.manifest.rawFiles.map((r) => ({ ...r, sampleRate: 44100 }));
        return m;
      },
    });
    ok(await run('import', ...ex.zips, '--script', ctx.pack, '--workspace', ctx.ws));
    const refused = await run('render', '--workspace', ctx.ws);
    assert.equal(refused.env.errors[0].code, 'missing-slides');
    assert.deepEqual(refused.env.errors[0].detail.skipped.unrenderable, ['s0001']);
    const auto = await run('render', '--workspace', ctx.ws, '--allow-missing');
    assert.equal(auto.code, 1);
    assert.equal(auto.env.errors[0].code, 'nothing-to-render');
    assert.equal(auto.env.warnings.find((w) => w.code === 'slide-unrenderable').detail.code, 'unsupported-rate');
    ok(await run('select', '--slide', 's0001', '--session', 'ex-basic', '--take', 't0001', '--workspace', ctx.ws));
    const sel = await run('render', '--workspace', ctx.ws);
    assert.equal(sel.code, 1);
    assert.equal(sel.env.errors[0].code, 'unsupported-rate');
  } finally { await cleanup(ctx.dir); }
});
