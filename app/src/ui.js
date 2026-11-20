// 画面。縦向きのスマホを主に、PC でも使える。外部の部品は使わない。

import { t, applyI18n, setLang, getLang } from './strings.js';
import { fmtSamples, fmtClock, fmtBytes } from './util.js';
import { parseScriptJson, readScriptPackZip } from './script-pack.js';
import * as opfs from './opfs.js';
import { mountAiPrompt } from './ai-prompt-ui.js';
import { continuousText } from './app.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

/** キーの割り当て（設計書 4.2）。プレゼン用のリモコンの PageDown／PageUp でも操作できる。 */
export function keyAction(e) {
  const k = e.key;
  if (e.ctrlKey || e.metaKey) {
    if (k === 'z' || k === 'Z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y' || k === 'Y') return 'redo';
    return null;
  }
  if (e.altKey) return null;
  switch (k) {
    case 'r': case 'R': return 'record';
    case ' ': case 'PageDown': return 'ok';
    case 'Backspace': case 'PageUp': return 'retake';
    case 'Enter': return 'next';
    case 'Escape': return 'pause';
    case 'l': case 'L': return 'listen';
    case 'm': case 'M': return 'mark';
    case 't': case 'T': return 'test';
    case 'p': case 'P': return 'listen-slide';
    default: return null;
  }
}

