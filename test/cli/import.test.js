// import：設計書 6.6 の表の行ごとの試験。取り込みの規則そのものは core の試験（test/core/importer.test.js）で見ている。
// ここでは、CLI としての入口（索引を先に渡す、フォルダを渡す、結果の形、終了コード、ワークスペースに残るもの）を見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { parseWavHeader, wavHeader } from '../../core/wav.js';
import { makeBoundaries } from './helpers/continuous.js';
import {
  run, tmpDir, cleanup, writeTinySource, exampleExport, snapshotDir, replaceFile, finalExport, permutations, EXAMPLES,
} from './helpers/cli.js';

const T = { timeout: 120000 };
const V2 = [['README.txt', 'script.json', 'events.jsonl', 'segments.json', 'edits.json', 'raw/rec-000001.wav'], ['raw/rec-000002.wav']];
const V3 = [['README.txt', 'script.json', 'events.jsonl', 'segments.json', 'edits.json'], ['raw/rec-000001.wav'], ['raw/rec-000002.wav']];

async function setup(label) {
  const dir = await tmpDir(label);
  await writeTinySource(path.join(dir, 'src'));
  const pack = path.join(dir, 'pack.zip');
  assert.equal((await run('pack', '--from-json', path.join(dir, 'src'), '--out', pack)).code, 0);
  return { dir, pack, ws: path.join(dir, 'ws') };
}

const ok = (r) => { assert.equal(r.code, 0, r.stdout); assert.equal(r.env.ok, true); assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] }); return r.env.result; };

test('import --audio converts an external 44.1 kHz narration without modifying the source', T, async () => {
  const { dir, pack, ws } = await setup('external-wav');
  try {
    const source = path.join(dir, 'source.wav');
    const samples = 44101;
    const pcm = Buffer.alloc(samples * 2);
    pcm.writeInt16LE(24000, 22050 * 2);
    const original = Buffer.concat([wavHeader({ sampleRate: 44100, samples }), pcm]);
    await fsp.writeFile(source, original);
    const args = ['import', '--audio', source, '--workspace', ws, '--script', pack];
    const imported = ok(await run(...args));
    assert.deepEqual(imported.audioIntake, { source, inputSampleRate: 44100, inputSamples: samples, sampleRate: 48000, samples: 48001 });
    assert.equal(imported.continuousAudio.sampleRate, 48000);
    const saved = readFileSync(path.join(ws, 'final', 'all.wav'));
    const header = parseWavHeader(saved);
    assert.equal(header.sampleRate, 48000);
    assert.equal(header.samples, 48001);
    assert.ok(saved.readInt16LE(header.dataOffset + 24000 * 2) > 18000, 'impulse remains at 0.5 seconds');
    assert.ok(readFileSync(source).equals(original));
    assert.equal(ok(await run(...args)).duplicates.length, 1);
    const script = JSON.parse(readFileSync(path.join(ws, 'script.json'), 'utf8'));
    const material = { all: { length: 48001 }, bounds: [0, 16000, 32000, 48001] };
    const boundaries = makeBoundaries({ script, material, sha256: imported.continuousAudio.sha256 });
    await fsp.writeFile(path.join(ws, 'boundaries.json'), JSON.stringify(boundaries));
    const rendered = ok(await run('render', '--workspace', ws, '--tail-margin-ms', '0'));
    assert.equal(rendered.mode, 'continuous');
    assert.deepEqual(rendered.finals.map((slide) => slide.samples), [16000, 16000, 16001]);
  } finally { await cleanup(dir); }
});

