// 「AI 用の動画作成プロンプト」の試験（ブラウザなし。担当 B2、dev/proposals/B-003.md）。
//   - 本文（app/prompts/video-prompt.md）は英語で、言語の規則の文（利用者の言語で答える）が冒頭近くの見出しにある
//   - 穴埋め：版（versionName）、言語のヒント（navigator.language）、アプリの表示言語、書き出した項目（ファイル名、exportId、スライドの数、撮り直しの数）
//   - プロンプトの中の narrate のコマンドとフラグが、cli の --help の usage と README に実在する（実在しないものがあれば落ちる）
//   - 終了コードの表が README と同じ
//   - release 用の補助（目印の行の除去、URL パラメーターの無視）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAiPrompt, exportsOfSession, renderExportsSection, sortExports, oneLine, PLACEHOLDERS } from '../../app/src/ai-prompt.js';
import { volumeName } from '../../app/src/export.js';
import { STRINGS } from '../../app/src/strings.js';
import { readConfig, appVersionName, APP_VERSION } from '../../app/src/config.js';
import { USAGE } from '../../cli/narrate.js';
import { stripNoRelease } from '../../native/scripts/prepare-www.mjs';
import { makeScript } from './helpers/fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'app', 'prompts', 'video-prompt.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const LANGUAGE_RULE = "Respond to the user in the user's own language — the language the user writes to you in (if you cannot tell, use the language hint below; if the hint is empty, ask the user which language they prefer). Do not answer in English just because this prompt is written in English. Keep commands, file names, code and error codes unchanged (do not translate them).";

const fill = (o = {}) => buildAiPrompt({ template: TEMPLATE, versionName: '0.2.0-native', languageHint: 'ja-JP', appLanguage: 'ja', exports: [], ...o });

