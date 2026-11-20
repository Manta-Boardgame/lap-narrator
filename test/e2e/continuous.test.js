// 通しの録音の通し試験（担当 B2）。既定の録り方（通し：「次のスライドへ」なし、台本の区切りなし）で、
//   (1) Chrome で、OK・撮り直し・再開を使って 1 本の通しで録り、録音中に強制終了 → 開き直して復旧 → 続きを採用 → 続きを録る。操作記録に next-slide／goto-slide が無い
//   (2) 全記録と完成版を書き出す（manifest の recording は continuous、台本は free の 1 枚）
//   (3) CLI で取り込む（警告 continuous-recording、final/all.wav）。status が通しと切れ目の待ちを示す
//   (4) 台本パック（examples/packs/tiny3.zip の 3 枚）を PC 側で渡し、切れ目は音声の中の音の高さの変わり目（1.2 秒と 2.2 秒）で手で書く → render → build（方式 B）→ verify が通る
// （音声は純音。文字起こしと照合（transcribe／align）は音声認識の試験 test/checker の範囲で、ここでは使わない。PowerPoint は使わない）
// 動かす：npm run test:e2e   ポート 8194〜8196、専用のプロフィール work/D/e2e/profile-C*。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readZipDirectory, readZipEntry } from '../../core/zip.js';
import { ROOT, E2E, RATE, waitUntil, startServer, launchChrome, chromeFound, openApp, tone, exportAll, narrate, PY } from './helpers/e2e.js';

const skip = chromeFound() ? false : 'Chrome がない';
const W = path.join(E2E, 'continuous');
// 無音（0.15 秒）のあとに雑音。声と同じく、各スライドの始まりに無音があり、純音でない（verify が相互相関で位置を測れる）
let seed = 12345; const noise = (n) => { const o = new Int16Array(n); for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; o[i] = ((seed >>> 16) - 32768) * 0.3; } return o; };
const voiced = (sec) => { const a = new Int16Array(Math.round(RATE * 0.15)); const b = noise(Math.round(RATE * sec) - a.length); const o = new Int16Array(a.length + b.length); o.set(b, a.length); return o; }; // 声に近い雑音（相互相関で位置が測れる）