test('1 巻の全記録：索引と一緒に取り込む。結果は received／committed／pending の形、sessions/ に統合される', T, async () => {
  const { dir, pack, ws } = await setup('imp');
  try {
    const ex = await exampleExport('tiny3-full', path.join(dir, 'ex'));
    const res = ok(await run('import', ex.index, ...ex.zips, '--script', pack, '--workspace', ws));
    assert.deepEqual(res.received.map((x) => [x.exportId, x.volume, x.volumes]), [['exp-tiny3-full', 1, 1]]);
    assert.deepEqual(res.committed, ['ex-tiny3-full']);
    assert.deepEqual(res.pending, []);
    assert.deepEqual(res.duplicates, []);
    assert.deepEqual(res.warnings, []);
    const files = Object.keys(snapshotDir(ws, 'sessions/')).sort();
    assert.deepEqual(files, ['sessions/ex-tiny3-full/edits.json', 'sessions/ex-tiny3-full/events.jsonl', 'sessions/ex-tiny3-full/raw/rec-000001.wav', 'sessions/ex-tiny3-full/script.json', 'sessions/ex-tiny3-full/segments.json', 'sessions/ex-tiny3-full/session.json']);
    assert.deepEqual(Object.keys(snapshotDir(ws, 'staging/')), [], '統合したら staging は消える');
    // 台本と絵は作業場に置かれる
    assert.ok(snapshotDir(ws)['script.json'] && snapshotDir(ws)['slides/0001.png']);
    const rec = JSON.parse(readFileSync(path.join(ws, 'receipts.json'), 'utf8'));
    assert.equal(rec.length, 1);
  } finally { await cleanup(dir); }
});

test('フォルダを渡す：*.zip と *_index.json をまとめて取り込む', T, async () => {
  const { dir, pack, ws } = await setup('imp');
  try {
    await exampleExport('file-rotate', path.join(dir, 'ex'), { volumeFiles: V2 });
    const res = ok(await run('import', path.join(dir, 'ex'), '--script', pack, '--workspace', ws));
    assert.equal(res.received.length, 2);
    assert.deepEqual(res.committed, ['ex-file-rotate']);
  } finally { await cleanup(dir); }
});

test('6.6「すでに受け取った (exportId, 巻) の組」：何もしない。統合の前でも後でも、ワークスペースは変わらない', T, async () => {
  const { dir, pack, ws } = await setup('dup');
  try {
    const ex = await exampleExport('file-rotate', path.join(dir, 'ex'), { volumeFiles: V2 });
    ok(await run('import', ex.zips[1], '--script', pack, '--workspace', ws)); // 第 2 巻だけ（待ち）
    const before = snapshotDir(ws);
    const again = ok(await run('import', ex.zips[1], '--workspace', ws));
    assert.deepEqual(again.received, []);
    assert.deepEqual(again.duplicates.map((x) => [x.exportId, x.volume]), [['exp-file-rotate', 2]]);
    assert.deepEqual(again.pending, [{ exportId: 'exp-file-rotate', missing: [1] }]);
    assert.deepEqual(snapshotDir(ws), before);
    ok(await run('import', ex.zips[0], '--workspace', ws));
    const done = snapshotDir(ws);
    // 全部をもう一度（再送）：何も変わらない。committed には出さず unchanged に出す
    const resend = ok(await run('import', ...ex.zips, ex.index, '--workspace', ws));
    assert.deepEqual(resend.received, []);
    assert.equal(resend.duplicates.length, 2);
    assert.deepEqual(resend.committed, []);
    assert.deepEqual(resend.unchanged, ['ex-file-rotate']);
    assert.deepEqual(snapshotDir(ws), done);
  } finally { await cleanup(dir); }
});

test('6.6「同じ (exportId, 巻) で中身が違う」：conflicting-volume で拒否（終了コード 3）。ワークスペースは変わらない', T, async () => {
  const { dir, pack, ws } = await setup('conf');
  try {
    const a = await exampleExport('basic', path.join(dir, 'a'));
    ok(await run('import', ...a.zips, '--script', pack, '--workspace', ws));
    const before = snapshotDir(ws);
    const b = await exampleExport('basic', path.join(dir, 'b'), { mutate: (manifest, vol, datas) => replaceFile({ manifest, datas }, 'README.txt', new TextEncoder().encode('changed readme\n')) });
    const r = await run('import', ...b.zips, '--workspace', ws);
    assert.equal(r.code, 3, r.stdout);
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'conflicting-volume');
    assert.deepEqual(r.env.result.received, []);
    assert.deepEqual(snapshotDir(ws), before);
  } finally { await cleanup(dir); }
});

