// 「AI 用の動画作成プロンプト」を組み立てる（画面を持たない部分。Node でも動く）。
// 本文は app/prompts/video-prompt.md（英語。1 つのファイル）。ここは、穴埋めだけを行う。
//   {{PROMPT_VERSION}}  アプリの版（versionName）
//   {{LANGUAGE_HINT}}   端末の言語（navigator.language）。空なら (empty)
//   {{APP_LANGUAGE}}    アプリの表示言語（ja か en）
//   {{EXPORTS}}         この端末で書き出した項目の情報（なければ一般形の文）
// 書き出した項目は、録音セッションの操作記録にある `export` の行（exportId、kind、volumes）から集める。
// 計算は tracker.js（撮り直しの数、録音済みのスライド）と export.js の volumeName（ファイル名）を使う。

import { track, computeInvalid, slideSummary } from './tracker.js';
import { volumeName } from './export.js';

export const PLACEHOLDERS = Object.freeze(['PROMPT_VERSION', 'LANGUAGE_HINT', 'APP_LANGUAGE', 'EXPORTS']);
export const TEMPLATE_URL = new URL('../prompts/video-prompt.md', import.meta.url);

let templatePromise = null;
/** 本文（video-prompt.md）を読む。画面の操作の前に呼んでおくと、押したときに待たない。 */
export function loadTemplate(url = TEMPLATE_URL) {
  if (!templatePromise) {
    templatePromise = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`prompt template: HTTP ${r.status}`);
      return r.text();
    }).catch((e) => { templatePromise = null; throw e; });
  }
  return templatePromise;
}

/** 題名などの、利用者の文字を、1 行の短い文字にする（改行、バッククォート、制御文字を除く）。 */
export function oneLine(s, max = 80) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 1 つの録音セッションから、書き出した項目（export の行）の情報を取り出す。
 * @param {{meta?:any, script?:any, events:any[]}} o events は seq の昇順
 * @returns {Array<{exportId:string, kind:string, volumes:number, projectId:string|null, sessionId:string|null, title:string|null,
 *   slides:number|null, recordable:number|null, recorded:number|null, retakes:number, wall:string|null, files:string[], indexFile:string}>}
 */
export function exportsOfSession({ meta, script, events }) {
  const list = (events || []).filter((e) => e && e.type === 'export' && typeof e.exportId === 'string' && e.exportId);
  if (!list.length) return [];
  const sessionId = (meta && meta.sessionId) || null;
  const continuous = !!meta && meta.recording === 'continuous';
  const projectId = (meta && meta.projectId) || (script && script.projectId) || null;
  const invalid = computeInvalid(events);
  const retakes = events.filter((e) => e.type === 'retake' && !invalid.has(e.eventId)).length;
  let slides = null; let recordable = null; let recorded = null;
  if (script && Array.isArray(script.slides)) {
    const rec = script.slides.filter((s) => s.recordable !== false);
    slides = script.slides.length;
    recordable = rec.length;
    if (!continuous) { // スライド区切りのときだけ、スライドごとの録音の有無が意味を持つ
      const st = track(events);
      recorded = rec.filter((s) => slideSummary(st, s.slideId).keptSamples > 0).length;
    }
  }
  return list.map((e) => {
    const volumes = Number.isInteger(e.volumes) && e.volumes > 0 ? e.volumes : 1;
    const kind = e.kind === 'final' ? 'final' : 'full';
    const files = projectId && sessionId
      ? Array.from({ length: volumes }, (_, i) => volumeName(projectId, sessionId, kind, i + 1))
      : [];
    return {
      exportId: e.exportId, kind, volumes, projectId, sessionId,
      recording: continuous ? 'continuous' : (meta && meta.recording === 'per-slide') ? 'per-slide' : 'unknown',
      title: (script && script.title) || (continuous ? null : (meta && meta.title)) || null,
      slides, recordable, recorded, retakes, wall: e.wall || null, files, indexFile: `${e.exportId}_index.json`,
    };
  });
}

