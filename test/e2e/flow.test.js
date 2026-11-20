// 第 1 波の合格の条件（dev/PLAN.md 4 章）を、1 本の通し試験にする（担当 D）。
//   (1) 2 つの専用プロフィールの Chrome で、台本パック tiny3 の別々のスライドを録る。片方は録音中に強制終了し、開き直して復旧、続きを採用する。
//   (2) 両方から、全記録と完成版を、巻を小さく分けて書き出す。
//   (3) CLI で、台本パックと書き出しを逆の順（第 2 巻を先に、再送を含む）で取り込み、status → render。
//   (4) できた timeline.json から、方式 B（CLI の build）で MP4 を作り、verify を通す。
//   (5) 方式 A（PowerPoint。リンク版、埋め込み版、-GridMs 33 と 0）を verify に通す。PowerPoint に他の資料が開いていれば、この段だけ skip する。
//   (6) わざと 100 ミリ秒ずらした動画を、verify が検出する。
//   (7) 各段の所要時間と、予定表との差を work/D/e2e-results.json に残す。
// 動かす：npm run test:e2e   （npm test には入れない。Chrome、PowerPoint、Python（.venv）を使う）
// 録音の操作は、Enter（次のスライドへ）が録音を止めない形（同じ位置の next-slide と rec-start）を前提にしている。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { readZipDirectory, readZipEntry } from '../../core/zip.js';
import { validate } from '../../core/validate.js';
import {
  ROOT, E2E, RATE, sleep, waitUntil, startServer, launchChrome, chromeFound, openApp, openPackAndStart, tone, exportAll,
  runNode, narrate, runPy, PY,
} from './helpers/e2e.js';
import { powerPointSkipReason, powerPointRunning } from '../builder/helpers/env.js';

const skipChrome = chromeFound() ? false : 'Chrome がない';
const PROJECT = 'tiny3_demo';
const HZ = { s1: 600, s1junk: 4200, s2: 1800, s3: 3000 };
const results = { startedAt: new Date().toISOString(), stages: {}, notes: [] };
const stage = async (name, fn) => {
  const t0 = performance.now();
  results.stages[name] = results.stages[name] || {};
  try { return await fn(); } finally { results.stages[name].ms = Math.round(performance.now() - t0); }
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 周波数 hz の成分の強さ（Goertzel。0..1 の振幅に近い値）。 */
function goertzel(pcm, hz) {
  const w = (2 * Math.PI * hz) / RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < pcm.length; i++) { const s = pcm[i] / 32768 + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) * 2 / pcm.length;
}
const wavPcm = (buf) => new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));

async function openZip(file) {
  const buf = fs.readFileSync(file);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = async (s, e) => u8.slice(s, e);
  const dir = await readZipDirectory(read, u8.length);
  const by = new Map(dir.map((e) => [e.name, e]));
  return {
    names: dir.map((e) => e.name),
    async readAll(name) { const parts = []; for await (const c of readZipEntry(read, by.get(name))) parts.push(c); return Buffer.concat(parts); },
  };
}

const walkHash = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${path.relative(dir, p)}:${sha(fs.readFileSync(p))}`); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};

/** この試験の実行中に起動し、資料が 1 つも開いていない PowerPoint だけを終わらせる（利用者のものには触らない）。 */
function cleanupPowerPoint(since) {
  const cmd = `