test('6.6「ある書き出しの一部の巻だけ」：受け取って待つ（警告 volumes-missing、ok、終了コード 0）。届く順は問わず、そろった時点で完了。どの順でも sessions/ は同じ', T, async () => {
  const { dir, pack } = await setup('vols');
  try {
    for (const [name, plan] of [['file-rotate', V2], ['file-rotate', V3]]) {
      const ex = await exampleExport(name, path.join(dir, `ex${plan.length}`), { volumeFiles: plan });
      let reference = null;
      for (const order of permutations(ex.zips.map((_, i) => i))) {
        const ws = path.join(dir, `ws-${plan.length}-${order.join('')}`);
        let committedAt = -1;
        for (let k = 0; k < order.length; k++) {
          const r = await run('import', ex.zips[order[k]], ...(k === 0 ? ['--script', pack] : []), '--workspace', ws);
          const res = ok(r);
          if (k < order.length - 1) {
            assert.equal(res.committed.length, 0, 'まだそろっていない');
            assert.equal(res.pending.length, 1);
            assert.equal(res.pending[0].missing.length, order.length - 1 - k);
            assert.deepEqual(r.env.warnings.map((w) => w.code), ['volumes-missing']);
            // 待っている間の status は、待ちを知らせる
            const st = ok(await run('status', '--workspace', ws));
            assert.deepEqual(st.pending.map((p) => p.exportId), ['exp-file-rotate']);
            assert.deepEqual(st.sessions, []);
          } else { assert.deepEqual(res.committed, ['ex-file-rotate']); committedAt = k; }
        }
        assert.equal(committedAt, order.length - 1);
        const snap = snapshotDir(ws, 'sessions/');
        if (reference === null) reference = snap; else assert.deepEqual(snap, reference, `order ${order.join(',')}`);
        assert.deepEqual(snapshotDir(ws, 'staging/'), {});
      }
    }
  } finally { await cleanup(dir); }
});

test('索引：先に渡しても、あとから渡しても、取り込める。巻のハッシュが索引と違えば拒否（終了コード 3）', T, async () => {
  const { dir, pack, ws } = await setup('idx');
  try {
    const ex = await exampleExport('file-rotate', path.join(dir, 'ex'), { volumeFiles: V2 });
    // 後から索引（巻を受け取ったあと）
    ok(await run('import', ex.zips[0], '--script', pack, '--workspace', ws));
    const r1 = ok(await run('import', ex.index, '--workspace', ws));
    assert.deepEqual(r1.received, []);
    ok(await run('import', ex.zips[1], '--workspace', ws));
    // 索引が巻と合わない：先に渡した索引で、あとから来た巻を拒否する
    const ws2 = path.join(dir, 'ws2');
    const bad = JSON.parse(JSON.stringify(ex.indexJson));
    bad.zips[1].sha256 = 'f'.repeat(64);
    const badFile = path.join(dir, 'bad_index.json');
    await fsp.writeFile(badFile, JSON.stringify(bad));
    const r2 = await run('import', badFile, ...ex.zips, '--script', pack, '--workspace', ws2);
    assert.equal(r2.code, 3, r2.stdout);
    assert.equal(r2.env.errors[0].code, 'bad-volume');
    assert.match(r2.env.errors[0].message, /index/);
    assert.deepEqual(r2.env.result.received.map((x) => x.volume), [1], '合う巻は受け取る');
    assert.deepEqual(r2.env.result.committed, []);
    assert.equal(r2.env.result.pending[0].missing[0], 2);
    // 受け取った巻を索引があとで否定する
    const ws3 = path.join(dir, 'ws3');
    ok(await run('import', ex.zips[0], '--workspace', ws3));
    const r3 = await run('import', badFile, '--workspace', ws3);
    assert.equal(r3.code, 0, '第 2 巻が未着なので、第 1 巻とだけ照合して受け取る');
    const r4 = await run('import', ex.zips[1], '--workspace', ws3);
    assert.equal(r4.code, 3);
    // 索引でないファイル
    await fsp.writeFile(path.join(dir, 'notindex.json'), '{"format":"other"}');
    const r5 = await run('import', path.join(dir, 'notindex.json'), '--workspace', ws3);
    assert.equal(r5.code, 2);
  } finally { await cleanup(dir); }
});