async function zipText(file, name) {
  const buf = fs.readFileSync(file);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = async (a, b) => u8.slice(a, b);
  const dir = await readZipDirectory(read, u8.length);
  const parts = [];
  for await (const c of readZipEntry(read, dir.find((e) => e.name === name))) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

describe('通しの録音：録音 → 強制終了と復旧 → 書き出し → 取り込み → render → 動画 → verify', { skip, timeout: 600000 }, () => {
  const st = { chromes: [] };
  before(async () => {
    fs.rmSync(W, { recursive: true, force: true });
    fs.mkdirSync(W, { recursive: true });
    st.server = await startServer(8194);
  });
  after(async () => {
    for (const c of st.chromes) { try { await c.close(); } catch { /* 無視 */ } }
    if (st.server) await st.server.close();
  });

  test('(1) 通しで録る（next なし）。録音中に強制終了し、復旧して続きを採用する', { timeout: 120000 }, async () => {
    const q = '?devinput=1&countdown=0&durableMs=250&nosw=1';
    const c1 = await launchChrome({ name: 'C1', port: 8195 });
    st.chromes.push(c1);
    const A = await openApp(c1, st.server.origin, q);
    st.sessionId = await A.page.evaluate(() => window.__lap.newSession(null, { mode: 'continuous' }));
    assert.equal((await A.press('record')).ok, true);
    await A.feed(voiced(1.2)); await A.press('ok');
    await A.feed(tone(0.6, 4200));
    assert.equal((await A.press('retake')).to, 'c0001');
    assert.equal((await A.press('record')).type, 'resume');
    await A.feed(voiced(1.0)); await A.press('ok');
    const nx = await A.press('next'); // 通しでは「次のスライドへ」は何もしない
    assert.deepEqual([nx.ok, nx.reason], [false, 'continuous']);
    await A.feed(voiced(0.9)); // OK を押す前に強制終了される分
    await waitUntil(async () => (await A.durable()).pos >= Math.round(RATE * 3.0), { what: '保存位置が進む', timeoutMs: 20000 });
    c1.kill();
    const c2 = await launchChrome({ name: 'C1', port: 8196, fresh: false });
    st.chromes.push(c2);
    const A2 = await openApp(c2, st.server.origin, q);
    const opened = await A2.openSession(st.sessionId);
    assert.ok(opened.recovery, '復旧の手順に入った');
    assert.equal((await A2.press('adopt')).ok, true);
    assert.equal((await A2.press('record')).type, 'resume');
    await A2.feed(noise(Math.round(RATE * 0.8))); await A2.press('ok'); await A2.press('pause');
    const ev = await A2.events();
    assert.equal(ev.some((e) => e.type === 'next-slide' || e.type === 'goto-slide'), false, 'スライドの区切りを書かない');
    assert.deepEqual([...new Set(ev.filter((e) => e.type === 'rec-start').map((e) => e.slideId))], ['free']);
    st.A = A2;
  });

  test('(2) 書き出し（全記録と完成版）：manifest は recording: continuous、台本は free の 1 枚', { timeout: 120000 }, async () => {
    st.out = path.join(W, 'export');
    const full = await exportAll(st.A, { kind: 'full' }, st.out);
    const fin = await exportAll(st.A, { kind: 'final' }, st.out);
    for (const x of [full, fin]) {
      const m = JSON.parse(await zipText(x.files[0], 'manifest.json'));
      const sj = JSON.parse(await zipText(x.files[0], 'script.json'));
      assert.equal(m.recording, 'continuous');
      assert.deepEqual(sj.slides.map((s) => [s.slideId, s.title, s.text]), [['free', '通し録音', '']]);
    }
    st.fullKind = full.sum.kind;
  });

  test('(3) 取り込み：警告 continuous-recording と final/all.wav。status が通しの録音と切れ目の待ちを示す', { timeout: 120000 }, async () => {
    st.ws = path.join(W, 'ws');
    const r = await narrate(['import', st.out, '--script', path.join(ROOT, 'examples', 'packs', 'tiny3.zip'), '--workspace', st.ws]); // 台本パック（3 枚）は PC 側にある
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.env.warnings.some((w) => w.code === 'continuous-recording'), JSON.stringify(r.env.warnings));
    const wav = path.join(st.ws, 'final', 'all.wav');
    assert.ok(fs.existsSync(wav));
    st.wav = fs.readFileSync(wav);
    st.samples = (st.wav.length - 44) / 2;
    // 採用した 1.2 + 1.0 + 復旧した続き（0.9 のうち保存されていた分）+ 0.8 秒。撮り直した 0.6 秒は入らない
    assert.ok(st.samples >= RATE * 3.0 && st.samples <= RATE * 3.9, `通しの音声 ${(st.samples / RATE).toFixed(2)} 秒`);
    const s = await narrate(['status', '--workspace', st.ws]);
    assert.equal(s.code, 0, s.stdout);
    assert.equal(s.env.result.continuous.present, true);
    assert.equal(s.env.result.boundaries.state, 'waiting-for-boundaries');
  });

  test('(4) 切れ目（3 枚を 3 等分）を手で書いて render → 方式 B の build → verify', { timeout: 300000, skip: fs.existsSync(PY) ? false : '.venv がない' }, async () => {
    const script = JSON.parse(fs.readFileSync(path.join(st.ws, 'script.json'), 'utf8'));
    const rec = script.slides.filter((x) => x.recordable);
    assert.equal(rec.length, 3);
    const cut = (i) => [0, Math.round(RATE * 1.2), Math.round(RATE * 2.2), st.samples][i]; // 600 Hz | 1800 Hz | 3000 Hz の境目
    const b = {
      format: 'lap-narrator/boundaries', version: 1, sampleRate: RATE,
      audio: { file: 'final/all.wav', sha256: crypto.createHash('sha256').update(st.wav).digest('hex'), samples: st.samples },
      script: { scriptHash: script.scriptHash },
      slides: rec.map((x, i) => ({ slideId: x.slideId, order: x.order, startSample: cut(i), endSample: cut(i + 1), confidence: 1, method: 'manual', status: 'confirmed' })),
    };
    fs.writeFileSync(path.join(st.ws, 'boundaries.json'), JSON.stringify(b, null, 2));
    const s = await narrate(['status', '--workspace', st.ws]);
    assert.equal(s.env.result.boundaries.state, 'ready', JSON.stringify(s.env.result.boundaries));
    const r = await narrate(['render', '--workspace', st.ws]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const bd = await narrate(['build', '--method', 'B', '--workspace', st.ws]);
    assert.equal(bd.code, 0, bd.stdout + bd.stderr);
    assert.ok(fs.statSync(path.join(st.ws, 'out', 'video.mp4')).size > 1000);
    const v = await narrate(['verify', '--workspace', st.ws]);
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.equal(v.env.result.pass, true);
  });
});
