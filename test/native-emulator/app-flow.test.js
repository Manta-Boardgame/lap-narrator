// アプリ単体（Chrome なし）の通しを、エミュレーター（emulator-5554）で確かめる試験（担当 K2）。
// 実機には触れない（adb-emu.js が `-s emulator-5554` を必ず付ける）。録音のマイクは仮想マイク（無音）。
// 前提：エミュレーターが起動済み（ANDROID_AVD_HOME=work/K/avd、`emulator -avd Medium_Phone_API_36.1 -no-snapshot -no-boot-anim -memory 2048`）。
//   起動していなければ全部スキップ。APK は環境変数 EMU_APK（既定 work/K/app-debug-k3.apk）。
// 場面：
//   1 台本パックの読み込み：画面の「台本パック（zip）を選ぶ」→ システムのファイル選択（DocumentsUI）で jp15.zip を選ぶ（Capacitor の file chooser）。
//        zip は adb push で /sdcard/Download/ に置く（利用者がスマホに置く操作の代わり。エミュレーターだけ）。
//   2 録音〜保存の通し：録音（約 8 秒）→ OK → 書き出し → システムの保存画面で保存。
//   3 Chrome 非依存：通しの間に com.android.chrome のアクティビティが起動していない（logcat の ActivityTaskManager START と dumpsys activity activities）。
// 結果は work/K/emu-app-flow-results.json、画面写真は work/K/emu-shots-app/。使い方：npm run test:native-emulator:app
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adbEmu, ROOT, PKG, WORK_DIR } from './adb-emu.js';
import { Cdp, httpJson, sleep } from '../device/helpers/cdp.js';