test('6.6「ハッシュが合わない」：zip の中身が manifest と違えば拒否（終了コード 3）。何も残らない', T, async () => {
  const { dir, pack, ws } = await setup('hash');
  try {
    const ex = await exampleExport('basic', path.join(dir, 'ex'), {
      mutate: (manifest, vol, datas) => {
        // manifest の SHA-256 はそのままで、録音ファイルの 1 バイトを変える
        const raw = datas.find(([n]) => n === 'raw/rec-000001.wav')[1].slice();
        raw[100] ^= 0xff;
        return { manifest, datas: datas.map(([n, d]) => [n, n === 'raw/rec-000001.wav' ? raw : d]) };
      },
    });
    const r = await run('import', ...ex.zips, '--script', pack, '--workspace', ws);
    assert.equal(r.code, 3, r.stdout);
    assert.equal(r.env.errors[0].code, 'bad-volume');
    assert.match(r.env.errors[0].message, /SHA-256 differs/);
    assert.deepEqual(r.env.result.received, []);
    assert.deepEqual(snapshotDir(ws, 'staging/'), {});
    assert.deepEqual(snapshotDir(ws, 'sessions/'), {});
  } finally { await cleanup(dir); }
});

test('6.6「巻が欠けている、壊れた zip」：壊れた zip、zip でないファイル、存在しないファイルは終了コード 1。ほかのファイルは取り込む', T, async () => {
  const { dir, pack, ws } = await setup('broken');
  try {
    const good = await exampleExport('basic', path.join(dir, 'good'));
    const full = readFileSync(good.zips[0]);
    const truncated = path.join(dir, 'truncated.zip');
    await fsp.writeFile(truncated, full.subarray(0, Math.floor(full.length / 2)));
    const garbage = path.join(dir, 'garbage.zip');
    await fsp.writeFile(garbage, 'this is not a zip file at all, just some text to make it longer than a header');
    const empty = path.join(dir, 'empty.zip');
    await fsp.writeFile(empty, '');
    const r = await run('import', truncated, garbage, empty, path.join(dir, 'nothere.zip'), ...good.zips, '--script', pack, '--workspace', ws);
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.env.ok, false);
    assert.deepEqual(r.env.errors.map((e) => e.code), ['cannot-read', 'bad-volume', 'bad-volume', 'bad-volume']);
    assert.deepEqual(r.env.result.committed, ['ex-basic'], '壊れていないファイルは取り込まれる');
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
  } finally { await cleanup(dir); }
});

