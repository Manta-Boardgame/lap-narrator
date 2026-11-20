// T3 (1)：既知の PCM を直接流し、保存された録音ファイルが 1 サンプルも欠けずに入力と一致する。
// あわせて、操作（OK、撮り直し、取り消し、次へ）が書く操作記録を、core の検査と解釈に通す。
// ブラウザ：インストール済みの Chrome を、work/B/profile-pipeline の専用のプロフィールで起動する。ポート 8100〜8102。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startStaticServer, REPO_ROOT } from './helpers/static-server.js';
import { launchChrome, chromePath, waitUntil, WORK } from './helpers/chrome.js';
import { openApp } from './helpers/app-page.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { makeScript, makePcm } from './helpers/fixtures.js';
import { validate } from '../../core/validate.js';
import { reduceEvents } from '../../core/reduce.js';
import { createZipWriter } from '../../core/zip.js';
import { sha256Hex } from '../../core/sha256.js';

const skip = chromePath() ? false : 'Chrome がない';
const RATE = 48000;

describe('録音の保存（既知の PCM、操作記録）', { skip }, () => {
  let server; let chrome;
  before(async () => {
    await acquireBrowserLock(); // ブラウザを使う試験ファイルは 1 つずつ動かす
    server = await startStaticServer({ port: 8100 });
    chrome = await launchChrome({ name: 'pipeline', port: 8101 });
  });
  after(async () => {
    if (chrome) await chrome.close();
    if (server) await server.close();
    releaseBrowserLock();
  });

  const posConsistent = (events, rawFiles) => {
    for (const e of events) {
      for (const k of ['at', 'toAt']) {
        const at = e[k];
        if (!at) continue;
        let base = 0;
        for (const r of rawFiles) { if (r.name === at.raw) break; base += r.samples; }
        assert.equal(at.pos, base + at.sample, `seq ${e.seq} ${k} の pos と (raw, sample) が整合する`);
        const rf = rawFiles.find((r) => r.name === at.raw);
        assert.ok(rf && at.sample <= rf.samples, `seq ${e.seq} の位置が録音ファイルの長さを超えない`);
      }
    }
  };

  test('既知の PCM を 6 秒流す：録音ファイルを分けても、つなぐと入力とバイト単位で一致する（file-rotate）', async () => {
    // rawMax = 96000 バイト = 48000 サンプル（1 秒）で切り替える
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0&rawMax=96000&durableMs=250');
    const projectId = await app.loadScript(makeScript({ slides: 3 }));
    const sessionId = await app.newSession(projectId);
    const pcm = makePcm(RATE * 6, { seed: 11 });
    assert.equal((await app.press('record')).ok, true);
    // 切れ目が録音ファイルの境目とずれるよう、大きさの違う流し方を混ぜる
    const cuts = [1000, 47000, 4097, 100000, 36903, 98999 - 1];
    let off = 0;
    for (const n of cuts) { await app.feed(pcm.subarray(off, off + n), { chunk: n % 2 ? 777 : 4096 }); off += n; }
    await app.feed(pcm.subarray(off), { chunk: 3000 });
    assert.equal((await app.press('pause')).ok, true);

    const st = await app.state();
    assert.equal(st.rawFiles.length, 6, '1 秒ごとに 6 つ');
    assert.deepEqual(st.rawFiles.map((r) => r.samples), Array(6).fill(RATE));
    const parts = [];
    for (const r of st.rawFiles) parts.push(await app.readRaw(r.name));
    const saved = Buffer.concat(parts);
    const expected = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    assert.equal(saved.length, expected.length, '1 サンプルも欠けていない');
    assert.ok(saved.equals(expected), '内容が入力と一致する');

    // 端末の中の実際のファイルの大きさも一致する
    const onDisk = await app.rawSizesOnDisk(sessionId);
    for (const r of st.rawFiles) assert.equal(onDisk[r.name], r.samples * 2);

    // 操作記録：file-rotate は 5 回。位置が整合する。各行がスキーマに通る
    const events = await app.events();
    const rotates = events.filter((e) => e.type === 'file-rotate');
    assert.equal(rotates.length, 5);
    rotates.forEach((e, i) => {
      assert.equal(e.from, `rec-00000${i + 1}`);
      assert.equal(e.to, `rec-00000${i + 2}`);
      assert.equal(e.at.sample, RATE);
      assert.equal(e.toAt.sample, 0);
      assert.equal(e.at.pos, e.toAt.pos);
    });
    posConsistent(events, st.rawFiles);
    events.forEach((e, i) => { assert.equal(e.seq, i); assert.deepEqual(validate('events', e).errors, [], `seq ${i}`); });
    // 保存位置（durable）は、書いた音声を超えない。最後の durable は終わりまで進んでいる
    const durables = events.filter((e) => e.type === 'durable');
    assert.ok(durables.length >= 12, `約 0.25 秒ごとに書く（実際 ${durables.length}）`);
    assert.ok(durables.every((d, i) => i === 0 || d.at.pos > durables[i - 1].at.pos));
    assert.equal(durables.at(-1).at.pos, RATE * 6);
    assert.deepEqual(app.errors, []);
    await app.page.close();
  });

  test('OK、撮り直し（連続）、取り消し、やり直し、次へ：操作記録が core の検査と解釈に通る', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0&durableMs=500');
    const projectId = await app.loadScript(makeScript({ slides: 3, projectId: 'proj-ops001' }));
    const sessionId = await app.newSession(projectId);
    const sec = (s, seed) => makePcm(Math.round(RATE * s), { seed });

    await app.press('record');
    await app.feed(sec(2, 1)); // 2 秒
    assert.equal((await app.press('ok')).checkpointId, 'c0001');
    await app.feed(sec(1, 2)); // 1 秒（これを撮り直す）
    const rt = await app.press('retake');
    assert.deepEqual([rt.ok, rt.to], [true, 'c0001']);
    let st = await app.state();
    assert.equal(st.mode, 'paused');
    assert.equal(st.recording, false);
    assert.equal(st.pendingSamples, 0);

    // 再開：新しい録音ファイル。同じテイクの続き
    const resumed = await app.press('record');
    assert.equal(resumed.type, 'resume');
    await app.feed(sec(2, 3));
    await app.press('ok'); // c0002
    await app.feed(sec(1, 4));
    // 次へ（ラップ式）：録音を止めずに、OK を含む next-slide と、同じ位置の rec-start（新しいテイク）を書く
    const nx = await app.press('next');
    assert.deepEqual([nx.type, nx.continued, nx.takeId], ['next-slide', true, 't0002']);
    st = await app.state();
    assert.equal(st.slideId, 's0002');
    assert.equal(st.mode, 'recording');
    assert.equal(st.recording, true, 'マイクは動いたまま');
    assert.equal(st.rawFiles.length, 2, '録音ファイルは変わらない（新しく作らない）');
    {
      const ev = await app.events();
      const i = ev.findIndex((e) => e.type === 'next-slide');
      assert.deepEqual(ev.slice(i, i + 2).map((e) => e.type), ['next-slide', 'rec-start']);
      assert.deepEqual(ev[i].at, ev[i + 1].at, '同じ位置');
      assert.equal(ev[i + 1].slideId, 's0002');
      assert.equal(ev[i + 1].takeId, 't0002');
    }

    // スライド 2：そのまま録って OK、取り消して、やり直す
    await app.feed(sec(1, 5));
    const ok2 = await app.press('ok');
    await app.press('undo');
    st = await app.state();
    assert.ok(st.invalid.length >= 1);
    assert.equal(st.canRedo, true);
    await app.press('redo');
    st = await app.state();
    assert.equal(st.invalid.length, 0);
    assert.equal(st.checkpoints.length, 1);
    assert.ok(ok2.ok);
    // 連続の撮り直し：テイクの最初まで戻る
    await app.feed(sec(0.5, 6));
    const a = await app.press('retake'); // 0.5 秒を捨てて c の位置へ
    const b = await app.press('retake'); // さらに前（テイクの最初）
    assert.deepEqual([a.to, b.to], [ok2.checkpointId, null]);
    const none = await app.press('retake');
    assert.equal(none.ok, false);
    await app.press('mark');

    const events = await app.events();
    const raws = (await app.state()).rawFiles;
    events.forEach((e) => assert.deepEqual(validate('events', e).errors, [], `seq ${e.seq}`));
    posConsistent(events, raws);

    // core の解釈：スライド 1 の採用は 2 + 2 + 1 = 5 秒、破棄は 1 秒
    const r = reduceEvents(events, raws.map((x) => ({ ...x })));
    assert.deepEqual(r.issues, [], JSON.stringify(r.issues));
    const t1 = r.takes.find((t) => t.slideId === 's0001');
    assert.equal(t1.samples, RATE * 5);
    assert.equal(t1.candidate, true);
    const discarded = r.segments.filter((s) => s.takeId === t1.takeId && s.status === 'discarded');
    assert.equal(discarded.reduce((n, s) => n + (s.end - s.start), 0), RATE * 1);
    // スライド 2 の最初のテイクは、すべて撮り直した（採用 0）
    const t2 = r.takes.find((t) => t.slideId === 's0002');
    assert.equal(t2.samples, 0);
    assert.equal(t2.candidate, false);
    assert.equal(r.defaultTakes.s0001, t1.takeId);
    assert.equal(sessionId.length, 12);
    assert.deepEqual(app.errors, []);
    await app.page.close();
  });

  test('台本パック（zip）を選んで開く（スライド区切りモード）：台本と絵が端末に保存され、録音の画面に絵と読む文が出る。壊れた台本は拒否する', async () => {
    const png = fs.readFileSync(path.join(REPO_ROOT, 'app', 'icons', 'icon-192.png'));
    const script = makeScript({ slides: 3, projectId: 'proj-pack001', title: 'Pack test deck' });
    script.slides.forEach((s, i) => { s.image = `slides/${String(i + 1).padStart(4, '0')}.png`; s.imageSha256 = sha256Hex(new Uint8Array(png)); });
    const build = async (file, sj) => {
      const parts = [];
      const zip = createZipWriter({ write: (u8) => { parts.push(Buffer.from(u8)); } });
      await zip.addFile('script.json', new TextEncoder().encode(JSON.stringify(sj)));
      for (const s of sj.slides) await zip.addFile(s.image, new Uint8Array(png));
      await zip.finish();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.concat(parts));
      return file;
    };
    const good = await build(path.join(WORK, 'packs', 'good.zip'), script);
    const bad = await build(path.join(WORK, 'packs', 'bad.zip'), { ...script, scriptHash: 'f'.repeat(64) });

    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0');
    const page = app.page;
    await page.setInputFiles('#file-pack', bad);
    await waitUntil(async () => /開けませんでした/.test(await page.textContent('#open-msg')), { what: '壊れた台本の拒否' });
    assert.equal((await app.page.evaluate(() => window.__lap.projects())).length === 0 || !(await app.page.evaluate(() => window.__lap.projects())).some((p) => p.projectId === 'proj-pack001'), true);
    await page.setInputFiles('#file-pack', good);
    await waitUntil(async () => /保存しました/.test(await page.textContent('#open-msg')), { what: '台本を開いたメッセージ' });
    await page.waitForSelector('[data-act=new-session][data-project=proj-pack001]');
    await page.evaluate(() => { localStorage.setItem('lap.recordMode', 'per-slide'); }); // スライド区切りモードを入れる
    await page.reload();
    await page.waitForFunction(() => window.__lap);
    await page.waitForSelector('[data-act=new-session][data-project=proj-pack001]');
    await page.fill('#speaker-proj-pack001', 'Speaker B');
    await page.click('[data-act=new-session][data-project=proj-pack001]');
    await page.waitForSelector('#view-record:not([hidden])');
    await waitUntil(async () => (await page.getAttribute('#slide-img', 'src')) !== null && !(await page.getAttribute('#slide-img', 'hidden') !== null), { what: 'スライドの絵' });
    assert.match(await page.textContent('#reading'), /Slide 1: this is the sentence/);
    // 「自分の担当だけ」：担当が Speaker B のスライドだけが残る
    await page.check('#chk-mine');
    await waitUntil(async () => (await page.locator('#slide-list li:visible').count()) === 1, { what: '担当の絞り込み' });
    assert.match(await page.textContent('#progress'), /担当 1 枚のうち 0 枚収録済み/);
    // 言語を切り替える（英語）
    await page.click('#btn-lang');
    assert.match(await page.textContent('#btn-record'), /Record/);
    await page.click('#btn-lang');
    assert.deepEqual(app.errors, []);
    await page.close();
  });

  test('台本パック（zip）を選んで開く（既定の通し）：台本は区切りなしの 1 本の文章で出て、表示／非表示を覚える。スライド区切りの導線は出ない。台本なしでも録音を始められる', async () => {
    const png = fs.readFileSync(path.join(REPO_ROOT, 'app', 'icons', 'icon-192.png'));
    const script = makeScript({ slides: 3, projectId: 'proj-pack001', title: 'Pack test deck' });
    script.slides.forEach((s, i) => { s.image = `slides/${String(i + 1).padStart(4, '0')}.png`; s.imageSha256 = sha256Hex(new Uint8Array(png)); });
    const parts = [];
    const zip = createZipWriter({ write: (u8) => { parts.push(Buffer.from(u8)); } });
    await zip.addFile('script.json', new TextEncoder().encode(JSON.stringify(script)));
    for (const s of script.slides) await zip.addFile(s.image, new Uint8Array(png));
    await zip.finish();
    const good = path.join(WORK, 'packs', 'good-cont.zip');
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.writeFileSync(good, Buffer.concat(parts));
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0');
    const page = app.page;
    await page.evaluate(() => localStorage.removeItem('lap.recordMode'));
    await page.reload();
    await page.waitForFunction(() => window.__lap);
    assert.equal(await page.isChecked('#chk-per-slide'), false, '既定は通し');
    await page.setInputFiles('#file-pack', good);
    await waitUntil(async () => /保存しました/.test(await page.textContent('#open-msg')), { what: '台本を開いたメッセージ' });
    assert.equal(await page.locator('#speaker-proj-pack001').count(), 0, '通しでは話す人の入力欄も出ない');
    await page.click('[data-act=new-session][data-project=proj-pack001]');
    await page.waitForSelector('#view-record:not([hidden])');
    // 台本は、スライドの区切りなしの 1 本の連続した文章として出る（絵もスライド番号もスライドの一覧も無い）
    await page.waitForSelector('#script-card:not([hidden])');
    const shown = (await page.textContent('#reading')).trim();
    assert.equal(shown, [1, 2, 3].map((i) => `Slide ${i}: this is the sentence to read aloud for slide number ${i}.`).join(' '));
    for (const id of ['slide-img', 'slide-no', 'slide-list', 'btn-next', 'btn-goto-todo', 'chk-mine', 'progress']) assert.equal(await page.isVisible(`#${id}`), false, id);
    // 表示／非表示：切り替えられ、次回起動時（再読み込み）も覚えている
    assert.equal(await page.isVisible('#script-body'), true);
    await page.click('#btn-script-toggle');
    assert.equal(await page.isVisible('#script-body'), false);
    assert.match(await page.textContent('#btn-script-toggle'), /台本を出す/);
    const sid = (await app.state()).sessionId;
    await page.reload();
    await page.waitForFunction(() => window.__lap);
    await page.evaluate((id) => window.__lap.openSession(id), sid);
    await page.waitForSelector('#view-record:not([hidden])');
    await page.waitForSelector('#script-card:not([hidden])');
    await page.waitForSelector('#script-body', { state: 'hidden' }); // 非表示の設定が反映されるまで待つ
    await page.click('#btn-script-toggle');
    assert.equal(await page.isVisible('#script-body'), true);
    assert.match(await page.textContent('#btn-script-toggle'), /台本を隠す/);
    assert.equal((await app.events()).find((e) => e.type === 'session-start').projectId, 'proj-pack001', '書き出しの台本の projectId は読み込んだ台本のもの（free の 1 枚）');
    await page.evaluate(() => window.__lap.closeSession());
    // 台本なしで録音を始める（ホームのボタン）
    await page.waitForSelector('#view-home:not([hidden])');
    await page.click('#btn-new-free');
    await page.waitForSelector('#view-record:not([hidden])');
    assert.equal(await page.isHidden('#script-card'), true, '台本が無いとき、台本の欄は出さない');
    // Enter を押しても、スライドの区切りは書かれない
    await page.click('#btn-record');
    await waitUntil(async () => (await app.state()).recording, { what: '録音中' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal((await app.events()).some((e) => e.type === 'next-slide' || e.type === 'goto-slide'), false);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__lap.closeSession());
    await page.evaluate(() => localStorage.removeItem('lap.recordMode'));
    assert.deepEqual(app.errors, []);
    await page.close();
  });

  test('通して聞く（P）：今のスライドの採用した音声を、つないだ状態で再生する（撮り直した声は入らない）', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0');
    const projectId = await app.loadScript(makeScript({ slides: 2, projectId: 'proj-listen1' }));
    await app.newSession(projectId);
    await app.press('record');
    await app.feed(makePcm(RATE * 2, { seed: 1 })); await app.press('ok');
    await app.feed(makePcm(RATE, { seed: 2 })); await app.press('retake'); // 1 秒を撮り直す
    await app.press('record');
    await app.feed(makePcm(RATE * 1, { seed: 3 })); await app.press('ok'); await app.press('pause');
    assert.equal((await app.state()).canListenSlide, true);
    const r = await app.press('listen-slide', { speed: 16 });
    assert.equal(r.ok, true);
    assert.equal(r.samples, RATE * 3, '採用した 2 秒 + 1 秒（撮り直した 1 秒は入らない）');
    assert.equal((await app.press('listen-slide', { speed: 16 })).samples, RATE * 3);
    // 録音のないスライドでは聞けるものがない
    await app.press('goto', 's0002');
    assert.equal((await app.state()).canListenSlide, false);
    assert.equal((await app.press('listen-slide')).ok, false);
    assert.deepEqual(app.errors, []);
    await app.page.close();
  });

  test('試し録り（T）：録った音は一時ファイルだけに書き、録音ファイルには入れない。操作記録は test-rec（durationMs）だけ。音量と音割れを表示する', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0&testMs=800');
    const projectId = await app.loadScript(makeScript({ slides: 3, projectId: 'proj-testrec' }));
    const sessionId = await app.newSession(projectId);
    const page = app.page;
    await app.press('record');
    await app.feed(makePcm(RATE, { seed: 5 }));
    await app.press('ok'); await app.press('pause');
    const before = await app.state();
    const rawBefore = before.rawFiles.map((r) => [r.name, r.samples]);
    const eventsBefore = (await app.events()).length;

    // 音割れする大きな音で試し録り（実時間より速く再生する）
    const done = page.evaluate(() => window.__lap.press('test', { speed: 16 }));
    await waitUntil(async () => (await app.state()).testing, { what: '試し録りの開始' });
    assert.equal((await app.press('record')).ok, false, '試し録りの間は録音を始められない');
    const loud = makePcm(Math.round(RATE * 0.7), { seed: 6, amp: 1.4 });
    await waitUntil(async () => { try { await app.feed(loud); return true; } catch { return false; } }, { what: '取得の開始' });
    await waitUntil(async () => /試し録り中/.test(await page.textContent('#test-note')), { what: '画面の表示' });
    const r = await done;
    assert.equal(r.ok, true);
    assert.equal(r.durationMs, Math.round((loud.length / RATE) * 1000));
    assert.ok(r.clipped > 1000, `音割れを数える（${r.clipped}）`);
    assert.ok(r.peakDb > -1 && r.rmsDb < 0 && r.rmsDb > -20, JSON.stringify(r));
    await waitUntil(async () => /音割れがあります/.test(await page.textContent('#test-note')), { what: '音割れの表示' });
    assert.match(await page.textContent('#test-note'), /音量 -?\d+(\.\d+)? dB、ピーク/);

    // 録音ファイルは変わらず、一時ファイルは消え、操作記録には test-rec だけが増える
    const after = await app.state();
    assert.deepEqual(after.rawFiles.map((x) => [x.name, x.samples]), rawBefore);
    assert.deepEqual(await app.rawSizesOnDisk(sessionId), Object.fromEntries(rawBefore.map(([n, s]) => [n, s * 2])));
    assert.equal(await page.evaluate((id) => window.__lap.testTempExists(id), sessionId), false, '一時ファイルは消えている');
    const added = (await app.events()).slice(eventsBefore);
    assert.deepEqual(added.map((e) => e.type), ['test-rec']);
    assert.equal(added[0].durationMs, r.durationMs);
    assert.equal('at' in added[0], false, '位置は持たない');
    assert.deepEqual(validate('events', added[0]).errors, []);
    assert.equal(after.mode, 'paused');

    // 静かな（何も入らない）試し録り：キーボードの T。「ほとんど聞こえません」
    await page.keyboard.press('t');
    await waitUntil(async () => (await app.state()).testing, { what: '2 回目の開始' });
    await waitUntil(async () => /ほとんど聞こえません/.test(await page.textContent('#test-note')), { what: '静かな結果の表示', timeoutMs: 8000 });
    // 中止（Esc）：再生せず、test-rec は実際に録った長さで残る
    const p3 = page.evaluate(() => window.__lap.press('test', { speed: 16 }));
    await waitUntil(async () => (await app.state()).testing, { what: '3 回目の開始' });
    assert.equal((await app.press('pause')).cancelled, true);
    assert.equal((await p3).cancelled, true);
    const types = (await app.events()).slice(eventsBefore).map((e) => e.type);
    assert.deepEqual(types, ['test-rec', 'test-rec', 'test-rec']);
    // core の解釈：test-rec は区間に影響しない
    const events = await app.events();
    const reduced = reduceEvents(events, (await app.state()).rawFiles.map((x) => ({ ...x })));
    assert.deepEqual(reduced.issues, []);
    assert.equal(reduced.takes[0].samples, RATE);
    assert.deepEqual(app.errors, []);
    await page.close();
  });

  test('キーボードで操作できる（R、Space、Backspace、Enter、Esc）。画面の状態が変わる', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0');
    const projectId = await app.loadScript(makeScript({ slides: 3, projectId: 'proj-keys01' }));
    await app.newSession(projectId);
    const page = app.page;
    await page.waitForSelector('#view-record:not([hidden])');
    await page.keyboard.press('r');
    await waitUntil(async () => (await app.state()).recording, { what: '録音中' });
    assert.match(await page.textContent('#status-chip'), /録音中/);
    await app.feed(makePcm(RATE * 2, { seed: 21 }));
    await page.keyboard.press('Space');
    await waitUntil(async () => (await app.state()).checkpoints.length === 1, { what: 'OK' });
    await app.feed(makePcm(RATE, { seed: 22 }));
    await page.keyboard.press('Backspace');
    await waitUntil(async () => (await app.state()).mode === 'paused', { what: '撮り直し' });
    await page.keyboard.press('r');
    await waitUntil(async () => (await app.state()).recording, { what: '再開' });
    await page.keyboard.press('Escape');
    await waitUntil(async () => !(await app.state()).recording, { what: '一時停止' });
    await page.keyboard.press('Enter');
    await waitUntil(async () => (await app.state()).slideId === 's0002', { what: '次へ' });
    await waitUntil(async () => /2 \/ 3/.test(await page.textContent('#slide-no')), { what: '画面の番号' });
    const types = (await app.events()).map((e) => e.type).filter((t) => t !== 'durable');
    assert.deepEqual(types, ['session-start', 'rec-start', 'ok', 'pause', 'retake', 'resume', 'pause', 'next-slide']);
    assert.deepEqual(app.errors, []);
    await page.close();
  });
});
