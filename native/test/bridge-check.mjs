// native/web/native-bridge.js の動作を、PC の Chrome で確かめる（実機ではない）。
// - Capacitor の橋渡し（window.Capacitor）を模擬に差し替え、プラグインの呼び出しを記録する。
// - 偽のマイク（Chrome の --use-fake-device-for-media-stream。音は出ない、本物のマイクは使わない）で getUserMedia を呼ぶ。
// - ページは https://localhost/ への要求を横取りして返す（ポートを開かない）。Chrome のプロフィールは work/K/ の専用のもの。
// 使い方：node native/test/bridge-check.mjs      （node:test ではない。npm test には入れない）
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const bridgeSrc = readFileSync(join(root, 'native', 'web', 'native-bridge.js'), 'utf8');
const profile = join(root, 'work', 'K', 'chrome-profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--no-default-browser-check'],
});
try {
  const page = await ctx.newPage();
  await page.route('https://localhost/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title></head><body></body></html>' }));

  // Capacitor の模擬：nativePromise の呼び出しを window.__calls に積む。saveWrite の中身は集める。
  await page.addInitScript(() => {
    window.__lapNativeTune = { resultGraceMs: 400, noticeMs: 700 };
    window.__calls = [];
    window.__saved = [];
    // 保存画面の模擬：beginMode 'now' は即返す、'delay' は delayMs 後、'never' は返さない（結果が失われた場合）。開いている保存画面の数を数える。
    window.__mock = { beginMode: 'now', delayMs: 150, open: 0, maxOpen: 0, seq: 0, bytes: {}, lateResolvers: [] };
    window.Capacitor = {
      isNativePlatform: () => true,
      nativePromise: (plugin, method, opts) => {
        const M = window.__mock;
        window.__calls.push({ plugin, method, opts: method === 'saveWrite' ? { handle: opts.handle, len: opts.data.length } : opts });
        if (method === 'saveWrite') { window.__saved.push(opts.data); M.bytes[opts.handle] = (M.bytes[opts.handle] || 0) + atob(opts.data).length; }
        if (method === 'saveBegin') {
          const handle = 'h' + (++M.seq);
          M.open++; M.maxOpen = Math.max(M.maxOpen, M.open);
          const result = { handle, uri: 'content://x/' + handle };
          if (M.beginMode === 'now') { M.open--; return Promise.resolve(result); }
          if (M.beginMode === 'delay') return new Promise((r) => setTimeout(() => { M.open--; r(result); }, M.delayMs));
          return new Promise((r) => { M.lateResolvers.push(() => { M.open--; r(result); }); }); // never：あとで手動で返す
        }
        if (method === 'saveEnd') return Promise.resolve({ bytes: M.bytes[opts.handle] || 0, uri: 'content://x/' + opts.handle });
        return Promise.resolve({});
      },
    };
  });
  await page.goto('https://localhost/');
  await page.evaluate(bridgeSrc); // 本番では main.js の前に <script> として読まれる

  check('lapNative が公開される', await page.evaluate(() => !!window.lapNative && window.lapNative.isNative === true));

  // 1. getUserMedia → 通知の許可 → サービスの開始
  const got = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    window.__streams = [s];
    await new Promise((r) => setTimeout(r, 50));
    return { tracks: s.getAudioTracks().length, calls: window.__calls.map((c) => c.method), state: window.lapNative.state() };
  });
  check('getUserMedia の成功でサービスを始める', got.tracks === 1 && got.calls.join(',') === 'ensureNotificationPermission,startService' && got.state.serviceOn, JSON.stringify(got));

  // 2. 画面が隠れたとき：サービスが動いている間は、あとから登録された監視に届かない
  const hidden = await page.evaluate(() => {
    let seen = 0;
    document.addEventListener('visibilitychange', () => { seen++; });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const whileRunning = seen;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return { whileRunning, afterVisible: seen, ignored: window.lapNative.state().hiddenIgnored };
  });
  check('サービス中の hidden は app に渡さない', hidden.whileRunning === 0 && hidden.ignored === 1, JSON.stringify(hidden));
  check('visible は app に渡す', hidden.afterVisible === 1);

  // 3. トラックを止めるとサービスを止める。止めたあとの hidden は app に届く
  const stopped = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true }); // 2 本目のストリーム
    s.getAudioTracks().forEach((t) => t.stop());
    await new Promise((r) => setTimeout(r, 50));
    return { calls: window.__calls.map((c) => c.method), state: window.lapNative.state() };
  });
  // 1 本目がまだ生きているので、2 本目の停止ではサービスを止めない
  check('別のストリームを止めてもサービスは続く', stopped.state.serviceOn && stopped.state.liveTracks === 1, JSON.stringify(stopped.state));
  // 残りのストリームを全部止める → サービスを止める。止めたあとの hidden は app に届く
  const allStopped = await page.evaluate(async () => {
    window.__calls.length = 0;
    for (const st of window.__streams) st.getAudioTracks().forEach((t) => t.stop());
    await new Promise((r) => setTimeout(r, 100));
    let seen = 0;
    document.addEventListener('visibilitychange', () => { seen++; });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    return { calls: window.__calls.map((c) => c.method), state: window.lapNative.state(), seenAfterStop: seen };
  });
  check('全部止めたらサービスを止める', allStopped.calls.join(',') === 'stopService' && !allStopped.state.serviceOn && allStopped.state.liveTracks === 0, JSON.stringify(allStopped));
  check('サービスが止まったあとの hidden は app に届く', allStopped.seenAfterStop === 1);

  // 4. 保存：blob の <a download> の click を、システムの保存画面の呼び出しに変える
  const size = 1_300_000; // 512KiB の塊で 3 つになる大きさ
  const saved = await page.evaluate(async (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 255;
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'テスト巻.zip';
    document.body.append(a);
    window.__calls.length = 0;
    window.__saved.length = 0;
    a.click();
    await new Promise((r) => setTimeout(r, 2500)); // 保存と、完了の表示の待ち
    // 書き出された内容が、元のバイト列と同じか
    const parts = window.__saved.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const total = parts.reduce((m, p) => m + p.length, 0);
    const all = new Uint8Array(total);
    let off = 0; for (const p of parts) { all.set(p, off); off += p.length; }
    let same = total === n;
    for (let i = 0; same && i < n; i++) if (all[i] !== bytes[i]) same = false;
    return { methods: window.__calls.map((c) => c.method), begin: window.__calls[0], total, same, overlay: !!document.querySelector('[role=alertdialog]') };
  }, size);
  check('保存の呼び出しの順序', saved.methods[0] === 'saveBegin' && saved.methods.at(-1) === 'saveEnd' && saved.methods.filter((m) => m === 'saveWrite').length === 3, saved.methods.join(','));
  check('保存名と種類', saved.begin.opts.name === 'テスト巻.zip' && saved.begin.opts.mimeType === 'application/zip');
  check('書いた中身が元と一致する', saved.same, `bytes=${saved.total}`);
  check('保存のあとで覆いが消える', saved.overlay === false);

  // 5. 取りやめ（保存画面で取り消した）：saveAbort は呼ばず（handle がない）、覆いが消える
  const cancelled = await page.evaluate(async () => {
    const orig = window.Capacitor.nativePromise;
    window.Capacitor.nativePromise = (p, m, o) => (m === 'saveBegin' ? Promise.reject(new Error('cancelled')) : orig(p, m, o));
    const url = URL.createObjectURL(new Blob([new Uint8Array(10)]));
    const a = document.createElement('a'); a.href = url; a.download = 'x.zip'; document.body.append(a);
    a.click();
    await new Promise((r) => setTimeout(r, 2800));
    window.Capacitor.nativePromise = orig;
    return { overlay: !!document.querySelector('[role=alertdialog]'), lastError: window.lapNative.state().lastError };
  });
  check('取りやめで覆いが消え、エラーが残る', cancelled.overlay === false && /cancel/i.test(cancelled.lastError || ''), JSON.stringify(cancelled));

  const returned = await page.evaluate(async () => {
    const blob = new Blob([new Uint8Array(30)]);
    const orig = window.Capacitor.nativePromise;
    const fail = (method, message) => {
      window.Capacitor.nativePromise = (p, m, o) => m === method ? Promise.reject(new Error(message)) : orig(p, m, o);
    };
    try {
      fail('saveBegin', 'cancelled');
      const cancelled = await window.lapSaveBlob(blob, 'cancelled.zip');
      fail('saveWrite', 'write failed');
      const failed = await window.lapSaveBlob(blob, 'failed.zip');
      window.Capacitor.nativePromise = orig;
      const saved = await window.lapSaveBlob(blob, 'retry.zip');
      return { cancelled, failed, saved };
    } finally {
      window.Capacitor.nativePromise = orig;
    }
  });
  check('画面の保存入口から取りやめ・書き込み失敗・再試行の結果が返る',
    returned.cancelled.ok === false && returned.cancelled.cancelled === true &&
    returned.failed.ok === false && returned.failed.error === 'write failed' &&
    returned.saved.ok === true && returned.saved.bytes === 30, JSON.stringify(returned));

  // 5b. 保存の直列化：重ねて呼んでも、保存画面は同時に 1 つしか開かない。順序は呼んだ順
  const serial = await page.evaluate(async () => {
    const M = window.__mock; M.beginMode = 'delay'; M.delayMs = 150; M.open = 0; M.maxOpen = 0;
    window.__calls.length = 0;
    const mk = (n, name) => { const b = new Blob([new Uint8Array(n).fill(3)]); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; document.body.append(a); return a; };
    const as = [mk(1000, 'v1.zip'), mk(2000, 'v2.zip'), mk(3000, 'idx.json')];
    for (const a of as) a.click(); // 待たずに 3 件続けて
    const queuedNow = window.lapNative.state().queued;
    await new Promise((r) => setTimeout(r, 2500));
    const st = window.lapNative.state();
    const begins = window.__calls.filter((c) => c.method === 'saveBegin').map((c) => c.opts.name);
    return { maxOpen: M.maxOpen, queuedNow, begins, savesOk: st.saveLog.slice(-3).map((e) => [e.name, e.ok, e.bytes]), queuedAfter: st.queued, overlay: !!document.querySelector('[role=alertdialog]') };
  });
  check('連続して呼んでも保存画面は同時に 1 つ', serial.maxOpen === 1 && serial.queuedNow === 3, JSON.stringify(serial));
  check('呼んだ順に保存し、全部成功', JSON.stringify(serial.begins) === JSON.stringify(['v1.zip', 'v2.zip', 'idx.json']) && serial.savesOk.every((e) => e[1]) && serial.savesOk.map((e) => e[2]).join() === '1000,2000,3000', JSON.stringify(serial.savesOk));
  check('全部終わったら覆いが消える', serial.queuedAfter === 0 && serial.overlay === false);

  // 5c. 保存画面から戻ったのに結果が来ない：取りやめとして返し、覆いを外し、次の保存ができる。遅れて来た結果は閉じる
  const lost = await page.evaluate(async () => {
    const M = window.__mock; M.beginMode = 'never'; M.lateResolvers.length = 0; M.open = 0; M.maxOpen = 0;
    window.__calls.length = 0;
    const b = new Blob([new Uint8Array(500)]); const u = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = u; a.download = 'lost.zip'; document.body.append(a);
    a.click();
    await new Promise((r) => setTimeout(r, 100));
    // 保存画面が前面に出て（hidden）、戻る（visible）。結果は来ない
    const setVis = (v) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); };
    setVis('hidden');
    await new Promise((r) => setTimeout(r, 100));
    setVis('visible');
    await new Promise((r) => setTimeout(r, 1200)); // 猶予（400ms）+ 余裕
    const st1 = window.lapNative.state();
    const overlay1 = !!document.querySelector('[role=alertdialog]');
    const reset = window.__calls.some((c) => c.method === 'saveResetPending');
    // 遅れて結果が来た：閉じて捨てる（saveAbort）
    M.lateResolvers.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 300));
    const aborted = window.__calls.some((c) => c.method === 'saveAbort');
    // 次の保存はできる
    M.beginMode = 'now';
    const b2 = new Blob([new Uint8Array(700)]); const u2 = URL.createObjectURL(b2);
    const a2 = document.createElement('a'); a2.href = u2; a2.download = 'next.zip'; document.body.append(a2);
    a2.click();
    await new Promise((r) => setTimeout(r, 600));
    const st2 = window.lapNative.state();
    return { cancelled: st1.saveLog.at(-1), overlay1, reset, aborted, cancels: st1.saveCancels, next: st2.saveLog.at(-1) };
  });
  check('戻ったのに結果が来ない場合は取りやめになり、覆いが外れる', lost.cancelled.cancelled === true && lost.overlay1 === false && lost.reset && lost.cancels === 1, JSON.stringify(lost));
  check('遅れて来た結果は閉じて捨てる', lost.aborted === true);
  check('そのあとの保存はできる', lost.next.ok === true && lost.next.bytes === 700, JSON.stringify(lost.next));

  // 5d. 完了の通知がファイル名つきで出て、閉じるボタンで消える
  const notice = await page.evaluate(async () => {
    const mk = () => { const b = new Blob([new Uint8Array(10)]); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'notice-test.zip'; document.body.append(a); return a; };
    mk().click();
    await new Promise((r) => setTimeout(r, 400));
    const n = document.querySelector('[role=status]');
    const text = n ? n.textContent : null;
    if (n) n.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 50));
    return { text, closed: !document.querySelector('[role=status]') };
  });
  check('完了の通知にファイル名が出て、閉じるボタンで消える', notice.text && notice.text.includes('notice-test.zip') && notice.closed, JSON.stringify(notice));

  // 6. 通常の（blob でない）ダウンロードや、download のないリンクには手を出さない
  const passthrough = await page.evaluate(() => {
    let prevented = false;
    const a = document.createElement('a'); a.href = '#x'; document.body.append(a);
    a.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); });
    a.click();
    return { prevented, hash: location.hash };
  });
  check('download のないリンクは素通し', passthrough.prevented === false);
} finally {
  await ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件が通った`);
process.exit(failed.length ? 1 : 0);