describe('プロンプトの本文（video-prompt.md）', () => {
  test('穴は 4 つで、それぞれ 1 回ずつ。ほかに {{ }} はない', () => {
    for (const name of PLACEHOLDERS) assert.equal(TEMPLATE.split(`{{${name}}}`).length - 1, 1, name);
    assert.deepEqual([...TEMPLATE.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort(), [...PLACEHOLDERS].sort());
  });

  test('本文は英語（日本語などの文字を含まない。review の出力の記号 ▮ ⟨ ⟩ だけは、出力どおりに書いてある）', () => {
    const non = TEMPLATE.match(/[^\u0000-\u007f—’▮⟨⟩]/g);
    assert.equal(non, null, `ASCII と em dash 以外の文字: ${non && [...new Set(non)].join('')}`);
  });

  test('言語の規則：目立つ見出しが冒頭近くにあり、決められた文がそのまま入っている', () => {
    const at = TEMPLATE.indexOf('## Language rule');
    assert.ok(at > 0 && at < 2500, `見出しの位置 ${at}`);
    assert.ok(TEMPLATE.includes(LANGUAGE_RULE), '言語の規則の文');
    assert.ok(TEMPLATE.indexOf(LANGUAGE_RULE) > at && TEMPLATE.indexOf(LANGUAGE_RULE) < at + 400, '規則の文は見出しのすぐ下');
    // 版は最初の行の近く
    assert.ok(TEMPLATE.indexOf('Prompt version: {{PROMPT_VERSION}}') < 200);
    // 言語のヒントを書く欄
    assert.match(TEMPLATE, /Language hint: \{\{LANGUAGE_HINT\}\}/);
    assert.match(TEMPLATE, /App display language: \{\{APP_LANGUAGE\}\}/);
  });

  test('目的、用意されるファイル、道具の場所の穴、方式 A と B、終了コード、判断待ち、禁止、完了の報告が書いてある', () => {
    for (const must of [
      'MP4', 'script-pack.zip', '.pptx', '*_index.json', '<path to the lap-narrator folder>', '--workspace <workspace>',
      'transcribe', 'align', 'boundary show', 'boundary set', 'boundary confirm', 'recording: per-slide', '--no-boundaries', 'final/all.wav', 'speech-unavailable',
      'Never run `boundary confirm` on an unsure boundary without reading the transcript', 'Do not add `--allow-unconfirmed`',
      'boundary review', '--at-text', '--before-text', '--nth', 'result.reviewHint', 'ambiguous-text', '4b. Review every boundary (always', 'Do not `confirm` anything you have not read', 'gets **no** flag',
      'Method A', 'Method B', 'PowerPoint', 'Windows', '.venv', 'powerpoint-busy',
      '## Exit codes', 'decision-required', 'needsDecision', 'select', 'out-of-tolerance', 'unmeasurable', '--allow-unmeasurable', 'passMeasuredOnly',
      'Do not modify, move, rename or delete the input files', 'Do not install anything', 'Do not send any file',
      'Do not change the script text or the recordings on a guess', 'maxAbsDiffMs', '## Final report',
    ]) assert.ok(TEMPLATE.includes(must), must);
  });

  test('音量と 4 秒：render の例に付け方があり、理由と読むべき警告が書いてある（担当 B3）', () => {
    const renders = TEMPLATE.split('\n').filter((l) => /^node cli\/narrate\.js render /.test(l));
    assert.ok(renders.length >= 2, 'render の例（通しの経路と、従来のスライド区切り）');
    // 通しの経路（手順 5）の例：音量をそろえる 3 つと、話し始めまでの 4 秒
    const main = renders[0];
    for (const f of ['--target-lufs -16', '--ceiling-db -1.5', '--lookahead-limiter', '--lead-in-sec 4']) assert.ok(main.includes(f), `手順 5 の render に ${f}`);
    // 従来のスライド区切りの例にも、音量をそろえる 3 つ（lead-in は通しの経路だけ）
    const old = renders[renders.length - 1];
    for (const f of ['--target-lufs -16', '--ceiling-db -1.5', '--lookahead-limiter']) assert.ok(old.includes(f), `従来の render に ${f}`);
    assert.ok(!old.includes('--lead-in-sec'), 'lead-in は通しの経路だけ');
    for (const must of [
      'very quiet', '-56 dBFS', 'too quiet to hear', 'microphone close to the mouth', 'loudness-target-unmet',
      '4 seconds between the moment a slide appears and the moment the narration', 'If the user asks for another number of seconds', 'lead-in-ignored',
    ]) assert.ok(TEMPLATE.includes(must), must);
    // コピーされる文面（穴埋めのあと）にも入っている
    const text = fill({});
    assert.ok(text.includes('--target-lufs -16 --ceiling-db -1.5 --lookahead-limiter') && text.includes('--lead-in-sec 4'));
  });

  test('終了コードの表が README の表と同じ（0〜4）', () => {
    const rows = (text) => [...text.matchAll(/^\| ([0-4]) \|/gm)].map((m) => m[1]);
    assert.deepEqual(rows(TEMPLATE), ['0', '1', '2', '3', '4']);
    assert.deepEqual(rows(README), ['0', '1', '2', '3', '4']);
  });
});

describe('プロンプトの中の narrate のコマンドが、実在する（cli の usage と README）', () => {
  // 本文中の `node cli/narrate.js <sub> …` の行（コードブロックと行内のコード）
  const lines = [];
  for (const m of TEMPLATE.matchAll(/node cli\/narrate\.js ([^\n`]*)/g)) lines.push(m[1].trim());
  const parsed = lines.map((l) => ({ line: l, sub: l.split(/\s+/)[0], flags: [...l.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]) }));
  const GLOBAL = new Set(['--workspace', '--json', '--help']);

  test('コマンドが見つかる（import、status、render、build、verify、select）', () => {
    const subs = new Set(parsed.map((p) => p.sub));
    for (const s of ['import', 'status', 'transcribe', 'align', 'boundary', 'render', 'build', 'verify', 'select']) assert.ok(subs.has(s), `${s} の例がない`);
  });

  test('手順の順番は README の最初の手順と同じ（import → status → transcribe → align → render → build → verify）', () => {
    const order = [...TEMPLATE.matchAll(/^### \d\. (\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(order, ['import', 'status', 'transcribe', 'align', 'render', 'build', 'verify']);
    const rd = [...README.matchAll(/^### \d\. (\w+)：/gm)].map((m) => m[1]).filter((x) => x !== 'pack');
    assert.deepEqual(rd.slice(0, 7).map((x) => x.toLowerCase()), order);
  });

  test('サブコマンドは cli の usage にある。フラグは、そのコマンドの usage にある（--workspace などの共通のものを除く）', () => {
    for (const p of parsed) {
      if (p.sub === '--help') continue;
      assert.ok(Object.hasOwn(USAGE, p.sub), `usage に無いサブコマンド: ${p.sub}（${p.line}）`);
      for (const f of p.flags) {
        assert.ok(GLOBAL.has(f) || USAGE[p.sub].includes(f), `usage に無いフラグ: ${p.sub} ${f}（${p.line}）`);
      }
    }
  });

  test('サブコマンドとフラグは README にも書いてある', () => {
    for (const p of parsed) {
      if (p.sub === '--help') continue;
      assert.match(README, new RegExp(`narrate ${p.sub}\\b`), `README に narrate ${p.sub} が無い`);
      for (const f of p.flags) assert.ok(README.includes(f), `README に無いフラグ: ${f}（${p.line}）`);
    }
  });

  test('本文中の、コード書式の --フラグ はすべて、どれかのコマンドの usage にある', () => {
    const inline = new Set([...TEMPLATE.matchAll(/`(--[a-z][a-z-]*)(?: [^`]*)?`/g)].map((m) => m[1]));
    const allUsage = Object.values(USAGE).join('\n');
    for (const f of inline) assert.ok(GLOBAL.has(f) || allUsage.includes(f), `usage に無いフラグ: ${f}`);
  });

  test('本文の誤りの検出が働く：実在しないフラグを足すと、上の検査が落ちる（検査自体の確認）', () => {
    const bogus = 'node cli/narrate.js build --method B --no-such-flag x --workspace w';
    const p = { sub: 'build', flags: [...bogus.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]) };
    assert.ok(p.flags.some((f) => !GLOBAL.has(f) && !USAGE.build.includes(f)));
  });
});

describe('プロンプトの生成（穴埋め）', () => {
  test('版、言語のヒント、アプリの表示言語が入る。穴は残らない', () => {
    const text = fill({ versionName: '0.2.0-native', languageHint: 'ja-JP', appLanguage: 'ja' });
    assert.match(text, /^# Make a narrated slide video with lap-narrator/);
    assert.match(text, /\nPrompt version: 0\.2\.0-native\n/);
    assert.match(text, /\nLanguage hint: ja-JP\n/);
    assert.match(text, /\nApp display language: ja\n/);
    assert.doesNotMatch(text, /\{\{/);
    assert.ok(text.includes(LANGUAGE_RULE));
  });

  test('ヒントが空なら (empty)。版が空なら unknown。$ を含む文字でも壊れない', () => {
    const t1 = fill({ languageHint: '', appLanguage: 'en' });
    assert.match(t1, /\nLanguage hint: \(empty\)\n/);
    assert.match(t1, /\nApp display language: en\n/);
    const t2 = fill({ versionName: '', languageHint: '$& $1 $`' });
    assert.match(t2, /\nPrompt version: unknown\n/);
    assert.match(t2, /\nLanguage hint: \$& \$1 \$\n/);
  });

  test('アプリの言語が日本語でも、本文は英語のまま（言語のヒントは ja）', () => {
    const text = fill({ languageHint: 'ja', appLanguage: 'ja' });
    assert.match(text, /\nLanguage hint: ja\n/);
    assert.equal(text.match(/[぀-ヿ一-鿿]/g), null);
  });

  test('穴が足りない本文は例外にする', () => {
    assert.throws(() => buildAiPrompt({ template: TEMPLATE.replace('{{EXPORTS}}', ''), versionName: 'x', appLanguage: 'ja' }), /EXPORTS/);
    assert.throws(() => buildAiPrompt({ template: `${TEMPLATE}\n{{NOPE}}`, versionName: 'x', appLanguage: 'ja' }), /NOPE/);
  });

  test('書き出しの記録がなければ、一般形の文（利用者にファイルを聞く）', () => {
    const text = fill({ exports: [] });
    assert.match(text, /## Facts from the app/);
    assert.match(text, /found no export record on this device/);
    assert.match(text, /Ask the user for the exported ZIP file\(s\)/);
  });
});

// ---- 書き出しの記録からの穴埋め
function Log() {
  const events = [];
  let n = 0;
  const add = (type, fields = {}, pos = null, wall = '2026-11-17T01:00:00.000Z') => {
    const e = { seq: n, eventId: `e${n}`, type, wall, mono: n * 10, ...fields };
    if (pos !== null) e.at = { raw: 'rec-000001', sample: pos, pos };
    events.push(e);
    n++;
    return e;
  };
  return { events, add };
}

function sampleSession() {
  const L = Log();
  L.add('session-start', { sessionId: 'sess0001' });
  L.add('rec-start', { slideId: 's0001', takeId: 't0001' }, 0);
  L.add('ok', { checkpointId: 'c0001' }, 48000);
  L.add('next-slide', { slideId: 's0001', nextSlideId: 's0002', checkpointId: 'c0002' }, 48000);
  L.add('rec-start', { slideId: 's0002', takeId: 't0002' }, 48000);
  L.add('ok', { checkpointId: 'c0003' }, 96000);
  L.add('pause', { reason: 'user' }, 100000);
  const r1 = L.add('retake', { toCheckpoint: null }, 100000); // 撮り直し（s0002 の録音が消える）
  const r2 = L.add('retake', { toCheckpoint: null }, 100000);
  L.add('undo', { target: r2.eventId });
  L.add('export', { exportId: 'exp0aaaa1111', kind: 'full', volumes: 2 }, null, '2026-11-17T02:00:00.000Z');
  L.add('export', { exportId: 'exp0bbbb2222', kind: 'final', volumes: 1 }, null, '2026-11-17T03:00:00.000Z');
  return { meta: { sessionId: 'sess0001', projectId: 'proj-aiprompt' }, script: makeScript({ slides: 3, projectId: 'proj-aiprompt', title: 'Quarterly `review`\nsecond line', nonRecordable: [3] }), events: L.events, r1 };
}

describe('書き出しの記録からの穴埋め', () => {
  const s = sampleSession();
  const list = exportsOfSession(s);

  test('export の行ごとに、exportId、kind、巻の数、ファイル名、索引のファイル名が入る', () => {
    assert.equal(list.length, 2);
    const a = list.find((x) => x.exportId === 'exp0aaaa1111');
    assert.equal(a.kind, 'full');
    assert.equal(a.volumes, 2);
    assert.deepEqual(a.files, [volumeName('proj-aiprompt', 'sess0001', 'full', 1), volumeName('proj-aiprompt', 'sess0001', 'full', 2)]);
    assert.equal(a.files[0], 'proj-aiprompt_sess0001_full_v001.zip');
    assert.equal(a.indexFile, 'exp0aaaa1111_index.json');
    const b = list.find((x) => x.exportId === 'exp0bbbb2222');
    assert.deepEqual(b.files, ['proj-aiprompt_sess0001_final_v001.zip']);
  });

  test('スライドの数、録音の対象の数、録音済みの数、撮り直しの数（取り消した撮り直しは数えない）', () => {
    const a = list[0];
    assert.equal(a.slides, 3);
    assert.equal(a.recordable, 2);
    assert.equal(a.recorded, 1, 's0001 だけが録音済み（s0002 は撮り直しで消えた）');
    assert.equal(a.retakes, 1);
  });

  test('通しの録音（recording: continuous）：スライドごとの録音の数は書かず、通しの流れ（transcribe／align）を示す。表示していた台本があれば題名を書く', () => {
    const c = exportsOfSession({ ...s, meta: { ...s.meta, recording: 'continuous', projectId: 'proj-aiprompt' } });
    assert.equal(c[0].recording, 'continuous');
    assert.equal(c[0].recorded, null);
    const md = renderExportsSection(c);
    assert.match(md, /Recording: continuous/);
    assert.match(md, /import, status, transcribe, align, render, build, verify/);
    assert.match(md, /Script shown in the app while recording: "Quarterly review second line" \(3 slides, 2 meant to be recorded\)/);
    assert.doesNotMatch(md, /with a kept recording/);
    const none = renderExportsSection(exportsOfSession({ ...s, meta: { ...s.meta, recording: 'continuous' }, script: null }));
    assert.match(none, /No script was loaded in the app while recording/);
    const per = renderExportsSection(exportsOfSession({ ...s, meta: { ...s.meta, recording: 'per-slide' } }));
    assert.match(per, /Recording: slide by slide/);
    assert.match(per, /old way/);
  });

  test('台本が端末に無いときは、スライドの数は不明と書く', () => {
    const l = exportsOfSession({ ...s, script: null });
    assert.equal(l[0].slides, null);
    const md = renderExportsSection(l);
    assert.match(md, /Slides: unknown/);
  });

  test('export の行がなければ空', () => {
    assert.deepEqual(exportsOfSession({ meta: {}, script: null, events: [{ seq: 0, eventId: 'e0', type: 'session-start' }] }), []);
  });

  test('プロンプトに、ファイル名、exportId、スライドの数、撮り直しの数、巻の数が入る。題名は 1 行にされる', () => {
    const text = fill({ exports: sortExports(list) });
    assert.match(text, /### Export 1: exportId `exp0bbbb2222` \(kind: final\)/, '新しい順');
    assert.match(text, /### Export 2: exportId `exp0aaaa1111` \(kind: full\)/);
    assert.ok(text.includes('`proj-aiprompt_sess0001_full_v001.zip`, `proj-aiprompt_sess0001_full_v002.zip`'));
    assert.ok(text.includes('`exp0aaaa1111_index.json`'));
    assert.match(text, /Slides: 3 in the script, 2 meant to be recorded, 1 of them with a kept recording/);
    assert.match(text, /Retake operations in the log: 1/);
    assert.match(text, /ZIP file\(s\), 2 volume\(s\)/);
    assert.ok(text.includes('Script: "Quarterly review second line"'), '題名の改行とバッククォートを除く');
    assert.doesNotMatch(text, /found no export record/);
    assert.doesNotMatch(text, /\{\{/);
  });

  test('古い記録は 5 件まで（omitted を書く）', () => {
    const md = renderExportsSection(list, { omitted: 3 });
    assert.match(md, /3 older export record\(s\) are not listed/);
  });

  test('oneLine：制御文字、バッククォート、長さ', () => {
    assert.equal(oneLine('a`b\nc\u0000d'), 'a b c d');
    assert.equal(oneLine('x'.repeat(200), 10).length, 10);
    assert.equal(oneLine(null), '');
  });
});

describe('ボタンの文言（ja と en）', () => {
  test('ボタンの文は指定どおり。ほかの文言も ja と en の両方にある', () => {
    assert.equal(STRINGS.ja['aiPrompt.copy'], 'AI 用の動画作成プロンプトをコピー');
    assert.equal(STRINGS.en['aiPrompt.copy'], 'Copy AI video-making prompt');
    assert.equal(STRINGS.ja['aiPrompt.copied'], 'コピーしました');
    const used = new Set();
    for (const f of ['ai-prompt-ui.js', 'export-ui.js', 'ui.js']) {
      const text = fs.readFileSync(path.join(ROOT, 'app', 'src', f), 'utf8');
      for (const m of text.matchAll(/['"](aiPrompt\.[A-Za-z]+)['"]/g)) used.add(m[1]);
    }
    for (const m of fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8').matchAll(/data-i18n="(aiPrompt\.[A-Za-z]+)"/g)) used.add(m[1]);
    assert.ok(used.size >= 6);
    for (const k of used) assert.ok(k in STRINGS.ja && k in STRINGS.en, k);
  });
});

describe('release の補助（目印の行の除去、URL パラメーターの無視、版の表示）', () => {
  test('stripNoRelease：begin と end の間（目印を含む）を取り除く。揃っていなければ例外', () => {
    const src = ['a', '// @no-release:begin', 'dev();', '// @no-release:end', 'b', '<!-- @no-release:begin -->', '<x>', '<!-- @no-release:end -->', 'c'].join('\n');
    assert.equal(stripNoRelease(src), 'a\nb\nc');
    assert.throws(() => stripNoRelease('// @no-release:begin\nx'), /end/);
    assert.throws(() => stripNoRelease('x\n// @no-release:end'), /begin/);
    assert.throws(() => stripNoRelease('// @no-release:begin\n// @no-release:begin\n// @no-release:end'), /入れ子/);
  });

  test('app のコードの目印は、すべて begin と end が揃っている', () => {
    for (const f of ['app/src/main.js', 'app/src/app.js', 'app/index.html', 'native/web/native-bridge.js']) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.match(text, /@no-release:begin/, f);
      assert.doesNotThrow(() => stripNoRelease(text, f));
      const stripped = stripNoRelease(text, f);
      assert.doesNotMatch(stripped, /installDevApi|createDevSource|window\.lapNative|__lapNativeTune|serviceWorker\.register|manifest\.webmanifest/, f);
    }
  });

  test('readConfig：release なら URL パラメーターをすべて無視する。release でなければ今まで通り', () => {
    const q = '?devinput=1&lapdev=1&nosw=1&rawMax=100&volumeMax=10&finalMax=60&testMs=200&countdown=0&durableMs=20&hook=after-audio&hookAt=5&devRate=44100&lang=en';
    const rel = readConfig(q, true);
    assert.deepEqual(rel, readConfig('', true));
    assert.equal(rel.dev, false);
    assert.equal(rel.devinput, false);
    assert.equal(rel.hook, null);
    assert.equal(rel.noSw, false);
    assert.equal(rel.lang, null);
    assert.equal('countdownSec' in rel, false, '録音開始のカウントダウンは無い（?countdown= は release でも debug でも何もしない）');
    const dev = readConfig(q, false);
    assert.equal(dev.dev, true);
    assert.equal(dev.devinput, true);
    assert.equal(dev.hook, 'after-audio');
    assert.equal(dev.testMs, 200);
    assert.equal(dev.rawMaxBytes, 100);
  });

  test('版の表示：リポジトリの中では APP_VERSION', () => {
    assert.equal(appVersionName(), APP_VERSION);
  });
});
