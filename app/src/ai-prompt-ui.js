// 「AI 用の動画作成プロンプトをコピー」のボタン（ホームと、書き出しの画面の両方で使う）。
// 押すと、プロンプトを作り（本文は app/prompts/video-prompt.md、組み立ては ai-prompt.js）、クリップボードへコピーして「コピーしました」を出す。
// コピーできなかったとき（権限、安全でない環境）は、本文を画面に出して、手で選んでコピーできるようにする。
// 通信はしない（本文はアプリの中のファイル。クリップボードへ入れるだけ）。

import { t, getLang, applyI18n } from './strings.js';
import { appVersionName } from './config.js';
import * as opfs from './opfs.js';
import { parseEventsBytes } from './events-io.js';

const MAX_EXPORTS = 5;

/**
 * クリップボードへ文字を入れる。navigator.clipboard.writeText を試し、だめなら textarea と execCommand('copy')。
 * @returns {Promise<{ok:boolean, method?:string}>}
 */
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard-api' };
    }
  } catch { /* 次の方法へ */ }
  let ta = null;
  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    if (document.execCommand && document.execCommand('copy')) return { ok: true, method: 'exec-command' };
  } catch { /* 手でコピーしてもらう */ } finally {
    if (ta) ta.remove();
  }
  return { ok: false };
}

/**
 * この端末で書き出した項目を集める。録音セッションの操作記録の `export` の行から。
 * @param {*} app
 * @param {{sessionId?:string, exportIds?:string[]}} [scope] 指定があれば、そのセッション・その書き出しだけ
 */
export async function gatherExports(app, scope = {}) {
  const { exportsOfSession, sortExports } = await import('./ai-prompt.js');
  const names = (await opfs.listDir(['sessions'])).filter((e) => e.kind === 'directory').map((e) => e.name);
  const scripts = new Map();
  const all = [];
  for (const id of names) {
    if (scope.sessionId && id !== scope.sessionId) continue;
    try {
      let meta; let events;
      if (app.session && app.session.sessionId === id) {
        meta = app.meta || { sessionId: id, projectId: app.session.script && app.session.script.projectId };
        events = app.session.events.slice().sort((a, b) => a.seq - b.seq);
      } else {
        meta = await opfs.readJson(['sessions', id, 'meta.json']);
        const f = await opfs.readFile(['sessions', id, 'events.jsonl']);
        events = f ? parseEventsBytes(new Uint8Array(await f.arrayBuffer())).events : [];
      }
      if (!events.some((e) => e.type === 'export')) continue;
      const projectId = meta && (meta.recording === 'continuous' ? meta.displayProjectId : meta.projectId); // 通しのときは、画面に出していた台本（あれば）
      if (projectId && !scripts.has(projectId)) scripts.set(projectId, await app.loadProject(projectId).catch(() => null));
      all.push(...exportsOfSession({ meta: { ...(meta || {}), sessionId: id }, script: projectId ? scripts.get(projectId) : null, events }));
    } catch (e) { console.warn('ai-prompt: session skipped', id, e); }
  }
  let list = all;
  if (scope.exportIds) list = list.filter((x) => scope.exportIds.includes(x.exportId));
  list = sortExports(list);
  return { exports: list.slice(0, MAX_EXPORTS), omitted: Math.max(0, list.length - MAX_EXPORTS) };
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

/**
 * ボタン、結果の表示、コピーできなかったときの本文の欄を、container の中に作る。
 * @param {HTMLElement} container
 * @param {*} app
 * @param {{idPrefix:string, getScope?:()=>object}} o  ボタンの id は `${idPrefix}-copy`、結果は `${idPrefix}-msg`、本文の欄は `${idPrefix}-text`
 */
export function mountAiPrompt(container, app, { idPrefix, getScope = () => ({}) }) {
  const btn = el('button', { class: 'btn primary', id: `${idPrefix}-copy`, type: 'button', 'data-act': 'copy-ai-prompt', 'data-i18n': 'aiPrompt.copy' });
  const msg = el('p', { class: 'note', id: `${idPrefix}-msg`, role: 'status' });
  const manualNote = el('p', { class: 'note', 'data-i18n': 'aiPrompt.manual' });
  const area = el('textarea', { id: `${idPrefix}-text`, class: 'prompt-text', readonly: true, rows: 10, spellcheck: 'false', 'aria-label': '' , 'data-i18n-aria': 'aiPrompt.textLabel' });
  const manual = el('div', { id: `${idPrefix}-manual`, hidden: true }, manualNote, area);
  container.append(btn, msg, manual);
  applyI18n(container);

  const setMsg = (key, params, kind) => {
    if (params) { delete msg.dataset.i18n; msg.textContent = t(key, params); } else { msg.dataset.i18n = key; msg.textContent = t(key); }
    msg.className = `note${kind ? ` ${kind}` : ''}`;
  };

  // 押したときに待たないよう、先に本文を読んでおく（失敗しても、押したときにもう一度試す）
  import('./ai-prompt.js').then((m) => m.loadTemplate()).catch(() => {});

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    manual.hidden = true;
    setMsg('aiPrompt.working');
    try {
      const mod = await import('./ai-prompt.js');
      const [template, found] = await Promise.all([mod.loadTemplate(), gatherExports(app, getScope())]);
      const text = mod.buildAiPrompt({
        template,
        versionName: appVersionName(),
        languageHint: (typeof navigator !== 'undefined' && navigator.language) || '',
        appLanguage: getLang(),
        exports: found.exports,
        omitted: found.omitted,
      });
      const r = await copyText(text);
      if (r.ok) {
        setMsg('aiPrompt.copied', null, 'ok-text');
        btn.dataset.copyMethod = r.method;
      } else {
        area.value = text;
        manual.hidden = false;
        setMsg('aiPrompt.failed', null, 'warn');
        btn.dataset.copyMethod = 'manual';
        area.focus();
        area.select();
      }
    } catch (e) {
      console.error(e);
      setMsg('aiPrompt.error', { error: String((e && e.message) || e) }, 'warn');
    } finally {
      btn.disabled = false;
    }
  });
  return { button: btn, message: msg, area, manual };
}