test('完成版だけが先に届く → 全記録が後から届く（録音ファイルと履歴を補う）。同じ編集の版なら検証にだけ使う', T, async () => {
  const { dir, pack, ws } = await setup('finalfirst');
  try {
    // 全記録から完成版を作る（別の作業場で render）
    const ws0 = path.join(dir, 'ws0');
    const full = await exampleExport('tiny3-full', path.join(dir, 'full'));
    ok(await run('import', ...full.zips, '--script', pack, '--workspace', ws0));
    const rr = ok(await run('render', '--workspace', ws0));
    const fin = await finalExport({ renderResult: rr, renderOut: rr.out, sessionDir: path.join(EXAMPLES, 'tiny3-full'), outDir: path.join(dir, 'fin'), editVersion: 1, exportId: 'exp-tiny3-final' });
    // 完成版だけ
    const a = ok(await run('import', fin.index, ...fin.zips, '--script', pack, '--workspace', ws));
    assert.deepEqual(a.committed, ['ex-tiny3-full']);
    let st = ok(await run('status', '--workspace', ws));
    assert.deepEqual(st.slides.map((s) => [s.state, s.candidates[0].source]), [['single', 'final'], ['single', 'final'], ['single', 'final']]);
    assert.equal(st.totalSamples, 38400);
    let sess = JSON.parse(readFileSync(path.join(ws, 'sessions', 'ex-tiny3-full', 'session.json'), 'utf8'));
    assert.equal(sess.events, null);
    assert.equal(sess.finals[0].role, 'candidate', '全記録がまだ無いので、採用の候補');
    // 全記録が後から：録音ファイルと履歴が補われる
    const b = ok(await run('import', ...full.zips, '--workspace', ws));
    assert.deepEqual(b.unchanged.concat(b.committed), ['ex-tiny3-full']);
    sess = JSON.parse(readFileSync(path.join(ws, 'sessions', 'ex-tiny3-full', 'session.json'), 'utf8'));
    assert.equal(sess.rawFiles.length, 1);
    assert.ok(sess.events.count > 0);
    assert.equal(sess.finals[0].role, 'verify-only', '編集の版が同じ完成版は、検証にだけ使う');
    st = ok(await run('status', '--workspace', ws));
    assert.deepEqual(st.slides.map((s) => [s.state, s.candidates.length, s.candidates[0].source]), [['single', 1, 'full'], ['single', 1, 'full'], ['single', 1, 'full']]);
  } finally { await cleanup(dir); }
});

test('6.6「文のハッシュが合わないテイク」：版の食い違い（stale-slides の警告）として知らせる。status は stale', T, async () => {
  const { dir, ws } = await setup('stale');
  try {
    // 作業場の台本の 2 枚目の文を変える
    const src2 = path.join(dir, 'src2');
    await writeTinySource(src2, { textOverride: { 1: '会は毎月、第三金曜日に開きます。' } });
    const pack2 = path.join(dir, 'pack2.zip');
    ok(await run('pack', '--from-json', src2, '--out', pack2));
    const ex = await exampleExport('tiny3-full', path.join(dir, 'ex'));
    const r = await run('import', ...ex.zips, '--script', pack2, '--workspace', ws);
    const res = ok(r);
    assert.deepEqual(res.committed, ['ex-tiny3-full']);
    const w = r.env.warnings.find((x) => x.code === 'stale-slides');
    assert.deepEqual(w.detail.staleSlides, ['s0002']);
    const st = ok(await run('status', '--workspace', ws));
    assert.deepEqual(st.slides.map((s) => s.state), ['single', 'stale', 'single']);
    assert.deepEqual(st.staleSlides, ['s0002']);
    assert.equal(st.slides[1].candidates[0].stale, true);
    assert.equal(st.counts.stale, 1);
  } finally { await cleanup(dir); }
});

test('台本を差し替える：警告 script-replaced。2 つ目の台本パックを位置引数で渡しても検出する。台本パックが 2 つなら使い方の誤り', T, async () => {
  const { dir, pack, ws } = await setup('script');
  try {
    const src2 = path.join(dir, 'src2');
    await writeTinySource(src2, { textOverride: { 0: 'はじめに、別の文です。' } });
    const pack2 = path.join(dir, 'pack2.zip');
    ok(await run('pack', '--from-json', src2, '--out', pack2));
    ok(await run('import', '--script', pack, '--workspace', ws));
    const r = await run('import', pack2, '--workspace', ws); // 位置引数の台本パックも見分ける
    ok(r);
    assert.deepEqual(r.env.warnings.map((w) => w.code), ['script-replaced']);
    const bad = await run('import', pack, pack2, '--workspace', ws);
    assert.equal(bad.code, 2);
    // 台本がないまま全記録だけ
    const ws2 = path.join(dir, 'ws2');
    const ex = await exampleExport('basic', path.join(dir, 'ex'));
    const r2 = await run('import', ...ex.zips, '--workspace', ws2);
    ok(r2);
    assert.deepEqual(r2.env.warnings.map((w) => w.code), ['no-script']);
    const st = await run('status', '--workspace', ws2);
    assert.equal(st.code, 1);
    assert.equal(st.env.errors[0].code, 'no-script');
  } finally { await cleanup(dir); }
});