const WORK = WORK_DIR; // 既定 work/K。LAP_EMU_WORK で変えられる
const SHOTS = path.join(WORK, 'emu-shots-app');
const RESULTS = path.join(WORK, 'emu-app-flow-results.json');
const APK = path.resolve(process.env.EMU_APK || path.join(WORK, 'app-debug-k3.apk'));
const PACK_NAME = 'jp15.zip';
const PACK = path.join(ROOT, 'examples', 'packs', PACK_NAME);
const APP_URL = 'https://localhost/app/index.html?lapdev=1&countdown=0&nosw=1';
const CDP_PORT = 9223;
const say = (m) => process.stderr.write(`[K-emu-app ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const R = { startedAt: new Date().toISOString(), apk: APK, scenes: {} };
const save = () => { fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(RESULTS, JSON.stringify(R, null, 2) + '\n'); };
const S = { skip: null, cdp: null, shotNo: 0 };
const lap = (expr, o) => S.cdp.eval(expr, o);

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
    const anr = nodes.some((n) => /isn't responding|応答していません|keeps stopping|停止しました/i.test(n.text || ''));
    if (!anr) return nodes;
    R.anrDialogs = (R.anrDialogs || 0) + 1;
    const wait = nodes.find((n) => /^(wait|待機|待つ|OK)$/i.test((n.text || '').trim()));
    if (wait) await tap(wait);
    await sleep(1500);
  }
  return [];
}
const inPicker = (nodes) => nodes.some((n) => n.package === 'com.google.android.documentsui');
const tap = (n) => adbEmu(['shell', 'input', 'tap', String(n.x), String(n.y)]);
const key = (code) => adbEmu(['shell', 'input', 'keyevent', String(code)]);
async function waitFor(pred, timeoutMs = 40000, every = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const nodes = await ui().catch(() => []); const v = pred(nodes); if (v) return { nodes, v }; await sleep(every); }
  return null;
}
async function frontActivity() {
  const r = await adbEmu(['shell', 'dumpsys', 'activity', 'activities'], { timeoutMs: 30000 });
  return ((r.out.match(/topResumedActivity=ActivityRecord\{[^ ]+ u0 ([^ ]+)/) || [])[1]) || null;
}
const findSave = (nodes) => nodes.find((n) => n.package === 'com.google.android.documentsui' && /^(save|保存)$/i.test((n.text || '').trim()) && /Button/.test(n.class || ''));

describe('アプリ単体（Chrome なし）の通し（エミュレーター）', { timeout: 900000 }, () => {
  before(async () => {
    const boot = await adbEmu(['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 15000 });
    if (boot.out.trim() !== '1') { S.skip = `エミュレーターが起動していない（sys.boot_completed=${JSON.stringify(boot.out.trim())}）`; R.skipped = S.skip; save(); return; }
    if (!fs.existsSync(APK)) { S.skip = `APK がない: ${APK}`; R.skipped = S.skip; save(); return; }
    R.model = (await adbEmu(['shell', 'getprop', 'ro.product.model'])).out.trim();
    const ins = await adbEmu(['install', '-r', APK], { timeoutMs: 180000 });
    assert.match(ins.out, /Success/, `install 失敗: ${ins.out}`);
    const pushed = await adbEmu(['push', PACK, `/sdcard/Download/${PACK_NAME}`], { timeoutMs: 60000 });
    R.push = pushed.out.trim().slice(-160);
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
    // 記録の入口（__lap）が要るので、開発用の URL で開き直す（台本パックの読み込みは、画面の本物の経路を使う）
    await S.cdp.send('Page.navigate', { url: APP_URL });
    for (let i = 0; i < 100; i++) { if (await lap('!!window.__lap && !!window.lapNative && !!document.getElementById("file-pack")').catch(() => false)) break; await sleep(200); }
    assert.ok(await lap('!!window.__lap && !!document.getElementById("file-pack")'), 'アプリの画面が出ない');
    R.firstScreen = { text: (await lap('document.body.innerText')).slice(0, 300), photo: await shot('first-screen') };
    save();
  });

  after(async () => {
    try { if (S.cdp) { await S.cdp.eval('__lap.closeSession()', { timeoutMs: 10000 }).catch(() => {}); S.cdp.close(); } } catch { /* 無視 */ }
    await adbEmu(['forward', '--remove', `tcp:${CDP_PORT}`]).catch(() => {});
    R.finishedAt = new Date().toISOString();
    save();
  });
  const skip = (t) => { if (S.skip) { t.skip(S.skip); return true; } return false; };

  test('1 台本パックの読み込み：システムのファイル選択で jp15.zip を選ぶと、アプリが台本を開く', async (t) => {
    if (skip(t)) return;
    const before = await lap('document.body.innerText');
    await lap('document.getElementById("file-pack").click()', { userGesture: true });
    const got = await waitFor((nodes) => inPicker(nodes) && nodes.length > 5, 30000);
    assert.ok(got, 'ファイル選択の画面が出ない（Capacitor の file chooser が開かない）');
    R.scenes.pack = { pickerPhoto: await shot('pack-picker'), pickerTexts: got.nodes.map((n) => n.text).filter(Boolean).slice(0, 30) };
    // jp15.zip が見えなければ、ドロワーから「ダウンロード」へ
    const fileNode = (nodes) => nodes.find((n) => n.package === 'com.google.android.documentsui' && (n.text || '').trim() === PACK_NAME);
    let f = fileNode(got.nodes);
    if (!f) {
      const drawer = got.nodes.find((n) => /roots|ルート|menu|メニュー/i.test(n['content-desc'] || ''));
      if (drawer) { await tap(drawer); await sleep(1200); }
      const nn = await ui();
      const dl = nn.find((n) => n.package === 'com.google.android.documentsui' && /^(downloads?|ダウンロード)$/i.test((n.text || '').trim()));
      R.scenes.pack.downloadsEntry = !!dl;
      if (dl) { await tap(dl); await sleep(2000); }
      const again = await waitFor((nodes) => fileNode(nodes), 20000);
      f = again && again.v;
      R.scenes.pack.afterNav = await shot('pack-picker-downloads');
    }
    assert.ok(f, `ファイル選択に ${PACK_NAME} が見えない`);
    await tap(f);
    // 選んだら、アプリへ戻り、台本が開く（ホームの表示が変わる、または open-msg に結果）
    let after = null;
    for (let i = 0; i < 40; i++) {
      await sleep(700);
      const front = await frontActivity();
      after = await lap('({ text: document.body.innerText, msg: (document.getElementById("open-msg") || {}).textContent || "" })').catch(() => null);
      if (front && front.includes(PKG) && after && after.text !== before) break;
    }
    R.scenes.pack.after = after && { msg: after.msg, text: after.text.slice(0, 600) };
    R.scenes.pack.photoAfter = await shot('pack-opened');
    save();
    assert.ok(after && after.text !== before, '画面が変わらない（台本が開いていない）');
    assert.ok(!/(error|失敗|読めません|invalid)/i.test(after.msg), `読み込みの失敗: ${after.msg}`);
    R.scenes.pack.ok = true;
  });

  test('2 録音（約 8 秒）→ OK → 書き出し → システムの保存画面で保存', async (t) => {
    if (skip(t)) return;
    const projs = await lap('__lap.projects()');
    R.scenes.rec = { projects: projs.map((p) => ({ id: p.projectId || p.id, title: p.title || p.name })) };
    assert.ok(projs.length >= 1, '読み込んだ台本が一覧にない');
    const pid = projs[0].projectId || projs[0].id;
    const sid = await lap(`__lap.newSession(${JSON.stringify(pid)}, { speaker: 'emu' })`, { userGesture: true, timeoutMs: 60000 }).catch((e) => `error:${e.message}`);
    R.scenes.rec.sessionId = sid;
    assert.ok(typeof sid === 'string' && !sid.startsWith('error:'), `セッションが作れない: ${sid}`);
    const rec = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 30000 });
    assert.ok(rec && rec.ok, `録音できない: ${JSON.stringify(rec)}`);
    await sleep(8000);
    await lap('__lap.press("ok")', { userGesture: true });
    await lap('__lap.press("pause")', { userGesture: true });
    const st = await lap('__lap.state().then(s => ({ cap: s.stats.captured, wr: s.stats.written, gaps: s.stats.gaps }))');
    R.scenes.rec.stats = st;
    assert.ok(st.cap > 48000 * 5 && st.cap === st.wr && st.gaps === 0, `録音の数が合わない: ${JSON.stringify(st)}`);
    const sum = await lap('__lap.exportStart({ kind: "full", speaker: "emu" })', { timeoutMs: 60000 });
    const built = await lap('__lap.exportBuild(1)', { timeoutMs: 120000 });
    const before = await lap('window.lapNative.state()');
    await lap('__lap.exportDownload(1)', { userGesture: true, timeoutMs: 30000 });
    const got = await waitFor((nodes) => inPicker(nodes) && findSave(nodes), 40000);
    assert.ok(got, '保存画面が出ない');
    R.scenes.rec.savePicker = await shot('save-picker');
    await tap(findSave(got.nodes));
    for (let i = 0; i < 30; i++) { await sleep(700); const f = await frontActivity(); if (f && f.includes(PKG)) break; }
    // 保存の書き込みを待つ（エミュレーターは遅く、約 1 MB の書き込みに 1 分近くかかることがある）
    for (let i = 0; i < 120; i++) { if ((await lap('window.lapNative.state().saves')) > before.saves) break; await sleep(1000); }
    const after = await lap('window.lapNative.state()');
    R.scenes.rec.save = { volumes: sum.volumes, bytes: built.bytes, saves: [before.saves, after.saves], last: after.saveLog.at(-1), photoAfter: await shot('save-done') };
    save();
    assert.equal(after.saves, before.saves + 1, '保存が完了しなかった');
    assert.ok(after.saveLog.at(-1).ok && after.saveLog.at(-1).bytes === built.bytes);
  });

  test('2b 共有（ACTION_SEND）：保存したファイルの共有の画面が出る', async (t) => {
    if (skip(t)) return;
    const uri = R.scenes.rec && R.scenes.rec.save && R.scenes.rec.save.last && R.scenes.rec.save.last.uri;
    assert.ok(uri, '保存した uri がない（2 が通っていない）');
    await lap(`window.lapNative.share({ uri: ${JSON.stringify(uri)}, mimeType: 'application/zip', title: 'lap-narrator' })`, { userGesture: true, timeoutMs: 20000 });
    let front = null;
    for (let i = 0; i < 20; i++) { await sleep(700); front = await frontActivity(); if (front && !front.includes(PKG)) break; }
    R.scenes.share = { front, photo: await shot('share-chooser') };
    save();
    assert.ok(front && /(Chooser|Resolver|Sharesheet|intentresolver)/i.test(front), `共有の画面が出ない: ${front}`);
    await key(4);
    await sleep(1200);
  });

  test('3 Chrome 非依存：通しの間に com.android.chrome が起動していない', async (t) => {
    if (skip(t)) return;
    const log = await adbEmu(['logcat', '-d'], { timeoutMs: 40000 });
    const starts = log.out.split('\n').filter((l) => /ActivityTaskManager: START u0/.test(l));
    const chromeStarts = starts.filter((l) => /com\.android\.chrome/.test(l));
    const acts = (await adbEmu(['shell', 'dumpsys', 'activity', 'activities'], { timeoutMs: 30000 })).out;
    const chromeInStack = /com\.android\.chrome/.test(acts);
    R.scenes.chrome = { startLinesChecked: starts.length, chromeStarts: chromeStarts.length, chromeInActivityStack: chromeInStack, startTargets: [...new Set(starts.map((l) => (l.match(/cmp=(\S+)/) || [])[1]).filter(Boolean))] };
    save();
    assert.equal(chromeStarts.length, 0, `Chrome が起動した: ${chromeStarts[0]}`);
    assert.equal(chromeInStack, false, 'アクティビティの一覧に Chrome がある');
  });

  test('4 AI 用の動画作成プロンプトのコピー：ホームのボタンを押すと「コピーしました」が出る（クリップボードの中身は、読めれば確かめる）', async (t) => {
    if (skip(t)) return;
    // 録音の画面からホームへ戻り、表示を日本語にする
    await lap('__lap.closeSession()', { timeoutMs: 20000 }).catch(() => {});
    for (let i = 0; i < 20 && !(await lap('!!document.getElementById("view-home") && !document.getElementById("view-home").hidden')); i++) await sleep(300);
    if ((await lap('document.documentElement.lang')) !== 'ja') await lap('document.getElementById("btn-lang").click()', { userGesture: true });
    const label = await lap('document.getElementById("ai-prompt-copy").textContent.trim()');
    assert.equal(label, 'AI 用の動画作成プロンプトをコピー');
    await lap('document.getElementById("ai-prompt-copy").scrollIntoView()');
    R.scenes.prompt = { label, photoBefore: await shot('prompt-before') };
    await lap('document.getElementById("ai-prompt-copy").click()', { userGesture: true });
    let msg = '';
    for (let i = 0; i < 40; i++) { await sleep(500); msg = await lap('document.getElementById("ai-prompt-msg").textContent'); if (/コピーしました|コピーできませんでした|作れませんでした/.test(msg)) break; }
    R.scenes.prompt.message = msg;
    R.scenes.prompt.copyMethod = await lap('document.getElementById("ai-prompt-copy").dataset.copyMethod || null');
    R.scenes.prompt.manualShown = await lap('!document.getElementById("ai-prompt-manual").hidden');
    R.scenes.prompt.photoAfter = await shot('prompt-copied');
    R.scenes.prompt.navigatorLanguage = await lap('navigator.language');
    save();
    assert.equal(msg, 'コピーしました', `メッセージ: ${msg}`);
    // システムのクリップボードの中身：WebView から読めれば読む。読めなければ、貼り付けのキー（KEYCODE_PASTE）で、アプリの入力欄に貼って読む。
    let clip = null;
    try { clip = await lap('navigator.clipboard.readText()', { userGesture: true, timeoutMs: 8000 }); R.scenes.prompt.clipboardVia = 'navigator.clipboard.readText'; } catch (e) { R.scenes.prompt.readTextError = String(e && e.message || e).slice(0, 120); }
    if (!clip) {
      await lap('(() => { document.querySelector("details.paste").open = true; const ta = document.getElementById("paste-json"); ta.value = ""; ta.focus(); return document.activeElement === ta; })()', { userGesture: true });
      await sleep(500);
      await key(279); // KEYCODE_PASTE
      await sleep(1500);
      clip = await lap('document.getElementById("paste-json").value');
      if (clip) R.scenes.prompt.clipboardVia = 'KEYCODE_PASTE into the paste box';
      await lap('(() => { const ta = document.getElementById("paste-json"); ta.value = ""; ta.blur(); document.querySelector("details.paste").open = false; })()');
    }
    R.scenes.prompt.clipboardLength = clip ? clip.length : 0;
    R.scenes.prompt.clipboardHead = clip ? clip.slice(0, 160) : null;
    if (clip) {
      assert.match(clip, /^# Make a narrated slide video with lap-narrator/);
      assert.match(clip, /Prompt version: 0[.]2[.]0-native/);
      assert.match(clip, /Language hint: [A-Za-z-]+/);
      assert.ok(clip.includes("Respond to the user in the user's own language"));
      assert.match(clip, /### Export 1: exportId `[a-z0-9]{12}`/, '直前の試験で書き出した項目の情報が入る（端末内の操作記録から）');
      R.scenes.prompt.clipboardChecked = true;
    } else {
      R.scenes.prompt.clipboardChecked = false;
      R.scenes.prompt.note = 'クリップボードの中身は読めなかった（未確認）。「コピーしました」の表示だけを確かめた';
    }
    save();
  });

  test('5 通しの録音：台本の表示／非表示、台本なしで録音を始める、録音 → 書き出し → 保存', async (t) => {
    if (skip(t)) return;
    const jsClick = (sel) => lap(`document.querySelector(${JSON.stringify(sel)}).click()`, { userGesture: true });
    await lap('__lap.closeSession()', { timeoutMs: 20000 }).catch(() => {});
    for (let i = 0; i < 20 && !(await lap('!document.getElementById("view-home").hidden')); i++) await sleep(300);
    if ((await lap('document.documentElement.lang')) !== 'ja') await jsClick('#btn-lang');
    R.scenes.cont = {};
    // 既定は通し：スライド区切りの設定は入っていない。読み込んだ台本（1 で読み込んだ jp15）を表示して録音を始める
    R.scenes.cont.perSlideChecked = await lap('document.getElementById("chk-per-slide").checked');
    assert.equal(R.scenes.cont.perSlideChecked, false, '既定は通し');
    await jsClick('[data-act=new-session][data-project]');
    for (let i = 0; i < 30 && !(await lap('!document.getElementById("view-record").hidden')); i++) await sleep(300);
    await sleep(500);
    const shown = await lap('({ card: !document.getElementById("script-card").hidden, body: !document.getElementById("script-body").hidden, len: document.getElementById("reading").textContent.length, next: !!document.getElementById("btn-next") && !document.getElementById("btn-next").offsetParent, list: !document.getElementById("slide-list").offsetParent })');
    R.scenes.cont.shown = shown;
    R.scenes.cont.photoShown = await shot('cont-script-shown');
    assert.ok(shown.card && shown.body && shown.len > 50, JSON.stringify(shown));
    assert.ok(shown.next && shown.list, '通しでは「次のスライドへ」とスライドの一覧は出ない');
    await jsClick('#btn-script-toggle');
    await sleep(300);
    R.scenes.cont.hidden = await lap('({ body: !document.getElementById("script-body").hidden, label: document.getElementById("btn-script-toggle").textContent, saved: localStorage.getItem("lap.scriptVisible") })');
    R.scenes.cont.photoHidden = await shot('cont-script-hidden');
    assert.deepEqual(R.scenes.cont.hidden, { body: false, label: '台本を出す', saved: '0' });
    await jsClick('#btn-script-toggle');
    await sleep(300);
    assert.equal(await lap('!document.getElementById("script-body").hidden'), true);
    await lap('__lap.closeSession()', { timeoutMs: 20000 });
    for (let i = 0; i < 20 && !(await lap('!document.getElementById("view-home").hidden')); i++) await sleep(300);
    // 台本なしで録音を始める（ホームのボタン）→ 約 6 秒録る → OK → 書き出し → 保存
    await jsClick('#btn-new-free');
    for (let i = 0; i < 30 && !(await lap('!document.getElementById("view-record").hidden')); i++) await sleep(300);
    assert.equal(await lap('document.getElementById("script-card").hidden'), true, '台本が無いときは台本の欄を出さない');
    const rec = await lap('__lap.press("record")', { userGesture: true, timeoutMs: 30000 });
    assert.ok(rec && rec.ok, JSON.stringify(rec));
    await sleep(6000);
    await lap('__lap.press("ok")', { userGesture: true });
    await lap('__lap.press("pause")', { userGesture: true });
    const st = await lap('__lap.state().then(s => ({ cap: s.stats.captured, wr: s.stats.written, gaps: s.stats.gaps, slide: s.slideId, types: null }))');
    const evs = await lap('__lap.events().then(e => e.map(x => x.type))');
    R.scenes.cont.stats = st;
    R.scenes.cont.types = [...new Set(evs)];
    assert.ok(st.cap > 48000 * 4 && st.cap === st.wr && st.gaps === 0, JSON.stringify(st));
    assert.equal(st.slide, 'free');
    assert.ok(!evs.includes('next-slide') && !evs.includes('goto-slide'));
    const sum = await lap('__lap.exportStart({ kind: "full" })', { timeoutMs: 60000 });
    const built = await lap('__lap.exportBuild(1)', { timeoutMs: 120000 });
    const before = await lap('window.lapNative.state()');
    await lap('__lap.exportDownload(1)', { userGesture: true, timeoutMs: 30000 });
    const got = await waitFor((nodes) => inPicker(nodes) && findSave(nodes), 40000);
    assert.ok(got, '保存画面が出ない');
    await tap(findSave(got.nodes));
    for (let i = 0; i < 30; i++) { await sleep(700); const fa = await frontActivity(); if (fa && fa.includes(PKG)) break; }
    // 保存の書き込みを待つ（エミュレーターは遅く、約 1 MB の書き込みに 1 分近くかかることがある）
    for (let i = 0; i < 120; i++) { if ((await lap('window.lapNative.state().saves')) > before.saves) break; await sleep(1000); }
    const after = await lap('window.lapNative.state()');
    R.scenes.cont.save = { volumes: sum.volumes, bytes: built.bytes, saves: [before.saves, after.saves], last: after.saveLog.at(-1), photo: await shot('cont-saved') };
    save();
    assert.equal(after.saves, before.saves + 1, '保存が完了しなかった');
    assert.ok(after.saveLog.at(-1).ok && after.saveLog.at(-1).bytes === built.bytes);
  });
});
