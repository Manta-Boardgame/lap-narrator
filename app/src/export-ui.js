// 書き出しの画面。含まれるものを一覧で見せ、1 巻ずつ「作る → 保存 → 保存を確かめる → 次の巻」と進める。
import { t } from './strings.js';
import { fmtBytes } from './util.js';
import { Exporter, describeContents, ExportError } from './export.js';
import { mountAiPrompt } from './ai-prompt-ui.js';

const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

function waitClick(btn, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const listener = new AbortController();
    btn.addEventListener('click', () => { listener.abort(); resolve(); }, { signal: listener.signal });
    signal.addEventListener('abort', () => { listener.abort(); reject(signal.reason); }, { signal: listener.signal });
  });
}

function saveAction(btn, status, save, signal, nextBtn) {
  let pending;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    status.textContent = t('export.saving');
    pending = (async () => {
      try {
        await save();
        if (signal.aborted) return;
        status.textContent = nextBtn ? '' : t(typeof window.lapSaveBlob === 'function' ? 'export.indexSaved' : 'export.indexDownload');
        if (nextBtn) nextBtn.disabled = false;
      } catch (e) {
        if (signal.aborted) return;
        status.textContent = e?.code === 'save-cancelled' ? t('export.saveCancelled') : t('export.failed', { error: e?.message || String(e) });
      } finally {
        if (!signal.aborted) btn.disabled = false;
      }
    })();
  }, { signal });
  return () => pending;
}

export async function openExportDialog(app, sessionId, { toast = () => {} } = {}) {
  if (!app.session || app.session.sessionId !== sessionId) await app.openSession(sessionId);
  const session = app.session;
  if (session.recovery) { toast(t('recovery.title')); return; }
  const dlg = $('dlg-export');
  if (dlg.open) return;
  const body = $('export-body');
  body.replaceChildren();
  const controller = new AbortController();
  const { signal } = controller;
  const close = () => {
    controller.abort();
    dlg.close();
  };

  const kinds = [
    { id: 'full', label: t('export.kind.full'), checked: true },
    { id: 'final', label: t('export.kind.final'), checked: false },
  ];
  const checks = kinds.map((k) => el('input', { type: 'checkbox', id: `export-kind-${k.id}`, checked: k.checked }));
  const speaker = el('input', { type: 'text', id: 'export-speaker', value: (app.meta && app.meta.speaker) || '', 'aria-label': t('export.speaker'), placeholder: t('export.speaker') });
  const updateSelection = () => { startBtn.disabled = !checks.some((check) => check.checked); };
  const startBtn = el('button', { class: 'btn primary', id: 'export-start' }, t('export.start'));
  for (const check of checks) check.addEventListener('change', updateSelection, { signal });
  body.append(
    el('h3', {}, t('export.contents')),
    ...kinds.map((k, i) => el('div', {}, el('label', {}, checks[i], ' ', k.label), el('ul', { class: 'note' }, describeContents(k.id).map((key) => el('li', {}, t(key)))))),
    el('p', { class: 'warn' }, t('export.retakeNote')),
    el('p', {}, speaker),
    el('p', { class: 'note' }, t('export.afterSave')),
    startBtn);
  dlg.showModal();
  $('export-close').addEventListener('click', close, { signal });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); }, { signal });
  dlg.addEventListener('close', () => { if (!dlg.open) controller.abort(); }, { signal });

  const log = el('div', { id: 'export-log' });
  const exportIds = [];
  try {
    let chosen = [];
    while (!chosen.length) {
      await waitClick(startBtn, signal);
      chosen = kinds.filter((_, i) => checks[i].checked).map((k) => k.id);
      updateSelection();
    }
    startBtn.disabled = true;
    for (const control of [...checks, speaker]) control.disabled = true;
    body.append(log);
    for (const kind of chosen) {
      signal.throwIfAborted();
      const ex = new Exporter({ app, session, kind, volumeMaxBytes: app.config.volumeMaxBytes, finalMaxBytes: app.config.finalMaxBytes, speaker: speaker.value.trim() });
      let pendingSave;
      try {
        const sum = await ex.prepare();
        signal.throwIfAborted();
        log.append(el('p', {}, t('export.plan', { volumes: sum.volumes, max: fmtBytes(sum.volumeMaxBytes) })));
        for (let n = 1; n <= sum.volumes; n++) {
          signal.throwIfAborted();
          const status = el('p', { class: 'note' }, t('export.building', { n, total: sum.volumes }));
          log.append(status);
          const built = await ex.buildVolume(n);
          signal.throwIfAborted();
          status.textContent = `${built.file} (${fmtBytes(built.bytes)})`;
          const saveBtn = el('button', { class: 'btn primary', 'data-act': 'save-volume' }, t('export.save', { n }));
          const nextBtn = el('button', { class: 'btn', 'data-act': 'confirm-volume', disabled: true }, t('export.confirmSaved'));
          const saveStatus = el('p', { class: 'note', role: 'status' });
          log.append(el('div', { class: 'row' }, saveBtn, nextBtn), saveStatus);
          pendingSave = saveAction(saveBtn, saveStatus, () => ex.downloadVolume(n), signal, nextBtn);
          await waitClick(nextBtn, signal);
          signal.throwIfAborted();
          saveBtn.disabled = true;
          nextBtn.disabled = true;
          await ex.confirmSaved(n);
          saveStatus.textContent = t('export.saved', { file: built.file });
        }
        exportIds.push(sum.exportId);
        const idxBtn = el('button', { class: 'btn', 'data-act': 'save-index' }, t('export.writeIndex'));
        const indexStatus = el('p', { class: 'note', role: 'status' });
        saveAction(idxBtn, indexStatus, () => ex.downloadIndex(), signal);
        log.append(el('div', { class: 'row' }, idxBtn), indexStatus);
      } finally {
        // 閉じたあとも、開始済みの保存が一時ファイルを読み終わってから片付ける。
        const discard = Promise.resolve(pendingSave?.()).then(() => ex.discard());
        if (!signal.aborted) await discard;
      }
    }
    signal.throwIfAborted();
    log.append(el('p', { class: 'big' }, t('export.done')), el('p', { class: 'note' }, t('export.deleteHint')));
    // 書き出しが済んだ画面：いま書き出した項目の情報で穴埋めした、AI 用のプロンプトをコピーできる
    const aiBox = el('div', { class: 'ai-prompt-box', id: 'export-ai-prompt' }, el('h3', {}, t('aiPrompt.title')), el('p', { class: 'note' }, t('aiPrompt.explain')));
    log.append(aiBox);
    mountAiPrompt(aiBox, app, { idPrefix: 'export-ai-prompt', getScope: () => ({ sessionId, exportIds }) });
  } catch (e) {
    if (signal.aborted) return;
    console.error(e);
    log.append(el('p', { class: 'warn' }, e instanceof ExportError ? t('export.failed', { error: e.message }) : t('export.failed', { error: String(e && e.message || e) })));
  }
  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
