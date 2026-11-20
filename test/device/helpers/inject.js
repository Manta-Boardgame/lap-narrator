// スマホの Chrome のページに、読み込みの前に差し込む診断用の道具（担当 F）。app/ は変えず、ページの外から観察するだけ。
//   - OPFS の最初の getDirectory() にかかった時間
//   - 標本の採取（取得したサンプル数、書き込んだサンプル数、保存位置、画面の可視状態、AudioContext の状態、Wake Lock）
//   - 画面の可視状態、AudioContext、マイクのトラック、Wake Lock の変化の記録
// dropVisibility を真にすると、アプリの visibilitychange の処理を無効にする（画面ロックのとき、アプリの一時停止を介さずに、
// AudioWorklet と Wake Lock の素の挙動を見るための診断。アプリのコードは変えていない）。

export function injectSource({ dropVisibility = false } = {}) {
  return `(() => {
  if (window.__fInstalled) return; window.__fInstalled = true;
  const log = (name, o) => { (window[name] ||= []).push({ t: performance.now(), wall: Date.now(), ...o }); };
  window.__opfsProbe = { calls: [], t0: performance.now() };
  try {
    const st = navigator.storage; const orig = st.getDirectory.bind(st);
    st.getDirectory = function () { const at = performance.now(); const p = orig(); p.then(() => window.__opfsProbe.calls.push({ at, ms: performance.now() - at }), (e) => window.__opfsProbe.calls.push({ at, err: String(e) })); return p; };
  } catch (e) { window.__opfsProbe.err = String(e); }
  document.addEventListener('visibilitychange', () => log('__visLog', { state: document.visibilityState }));
  ${dropVisibility ? "{ const o = document.addEventListener.bind(document); document.addEventListener = (type, ...r) => { if (type === 'visibilitychange') { log('__visDropped', { }); return; } return o(type, ...r); }; }" : ''}
  try {
    const OrigAC = window.AudioContext;
    window.AudioContext = class extends OrigAC { constructor(...a) { super(...a); window.__ac = this; this.addEventListener('statechange', () => log('__acLog', { state: this.state })); } };
  } catch (e) { /* 無視 */ }
  try {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const t0 = performance.now(); const s = await gum(c); log('__gumLog', { ms: performance.now() - t0 });
      s.getTracks().forEach((tr) => { for (const ev of ['mute', 'unmute', 'ended']) tr.addEventListener(ev, () => log('__trackLog', { ev })); });
      return s;
    };
  } catch (e) { /* 無視 */ }
  try {
    if (navigator.wakeLock) {
      const rq = navigator.wakeLock.request.bind(navigator.wakeLock);
      navigator.wakeLock.request = async (type) => { const l = await rq(type); log('__wlLog', { ev: 'acquired' }); l.addEventListener('release', () => log('__wlLog', { ev: 'released' })); return l; };
    }
  } catch (e) { /* 無視 */ }
  const F = window.__f = { samples: [], timer: null, idx: 0, busy: false };
  F.tick = async () => {
    if (F.busy) return; F.busy = true;
    const t0 = performance.now();
    try {
      const app = window.__lap && window.__lap.app; const s = app && app.session;
      if (!s) return;
      const st = await s.backend.stats();
      const t1 = performance.now();
      const dur = s.backend.durable();
      let raw = 0; for (const r of st.rawFiles) raw += r.samples;
      F.samples.push({ t: (t0 + t1) / 2, t0, t1, wall: Date.now(), captured: st.captured, written: st.written, gaps: st.gaps, dropped: st.dropped,
        pos: st.cursor ? st.cursor.pos : null, raw, durablePos: dur ? dur.pos : null, workerDurablePos: st.lastDurable ? st.lastDurable.pos : null,
        vis: document.visibilityState, ctx: s.source.state ?? null, rec: s.ts.recording, wake: s.wakeLockActive, ev: s.events.length });
    } catch (e) { F.samples.push({ t: performance.now(), err: String((e && e.message) || e) }); } finally { F.busy = false; }
  };
  F.start = (period = 400) => { clearInterval(F.timer); F.timer = setInterval(F.tick, period); };
  F.take = () => { const a = F.samples.slice(F.idx); F.idx = F.samples.length; return a; };
  window.__diag = () => ({ vis: window.__visLog || [], visDropped: (window.__visDropped || []).length, ac: window.__acLog || [], gum: window.__gumLog || [], track: window.__trackLog || [], wl: window.__wlLog || [], opfs: window.__opfsProbe, now: performance.now(), wall: Date.now(), visState: document.visibilityState, acState: window.__ac ? window.__ac.state : null });
})();`;
}
