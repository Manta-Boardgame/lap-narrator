// 保存画面（ACTION_CREATE_DOCUMENT）の流れを、エミュレーター（emulator-5554）で自動で通す試験（担当 K）。
// 実機には触れない（adb-emu.js が `-s emulator-5554` を必ず付ける）。録音のマイクは仮想マイク（無音）。
// 前提：エミュレーターが起動済み（`emulator -avd Medium_Phone_API_36.1 -no-snapshot-save -no-boot-anim -memory 2048`）。
//   起動していなければ、全部スキップする。APK は work/K/ の APK（環境変数 EMU_APK で指定。既定 work/K/app-debug-save2.apk）。
// 場面：1 件の保存、取りやめ、巻と索引の連続保存（保存画面が二重に開かないこと）、同じ名前での上書き、保存できない場所での押下（観察のみ）。
// 各場面の画面写真は work/K/emu-shots/ に、数値は work/K/emu-results.json に残す。
// 使い方：npm run test:native-emulator
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adbEmu, ROOT, PKG, WORK_DIR } from './adb-emu.js';
import { Cdp, httpJson, sleep } from '../device/helpers/cdp.js';
import { readZipDirectory, readZipEntry } from '../../core/zip.js';

const WORK = WORK_DIR; // 既定 work/K。LAP_EMU_WORK で変えられる
const SHOTS = path.join(WORK, 'emu-shots');
const RESULTS = path.join(WORK, 'emu-results.json');
const APK = path.resolve(process.env.EMU_APK || path.join(WORK, 'app-debug-save2.apk'));
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const APP_URL = 'https://localhost/app/index.html?lapdev=1&countdown=0&nosw=1&volumeMax=250000';
const CDP_PORT = 9223;
const say = (m) => process.stderr.write(`[K-emu ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const R = { startedAt: new Date().toISOString(), apk: APK, scenes: {} };
const save = () => { fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(RESULTS, JSON.stringify(R, null, 2) + '\n'); };
const S = { skip: null, cdp: null, shotNo: 0 };
const lap = (expr, o) => S.cdp.eval(expr, o);

// ---- 画面の道具
async function shot(label) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await adbEmu(['exec-out', 'screencap', '-p'], { timeoutMs: 30000 });
  const file = path.join(SHOTS, `${String(++S.shotNo).padStart(2, '0')}-${label}.png`);
  if (r.buf.length > 1000) fs.writeFileSync(file, r.buf);
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function parseNodes(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\s[^>]*?\/?>/g)) {
    const a = {};
    for (const kv of m[0].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) a[kv[1]] = kv[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (b) { a.x = Math.round((+b[1] + +b[3]) / 2); a.y = Math.round((+b[2] + +b[4]) / 2); }
    nodes.push(a);
  }
  return nodes;
}
async function ui() {
  for (let k = 0; k < 4; k++) {
    await adbEmu(['shell', 'uiautomator', 'dump', '/data/local/tmp/lapui.xml'], { timeoutMs: 40000 });
    const r = await adbEmu(['exec-out', 'cat', '/data/local/tmp/lapui.xml'], { timeoutMs: 20000 });
    const nodes = parseNodes(r.out);
    // 遅いエミュレーターでは「System UI isn't responding」などの ANR の確認が出る。「待つ」を押して先へ進む
    const anr = nodes.some((n) => /isn't responding|応答していません|keeps stopping|停止しました/i.test(n.text || ''));
    if (!anr) return nodes;
    R.anrDialogs = (R.anrDialogs || 0) + 1;
    const wait = nodes.find((n) => /^(wait|待機|待つ|OK)$/i.test((n.text || '').trim()));
    await shot('anr-dialog');
    if (wait) await tap(wait);
    await sleep(1500);
  }
  return [];
}
const inPicker = (nodes) => nodes.some((n) => n.package === 'com.google.android.documentsui');
async function frontActivity() {
  const r = await adbEmu(['shell', 'dumpsys', 'activity', 'activities'], { timeoutMs: 30000 });
  return ((r.out.match(/topResumedActivity=ActivityRecord\{[^ ]+ u0 ([^ ]+)/) || [])[1]) || null;
}
const tap = (n) => adbEmu(['shell', 'input', 'tap', String(n.x), String(n.y)]);
const key = (code) => adbEmu(['shell', 'input', 'keyevent', String(code)]);
async function waitPicker(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const nodes = await ui().catch(() => []);
    if (inPicker(nodes) && findSave(nodes)) return nodes;
    await sleep(700);
  }
  return null;
}
const findSave = (nodes) => nodes.find((n) => n.package === 'com.google.android.documentsui' && /^(save|保存)$/i.test((n.text || '').trim()) && /Button/.test(n.class || ''));
async function waitMainFront(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = await frontActivity();
    if (f && f.includes(PKG)) return f;
    await sleep(600);
  }
  return null;
}
async function startsOfPicker() {
  const r = await adbEmu(['logcat', '-d'], { timeoutMs: 40000 });
  return r.out.split('\n').filter((l) => /ActivityTaskManager: START u0 \{act=android\.intent\.action\.CREATE_DOCUMENT/.test(l)).length;
}
const bridge = () => lap('window.lapNative.state()');

async function loadPack() {
  const buf = fs.readFileSync(PACK);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = async (s, e) => u8.slice(s, e);
  const dir = await readZipDirectory(read, u8.length);
  const get = async (name) => { const e = dir.find((x) => x.name === name); const parts = []; for await (const c of readZipEntry(read, e)) parts.push(c); return Buffer.concat(parts); };
  const script = JSON.parse((await get('script.json')).toString('utf8'));
  const images = {};
  for (const s of script.slides) images[s.image] = (await get(s.image)).toString('base64');
  return { script, images };
}

/** 保存画面が出るたびに「保存」を押す。n 件ぶん。押したあと、画面が閉じるのを待つ。 */
async function pressSaveTimes(n, label) {
  const done = [];
  for (let i = 1; i <= n; i++) {
    const nodes = await waitPicker();
    assert.ok(nodes, `${label}: ${i} 件目の保存画面が出ない`);
    const photo = await shot(`${label}-picker-${i}`);
    const btn = findSave(nodes);
    assert.ok(btn, `${label}: 保存ボタンが見つからない`);
    await tap(btn);
    // 上書きの確認が出たら押す
    await sleep(1200);
    const after = await ui().catch(() => []);
    const ok2 = after.find((x) => /^(replace|overwrite|置換|上書き(する)?)$/i.test((x.text || '').trim()));
    if (ok2) { await shot(`${label}-confirm-${i}`); await tap(ok2); }
    // 画面が閉じるまで
    const t0 = Date.now();
    let still = true;
    while (Date.now() - t0 < 20000) { const nn = await ui().catch(() => []); if (!inPicker(nn)) { still = false; break; } await sleep(600); }
    done.push({ i, photo, savePressed: true, pickerStillAfter20s: still });
  }
  return done;
}

describe('保存画面の流れ（エミュレーター）', { timeout: 1200000 }, () => {
  before(async () => {
    const boot = await adbEmu(['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 15000 });
    if (boot.out.trim() !== '1') { S.skip = `エミュレーターが起動していない（sys.boot_completed=${JSON.stringify(boot.out.trim())}）`; R.skipped = S.skip; save(); return; }
    if (!fs.existsSync(APK)) { S.skip = `APK がない: ${APK}`; R.skipped = S.skip; save(); return; }
    R.model = (await adbEmu(['shell', 'getprop', 'ro.product.model'])).out.trim();
    const ins = await adbEmu(['install', '-r', APK], { timeoutMs: 180000 });
    R.install = ins.out.trim().slice(-200);
    assert.match(ins.out, /Success/, `install 失敗: ${ins.out}`);
    for (const p of ['android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS']) await adbEmu(['shell', 'pm', 'grant', PKG, p]);
    await adbEmu(['shell', 'am', 'force-stop', PKG]);
    await adbEmu(['logcat', '-c']);
    await adbEmu(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
    let pid = null;
    for (let i = 0; i < 60 && !pid; i++) { await sleep(500); const m = (await adbEmu(['shell', 'pidof', PKG])).out.trim().match(/^\d+/); pid = m && m[0]; }
    assert.ok(pid, 'アプリの pid が出ない');
    const fw = await adbEmu(['forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
    assert.equal(fw.code, 0, fw.out);
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      try { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`, { timeoutMs: 3000 }); page = l.find((t) => t.type === 'page' && /^https:\/\/localhost/.test(t.url)); } catch { /* 待つ */ }
      if (!page) await sleep(500);
    }
    assert.ok(page, 'WebView のページにつながらない');
    R.startUrl = page.url;
    S.cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await S.cdp.send('Page.enable'); await S.cdp.send('Runtime.enable');
    await S.cdp.send('Page.navigate', { url: APP_URL });
    for (let i = 0; i < 100; i++) { if (await lap('!!window.__lap && !!window.lapNative').catch(() => false)) break; await sleep(200); }
    assert.ok(await lap('!!window.__lap && !!window.lapNative'), '__lap / lapNative が出ない');
    // 短い録音を 1 つ作る（巻を作れるように）
    const { script, images } = await loadPack();
    await lap(`__lap.loadScript(${JSON.stringify(script)}, ${JSON.stringify(images)})`);
    const sid = await lap(`__lap.newSession(${JSON.stringify(script.projectId)}, { speaker: 'emu' })`, { userGesture: true, timeoutMs: 60000 });
    R.sessionId = sid;
    const rec = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 30000 });
    assert.ok(rec && rec.ok, `録音できない: ${JSON.stringify(rec)}`);
    await sleep(6000);
    await lap('__lap.press("ok")', { userGesture: true });
    await lap('__lap.press("pause")', { userGesture: true });
    const st = await lap('__lap.state().then(s => ({ cap: s.stats.captured, wr: s.stats.written, gaps: s.stats.gaps, raw: s.rawFiles.length }))');
    R.recording = st;
    assert.ok(st.cap > 48000 * 3, `録音が短い: ${JSON.stringify(st)}`);
    save();
  });

  after(async () => {
    try { if (S.cdp) { await S.cdp.eval('__lap.closeSession()', { timeoutMs: 10000 }).catch(() => {}); S.cdp.close(); } } catch { /* 無視 */ }
    await adbEmu(['forward', '--remove', `tcp:${CDP_PORT}`]).catch(() => {});
    R.finishedAt = new Date().toISOString();
    save();
  });

  const skip = (t) => { if (S.skip) { t.skip(S.skip); return true; } return false; };

  test('1 件の保存：保存画面は 1 回だけ開き、結果が JS に戻り、アプリが前面に戻る', async (t) => {
    if (skip(t)) return;
    await adbEmu(['logcat', '-c']);
    const sum = await lap('__lap.exportStart({ kind: "full", speaker: "emu" })', { timeoutMs: 60000 });
    const built = await lap('__lap.exportBuild(1)', { timeoutMs: 120000 });
    const before = await bridge();
    await lap('__lap.exportDownload(1)', { userGesture: true, timeoutMs: 30000 });
    const pressed = await pressSaveTimes(1, 'single');
    await sleep(1500);
    const after = await bridge();
    const front = await waitMainFront();
    const starts = await startsOfPicker();
    R.scenes.single = { volumes: sum.volumes, built: { file: built.file, bytes: built.bytes }, pressed, before, after, front, pickerStarts: starts, photoAfter: await shot('single-after') };
    save();
    assert.equal(starts, 1, '保存画面が 1 回より多く（または 0 回）開いた');
    assert.equal(after.saves, before.saves + 1, '保存が完了しなかった');
    const entry = after.saveLog.at(-1);
    assert.ok(entry.ok && entry.bytes === built.bytes, `保存した大きさが違う: ${JSON.stringify(entry)}`);
    assert.ok(front && front.includes(PKG), `アプリが前面に戻っていない: ${front}`);
    assert.equal(after.queued, 0);
    await lap('__lap.exportConfirm(1)');
  });

  test('取りやめ：戻るキーで保存画面を閉じると、取りやめとして返り、覆いが残らない', async (t) => {
    if (skip(t)) return;
    await adbEmu(['logcat', '-c']);
    await lap('__lap.exportStart({ kind: "full", speaker: "emu" })', { timeoutMs: 60000 });
    const built = await lap('__lap.exportBuild(1)', { timeoutMs: 120000 });
    const before = await bridge();
    await lap('__lap.exportDownload(1)', { userGesture: true, timeoutMs: 30000 });
    const nodes = await waitPicker();
    assert.ok(nodes, '保存画面が出ない');
    const photo = await shot('cancel-picker');
    await key(4); // BACK
    const front = await waitMainFront();
    await sleep(2500);
    const after = await bridge();
    const overlay = await lap("!!document.querySelector('[role=alertdialog]')");
    const starts = await startsOfPicker();
    R.scenes.cancel = { photo, before, after, front, overlay, pickerStarts: starts, photoAfter: await shot('cancel-after') };
    save();
    assert.equal(starts, 1);
    assert.equal(after.saves, before.saves);
    assert.ok(after.saveLog.at(-1).cancelled, `取りやめとして返っていない: ${JSON.stringify(after.saveLog.at(-1))}`);
    assert.equal(overlay, false, '覆いが残っている');
    assert.ok(front && front.includes(PKG));
    await lap('__lap.exportConfirm(1)').catch(() => {});
  });

  test('巻と索引の連続保存：重ねて呼んでも保存画面は 1 つずつ（二重に開かない）', async (t) => {
    if (skip(t)) return;
    await adbEmu(['logcat', '-c']);
    const sum = await lap('__lap.exportStart({ kind: "full", speaker: "emu" })', { timeoutMs: 60000 });
    assert.ok(sum.volumes >= 2, `巻が 2 つ以上にならない（${sum.volumes}）。volumeMax を見直す`);
    const before = await bridge();
    const expectBytes = [];
    const photos = [];
    let total = 0;
    // アプリの手順どおり、1 巻ずつ「作る → 保存 → 保存したと確かめる」。1 巻目だけ、保存ボタンを素早く 2 回押した（二重の呼び出し）形にする
    for (let n = 1; n <= sum.volumes; n++) {
      const built = await lap(`__lap.exportBuild(${n})`, { timeoutMs: 120000 });
      const calls = n === 1 ? 2 : 1;
      await lap(`(() => { for (let k = 0; k < ${calls}; k++) __lap.exportDownload(${n}); })()`, { userGesture: true, timeoutMs: 30000 });
      const mid = await bridge();
      if (n === 1) R.queuedRightAfterDoubleCall = mid.queued;
      for (let k = 0; k < calls; k++) expectBytes.push(built.bytes);
      total += calls;
      photos.push(...await pressSaveTimes(calls, `multi-v${n}`));
      await lap(`__lap.exportConfirm(${n})`);
    }
    // 索引を続けて 2 回（巻のあとに索引を保存する手順）
    await lap('(() => { __lap.exportDownloadIndex(); __lap.exportDownloadIndex(); })()', { userGesture: true, timeoutMs: 30000 });
    total += 2;
    photos.push(...await pressSaveTimes(2, 'multi-index'));
    await sleep(2000);
    const after = await bridge();
    const front = await waitMainFront();
    const starts = await startsOfPicker();
    R.scenes.multi = { volumes: sum.volumes, total, expectBytes, before, queuedRightAfterDoubleCall: R.queuedRightAfterDoubleCall, photos, after, front, pickerStarts: starts, photoAfter: await shot('multi-after') };
    save();
    assert.equal(starts, total, `保存画面の起動が ${starts} 回（期待 ${total}）`);
    assert.equal(after.saves, before.saves + total, '全部が保存されていない');
    assert.equal(after.saveStarts, before.saveStarts + total);
    const log = after.saveLog.slice(-total);
    assert.ok(log.every((e) => e.ok), `失敗がある: ${JSON.stringify(log)}`);
    expectBytes.forEach((bytes, i) => assert.equal(log[i].bytes, bytes, `${i + 1} 件目の大きさ`));
    assert.equal(after.queued, 0);
    assert.ok(front && front.includes(PKG));
  });

  test('同じ名前での上書き：2 回目も保存でき、書いた大きさが 2 回目のものになる', async (t) => {
    if (skip(t)) return;
    await adbEmu(['logcat', '-c']);
    const before = await bridge();
    const out = [];
    for (const size of [200000, 80000]) {
      await lap(`(() => { const b = new Blob([new Uint8Array(${size}).fill(7)], { type: 'application/octet-stream' }); window.__r = window.lapNative.saveBlob(b, 'overwrite-test.bin'); })()`, { userGesture: true });
      out.push(...await pressSaveTimes(1, `overwrite-${size}`));
      const r = await lap('window.__r');
      out.push({ size, result: r });
    }
    await sleep(1000);
    const after = await bridge();
    R.scenes.overwrite = { out, before, after, pickerStarts: await startsOfPicker(), photoAfter: await shot('overwrite-after') };
    save();
    assert.equal(after.saves, before.saves + 2);
    assert.deepEqual(after.saveLog.slice(-2).map((e) => e.bytes), [200000, 80000]);
  });

  test('保存できない場所での押下（観察）：保存画面に残るか、戻るか、アプリが落ちないか', async (t) => {
    if (skip(t)) return;
    await adbEmu(['logcat', '-c']);
    const before = await bridge();
    await lap(`(() => { window.__r = window.lapNative.saveBlob(new Blob([new Uint8Array(1000)]), 'blocked-place.bin'); })()`, { userGesture: true });
    const nodes = await waitPicker();
    assert.ok(nodes, '保存画面が出ない');
    const obs = { photoStart: await shot('blocked-picker'), steps: [] };
    // 保存できない場所へ移る：ルートの一覧（ドロワー）から「最近」「画像」など、保存先にできない場所を選ぶ
    const drawer = nodes.find((n) => /roots|ルート|menu|メニュー/i.test(n['content-desc'] || ''));
    if (drawer) {
      await tap(drawer); await sleep(1200);
      const n2 = await ui();
      obs.drawerPhoto = await shot('blocked-drawer');
      // 端末の保存領域のルート（sdk_gphone…）へ移り、Android フォルダ、その中の data（アプリのデータの場所。保存先にできない）まで進む
      const target = n2.find((n) => n.package === 'com.google.android.documentsui' && /^(sdk_|internal|内部|recent|最近)/i.test((n.text || '').trim()));
      obs.target = target ? target.text : null;
      if (target) { await tap(target); await sleep(2000); }
      for (const folder of ['Android', 'data']) {
        const nn = await ui();
        const f = nn.find((n) => n.package === 'com.google.android.documentsui' && (n.text || '').trim() === folder);
        obs.steps.push({ folder, found: !!f });
        if (!f) break;
        await tap(f); await sleep(2000);
      }
    } else obs.drawer = 'ドロワーのボタンが見つからない';
    const n3 = await waitPicker(8000).catch(() => null);
    obs.photoBlockedPlace = await shot('blocked-place');
    const saveBtn = n3 && findSave(n3);
    obs.saveEnabled = saveBtn ? saveBtn.enabled : null;
    if (saveBtn) { await tap(saveBtn); await sleep(2500); obs.photoAfterTap = await shot('blocked-after-tap'); }
    const n4 = await ui().catch(() => []);
    obs.pickerStillOpenAfterTap = inPicker(n4);
    obs.front = await frontActivity();
    obs.dialogTexts = n4.filter((n) => n.package === 'com.google.android.documentsui' && n.text).map((n) => n.text).slice(0, 25);
    // 後始末：保存画面が残っていれば戻るキーで閉じる
    for (let i = 0; i < 4 && obs.pickerStillOpenAfterTap; i++) { await key(4); await sleep(1500); obs.pickerStillOpenAfterTap = inPicker(await ui().catch(() => [])); }
    await waitMainFront();
    await sleep(3500);
    const after = await bridge();
    obs.starts = await startsOfPicker();
    obs.bridge = { before, after };
    obs.crash = (await adbEmu(['logcat', '-d'])).out.split('\n').filter((l) => /FATAL EXCEPTION/.test(l) && l.includes('lapnarrator')).length;
    R.scenes.blocked = obs;
    save();
    assert.equal(obs.crash, 0, 'アプリが異常終了した');
    assert.ok((await frontActivity() || '').includes(PKG), 'アプリが前面にいない');
  });
});