$since = [DateTime]::Parse('${since}').ToLocalTime()
$procs = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since })
if ($procs.Count -eq 0) { 'none'; return }
$app = $null
try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
$docs = -1
if ($app) { try { $docs = [int]$app.Presentations.Count + [int]$app.ProtectedViewWindows.Count } catch { } }
if ($docs -eq 0) { try { $app.Quit() } catch { }; Start-Sleep -Seconds 3; Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since } | Stop-Process -Force -ErrorAction SilentlyContinue; 'quit leftover' } else { 'left alone' }`;
  return (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60000 }).stdout ?? '').trim();
}

describe('第 1 波の通し試験：録音 → 強制終了と復旧 → 書き出し → CLI で取り込み → render → 動画（B、A）→ verify', { skip: skipChrome, timeout: 3600000 }, () => {
  const W = path.join(E2E, 'run');
  const DL = path.join(W, 'downloads');
  const WS = path.join(W, 'ws');
  const st = { chromes: [] };
  const testStart = new Date();

  before(async () => {
    fs.rmSync(W, { recursive: true, force: true });
    fs.mkdirSync(DL, { recursive: true });
    // 素材：台本パックと pptx（testgen が作る。同じ指定から同じ素材）
    for (const sub of ['packs', 'pptx']) {
      const r = await runNode([path.join(ROOT, 'testgen', 'cli.js'), sub, '--out', path.join(W, sub)], { timeoutMs: 120000 });
      assert.equal(r.code, 0, r.stdout + r.stderr);
    }
    st.pack = path.join(W, 'packs', 'tiny3.zip');
    st.pptx = path.join(W, 'pptx', 'tiny3.pptx');
    assert.ok(fs.existsSync(st.pack) && fs.existsSync(st.pptx));
    st.server = await startServer(8190);
  });

  after(async () => {
    for (const c of st.chromes) { try { await c.close(); } catch { /* 無視 */ } }
    if (st.server) await st.server.close();
    results.powerPointCleanup = cleanupPowerPoint(testStart.toISOString());
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ROOT, 'work', 'D', 'e2e-results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log('結果の JSON：work/D/e2e-results.json');
    console.log('PowerPoint の後始末：' + results.powerPointCleanup);
  });

  test('(1) ブラウザ A：スライド 1 と 2 を録る（撮り直しを含む）。ブラウザ B：スライド 3。A は録音中に強制終了し、復旧して続きを採用する', { timeout: 300000 }, async () => {
    await stage('1-record-and-recover', async () => {
      const qA = '?devinput=1&countdown=0&durableMs=250&volumeMax=150000';
      const qB = '?devinput=1&countdown=0&durableMs=250&volumeMax=120000';
      const cA = await launchChrome({ name: 'A', port: 8191 });
      st.chromes.push(cA);
      const A = await openApp(cA, st.server.origin, qA);
      st.sessionA = await openPackAndStart(A, st.pack, PROJECT, 'Speaker A');
      assert.equal((await A.press('record')).ok, true);
      await A.feed(tone(1.2, HZ.s1)); await A.press('ok');              // c0001：1.2 秒（採用）
      await A.feed(tone(0.6, HZ.s1junk));                                // 撮り直す声（別の高さの音。完成版に入ってはいけない）
      assert.equal((await A.press('retake')).to, 'c0001');
      assert.equal((await A.press('record')).type, 'resume');
      await A.feed(tone(1.0, HZ.s1)); await A.press('ok');              // c0002：1.0 秒
      await A.feed(tone(0.3, HZ.s1));
      const nx = await A.press('next');                                  // OK を含み、録音は止めない（同じ位置の next-slide と rec-start）
      assert.deepEqual([nx.type, nx.continued], ['next-slide', true]);
      let s = await A.state();
      assert.equal(s.slideId, 's0002');
      assert.equal(s.recording, true, 'Enter で録音は止まらない');
      const ev = await A.events();
      const i = ev.findIndex((e) => e.type === 'next-slide');
      assert.deepEqual(ev.slice(i, i + 2).map((e) => e.type), ['next-slide', 'rec-start']);
      assert.deepEqual(ev[i].at, ev[i + 1].at, '同じ位置');
      st.slide2StartPos = ev[i + 1].at.pos;
      await A.feed(tone(0.8, HZ.s2)); await A.press('ok');              // スライド 2：最後の OK 点
      await A.feed(tone(0.7, HZ.s2));                                    // OK を押す前に強制終了される分
      const fedPos = st.slide2StartPos + Math.round(RATE * 1.5);
      await waitUntil(async () => (await A.durable()).pos >= st.slide2StartPos + Math.round(RATE * 1.0), { what: '保存位置が進む', timeoutMs: 20000 });
      assert.equal((await A.state()).recording, true, '録音中のまま');
      cA.kill();                                                         // 強制終了（自分が起動した pid だけ）
      assert.equal(cA.exited, true);

      // 開き直す（同じプロフィール）。復旧の手順に入る
      const cA2 = await launchChrome({ name: 'A', port: 8193, fresh: false });
      st.chromes.push(cA2);
      const A2 = await openApp(cA2, st.server.origin, qA);
      const info = (await A2.sessions()).find((x) => x.sessionId === st.sessionA);
      assert.ok(info && info.interrupted === true, '中断として読める');
      const disk = await A2.page.evaluate((id) => window.__lap.rawSizesOnDisk(id), st.sessionA);
      const diskSamples = Object.values(disk).reduce((n, b) => n + b / 2, 0);
      const opened = await A2.openSession(st.sessionA);
      const rec = opened.recovery;
      assert.ok(rec, '復旧の手順に入った');
      assert.ok(rec.recoveredPos <= diskSamples, `復旧位置 ${rec.recoveredPos} は保存されていた ${diskSamples} を超えない`);
      assert.equal(rec.recoveredPos, diskSamples);
      assert.ok(rec.recoveredPos <= fedPos, '流した分を超えない');
      assert.ok(rec.recoveredPos > st.slide2StartPos + RATE * 0.8, '最後の OK より先まで復旧する');
      assert.ok(rec.lastOkPos !== null && rec.lastOkPos < rec.recoveredPos);
      assert.equal((await A2.state()).recording, false, 'マイクは自動で再開しない');
      // 続きを聞いて採用し、そのあと続きを録る
      const played = await A2.page.evaluate(() => window.__lap.playRecovered({ speed: 16 }));
      assert.equal(played.ok, true);
      assert.equal(played.samples, rec.continuationSamples);
      assert.equal((await A2.press('adopt')).ok, true);
      assert.equal((await A2.press('record')).type, 'resume');
      await A2.feed(tone(0.8, HZ.s2)); await A2.press('ok'); await A2.press('pause');
      st.A = A2;
      st.expectS2 = rec.recoveredPos - st.slide2StartPos + Math.round(RATE * 0.8);
      st.recovery = { recoveredPos: rec.recoveredPos, diskSamples, fedPos, lastOkPos: rec.lastOkPos };
      results.stages['1-record-and-recover'].recovery = st.recovery;

      // ブラウザ B：スライド 3（別のプロフィール、別の端末の代わり）
      const cB = await launchChrome({ name: 'B', port: 8192 });
      st.chromes.push(cB);
      const B = await openApp(cB, st.server.origin, qB);
      st.sessionB = await openPackAndStart(B, st.pack, PROJECT, 'Speaker B');
      assert.equal((await B.press('goto', 's0003')).ok !== false, true);
      await B.press('record');
      await B.feed(tone(2.0, HZ.s3)); await B.press('ok'); await B.press('pause');
      st.B = B;
      assert.notEqual(st.sessionA, st.sessionB);
      assert.deepEqual(A.errors, []);
      assert.deepEqual(A2.errors, []);
      assert.deepEqual(B.errors, []);
    });
  });

  test('(2) 両方のブラウザから、全記録（full）と完成版（final）を、巻を小さく分けて書き出す', { timeout: 300000 }, async () => {
    await stage('2-export', async () => {
      st.exports = {};
      for (const [who, app] of [['A', st.A], ['B', st.B]]) {
        for (const kind of ['full', 'final']) {
          const t0 = performance.now();
          const r = await exportAll(app, { kind }, path.join(DL, `${who}-${kind}`));
          st.exports[`${who}-${kind}`] = r;
          assert.ok(r.sum.volumes >= 2, `${who} ${kind} は巻に分かれた（${r.sum.volumes} 巻）`);
          assert.deepEqual(validate('index', r.index).errors, []);
          results.stages['2-export'][`${who}-${kind}`] = { volumes: r.sum.volumes, ms: Math.round(performance.now() - t0) };
        }
      }
      // 書き出しは端末の外へ通信していない（POST/PUT なし。要求は自分のサーバーだけ）
      assert.ok(st.server.log.every((l) => l.method === 'GET' || l.method === 'HEAD'), '書き込みの要求がない');
    });
  });

  test('(3) CLI：作業場を作り、台本パックと書き出しを逆の順（第 2 巻を先に、再送を含む）で取り込む。status → render', { timeout: 600000 }, async () => {
    const all = [];
    for (const k of ['A-full', 'A-final', 'B-full', 'B-final']) all.push(...st.exports[k].files);
    const indexes = Object.values(st.exports).map((e) => e.indexFile);
    const reversed = [...all].reverse();

    await stage('3-import', async () => {
      // 1. A の全記録の最後の巻だけを、台本パックといっしょに先に渡す：巻が欠けている間は確定しない
      const lastA = st.exports['A-full'].files.at(-1);
      let r = await narrate(['import', lastA, '--script', st.pack, '--workspace', WS]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.env.result.committed.length, 0);
      assert.equal(r.env.result.pending.length, 1);
      assert.equal(r.env.result.pending[0].exportId, st.exports['A-full'].sum.exportId);
      assert.ok(!r.env.result.pending[0].missing.includes(st.exports['A-full'].files.length), '渡した巻は欠けていない');
      // 2. 残りを逆の順に（最後の巻から最初の巻へ）。B の完成版の第 2 巻が最初
      r = await narrate(['import', ...reversed.filter((f) => f !== lastA), '--workspace', WS]);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(r.env.result.pending, []);
      assert.deepEqual([...r.env.result.committed].sort(), [st.sessionA, st.sessionB].sort());
      // 索引（ZIP 全体のハッシュ）と照合する
      r = await narrate(['import', ...indexes, '--workspace', WS]);
      assert.equal(r.code, 0, r.stdout);
      // 3. 全部の再送：何も変わらない
      const before = walkHash(path.join(WS, 'sessions'));
      assert.ok(before.length > 10);
      r = await narrate(['import', ...all, ...indexes, '--workspace', WS]);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(r.env.result.received, [], '再送は受け取り直さない');
      assert.deepEqual(walkHash(path.join(WS, 'sessions')), before, '再送で統合の結果が変わらない');
    });

    await stage('3-status-render', async () => {
      let s = await narrate(['status', '--workspace', WS]);
      assert.equal(s.code, 0, s.stdout);
      results.stages['3-status-render'].statusStates = s.env.result.slides.map((x) => [x.slideId, x.state]);
      // 同じセッション・同じテイクの全記録と完成版は、本来 1 つの候補のはず。いまは app が完成版の manifest に editVersion を書かない
      // ため、CLI は完成版を別の候補とみなして multiple にする（dev/proposals/D-002.md）。そのときは select で全記録のテイクを選ぶ。
      const multiple = s.env.result.slides.filter((x) => x.state === 'multiple');
      let selected = 0;
      for (const sl of multiple) {
        const keys = new Set(sl.candidates.map((c) => `${c.sessionId}/${c.takeId}`));
        assert.equal(keys.size, 1, `${sl.slideId}：候補は同じセッションの同じテイクだけ（${[...keys]}）`);
        const full = sl.candidates.find((c) => c.source === 'full');
        const sel = await narrate(['select', '--slide', sl.slideId, '--session', full.sessionId, '--take', full.takeId, '--workspace', WS]);
        assert.equal(sel.code, 0, sel.stdout);
        selected++;
      }
      results.stages['3-status-render'].selectedBecauseMultiple = selected;
      if (selected) results.notes.push(`status が ${selected} 枚を multiple（全記録と完成版が別候補）としたので select した（D-002）`);
      s = await narrate(['status', '--workspace', WS]);
      assert.deepEqual(s.env.result.slides.map((x) => x.resolved ?? x.state === 'single'), [true, true, true], JSON.stringify(s.env.result.slides.map((x) => [x.slideId, x.state, x.resolved])));
      const t0 = performance.now();
      const r = await narrate(['render', '--workspace', WS]);
      assert.equal(r.code, 0, r.stdout);
      results.stages['3-status-render'].renderMs = Math.round(performance.now() - t0);
      st.out = path.join(WS, 'out');
      st.tl = JSON.parse(fs.readFileSync(path.join(st.out, 'timeline.json'), 'utf8'));
      assert.deepEqual(validate('timeline', st.tl), { ok: true, errors: [] });
      assert.deepEqual(st.tl.slides.map((x) => x.slideId), ['s0001', 's0002', 's0003']);
      // 録音した分だけが入っている（撮り直した声は入らない。復旧した続きは入る）
      assert.deepEqual(st.tl.slides.map((x) => x.audioSamples), [Math.round(RATE * 2.5), st.expectS2, Math.round(RATE * 2.0)]);
      // 撮り直した声（4200 Hz）は完成した音声に入っていない
      const w1 = fs.readFileSync(path.join(st.out, 'final', 's0001.wav'));
      const pcm1 = wavPcm(w1);
      assert.ok(goertzel(pcm1, HZ.s1) > 0.1, '採用した声（600 Hz）は入っている');
      assert.ok(goertzel(pcm1, HZ.s1junk) < 0.002, '撮り直した声（4200 Hz）は入っていない');
      // アプリが書き出した完成版の WAV と、CLI の render の WAV が、ビット単位で同じ
      for (const [who, ids] of [['A', ['s0001', 's0002']], ['B', ['s0003']]]) {
        const bytesById = {};
        for (const f of st.exports[`${who}-final`].files) {
          const z = await openZip(f);
          for (const n of z.names.filter((x) => x.startsWith('final/'))) bytesById[n] = await z.readAll(n);
        }
        for (const id of ids) {
          const fromApp = bytesById[`final/${id}.wav`];
          assert.ok(fromApp, `完成版に final/${id}.wav がある`);
          const fromCli = fs.readFileSync(path.join(st.out, 'final', `${id}.wav`));
          assert.equal(sha(fromApp), sha(fromCli), `${id}：アプリの完成版と CLI の render が一致する`);
        }
      }
    });
  });

  const summarize = (res) => ({
    pass: res.pass, counts: res.counts, totalDiffMs: res.totalDiffMs,
    maxAbsShowMs: Math.max(...res.slides.map((s) => (s.diffMs.show === null ? 0 : Math.abs(s.diffMs.show)))),
    maxAbsAudioMs: Math.max(...res.slides.map((s) => (s.diffMs.audio === null ? 0 : Math.abs(s.diffMs.audio)))),
    slides: res.slides.map((s) => ({ slideId: s.slideId, status: s.status, showMs: s.diffMs.show, audioMs: s.diffMs.audio })),
  });

  test('(4) 方式 B：CLI の build で MP4 を作り、verify を通す（絵 1 フレーム、音声 20 ミリ秒）', { timeout: 300000 }, async () => {
    const b = await narrate(['build', '--method', 'B', '--workspace', WS]);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    const v = await narrate(['verify', '--workspace', WS]);
    results.stages['4-method-B'] = { buildMs: b.ms, verifyMs: v.ms, elapsedMsReported: b.env.result.elapsedMs };
    assert.equal(v.code, 0, v.stdout);
    assert.equal(v.env.result.pass, true);
    assert.equal(v.env.result.allMeasured, true, '3 枚とも絵と音声が測れた');
    const sum = summarize(v.env.result);
    Object.assign(results.stages['4-method-B'], sum);
    for (const s of v.env.result.slides) {
      assert.equal(s.status, 'ok', JSON.stringify(s));
      assert.ok(Math.abs(s.diffMs.show) <= 1000 / 30 + 0.01, `絵 ${s.diffMs.show}`);
      assert.ok(Math.abs(s.diffMs.audio) <= 20, `音声 ${s.diffMs.audio}`);
    }
    // 長さは予定表どおり（1 フレームの丸めの範囲）
    assert.ok(Math.abs(v.env.result.totalDiffMs) <= 2 * (1000 / 30));
  });

  test('(5) 方式 A（PowerPoint）：リンク版、埋め込み版、-GridMs 33 と 0 を verify に通す。他の資料が開いていれば skip', { timeout: 900000 }, async (t) => {
    const reason = process.env.LAP_SKIP_POWERPOINT ? 'LAP_SKIP_POWERPOINT=1（PowerPoint を動かさない）' : powerPointSkipReason();
    if (reason) {
      results.stages['5-method-A'] = { skipped: reason };
      console.log('方式 A を skip：' + reason);
      t.skip(reason);
      return;
    }
    const tlPath = path.join(st.out, 'timeline.json');
    results.stages['5-method-A'] = {};
    for (const grid of [33, 0]) {
      const out = path.join(WS, `out-a-grid${grid}`);
      const b = await narrate(['build', '--method', 'A', '--pptx', st.pptx, '--workspace', WS, '--out', out, '--timeline', tlPath,
        '--mode', 'both', '--grid-ms', String(grid), '--timeout-sec', '300'], { timeoutMs: 600000 });
      assert.equal(b.code, 0, b.stdout + b.stderr);
      const rep = b.env.result;
      assert.deepEqual(rep.variants.map((v) => v.method), ['A-linked', 'A-embedded']);
      for (const v of rep.variants) {
        assert.equal(v.audioInVideo, true, `${v.method}（grid ${grid}）の音声が MP4 に入っている`);
        // 自分で復号して測り直す（build-a.ps1 の報告を信じない）
        const ver = await narrate(['verify', '--video', path.join(out, v.video), '--timeline', tlPath, '--method', 'A']);
        assert.ok([0, 3].includes(ver.code), ver.stdout);
        const sum = summarize(ver.env.result);
        results.stages['5-method-A'][`${v.method}-grid${grid}`] = { createVideoMs: v.createVideoMs, buildMs: v.elapsedMs, wallMs: b.ms, ...sum };
        // 絵と音声が、3 枚とも見つかっている
        for (const s of ver.env.result.slides) {
          assert.notEqual(s.detail.audio, 'missing', `${v.method} ${s.slideId} 音声`);
          assert.notEqual(s.detail.show, 'missing', `${v.method} ${s.slideId} 絵`);
        }
        if (grid === 33) assert.equal(ver.env.result.pass, true, `${v.method} -GridMs 33 は 50 ミリ秒の目標を満たす：` + JSON.stringify(sum));
      }
      assert.ok(fs.existsSync(path.join(out, 'video.mp4')));
    }
    assert.equal(fs.readFileSync(st.pptx).length > 0, true);
  });

  test('(6) わざと 100 ミリ秒ずらした動画（音声）を、verify が検出する', { timeout: 300000 }, async () => {
    const bad = path.join(WS, 'out-shift100');
    const tlPath = path.join(st.out, 'timeline.json');
    const r = await runPy([path.join(ROOT, 'builder', 'build_b.py'), '--timeline', tlPath, '--out', bad, '--debug-audio-shift-ms', '100']);
    assert.equal(r.code, 0, r.stderr);
    const v = await narrate(['verify', '--video', path.join(bad, 'video.mp4'), '--timeline', tlPath, '--method', 'B']);
    assert.equal(v.code, 3, v.stdout);
    assert.equal(v.env.ok, false);
    assert.equal(v.env.errors[0].code, 'out-of-tolerance');
    for (const s of v.env.result.slides) {
      assert.equal(s.detail.audio, 'out-of-tolerance');
      assert.ok(s.diffMs.audio > 99 && s.diffMs.audio < 101, `音声の差 ${s.diffMs.audio}`);
    }
    results.stages['6-shifted'] = { detected: true, ...summarize(v.env.result), verifyMs: v.ms };
  });
});
