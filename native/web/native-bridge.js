// ネイティブ版（Capacitor の WebView）だけで働く、橋渡し。Web 版（ブラウザ、PWA）では何もしない。
// main.js より前に読み込み、マイクと Android の保存画面をつなぐ。録音中は app/ の保存通知を監視する。
//
// していること：
//  1. マイクを開いている間（getUserMedia の成功から、全トラックの停止まで）、フォアグラウンドサービス（microphone 型、通知付き）を動かす。
//  2. サービスが動いている間は、画面が隠れても visibilitychange の 'hidden' を app の側に渡さない（pause('hidden') にしない）。
//  3. 書き出しの「ダウンロード」（<a download> の blob）を、システムの保存画面（ACTION_CREATE_DOCUMENT）で端末に保存する。
//     WebView は blob のダウンロードを扱えないため、これがないと保存できない。
//     - 保存は 1 件ずつ順に行う（待ち行列）。保存画面は同時に 1 つしか開かない（Capacitor の startActivityForResult は最後の呼び出ししか
//       覚えていないため、重ねると結果が取り違えられ、先の呼び出しが永久に返らない）。
//     - 保存画面から戻ったのに結果が来ないとき（Activity が作り直された、など）は「取りやめ」として覆いを外す。
//     - 完了と失敗は、ファイル名つきの通知を数秒残す（閉じるボタンつき）。
// 通信はしない。Capacitor の橋渡し（window.Capacitor.nativePromise）でアプリの中のネイティブ部品を呼ぶだけ。
(function () {
  'use strict';
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform() || typeof cap.nativePromise !== 'function') return;

  const PLUGIN = 'LapRecorder';
  const call = (method, opts) => cap.nativePromise(PLUGIN, method, opts || {});
  const isJa = () => /^ja/i.test(document.documentElement.lang || '');
  const T = (jaText, enText) => (isJa() ? jaText : enText);
  // 試験用に変えられる待ち時間（ミリ秒）。配る版（prepare-www.mjs --release）では、この指定の読み取りごと取り除かれる（既定の値だけ）。
  let TUNE = {};
  // @no-release:begin
  TUNE = window.__lapNativeTune || {};
  // @no-release:end
  const RESULT_GRACE_MS = TUNE.resultGraceMs || 3000; // 保存画面から戻ってから、結果を待つ時間
  const NOTICE_MS = TUNE.noticeMs || 8000; // 完了・失敗の通知を残す時間

  // ------------------------------------------------------------ 1・2．フォアグラウンドサービスと、画面が隠れたときの扱い

  let serviceOn = false;
  let monitoring = false;
  let serviceBusy = Promise.resolve();
  let hiddenSeq = 0; // 'hidden' を受けた回数（保存画面から戻ったことの検知に使う）
  const liveTracks = new Set();
  const state = { lastError: null, serviceStarts: 0, hiddenIgnored: 0, saves: 0, saveStarts: 0, saveCancels: 0, queued: 0, lastSaved: null, saveLog: [] };

  function syncService() {
    // 開始と停止を、順に 1 つずつ行う（速い開け閉めで逆順にならないように）
    serviceBusy = serviceBusy.then(async () => {
      const want = liveTracks.size > 0;
      if (want && !serviceOn) {
        try {
          await call('startService', {
            title: T('lap-narrator：マイクを使用中', 'lap-narrator: microphone in use'),
            text: T('ロック画面にも表示される場合があります。録音中はアプリで保存位置を確認できます。', 'This notification may appear on the lock screen. Check saved progress in the app during recording.'),
            stalledTitle: T('録音が止まっています', 'Recording has stopped'),
            stalledText: T('録音の保存位置が更新されていません。アプリを開いて確認してください。', 'Saved recording progress has stalled. Open the app to check the recording.'),
          });
          lastBeatSent = 0;
          serviceOn = true;
          state.serviceStarts++;
          if (monitoring) await call('monitorRecording', { active: true });
        } catch (e) { state.lastError = String((e && e.message) || e); console.warn('[native-bridge] startService', state.lastError); }
      } else if (!want && serviceOn) {
        try { await call('stopService'); } catch (e) { state.lastError = String((e && e.message) || e); }
        serviceOn = false;
      }
    });
    return serviceBusy;
  }

  // 心拍は、録音 Worker が音声と保存記録を flush したときだけ送る。
  let lastBeatSent = 0;
  let monitorBusy = Promise.resolve();
  state.beats = 0;
  window.addEventListener('lap:recorder', ({ detail }) => {
    if (detail === 'recording' || detail === 'idle') {
      monitoring = detail === 'recording';
      lastBeatSent = 0;
      if (serviceOn) {
        const active = monitoring;
        monitorBusy = monitorBusy.then(() => call('monitorRecording', { active })).catch(() => {});
      }
      return;
    }
    if (detail !== 'durable' || !serviceOn || !monitoring) return;
    const now = performance.now();
    if (lastBeatSent && now - lastBeatSent < 750) return;
    lastBeatSent = now;
    state.beats++;
    monitorBusy = monitorBusy.then(() => call('heartbeat')).catch(() => {});
  });

  // 隠れたページを「音を出しているページ」に保つ（実機の診断 K-002 の結論）。Chromium は、画面から隠れて約 60 秒たったページを凍結する（freeze イベント。
  // 主スレッド、AudioWorklet、タイマーがすべて止まり、表に戻るまで再開しない。取得数も欠落（gaps）も変わらないので、app は気づけない）。
  // 音を出している（聞こえる、と判定される）ページは凍結されない。app は AudioContext の出力を音量 0 の GainNode につなぐので、完全な無音になる（-90 dBFS では足りなかった）。
  // 対策：ほぼ聞こえないレベル（-60 dBFS）の雑音を destination にも流す。app/ は変えない。
  const INAUDIBLE_DB = -60;
  const AC = window.AudioContext;
  if (typeof AC === 'function' && !TUNE.noKeepAlive) { // noKeepAlive：試験用（凍結の再現と、見張りの試験）
    window.AudioContext = class extends AC {
      constructor(...a) {
        super(...a);
        try {
          const n = this.sampleRate;
          const buf = this.createBuffer(1, n, n);
          const d = buf.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
          const src = this.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          const g = this.createGain();
          g.gain.value = Math.pow(10, INAUDIBLE_DB / 20);
          src.connect(g);
          g.connect(this.destination);
          src.start();
          state.keepAlive = INAUDIBLE_DB;
        } catch (e) { state.lastError = String((e && e.message) || e); }
      }
    };
  }

  function hold(stream) {
    for (const track of stream.getAudioTracks()) {
      if (liveTracks.has(track)) continue;
      liveTracks.add(track);
      const release = () => { if (liveTracks.delete(track)) syncService(); };
      track.addEventListener('ended', release, { once: true });
      const stop = track.stop.bind(track);
      track.stop = () => { try { stop(); } finally { release(); } };
    }
    return syncService();
  }

  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      // 通知の許可（Android 13 以降）は、サービスの開始の前に 1 度だけ求める。断られても録音はできる（通知が見えないだけ）。
      if (constraints && constraints.audio) { try { await call('ensureNotificationPermission'); } catch (e) { /* 無視 */ } }
      const stream = await orig(constraints);
      if (constraints && constraints.audio) await hold(stream);
      return stream;
    };
  }

  // 画面が隠れても、サービスが動いている間は録音を続ける。捕まえる側（capture）で先に受けて、app の側には渡さない。
  document.addEventListener('visibilitychange', (e) => {
    if (document.visibilityState !== 'hidden') return;
    hiddenSeq++;
    if (serviceOn) { state.hiddenIgnored++; e.stopImmediatePropagation(); }
  }, true);

  // ------------------------------------------------------------ 3．書き出しの保存（システムの保存画面）

  const blobs = new Map(); // blob の URL → Blob（fetch せずに中身へ届くように、作った時点で控える）
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  const saving = new Set(); // 保存の待ち行列に入っている blob の URL
  URL.createObjectURL = function (obj) {
    const url = createObjectURL(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    // app は 120 秒後に解放する。待ち行列にあるものは、保存が終わるまで控えを残す。
    if (!saving.has(url)) blobs.delete(url);
    return revokeObjectURL(url);
  };

  const CHUNK = 512 * 1024;
  function toBase64(bytes) {
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + step)));
    return btoa(s);
  }

  function mimeFor(name) {
    if (/\.zip$/i.test(name)) return 'application/zip';
    if (/\.json$/i.test(name)) return 'application/json';
    if (/\.wav$/i.test(name)) return 'audio/wav';
    return 'application/octet-stream';
  }

  // 覆い（操作を止める）：待ち行列に 1 件でもある間だけ出す
  let overlay = null;
  function showOverlay(text) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-live', 'assertive');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.72);color:#fff;font:16px/1.6 system-ui,sans-serif;padding:24px;text-align:center;white-space:pre-line';
      document.body.append(overlay);
    }
    overlay.textContent = text;
  }
  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }

  // 通知（操作を止めない）：完了と失敗を、ファイル名つきで残す。閉じるボタンつき。
  let notice = null;
  let noticeTimer = null;
  function showNotice(text, { error = false } = {}) {
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('role', error ? 'alert' : 'status');
      notice.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;display:flex;gap:12px;align-items:center;' +
        'padding:12px 16px;border-radius:8px;font:15px/1.5 system-ui,sans-serif;white-space:pre-line;color:#fff';
      const msg = document.createElement('span');
      msg.style.cssText = 'flex:1;overflow-wrap:anywhere';
      msg.dataset.role = 'notice-text';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = T('閉じる', 'Close');
      btn.style.cssText = 'font:inherit;padding:6px 12px;border-radius:6px;border:0;background:#fff;color:#14213d';
      btn.addEventListener('click', hideNotice);
      notice.append(msg, btn);
      document.body.append(notice);
    }
    notice.style.background = error ? '#8b1e1e' : '#1b5e20';
    notice.querySelector('[data-role=notice-text]').textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }
  function hideNotice() { clearTimeout(noticeTimer); noticeTimer = null; if (notice) { notice.remove(); notice = null; } }

  /** 保存画面を開く。戻ったのに結果が来ないときは「取りやめ」にする（遅れて来た結果は閉じて捨てる）。 */
  function saveBegin(opts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const startHidden = hiddenSeq;
      const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); fn(v); };
      const onVisible = () => {
        // 保存画面が前面にあった間に 'hidden' があり、いま戻ってきた。結果は戻ってすぐ来るはずなので、少し待って来なければ取りやめ。
        if (document.visibilityState !== 'visible' || hiddenSeq === startHidden || timer) return;
        timer = setTimeout(() => {
          if (settled) return;
          call('saveResetPending').catch(() => {});
          state.saveCancels++;
          finish(reject, new Error('cancelled: no result after returning from the save screen'));
        }, RESULT_GRACE_MS);
      };
      document.addEventListener('visibilitychange', onVisible);
      call('saveBegin', opts).then(
        (r) => { if (settled) { call('saveAbort', { handle: r.handle }).catch(() => {}); } else finish(resolve, r); },
        (e) => { finish(reject, e); },
      );
    });
  }

  async function saveOne(blob, name) {
    const mimeType = blob.type || mimeFor(name);
    state.saveStarts++;
    showOverlay(T('保存先を選んでください…', 'Choose where to save…') + '\n' + name);
    let handle = null;
    const entry = { name, bytes: blob.size, ok: false };
    try {
      const begun = await saveBegin({ name, mimeType });
      handle = begun.handle;
      let done = 0;
      for (let off = 0; off < blob.size; off += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + CHUNK)).arrayBuffer());
        await call('saveWrite', { handle, data: toBase64(bytes) });
        done += bytes.length;
        showOverlay(T('保存しています… ', 'Saving… ') + Math.floor((done / Math.max(1, blob.size)) * 100) + '%\n' + name);
      }
      const ended = await call('saveEnd', { handle });
      handle = null;
      if (ended.bytes !== blob.size) throw new Error('size-mismatch:' + ended.bytes + '/' + blob.size);
      state.saves++;
      entry.ok = true;
      entry.uri = ended.uri;
      state.lastSaved = { name, bytes: ended.bytes, uri: ended.uri };
      showNotice(T('保存しました：', 'Saved: ') + name + ' (' + ended.bytes + ' ' + T('バイト', 'bytes') + ')');
      return { ok: true, bytes: ended.bytes, uri: ended.uri };
    } catch (e) {
      if (handle) { try { await call('saveAbort', { handle }); } catch (e2) { /* 無視 */ } }
      const msg = String((e && (e.message || e.code)) || e);
      state.lastError = msg;
      const cancelled = /cancel/i.test(msg);
      entry.error = msg;
      entry.cancelled = cancelled;
      showNotice((cancelled ? T('保存を取りやめました：', 'Save cancelled: ') : T('保存できませんでした：', 'Could not save: ')) + name +
        (cancelled ? '' : '\n' + msg) + '\n' + T('もう一度「保存」を押してください。', 'Press Save again.'), { error: true });
      return { ok: false, error: msg, cancelled };
    } finally {
      state.saveLog.push(entry);
    }
  }

  // 保存は 1 件ずつ順に行う。重ねて呼ばれても、保存画面は 1 つずつしか開かない。
  let queue = Promise.resolve();
  function saveBlob(blob, name) {
    state.queued++;
    const run = queue.then(() => saveOne(blob, name));
    queue = run.catch(() => {}).then(() => { state.queued--; if (state.queued === 0) hideOverlay(); });
    return run;
  }

  // 書き出し画面はこの入口から、保存の完了・取りやめ・失敗を受け取る。
  window.lapSaveBlob = saveBlob;

  // blob: URL のダウンロードリンクも、Android の保存画面へ渡す。
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.href || '';
    if (this.hasAttribute('download') && href.startsWith('blob:') && blobs.has(href)) {
      const blob = blobs.get(href);
      const name = this.getAttribute('download') || 'download';
      saving.add(href);
      saveBlob(blob, name).finally(() => { saving.delete(href); });
      return undefined;
    }
    return anchorClick.call(this);
  };

  // @no-release:begin
  // ------------------------------------------------------------ 診断用の入口（画面からは使わない）

  window.lapNative = Object.freeze({
    isNative: true,
    state: () => ({ ...state, saveLog: state.saveLog.slice(), serviceOn, liveTracks: liveTracks.size }),
    status: () => call('status'),
    saveBlob,
    share: (opts) => call('share', opts),
    keepsRecording: () => serviceOn,
  });
  // @no-release:end
})();
