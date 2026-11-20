// 書き出し：全記録（kind: full）と完成版（kind: final）、巻の分割、巻ごとの保存の動き、ZIP の中身の検証。
// 2 つのブラウザ（別々のプロフィール）で別のスライドを録り、それぞれ書き出して、core の取り込みへ順不同・再送で渡す。
// ブラウザ：work/B/profile-exportA / exportB。ポート 8112〜8115。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startStaticServer } from './helpers/static-server.js';
import { launchChrome, chromePath, waitUntil, WORK } from './helpers/chrome.js';
import { openApp } from './helpers/app-page.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { makeScript, makePcm, prng } from './helpers/fixtures.js';
import { openZip, sha, memStore } from './helpers/zipcheck.js';
import { validate } from '../../core/validate.js';
import { reduceEvents } from '../../core/reduce.js';
import { parseWavHeader } from '../../core/wav.js';
import { receiveVolume, commitIfComplete } from '../../core/importer.js';

const skip = chromePath() ? false : 'Chrome がない';
const RATE = 48000;
const DL = path.join(WORK, 'downloads');
const pcmBytes = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
const sec = (s, seed) => makePcm(Math.round(RATE * s), { seed });

describe('書き出し', { skip }, () => {
  let server; let chromeA; let chromeB;
  const state = {};
  before(async () => {
    await acquireBrowserLock(); // ブラウザを使う試験ファイルは 1 つずつ動かす
    fs.rmSync(DL, { recursive: true, force: true });
    fs.mkdirSync(DL, { recursive: true });
    server = await startStaticServer({ port: 8112 });
    chromeA = await launchChrome({ name: 'exportA', port: 8113 });
    chromeB = await launchChrome({ name: 'exportB', port: 8114 });
  });
  after(async () => {
    if (chromeA) await chromeA.close();
    if (chromeB) await chromeB.close();
    if (server) await server.close();
    releaseBrowserLock();
  });

  /** 1 巻ずつ：作る → ダウンロード → 保存を確かめる → 次の巻。保存した ZIP（Buffer）の列を返す。 */
  async function exportAll(app, opts, { checkOneAtATime = true } = {}) {
    const sum = await app.page.evaluate((o) => window.__lap.exportStart(o), opts);
    const bufs = [];
    for (let n = 1; n <= sum.volumes; n++) {
      const built = await app.page.evaluate((k) => window.__lap.exportBuild(k), n);
      if (checkOneAtATime) {
        const inOpfs = await app.page.evaluate(() => window.__lap.exportFilesInOpfs());
        assert.equal(inOpfs.length, 1, `端末内に残る書き出しは 1 巻分だけ（${inOpfs}）`);
      }
      if (n < sum.volumes && checkOneAtATime) {
        // 保存を確かめるまで、次の巻は作れない
        const err = await app.page.evaluate((k) => window.__lap.exportBuild(k).then(() => null, (e) => e.code), n + 1);
        assert.equal(err, 'out-of-order');
      }
      const dl = app.page.waitForEvent('download', { timeout: 30000 });
      await app.page.evaluate((k) => window.__lap.exportDownload(k), n);
      const download = await dl;
      assert.equal(download.suggestedFilename(), built.file);
      const saved = path.join(DL, `${opts.kind}-${sum.exportId}-${n}.zip`);
      await download.saveAs(saved);
      const buf = fs.readFileSync(saved);
      assert.equal(buf.length, built.bytes, '保存された大きさが一致する');
      assert.equal(sha(buf), built.sha256, '保存された ZIP のハッシュが一致する');
      bufs.push({ buf, built });
      await app.page.evaluate((k) => window.__lap.exportConfirm(k), n);
      assert.deepEqual(await app.page.evaluate(() => window.__lap.exportFilesInOpfs()), [], '保存を確かめたら、一時ファイルを消す');
    }
    const index = await app.page.evaluate(() => window.__lap.exportIndex());
    return { sum, bufs, index };
  }

  test('2 つのブラウザで別々のスライドを録る（A：スライド 1 と 2、B：スライド 3）', async () => {
    const script = makeScript({ slides: 3, projectId: 'proj-export1' });
    state.script = script;
    // ブラウザ A：録音ファイルは 2 秒（192000 バイト）で切り替える。巻は 300000 バイトまで
    const A = await openApp(chromeA, server.origin, '?devinput=1&countdown=0&rawMax=192000&volumeMax=300000&finalMax=100044&durableMs=500');
    await A.loadScript(script);
    await A.newSession('proj-export1', { speaker: 'Speaker A' });
    const a = sec(3, 1); const b = sec(1, 2); const c = sec(2, 3); const d = sec(0.5, 4); const e = sec(1.5, 5);
    await A.press('record');
    await A.feed(a); await A.press('ok');
    await A.feed(b); await A.press('retake');
    await A.press('record');
    await A.feed(c); await A.press('ok');
    await A.feed(d);
    await A.press('next'); // 録音は止まらず、スライド 2 の新しいテイクが同じ位置から始まる
    assert.equal((await A.state()).slideId, 's0002');
    assert.equal((await A.state()).recording, true);
    await A.feed(e); await A.press('ok'); await A.press('pause');
    state.A = A;
    state.fedAll = Buffer.concat([a, b, c, d, e].map(pcmBytes));
    state.keptSlide1 = Buffer.concat([a, c, d].map(pcmBytes));
    state.keptSlide2 = pcmBytes(e);
    assert.equal((await A.state()).rawFiles.length, 4);

    const B = await openApp(chromeB, server.origin, '?devinput=1&countdown=0&durableMs=500');
    await B.loadScript(script);
    await B.newSession('proj-export1', { speaker: 'Speaker B' });
    await B.press('goto', 's0003');
    const f = sec(2, 6);
    await B.press('record');
    await B.feed(f); await B.press('ok'); await B.press('pause');
    state.B = B;
    state.fedB = pcmBytes(f);
  });

  test('全記録（full）を巻に分けて書き出す：1 巻ずつ作り、保存を確かめてから次へ。中身が仕様どおり', { timeout: 120000 }, async () => {
    const A = state.A;
    const { sum, bufs, index } = await exportAll(A, { kind: 'full' });
    state.fullA = { sum, bufs, index };
    assert.ok(sum.volumes >= 3, `巻に分かれた（${sum.volumes} 巻）`);
    const events0 = await A.events();
    const exportEvent = events0.find((e) => e.type === 'export' && e.exportId === sum.exportId);
    assert.deepEqual([exportEvent.kind, exportEvent.volumes], ['full', sum.volumes]);

    const manifests = [];
    const rawContents = new Map();
    let total = 0;
    for (let i = 0; i < bufs.length; i++) {
      const { buf, built } = bufs[i];
      const zip = await openZip(buf);
      assert.ok(zip.names.includes('manifest.json'), `第 ${i + 1} 巻に manifest.json がある`);
      const m = JSON.parse((await zip.readAll('manifest.json')).toString('utf8'));
      assert.deepEqual(validate('manifest', m).errors, []);
      manifests.push(m);
      assert.deepEqual([m.kind, m.volume, m.volumes, m.exportId, m.projectId, m.scriptHash], ['full', i + 1, sum.volumes, sum.exportId, 'proj-export1', state.script.scriptHash]);
      assert.equal(m.editVersion, 1, '全記録の manifest にも編集の版を書く');
      assert.equal(m.renderSpec.preserveFileRotations, true);
      assert.equal(m.speaker, 'Speaker A');
      assert.equal(m.mic.requested.source, 'dev-input');
      // files[]：その巻のファイル（manifest 自身を除く）。大きさと SHA-256 が実物と一致する
      const others = zip.names.filter((n) => n !== 'manifest.json').sort();
      assert.deepEqual(m.files.map((f) => f.path).sort(), others);
      for (const f of m.files) {
        const data = await zip.readAll(f.path);
        assert.equal(data.length, f.bytes, f.path);
        assert.equal(sha(data), f.sha256, f.path);
        if (f.path.startsWith('raw/')) rawContents.set(f.path, data);
      }
      // 第 1 巻に記録のファイル、第 2 巻以降は manifest と録音ファイルだけ
      const docs = ['README.txt', 'script.json', 'events.jsonl', 'segments.json', 'edits.json'];
      if (i === 0) for (const d of docs) assert.ok(zip.names.includes(d), `第 1 巻に ${d}`);
      else assert.deepEqual(others.filter((n) => !n.startsWith('raw/')), []);
      assert.ok(others.some((n) => n.startsWith('raw/')) || i === 0, '録音ファイルを持たない巻はない');
      // 巻の大きさの上限（1 つで超えるものを除く）
      if (m.files.length > 1) assert.ok(buf.length <= 300000, `第 ${i + 1} 巻 ${buf.length} <= 300000`);
      total += buf.length;
      assert.deepEqual(m.rawFiles, manifests[0].rawFiles, '全巻の manifest が、全体の録音ファイルの一覧を持つ');
      assert.equal(built.bytes, buf.length);
    }
    // 録音ファイル：WAV（44 バイトの標準ヘッダー）。つなぐと、流した音声そのもの（撮り直した声も含む）
    const m0 = manifests[0];
    assert.equal(m0.rawFiles.length, 4);
    const pcmParts = [];
    for (const r of m0.rawFiles) {
      const wav = rawContents.get(r.file);
      assert.ok(wav, r.file);
      const h = parseWavHeader(new Uint8Array(wav.buffer, wav.byteOffset, 44));
      assert.deepEqual([h.sampleRate, h.channels, h.bits, h.samples, h.dataOffset], [RATE, 1, 16, r.samples, 44]);
      assert.equal(wav.length, 44 + r.samples * 2);
      assert.equal(sha(wav), r.sha256);
      assert.ok(r.durableSamples <= r.samples && r.durableSamples > 0);
      pcmParts.push(wav.subarray(44));
    }
    assert.ok(Buffer.concat(pcmParts).equals(state.fedAll), '録音ファイルをつなぐと、流した音声と 1 サンプルの欠落もなく一致する');

    // events.jsonl：各行がスキーマに通り、書き出しの事実を含む。segments.json は events.jsonl から再現できる
    const zip1 = await openZip(bufs[0].buf);
    const lines = (await zip1.readAll('events.jsonl')).toString('utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    lines.forEach((e, i) => { assert.equal(e.seq, i); assert.deepEqual(validate('events', e).errors, [], `seq ${i}`); });
    assert.ok(lines.some((e) => e.type === 'export' && e.exportId === sum.exportId));
    const segments = JSON.parse((await zip1.readAll('segments.json')).toString('utf8'));
    assert.deepEqual(validate('segments', segments).errors, []);
    const again = reduceEvents(lines, m0.rawFiles.map((r) => ({ name: r.file.replace(/^raw\/|\.wav$/g, ''), sampleRate: r.sampleRate, samples: r.samples, durableSamples: r.durableSamples })));
    const { state: _s, ...expectSeg } = again;
    assert.deepEqual(JSON.parse(JSON.stringify({ ...expectSeg, sessionId: segments.sessionId })), segments);
    assert.deepEqual(segments.issues, []);
    const slide1 = segments.takes.find((t) => t.slideId === 's0001');
    assert.equal(slide1.samples, state.keptSlide1.length / 2);
    const editsJson = JSON.parse((await zip1.readAll('edits.json')).toString('utf8'));
    assert.deepEqual(validate('edits', editsJson).errors, []);
    assert.equal(editsJson.editVersion, m0.editVersion, 'edits.json と manifest の編集の版が同じ');
    const script = JSON.parse((await zip1.readAll('script.json')).toString('utf8'));
    assert.equal(script.scriptHash, state.script.scriptHash);
    const readmeText = (await zip1.readAll('README.txt')).toString('utf8');
    assert.match(readmeText, /撮り直した声も含みます/);
    assert.ok(readmeText.split('\n').includes(`volumes  : ${sum.volumes}`), 'README の巻の数が実際の数');
    assert.doesNotMatch(readmeText, /volumes {2}: \?/);

    // 索引：全巻の ZIP のハッシュ
    assert.deepEqual(validate('index', index).errors, []);
    assert.deepEqual(index.zips.map((z) => [z.volume, z.bytes, z.sha256]), bufs.map((b, i) => [i + 1, b.buf.length, sha(b.buf)]));
    assert.ok(total > 0);
  });

  test('完成版（final）を巻に分けて書き出す：スライド別の WAV、分割したときは .p001.wav …', { timeout: 120000 }, async () => {
    const A = state.A;
    const { sum, bufs, index } = await exportAll(A, { kind: 'final' });
    state.finalA = { sum, bufs, index };
    assert.ok(sum.volumes >= 2);
    const files = new Map();
    let m0;
    for (let i = 0; i < bufs.length; i++) {
      const zip = await openZip(bufs[i].buf);
      const m = JSON.parse((await zip.readAll('manifest.json')).toString('utf8'));
      assert.deepEqual(validate('manifest', m).errors, []);
      assert.deepEqual([m.kind, m.volume, m.volumes], ['final', i + 1, sum.volumes]);
      assert.equal(m.editVersion, 1, '完成版では書き出し側が必ず editVersion を書く（CONTRACTS 7.4）');
      if (i === 0) { m0 = m; assert.ok(zip.names.includes('script.json')); }
      assert.deepEqual(m.finals, m0.finals, '全巻の manifest が、完成した音声の全体の一覧を持つ');
      assert.deepEqual(m.files.map((f) => f.path).sort(), zip.names.filter((n) => n !== 'manifest.json').sort());
      for (const f of m.files) {
        const data = await zip.readAll(f.path);
        assert.equal(sha(data), f.sha256, f.path);
        if (f.path.startsWith('final/')) files.set(f.path, data);
      }
      assert.ok(zip.names.every((n) => n === 'manifest.json' || n === 'script.json' || n.startsWith('final/')));
    }
    assert.equal(m0.renderSpec.version, 1);
    assert.equal(m0.renderSpec.preserveFileRotations, true);
    assert.deepEqual(m0.finals.map((f) => f.slideId), ['s0001', 's0002'], '録音していないスライドは含まない');
    const expected = { s0001: state.keptSlide1, s0002: state.keptSlide2 };
    for (const f of m0.finals) {
      assert.deepEqual([f.applied.gainDb, f.applied.limiter], [0, 'none']);
      assert.equal(f.sampleRate, RATE);
      assert.ok(f.parts.length >= 2, `${f.slideId} は ${f.parts.length} 分割`);
      f.parts.forEach((p, i) => assert.equal(p.file, `final/${f.slideId}.p${String(i + 1).padStart(3, '0')}.wav`));
      const pcm = [];
      let samples = 0;
      for (const p of f.parts) {
        const wav = files.get(p.file);
        assert.ok(wav && wav.length <= 100044, `${p.file} は上限以下`);
        assert.equal(sha(wav), p.sha256);
        assert.equal(parseWavHeader(new Uint8Array(wav.buffer, wav.byteOffset, 44)).samples, p.samples);
        pcm.push(wav.subarray(44));
        samples += p.samples;
      }
      assert.equal(samples, f.samples);
      // 採用の区間は連続しているわけではない（撮り直しで間が空く）ので、つなぎ目にフェードがかかる。
      // フェードの外側（つなぎ目から離れた部分）は入力と一致する
      const out = Buffer.concat(pcm);
      const want = expected[f.slideId];
      assert.equal(out.length, want.length);
      if (f.slideId === 's0002') assert.ok(out.equals(want), '1 区間だけのテイクは、入力と一致する');
      else {
        // 撮り直しの境目だけにフェードがかかる。録音ファイルの切り替えでは入力と一致する。
        const fade = 384;
        const joins = [144000];
        let from = 0;
        for (const j of [...joins, want.length / 2]) {
          const to = j === want.length / 2 ? j : j - fade;
          assert.ok(out.subarray(from * 2, to * 2).equals(want.subarray(from * 2, to * 2)), `区間 ${from}..${to} は入力と一致する`);
          from = j + fade;
        }
        assert.ok(!out.subarray((144000 - fade) * 2, (144000 + fade) * 2).equals(want.subarray((144000 - fade) * 2, (144000 + fade) * 2)), 'つなぎ目にはフェードがかかる');
      }
    }
    // 巻の順序と再送に備えて、保存した ZIP の索引
    assert.equal(index.volumes, sum.volumes);
  });

  test('ブラウザ B も全記録と完成版を書き出し、2 つの書き出しを core の取り込みへ、順不同・再送で渡すと、どの順でも同じ結果になる', { timeout: 120000 }, async () => {
    const B = state.B;
    const fullB = await exportAll(B, { kind: 'full' });
    const finalB = await exportAll(B, { kind: 'final' });
    assert.equal(fullB.sum.volumes, 1);
    const sets = [state.fullA, state.finalA, fullB, finalB];

    const run = async (order) => {
      const store = memStore();
      const log = [];
      for (const [si, vi] of order) {
        const { buf } = sets[si].bufs[vi];
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const r = await receiveVolume(store, { name: `s${si}v${vi}.zip`, size: u8.length, read: async (s, e) => u8.slice(s, e) });
        log.push(r.status);
      }
      const results = [];
      for (const s of sets) results.push(await commitIfComplete(store, s.sum.exportId));
      return { store, log, results };
    };
    const forward = [];
    sets.forEach((s, si) => s.bufs.forEach((_, vi) => forward.push([si, vi])));
    const reverse = [...forward].reverse();
    // 第 2 巻が先着 → 第 1 巻 → 第 2 巻を再送
    const shuffled = [[0, 1], [0, 0], [0, 1], ...forward.filter(([si, vi]) => !(si === 0 && vi < 2)), [2, 0]];
    const r1 = await run(forward);
    const r2 = await run(reverse);
    const r3 = await run(shuffled);
    for (const r of [r1, r2, r3]) {
      assert.ok(r.results.every((x) => x.committed === true), JSON.stringify(r.results));
    }
    assert.ok(r3.log.includes('duplicate'), '再送は何もしない');
    const snapshot = (st) => [...st.files.keys()].filter((k) => k.startsWith('sessions/')).sort().map((k) => `${k}:${sha(Buffer.from(st.files.get(k)))}`);
    // 同じセッションの全記録と完成版は、編集の版が同じなので、完成版は検証にだけ使う（候補にならない）
    for (const r of [r1, r2, r3]) {
      const key = [...r.store.files.keys()].find((k) => k.endsWith('/session.json') && k.includes(r1.results[0].sessionId));
      const sj = JSON.parse(Buffer.from(r.store.files.get(key)).toString('utf8'));
      assert.ok(sj.finals.length >= 1);
      assert.deepEqual(sj.finals.map((f) => [f.editVersion, f.role]), sj.finals.map(() => [1, 'verify-only']));
    }
    const s1 = snapshot(r1.store);
    assert.ok(s1.length > 5);
    assert.deepEqual(snapshot(r2.store), s1, '逆の順でも同じ');
    assert.deepEqual(snapshot(r3.store), s1, '順不同・再送でも同じ');
  });

  test('画面から書き出す：含まれるものの一覧、巻ごとの「作る → 保存 → 保存できました → 次の巻」、索引', { timeout: 120000 }, async () => {
    // 前の試験が chromeB に残したページは、録音の保存の鍵（同時に 1 つのページだけが書ける）を持ったままのことがある。閉じてから始める
    for (const p of chromeB.context.pages()) await p.close().catch(() => {});
    const D = await openApp(chromeB, server.origin, '?devinput=1&countdown=0&volumeMax=250000&rawMax=192000');
    await D.loadScript(makeScript({ slides: 3, projectId: 'proj-uiexp01' }));
    await D.newSession('proj-uiexp01', { speaker: 'Speaker D' });
    await D.press('record');
    await D.feed(sec(5, 9)); await D.press('ok'); await D.press('pause');
    const page = D.page;
    await page.click('#btn-back');
    await page.waitForSelector('#view-home:not([hidden])');
    await page.waitForSelector('[data-session] [data-act=export-session]');
    await page.locator('[data-session]').first().locator('[data-act=export-session]').click();
    await page.waitForSelector('#dlg-export[open]');
    const text = await page.textContent('#export-body');
    assert.match(text, /撮り直した声も含みます/);
    assert.match(text, /操作の履歴/);
    assert.match(text, /端末の情報/);
    await page.click('#export-start');
    for (let n = 1; n < 20; n++) {
      // n 巻目ができて、保存のボタンが出る
      await page.waitForFunction((k) => document.querySelectorAll('[data-act=save-volume]').length === k, n, { timeout: 20000 });
      const nextBtn = page.locator('[data-act=confirm-volume]').last();
      assert.equal(await nextBtn.isDisabled(), true, '保存するまで次へ進めない');
      const dl = page.waitForEvent('download');
      await page.locator('[data-act=save-volume]').last().click();
      const d = await dl;
      assert.equal(d.suggestedFilename().endsWith(`_full_v${String(n).padStart(3, '0')}.zip`), true, d.suggestedFilename());
      await nextBtn.click();
      // 次の巻ができるか、索引のボタンが出る
      await page.waitForFunction((k) => document.querySelector('[data-act=save-index]') || document.querySelectorAll('[data-act=save-volume]').length > k, n, { timeout: 20000 });
      if (await page.locator('[data-act=save-index]').count()) break;
    }
    assert.ok((await page.locator('[data-act=save-volume]').count()) >= 3, '巻に分かれた');
    const idl = page.waitForEvent('download');
    await page.click('[data-act=save-index]');
    assert.equal((await idl).suggestedFilename().endsWith('_index.json'), true);
    assert.match(await page.textContent('#export-log'), /書き出しが終わりました/);
    await page.click('#export-close');
    assert.deepEqual(D.errors, []);
    await page.close();
  });

  test('Android の保存結果を待ち、取りやめ・失敗から再試行できる。未選択や閉じた書き出しは完了しない', { timeout: 120000 }, async () => {
    const P = await openApp(chromeB, server.origin, '?devinput=1&countdown=0');
    await P.loadScript(makeScript({ slides: 2, projectId: 'proj-expnative' }));
    const sessionId = await P.newSession('proj-expnative');
    await P.press('record');
    await P.feed(sec(1, 7)); await P.press('ok'); await P.press('pause');
    const page = P.page;
    page.setDefaultTimeout(10000);
    await page.evaluate(() => {
      window.saveRequests = [];
      window.lapSaveBlob = (blob, name) => new Promise((resolve) => {
        window.saveRequests.push({ name, bytes: blob.size, resolve });
      });
    });
    await page.click('#btn-back');
    const dialog = page.locator('#dlg-export');
    const open = async () => {
      await page.locator(`[data-session="${sessionId}"] [data-act=export-session]`).click();
      await page.waitForSelector('#dlg-export[open]');
    };
    await open();
    await page.locator('#export-kind-full').uncheck();
    assert.equal(await page.locator('#export-start').isDisabled(), true);
    assert.equal(await page.locator('#export-log').count(), 0);
    await page.click('#export-close');
    await page.waitForSelector('#dlg-export[open]', { state: 'hidden' });

    await open();
    await page.click('#export-start');
    const save = page.locator('[data-act=save-volume]');
    const next = page.locator('[data-act=confirm-volume]');
    await save.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.doesNotMatch(await page.textContent('#export-log'), /書き出しが終わりました|端末内の録音の削除/);

    await open();
    await page.click('#export-start');
    const reply = async (request, result) => {
      await page.waitForFunction((n) => window.saveRequests.length === n, request + 1);
      await page.evaluate(([i, r]) => window.saveRequests[i].resolve(r), [request, result]);
    };
    await save.click();
    assert.equal(await save.isDisabled(), true);
    assert.equal(await next.isDisabled(), true);
    await reply(0, { ok: false, cancelled: true });
    await page.getByText('保存を取りやめました。もう一度保存できます。').waitFor();
    assert.equal(await next.isDisabled(), true);
    await save.click();
    await reply(1, { ok: false, error: 'write failed' });
    await page.getByText(/書き出しに失敗しました.*write failed/).waitFor();
    assert.equal(await next.isDisabled(), true);
    assert.doesNotMatch(await page.textContent('#export-log'), /書き出しが終わりました|端末内の録音の削除/);
    await save.click();
    await reply(2, { ok: true });
    await next.click();
    await page.getByText('書き出しが終わりました。').waitFor();
    assert.equal(await save.isDisabled(), true);

    const index = page.locator('[data-act=save-index]');
    await index.click();
    assert.equal(await index.isDisabled(), true);
    await reply(3, { ok: false, error: 'index failed' });
    await page.getByText(/書き出しに失敗しました.*index failed/).waitFor();
    await index.click();
    await reply(4, { ok: true });
    await page.getByText('索引を保存しました。').waitFor();
    const requests = await page.evaluate(() => window.saveRequests.map(({ name, bytes }) => [name, bytes]));
    assert.deepEqual(requests.slice(0, 3), Array(3).fill(requests[0]));
    assert.deepEqual(requests[3], requests[4]);
    assert.match(requests[0][0], /_full_v001\.zip$/);
    assert.match(requests[3][0], /_index\.json$/);
    await page.click('#export-close');

    await open();
    await page.click('#export-start');
    await save.click();
    await page.waitForFunction(() => window.saveRequests.length === 6);
    await page.click('#export-close');
    await page.waitForSelector('#view-home:not([hidden])');
    await reply(5, { ok: true });
    assert.equal(await next.isDisabled(), true);
    assert.doesNotMatch(await page.textContent('#export-log'), /書き出しが終わりました|端末内の録音の削除/);
    assert.deepEqual(P.errors, []);
    await page.close();
  });

  // D-002 の 2：巻の計画が、巻の大きさの境目で plan-changed になった
  test('巻の大きさをいろいろに変えても書き出せる：D-002 の再現、巻の大きさの掃引、無作為な大きさと録音の中身', { timeout: 170000 }, async () => {
    let P = await openApp(chromeB, server.origin, '?devinput=1&countdown=0&durableMs=250&volumeMax=200000');
    const tone = (sec, freq, seed) => makePcm(Math.round(RATE * sec), { seed, freq });
    const setMax = (v) => P.page.evaluate((x) => { window.__lap.app.config.volumeMaxBytes = x; }, v);
    const tryExport = async (kind, max, { build = false } = {}) => {
      await setMax(max);
      const r = await P.page.evaluate((k) => window.__lap.exportStart({ kind: k }).then((s) => ({ ok: true, s }), (e) => ({ ok: false, code: e.code, message: e.message })), kind);
      assert.equal(r.ok, true, `${kind} volumeMax=${max}: ${r.code} ${r.message}`);
      if (build) {
        const sizes = [];
        for (let n = 1; n <= r.s.volumes; n++) {
          const b = await P.page.evaluate((k) => window.__lap.exportBuild(k), n);
          sizes.push(b.bytes);
          if (r.s.volumes > 1 || b.bytes > max) assert.ok(b.bytes <= max || r.s.plan[n - 1].files.length === 1, `巻の大きさの上限（${b.bytes} <= ${max}）`);
          await P.page.evaluate((k) => window.__lap.exportConfirm(k), n);
        }
        assert.equal(sizes.length, r.s.volumes, '見積もりの巻の数と、作った巻の数が同じ');
      }
      return r.s;
    };

    // 再現：600Hz 1.2 秒 → ok → 4200Hz 0.6 秒 → retake → 600Hz 1.0 秒 → ok
    await P.loadScript(makeScript({ slides: 3, projectId: 'proj-planchg1' }));
    await P.newSession('proj-planchg1');
    await P.press('record');
    await P.feed(tone(1.2, 600, 1)); await P.press('ok');
    await P.feed(tone(0.6, 4200, 2)); await P.press('retake');
    await P.press('record');
    await P.feed(tone(1.0, 600, 3)); await P.press('ok'); await P.press('pause');
    for (const max of [150000, 200000, 250000, 300000]) {
      await tryExport('full', max, { build: true });
      await tryExport('final', max);
    }
    // 掃引：同じ録音で、巻の大きさを細かく変える（境目をまたぐ）
    const counts = new Set();
    for (let max = 60000; max <= 420000; max += 3000) counts.add((await tryExport('full', max)).volumes);
    assert.ok(counts.size >= 2, `巻の数が変わる（${[...counts]}）`);

    // 無作為な大きさと録音の中身（種を固定）。録音ファイルを 1 秒ごとに切り替えて、巻の数が増えるようにする
    assert.deepEqual(P.errors, []);
    await P.page.close();
    P = await openApp(chromeB, server.origin, '?devinput=1&countdown=0&durableMs=250&volumeMax=200000&rawMax=96000');
    const manyCounts = new Set();
    const rnd = prng(20261116);
    for (let it = 0; it < 16; it++) {
      const id = `proj-plan${String(it).padStart(4, '0')}`;
      await P.loadScript(makeScript({ slides: 3, projectId: id }));
      await P.newSession(id);
      await P.press('record');
      const parts = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < parts; k++) {
        await P.feed(tone(0.5 + rnd() * 1.5, 200 + Math.floor(rnd() * 4800), 100 + it * 10 + k));
        await P.press('ok');
        if (rnd() < 0.5) { await P.feed(tone(0.1 + rnd(), 300 + Math.floor(rnd() * 4000), 500 + k)); await P.press('retake'); await P.press('record'); }
      }
      await P.press('pause');
      const max = 30000 + Math.floor(rnd() * 270000);
      const s = await tryExport(rnd() < 0.5 ? 'full' : 'final', max, { build: true });
      manyCounts.add(s.volumes);
    }
    assert.ok(manyCounts.size >= 3, `巻の数がいろいろに変わる（${[...manyCounts]}）`);
    assert.deepEqual(P.errors, []);
    await P.page.close();
  });

  test('大きい録音でも、全体をメモリに載せずに書き出せる（約 40MB の録音ファイルを書き出して、使用メモリの増加が小さい）', { timeout: 180000 }, async () => {
    const C = await openApp(chromeB, server.origin, '?devinput=1&countdown=0&durableMs=1000');
    await C.loadScript(makeScript({ slides: 3, projectId: 'proj-bigexp1' }));
    await C.newSession('proj-bigexp1');
    await C.press('record');
    const chunk = makePcm(1_000_000, { seed: 77 });
    for (let i = 0; i < 20; i++) await C.feed(chunk);
    await C.press('ok'); await C.press('pause');
    const rawBytes = (await C.state()).rawFiles[0].samples * 2;
    assert.equal(rawBytes, 40_000_000);
    const before = await C.page.evaluate(() => window.__lap.heapUsed());
    let peak = before;
    const sum = await C.page.evaluate(() => window.__lap.exportStart({ kind: 'full' }));
    assert.equal(sum.volumes, 1);
    const poll = setInterval(() => { C.page.evaluate(() => window.__lap.heapUsed()).then((h) => { if (h > peak) peak = h; }).catch(() => {}); }, 100);
    const built = await C.page.evaluate(() => window.__lap.exportBuild(1));
    clearInterval(poll);
    assert.ok(built.bytes > 40_000_000);
    assert.ok(peak - before < 25_000_000, `使用メモリの増加 ${(peak - before) / 1e6} MB（40MB の録音に対して）`);
    // 一部を読んで確かめる（先頭が ZIP の局所ヘッダー）
    const head = Buffer.from(await C.page.evaluate(() => window.__lap.exportReadVolume(1, 0, 4)), 'base64');
    assert.equal(head.toString('latin1', 0, 2), 'PK');
    await C.page.evaluate(() => window.__lap.exportConfirm(1));
    await C.page.close();
  });
});