/** 新しい順に並べる（同じ時刻なら元の順を保つ）。 */
export function sortExports(list) {
  return list.map((x, i) => [x, i]).sort((a, b) => String(b[0].wall || '').localeCompare(String(a[0].wall || '')) || a[1] - b[1]).map(([x]) => x);
}

const q = (s) => `\`${s}\``;

/** {{EXPORTS}} の部分（Markdown。英語）。exports が空なら一般形。 */
export function renderExportsSection(exports, { omitted = 0 } = {}) {
  const out = ['## Facts from the app (filled in when this prompt was copied)', ''];
  if (!exports.length) {
    out.push(
      'The app found no export record on this device when this prompt was copied, so nothing is filled in here.',
      'Ask the user for the exported ZIP file(s), the `*_index.json` file, the script pack and the `.pptx`, and for their full paths.');
    return out.join('\n');
  }
  out.push(
    'The app recorded the following export(s) on this device. The file names are the names the app proposed when saving; the user may have renamed or moved the files, so confirm the real paths with the user. An export record means that the user started that export; it does not prove that every volume was saved.',
    '');
  exports.forEach((x, i) => {
    out.push(`### Export ${i + 1}: exportId ${q(x.exportId)} (kind: ${x.kind})`);
    if (x.recording === 'continuous') {
      out.push('- Recording: continuous (`recording: continuous`): one take with no slide markers. Use the continuous way: import, status, transcribe, align, render, build, verify.');
      if (x.title) out.push(`- Script shown in the app while recording: "${oneLine(x.title)}"${x.slides !== null ? ` (${x.slides} slides, ${x.recordable} meant to be recorded)` : ''}. It is only a display copy: the script pack must come from the user.`);
      else out.push('- No script was loaded in the app while recording. The user must give you the script pack (or the `.pptx`).');
    } else {
      if (x.recording === 'per-slide') out.push('- Recording: slide by slide (`recording: per-slide`): the user pressed "next slide" while recording. Use the old way (no transcribe or align): import, status, render, build, verify.');
      if (x.title) out.push(`- Script: "${oneLine(x.title)}"${x.projectId ? ` (projectId ${q(x.projectId)})` : ''}`);
      else if (x.projectId) out.push(`- projectId: ${q(x.projectId)}`);
      if (x.slides === null) out.push('- Slides: unknown (the script is no longer on this device)');
      else out.push(`- Slides: ${x.slides} in the script, ${x.recordable} meant to be recorded, ${x.recorded} of them with a kept recording`);
    }
    out.push(`- Retake operations in the log: ${x.retakes}`);
    if (x.sessionId) out.push(`- Recording session: ${q(x.sessionId)}`);
    if (x.files.length) out.push(`- ZIP file(s), ${x.volumes} volume(s): ${x.files.map(q).join(', ')}`);
    else out.push(`- Volumes: ${x.volumes}`);
    out.push(`- Index file (only if the user saved it): ${q(x.indexFile)}`, '');
  });
  if (omitted > 0) out.push(`(${omitted} older export record(s) are not listed.)`, '');
  out.push('The script pack (`script-pack.zip`) and the `.pptx` are not recorded by the app: ask the user for them.');
  return out.join('\n');
}

/**
 * プロンプトの本文を作る。
 * @param {{template:string, versionName:string, languageHint?:string, appLanguage:string, exports?:any[], omitted?:number}} o
 */
export function buildAiPrompt({ template, versionName, languageHint, appLanguage, exports = [], omitted = 0 }) {
  for (const name of PLACEHOLDERS) {
    if (!template.includes(`{{${name}}}`)) throw new Error(`prompt template: {{${name}}} is missing`);
  }
  const values = {
    PROMPT_VERSION: oneLine(versionName, 64) || 'unknown',
    LANGUAGE_HINT: oneLine(languageHint, 64) || '(empty)',
    APP_LANGUAGE: oneLine(appLanguage, 16) || '(unknown)',
    EXPORTS: renderExportsSection(exports, { omitted }),
  };
  const text = template.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(values, k) ? values[k] : m));
  const left = text.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`prompt template: unknown placeholder ${left[0]}`);
  return text;
}