export function initUi(app) {
  let currentView = 'home';
  let session = null;
  let offSession = null;
  let renderQueued = false;
  let toastTimer = null;
  let lastToastAt = 0;
  let listBuiltFor = null;
  let imageFor = null;
  let onlyMine = false;
  let scriptFor = null; // 台本の本文を入れたセッション（通しのとき）
  const scriptKey = 'lap.scriptVisible';
  let scriptVisible = true;
  try { scriptVisible = localStorage.getItem(scriptKey) !== '0'; } catch { /* 保存できなくてもよい */ }
  const fontKey = 'lap.fontScale';
  let fontScale = 1;
  try { fontScale = Number(localStorage.getItem(fontKey)) || 1; } catch { /* 保存できなくてもよい */ }

  // ---------------------------------------------------------------- 共通

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function showView(name) {
    currentView = name;
    $('view-home').hidden = name !== 'home';
    $('view-record').hidden = name !== 'record';
    $('btn-back').hidden = name === 'home';
    $('status-chip').hidden = name === 'home';
    if (name === 'home') renderHome().catch(console.error);
    else scheduleRender();
  }

  function applyFont() {
    document.documentElement.style.setProperty('--reading-size', `${1.6 * fontScale}rem`);
    try { localStorage.setItem(fontKey, String(fontScale)); } catch { /* 無視 */ }
  }

  function attachSession(s) {
    if (offSession) offSession();
    session = s;
    listBuiltFor = null;
    imageFor = null;
    scriptFor = null;
    offSession = s ? s.update.on(scheduleRender) : null;
  }

  // ---------------------------------------------------------------- ホーム

  async function renderHome() {
    const box = $('projects');
    const perSlide = app.recordMode === 'per-slide';
    const projects = await app.listProjects();
    $('chk-per-slide').checked = perSlide;
    $('btn-new-free').hidden = perSlide; // スライド区切りモードには台本パックが要る
    $('mode-msg').textContent = perSlide && !projects.length ? t('home.perSlideNeedsScript') : '';
    let sessions = [];
    try { sessions = await app.backend.listSessions(); } catch (e) { console.error(e); }
    box.replaceChildren();
    if (!projects.length) box.append(h('p', { class: 'note' }, t('home.noProjects')));
    for (const p of projects) {
      const mine = sessions.filter((s) => s.meta && s.meta.projectId === p.projectId && s.meta.recording !== 'continuous')
        .sort((a, b) => String(b.meta.createdAt).localeCompare(String(a.meta.createdAt)));
      const speaker = perSlide ? h('input', { type: 'text', id: `speaker-${p.projectId}`, 'aria-label': t('home.speaker'), placeholder: t('home.speaker') }) : null;
      const card = h('div', { class: 'project' },
        h('h3', {}, p.title || p.projectId),
        h('div', { class: 'note' }, `${t('home.slidesCount', { count: p.slides })} · ${fmtBytes(p.bytes)}`),
        speaker ? h('div', { class: 'row' }, speaker) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', 'data-act': 'new-session', 'data-project': p.projectId, onclick: () => startNew(p.projectId, speaker ? speaker.value.trim() : '') }, t(perSlide ? 'home.startPerSlide' : 'home.startWithScript')),
          h('button', { class: 'btn small', 'data-act': 'delete-project', onclick: async () => {
            if (!confirm(t('home.confirmDeleteProject'))) return;
            await app.deleteProject(p.projectId);
            renderHome();
          } }, t('home.deleteProject'))),
        perSlide ? [h('div', { class: 'note' }, t('home.sessions')), mine.length ? mine.map((s) => sessionRow(s)) : h('div', { class: 'note' }, t('home.noSessions'))] : null);
      box.append(card);
    }
    // 録音セッションの一覧（通しの録音。スライド区切りのセッションは、台本のカードの下にも出る）
    const list = $('sessions');
    list.replaceChildren();
    const shown = sessions.filter((x) => !(perSlide && x.meta && x.meta.recording !== 'continuous'))
      .sort((a, b) => String((b.meta && b.meta.createdAt) || '').localeCompare(String((a.meta && a.meta.createdAt) || '')));
    list.append(h('div', { class: 'note' }, t('home.sessions')));
    if (shown.length) for (const x of shown) list.append(sessionRow(x)); else list.append(h('div', { class: 'note' }, t('home.noSessions')));
    const st = await opfs.storageStatus();
    const persisted = st.persisted === null ? t('storage.unknown') : st.persisted ? t('storage.yes') : t('storage.no');
    $('storage-info').textContent = [
      t('storage.persisted', { value: persisted }),
      st.usage != null && st.quota != null ? t('storage.usage', { used: fmtBytes(st.usage), quota: fmtBytes(st.quota) }) : '',
    ].filter(Boolean).join(' / ');
  }

  function sessionRow(s) {
    const when = s.meta && s.meta.createdAt ? new Date(s.meta.createdAt).toLocaleString(getLang() === 'en' ? 'en' : 'ja') : s.sessionId;
    const shownTitle = s.meta && s.meta.displayTitle ? ` · ${s.meta.displayTitle}` : '';
    return h('div', { class: 'session', 'data-session': s.sessionId },
      h('div', { class: 'grow' }, `${when}${shownTitle} · ${fmtBytes(s.totalBytes)}`,
        ' ', h('span', { class: `tag${s.interrupted ? ' bad' : ''}` }, s.interrupted ? t('home.session.interrupted') : t('home.session.idle')),
        s.tornTail ? [' ', h('span', { class: 'tag' }, t('home.session.torn'))] : null),
      h('button', { class: 'btn small', 'data-act': 'open-session', onclick: () => openExisting(s.sessionId) }, t('home.open')),
      h('button', { class: 'btn small', 'data-act': 'export-session', onclick: () => openExport(s.sessionId) }, t('home.export')),
      h('button', { class: 'btn small', 'data-act': 'delete-session', onclick: async () => {
        if (!confirm(t('home.confirmDelete'))) return;
        await app.deleteSession(s.sessionId);
        renderHome();
      } }, t('home.delete')));
  }

  async function startNew(projectId = null, speaker = '') {
    try {
      const s = await app.newSession(projectId, { speaker: speaker || undefined });
      attachSession(s);
      showView('record');
    } catch (e) {
      console.error(e);
      toast(t('home.micFailed', { error: e && e.name ? `${e.name}` : String(e) }));
    }
  }

  async function openExisting(sessionId) {
    try {
      const s = await app.openSession(sessionId);
      attachSession(s);
      showView('record');
    } catch (e) {
      console.error(e);
      toast(e && e.code === 'locked' ? t('home.locked') : t('home.sessionOpenFailed', { error: String(e && e.message || e) }));
    }
  }

  let exporting = false;
  async function openExport(sessionId) {
    if (exporting) return;
    exporting = true;
    try {
      const mod = await import('./export-ui.js');
      try {
        await mod.openExportDialog(app, sessionId, { toast });
      } finally {
        if (app.session?.sessionId === sessionId) await app.closeSession();
      }
    } catch (e) {
      console.error(e);
      toast(t('export.failed', { error: String(e && e.message || e) }));
    } finally {
      exporting = false;
    }
  }

  function showOpenMessage(res) {
    const lines = [];
    if (res.ok) lines.push(t('home.opened', { title: res.script.title, count: res.script.slides.length }));
    else lines.push(t('home.invalid', { errors: (res.errors || []).join(', ') }));
    for (const w of res.warnings || []) {
      if (w === 'core-check-unavailable') lines.push(t('home.warn.coreCheck'));
      else lines.push(t('home.warn.image', { detail: w }));
    }
    $('open-msg').textContent = lines.join(' ');
  }

  async function onPackChosen(file) {
    if (!file) return;
    try {
      const res = await readScriptPackZip(file);
      if (res.ok) await app.saveProject(res.script, res.images);
      showOpenMessage(res);
      renderHome();
    } catch (e) {
      console.error(e);
      showOpenMessage({ ok: false, errors: [String(e && e.message || e)] });
    }
  }

  async function onPaste() {
    const res = parseScriptJson($('paste-json').value);
    if (res.ok) await app.saveProject(res.script, {});
    showOpenMessage(res);
    renderHome();
  }

  // ---------------------------------------------------------------- 録音の画面

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderRecord(); });
  }

  function buildSlideList(v) {
    const list = $('slide-list');
    list.replaceChildren();
    for (const s of v.slides) {
      const li = h('li', { 'data-slide': s.slideId, onclick: () => act('goto', s.slideId) },
        h('span', { class: 'no' }, String(s.index + 1)),
        h('span', { class: 'ttl' }, s.title || s.text.slice(0, 24) || s.slideId),
        h('span', { class: 'st' }),
        h('span', { class: 'dur' }));
      list.append(li);
    }
    listBuiltFor = `${v.sessionId}:${v.slides.length}`;
  }

  /** 台本の表示／非表示（通しの録音）。切り替えは次回起動時も覚える。 */
  function applyScriptVisibility() {
    $('script-body').hidden = !scriptVisible;
    const b = $('btn-script-toggle');
    b.textContent = scriptVisible ? t('rec.scriptHide') : t('rec.scriptShow');
    b.setAttribute('aria-pressed', scriptVisible ? 'true' : 'false');
  }

  function renderRecord() {
    if (!session || currentView !== 'record') return;
    const v = session.view();
    const per = !v.continuous;
    for (const el of document.querySelectorAll('.per-slide-only')) el.hidden = !per; // スライドの区切りを連想させる導線は、スライド区切りモードのときだけ
    if (per && listBuiltFor !== `${v.sessionId}:${v.slides.length}`) buildSlideList(v);

    // 台本：通しでは、読み込んだ台本の全文を 1 本の連続した文章で（表示／非表示を切り替えられる）。区切りモードでは、今のスライドの文
    const ds = v.continuous ? app.displayScript : session.script;
    $('script-card').hidden = !ds;
    $('btn-script-toggle').hidden = per;
    if (ds) {
      if (v.continuous) {
        if (scriptFor !== v.sessionId) { scriptFor = v.sessionId; $('reading').textContent = continuousText(ds); $('reading').scrollTop = 0; }
        applyScriptVisibility();
      } else {
        $('script-body').hidden = false;
        scriptFor = null;
        $('reading').textContent = v.slide ? v.slide.text : '';
      }
    }

    // 見出し・絵
    if (per) {
    $('slide-no').textContent = t('rec.slide', { n: v.slideIndex + 1, total: v.slides.length });
    $('slide-title').textContent = v.slide ? (v.slide.title || '') : '';
    }
    if (per && v.slide && imageFor !== v.slide.slideId) {
      imageFor = v.slide.slideId;
      const projectId = session.script.projectId;
      app.slideImageUrl(projectId, v.slide.image).then((url) => {
        if (imageFor !== v.slide.slideId) return;
        const img = $('slide-img');
        if (url) { img.src = url; img.hidden = false; $('slide-noimg').hidden = true; }
        else { img.hidden = true; $('slide-noimg').hidden = false; }
      }).catch(() => { $('slide-img').hidden = true; $('slide-noimg').hidden = false; });
    }

    // 状態の札
    const chip = $('status-chip');
    chip.textContent = t(`rec.status.${v.mode}`);
    chip.className = `chip ${v.mode}`;
    $('recording-fault').hidden = !v.recordingFault;
    const faultMessage = v.recordingFault ? t('rec.fault', { error: v.recordingFault.message }) : '';
    if ($('recording-fault-text').textContent !== faultMessage) $('recording-fault-text').textContent = faultMessage;

    // 時間
    const take = v.take;
    if (per) {
    const slideSamples = take ? take.keptSamples + take.pendingSamples : 0;
    if (per) $('t-slide').textContent = t('rec.slideTime', { time: fmtSamples(slideSamples, v.rate) });
    $('t-target').textContent = v.slide && v.slide.targetSec ? t('rec.slideTarget', { sec: v.slide.targetSec }) : '';
    }
    $('t-total').textContent = t('rec.total', { time: fmtSamples(v.totalSamples, v.rate) });
    $('durable-pos').textContent = fmtSamples(v.durable ? v.durable.pos : 0, v.rate);
    $('last-ok').textContent = v.lastOk ? fmtSamples(v.lastOk.pos, v.rate) : t('rec.none');

    // 確定した録音時間（OK まで採用した音声の合計）と、まだ確定していない分（最後の OK から今まで）
    $('t-confirmed').textContent = t('rec.confirmed', { time: fmtSamples(v.confirmedSamples, v.rate) });
    $('t-unconfirmed').textContent = t('rec.unconfirmed', { time: fmtSamples(v.pendingSamples, v.rate) });

    // ボタン
    $('btn-record').disabled = !v.canRecord;
    $('lbl-record').textContent = v.mode === 'paused' ? t('btn.resume') : t('btn.record');
    $('btn-ok').disabled = !!v.recordingFault || !v.canOk;
    $('btn-retake').disabled = !!v.recordingFault || !v.canRetake;
    $('btn-next').disabled = !!v.recordingFault || !per || !v.canNext;
    $('btn-pause').disabled = v.mode !== 'recording';
    $('btn-listen').disabled = !!v.recordingFault || !v.canListen || v.playing;
    $('btn-mark').disabled = !!v.recordingFault || !v.canMark;
    $('btn-test').disabled = !!v.recordingFault || !v.canTest;
    $('btn-listen-slide').disabled = !!v.recordingFault || !v.canListenSlide || v.playing;
    $('btn-undo').disabled = !!v.recordingFault || !v.canUndo;
    $('btn-redo').disabled = !!v.recordingFault || !v.canRedo;
    $('play-note').hidden = !v.playing;
    $('test-note').textContent = testNote(v);
    $('wake-note').textContent = v.mode === 'recording' ? (v.wake ? t('rec.wake.on') : t('rec.wake.off')) : '';
    $('storage-note').textContent = v.storage && v.storage.remainingSec != null && v.mode === 'recording'
      ? [t('storage.remaining', { time: fmtClock(v.storage.remainingSec) }), v.storage.warn ? t('storage.low') : ''].filter(Boolean).join(' ') : '';

    // スライドの一覧
    if (per) {
    const mineOnly = onlyMine && app.meta && app.meta.speaker;
    for (const li of $('slide-list').children) {
      const s = v.slides.find((x) => x.slideId === li.dataset.slide);
      if (!s) continue;
      li.className = `${s.slideId === v.slideId ? 'current' : ''} ${s.state === 'skip' ? 'skip' : ''}`.trim();
      li.hidden = !!(mineOnly && s.speaker !== app.meta.speaker);
      const st = li.querySelector('.st');
      st.className = `st ${s.state}`;
      st.textContent = t(`rec.state.${s.state}`);
      li.querySelector('.dur').textContent = s.keptSamples ? fmtSamples(s.keptSamples, v.rate) : '';
    }
    const assigned = v.slides.filter((s) => s.recordable && (!mineOnly || s.speaker === app.meta.speaker));
    $('progress').textContent = t('rec.progress', { total: assigned.length, done: assigned.filter((s) => s.state === 'done').length });
    }

    // 通知
    if (v.toast && v.toast.at !== lastToastAt) { lastToastAt = v.toast.at; toast(t(v.toast.key, v.toast.params)); }

    renderRecovery(v);
    renderMeter();
  }

  /** 試し録りの表示：録音中の経過、再生中、結果（音量・音割れ）。 */
  function testNote(v) {
    if (v.testing) {
      return v.testing.phase === 'playing' ? t('test.playing')
        : t('test.recording', { sec: Math.min(v.testing.ms, v.testing.elapsedMs) / 1000 | 0, total: Math.round(v.testing.ms / 1000) });
    }
    const r = v.testResult;
    if (!r) return '';
    if (r.cancelled) return t('test.cancelled');
    const clip = r.clipped > 0 ? t('test.clipYes', { n: r.clipped }) : r.rmsDb < -50 ? t('test.quiet') : t('test.clipNo');
    return t('test.result', { rms: r.rmsDb, peak: r.peakDb, clip });
  }

  function renderMeter() {
    if (!session) return;
    const peak = session.level.peak || 0;
    const db = peak > 0 ? 20 * Math.log10(peak) : -90;
    const val = Math.max(0, Math.min(1, (db + 60) / 60));
    $('meter-fill').style.setProperty('--level', String(val));
    $('clip-warn').hidden = !(performance.now() < session.level.clipUntil);
  }

  // ---------------------------------------------------------------- 復旧（設計書 4.5）

  function renderRecovery(v) {
    const dlg = $('dlg-recovery');
    if (!v.recoveryNeeded || v.recordingFault) { if (dlg.open) dlg.close(); return; }
    const r = v.recovery;
    $('rec-summary').textContent = t('recovery.summary', {
      recovered: fmtSamples(r.recoveredPos, r.rate),
      lastOk: r.lastOkPos == null ? t('rec.none') : fmtSamples(r.lastOkPos, r.rate),
    });
    const sec = Math.max(0, Math.round(r.continuationSamples / r.rate));
    const btn = $('rec-listen');
    btn.textContent = r.continuationSamples > 0 ? t('recovery.listen', { sec }) : t('recovery.nothing');
    btn.disabled = r.continuationSamples === 0 || v.playing;
    $('rec-extra').textContent = [
      r.tornTail ? t('recovery.torn') : '',
      r.durablePos != null ? t('recovery.durable', { durable: fmtSamples(r.durablePos, r.rate) }) : '',
    ].filter(Boolean).join(' ');
    if (!dlg.open) dlg.showModal();
  }

  // ---------------------------------------------------------------- 操作

  async function act(name, arg) {
    if (!session || session.recordingFault) return;
    try {
      switch (name) {
        case 'record':
          try { await app.openMic(); } catch (e) { toast(t('home.micFailed', { error: e && e.name ? e.name : String(e) })); return; }
          await session.record();
          break;
        case 'ok': await session.ok(); break;
        case 'retake': await session.retake(); break;
        case 'next': if (!session.continuous) await session.next(); break;
        case 'pause': await session.pause('user'); break;
        case 'listen': await session.listenLast(); break;
        case 'mark': await session.mark(); break;
        case 'listen-slide': await session.listenSlide(); break;
        case 'test':
          try { await app.openMic(); } catch (e) { toast(t('home.micFailed', { error: e && e.name ? e.name : String(e) })); return; }
          await session.testRec();
          break;
        case 'undo': await session.undo(); break;
        case 'redo': await session.redo(); break;
        case 'goto': if (!session.continuous) await session.gotoSlide(arg); break;
        default: break;
      }
    } catch (e) {
      console.error(e);
      toast(t('toast.error', { message: String(e && e.message || e) }));
    }
    scheduleRender();
  }

  function bind() {
    const click = (id, fn) => $(id).addEventListener('click', (e) => { fn(e); e.currentTarget.blur(); });
    click('btn-record', () => act('record'));
    click('btn-ok', () => act('ok'));
    click('btn-retake', () => act('retake'));
    click('btn-next', () => act('next'));
    click('btn-pause', () => act('pause'));
    click('btn-listen', () => act('listen'));
    click('btn-mark', () => act('mark'));
    click('btn-test', () => act('test'));
    click('btn-listen-slide', () => act('listen-slide'));
    click('btn-undo', () => act('undo'));
    click('btn-redo', () => act('redo'));
    click('btn-stop-play', () => session && session.stopPlayback());
    click('btn-font-minus', () => { fontScale = Math.max(0.7, fontScale - 0.15); applyFont(); });
    click('btn-font-plus', () => { fontScale = Math.min(2.4, fontScale + 0.15); applyFont(); });
    click('btn-goto-todo', () => {
      if (!session) return;
      const v = session.view();
      const next = v.slides.find((s) => s.recordable && s.state === 'todo');
      if (next) act('goto', next.slideId);
    });
    click('btn-new-free', () => startNew(null));
    click('btn-script-toggle', () => {
      scriptVisible = !scriptVisible;
      try { localStorage.setItem(scriptKey, scriptVisible ? '1' : '0'); } catch { /* 無視 */ }
      applyScriptVisibility();
    });
    $('chk-per-slide').addEventListener('change', async (e) => {
      const projects = await app.listProjects();
      if (e.target.checked && !projects.length) { // スライド区切りモードには台本パックが要る：入れずに、読み込みを促す
        e.target.checked = false;
        app.recordMode = 'continuous';
        $('mode-msg').textContent = t('home.perSlideNeedsScript');
        return;
      }
      app.recordMode = e.target.checked ? 'per-slide' : 'continuous';
      renderHome();
    });
    $('chk-mine').addEventListener('change', (e) => { onlyMine = e.target.checked; scheduleRender(); });
    click('btn-back', async () => {
      await app.closeSession();
      attachSession(null);
      showView('home');
    });
    click('btn-lang', () => {
      setLang(getLang() === 'ja' ? 'en' : 'ja');
      try { localStorage.setItem('lap.lang', getLang()); } catch { /* 保存できなくてもよい */ }
      applyI18n(document);
      listBuiltFor = null;
      if (currentView === 'home') renderHome(); else scheduleRender();
    });
    $('file-pack').addEventListener('change', (e) => { onPackChosen(e.target.files[0]); e.target.value = ''; });
    click('btn-paste', () => onPaste());

    // 復旧
    click('btn-reopen-recording', async () => {
      const id = session?.sessionId;
      if (!id) return;
      const button = $('btn-reopen-recording');
      button.disabled = true;
      try { await openExisting(id); } finally { button.disabled = false; }
    });
    $('dlg-recovery').addEventListener('cancel', (e) => e.preventDefault()); // Esc で閉じない（選ぶまで先へ進ませない）
    $('rec-listen').addEventListener('click', async () => { if (session) { await session.listenRecovered(); scheduleRender(); } });
    $('rec-adopt').addEventListener('click', async () => { if (session) { await session.adoptRecovered(); scheduleRender(); } });
    $('rec-retake').addEventListener('click', async () => { if (session) { await session.retakeFromLastOk(); scheduleRender(); } });

    document.addEventListener('keydown', (e) => {
      if (currentView !== 'record' || !session || session.recordingFault) return;
      if (document.querySelector('dialog[open]')) return;
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const name = keyAction(e);
      if (!name) return;
      e.preventDefault();
      if (e.repeat) return;
      act(name);
    });
    document.addEventListener('keyup', (e) => {
      if (currentView === 'record' && e.key === ' ') e.preventDefault();
    });

    // 中断の検知（設計書 4.5）：画面が隠れたら一時停止して理由を記録する。戻ったら画面を消さない設定を取り直す。
    document.addEventListener('visibilitychange', () => {
      if (!session) return;
      if (document.visibilityState === 'hidden') {
        if (session.ts.recording) session.pause('hidden').catch(() => {});
      } else {
        session.reacquireWake().catch(() => {});
      }
    });

    app.levelListeners.on(() => requestAnimationFrame(renderMeter));
    // 試験用の入口（__lap）などで、画面の外からセッションが開閉されたときも、画面を合わせる
    app.update.on(() => {
      if (app.session && app.session !== session) { attachSession(app.session); showView('record'); }
      else if (!app.session && session) { attachSession(null); showView('home'); }
      else scheduleRender();
    });
  }

  // ---------------------------------------------------------------- 起動

  applyI18n(document);
  applyFont();
  bind();
  mountAiPrompt($('ai-prompt-home'), app, { idPrefix: 'ai-prompt' }); // ホーム：この端末で書き出した項目があれば、その情報で穴埋めする
  showView('home');
  return { toast, showView, renderHome, attachSession, act, openExisting, startNew, get currentView() { return currentView; } };
}
