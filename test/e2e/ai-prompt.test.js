// 「AI 用の動画作成プロンプトをコピー」ボタンを、PC の Chrome で実際に押して、クリップボードの中身を読む試験（担当 B2、dev/proposals/B-003.md）。
//   1 ホーム（書き出しなし）：コピーして「コピーしました」。中身は英語の本文、版、言語のヒント（navigator.language）、アプリの表示言語、言語の規則の文。言語を切り替えると文言と表示言語が変わる
//   2 コピーに失敗：navigator.clipboard.writeText と execCommand の両方が失敗 → 本文が画面に出て、手で選んでコピーできる
//   3 writeText だけ失敗：execCommand のフォールバックでコピーされる
//   4 書き出しの画面：書き出しを終えた画面にボタンがあり、いま書き出したファイル名、スライドの数が入ったプロンプトがコピーされる
//   5 ホーム（書き出しのあと、セッションを閉じた状態）：端末内の操作記録から、同じ書き出しの情報が入る
// Chrome は work/B2/ の専用のプロフィール（利用者のプロフィールは使わない）。静的サーバーはポート 8117。音は出さない。
// 動かす：npm run test:e2e   （または node --test test/e2e/ai-prompt.test.js）
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { startStaticServer, REPO_ROOT } from '../app/helpers/static-server.js';
import { chromePath } from '../app/helpers/chrome.js';
import { openApp } from '../app/helpers/app-page.js';
import { makeScript, makePcm } from '../app/helpers/fixtures.js';
import { readZipDirectory, readZipEntry } from '../../core/zip.js';

const skip = chromePath() ? false : 'Chrome がない';
const PROFILE = path.join(REPO_ROOT, 'work', 'B2', 'profile-e2e');
const RATE = 48000;
const LANGUAGE_RULE = "Respond to the user in the user's own language";
const norm = (s) => s.split('\r\n').join('\n'); // Windows のクリップボードは改行を CRLF にする

describe('AI 用の動画作成プロンプトのボタン（PC の Chrome）', { skip, timeout: 240000 }, () => {
  let server; let ctx;
  before(async () => {
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.mkdirSync(PROFILE, { recursive: true });
    server = await startStaticServer({ port: 8117 });
    ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chrome', headless: true, locale: 'ja-JP',
      permissions: ['clipboard-read', 'clipboard-write'],
      args: ['--no-first-run', '--no-default-browser-check', '--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
  });
  after(async () => {
    if (ctx) await ctx.close().catch(() => {});
    if (server) await server.close();
  });

  const open = async (query) => {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/[/]favicon[.]ico$/.test(m.location().url || '')) errors.push(`console: ${m.text()}`); });
    await page.goto(`${server.origin}/app/index.html${query}`);
    await page.waitForSelector('#view-home:not([hidden])');
    await page.waitForSelector('#ai-prompt-copy');
    return { page, errors };
  };
  const clipboard = async (page) => norm(await page.evaluate(() => navigator.clipboard.readText()));
  const msgOf = (page, id = 'ai-prompt-msg') => page.textContent(`#${id}`);

  test('1 ホーム（書き出しなし）：押すと「コピーしました」。中身は英語の本文、版、言語のヒント、言語の規則の文。言語を切り替えると変わる', async () => {
    const { page, errors } = await open('?nosw=1');
    assert.equal((await page.textContent('#ai-prompt-copy')).trim(), 'AI 用の動画作成プロンプトをコピー');
    await page.evaluate(() => navigator.clipboard.writeText('before'));
    await page.click('#ai-prompt-copy');
    await page.waitForFunction(() => document.getElementById('ai-prompt-msg').textContent === 'コピーしました');
    const text = await clipboard(page);
    assert.match(text, /^# Make a narrated slide video with lap-narrator/);
    assert.match(text, /\nPrompt version: 0\.1\.0-wave1\n/, 'リポジトリの中の版は APP_VERSION');
    assert.match(text, /\nLanguage hint: ja-JP\n/);
    assert.match(text, /\nApp display language: ja\n/);
    assert.ok(text.includes(LANGUAGE_RULE));
    assert.match(text, /found no export record on this device/);
    assert.doesNotMatch(text, /\{\{/);
    assert.equal(await page.isHidden('#ai-prompt-manual'), true, '成功したら手動の欄は出さない');
    // 英語に切り替える
    await page.click('#btn-lang');
    assert.equal((await page.textContent('#ai-prompt-copy')).trim(), 'Copy AI video-making prompt');
    await page.click('#ai-prompt-copy');
    await page.waitForFunction(() => document.getElementById('ai-prompt-msg').textContent === 'Copied');
    const en = await clipboard(page);
    assert.match(en, /\nLanguage hint: ja-JP\n/, 'ヒントは端末の言語');
    assert.match(en, /\nApp display language: en\n/);
    assert.ok(en.includes(LANGUAGE_RULE));
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('2 コピーに失敗（writeText も execCommand も失敗）：本文を画面に出して、手で選んでコピーできる', async () => {
    const { page, errors } = await open('?nosw=1');
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      document.execCommand = () => false;
    });
    await page.click('#ai-prompt-copy');
    await page.waitForSelector('#ai-prompt-manual:not([hidden])');
    assert.match(await msgOf(page), /コピーできませんでした/);
    const value = await page.inputValue('#ai-prompt-text');
    assert.match(value, /^# Make a narrated slide video with lap-narrator/);
    assert.ok(value.includes(LANGUAGE_RULE));
    // 本文が選ばれている（Ctrl+C でコピーできる）
    const sel = await page.evaluate(() => { const t = document.getElementById('ai-prompt-text'); return [t.selectionStart, t.selectionEnd, t.value.length, document.activeElement === t, t.readOnly]; });
    assert.deepEqual(sel, [0, sel[2], sel[2], true, true]);
    assert.equal(await page.getAttribute('#ai-prompt-copy', 'data-copy-method'), 'manual');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('3 writeText だけ失敗：textarea と execCommand("copy") のフォールバックでコピーされる', async () => {
    const { page, errors } = await open('?nosw=1');
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    await page.click('#ai-prompt-copy');
    await page.waitForFunction(() => document.getElementById('ai-prompt-msg').textContent === 'コピーしました');
    assert.equal(await page.getAttribute('#ai-prompt-copy', 'data-copy-method'), 'exec-command');
    const text = await clipboard(page);
    assert.match(text, /^# Make a narrated slide video with lap-narrator/);
    assert.equal(await page.locator('textarea[aria-hidden=true]').count(), 0, '一時の textarea は残さない');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('4・5 書き出しの画面と、書き出したあとのホーム：いま書き出したファイル名、exportId、スライドの数が入る', async () => {
    const D = await openApp({ context: ctx }, server.origin, '?devinput=1&countdown=0&nosw=1');
    const p = D.page;
    const script = makeScript({ slides: 3, projectId: 'proj-aiexp01', title: 'AI prompt deck', nonRecordable: [3] });
    await D.loadScript(script);
    const sessionId = await D.newSession('proj-aiexp01', { speaker: 'Speaker E' });
    await D.press('record');
    await D.feed(makePcm(RATE * 3, { seed: 7 }), {});
    await D.press('ok');
    await D.press('pause');
    await p.click('#btn-back');
    await p.waitForSelector('#view-home:not([hidden])');
    await p.locator(`[data-session="${sessionId}"] [data-act=export-session]`).first().click();
    await p.waitForSelector('#dlg-export[open]');
    assert.equal(await p.locator('#export-ai-prompt-copy').count(), 0, '書き出しが済むまでは出さない');
    await p.click('#export-start');
    await p.waitForSelector('[data-act=save-volume]', { timeout: 30000 });
    const dl = p.waitForEvent('download');
    await p.click('[data-act=save-volume]');
    const file = (await dl).suggestedFilename();
    await p.click('[data-act=confirm-volume]');
    await p.waitForSelector('#export-ai-prompt-copy', { timeout: 30000 });
    assert.match(await p.textContent('#export-log'), /書き出しが終わりました/);
    assert.equal((await p.textContent('#export-ai-prompt-copy')).trim(), 'AI 用の動画作成プロンプトをコピー');
    await p.click('#export-ai-prompt-copy');
    await p.waitForFunction(() => document.getElementById('export-ai-prompt-msg').textContent === 'コピーしました');
    const inDialog = await clipboard(p);
    assert.ok(inDialog.includes(`\`${file}\``), `ファイル名 ${file}`);
    assert.match(inDialog, /### Export 1: exportId `[a-z0-9]{12}` \(kind: full\)/);
    assert.match(inDialog, /Script: "AI prompt deck" \(projectId `proj-aiexp01`\)/);
    assert.match(inDialog, /Slides: 3 in the script, 2 meant to be recorded, 1 of them with a kept recording/);
    assert.match(inDialog, /Retake operations in the log: 0/);
    assert.match(inDialog, /ZIP file\(s\), 1 volume\(s\)/);
    assert.doesNotMatch(inDialog, /found no export record/);
    const exportId = inDialog.match(/exportId `([a-z0-9]{12})`/)[1];
    assert.ok(inDialog.includes(`\`${exportId}_index.json\``));
    // 同じ画面から、ホームのボタンも使える（ダイアログを閉じる前は、ダイアログが前面）
    await p.click('#export-close');
    await p.waitForSelector('#dlg-export:not([open])', { state: 'attached' });

    // 5 セッションを閉じた状態（端末内の操作記録から読む）のホーム
    await p.evaluate(() => window.__lap.closeSession());
    await p.evaluate(() => navigator.clipboard.writeText('x'));
    await p.click('#ai-prompt-copy');
    await p.waitForFunction(() => document.getElementById('ai-prompt-msg').textContent === 'コピーしました');
    const home = await clipboard(p);
    assert.ok(home.includes(`\`${file}\``));
    assert.ok(home.includes(`exportId \`${exportId}\``));
    assert.match(home, /Slides: 3 in the script, 2 meant to be recorded, 1 of them with a kept recording/);
    assert.deepEqual(D.errors, []);
    await p.close();
  });

  test('6 通しの録音（recording: continuous）：書き出しの画面のプロンプトは通しの流れ（transcribe／align）を示し、表示していた台本の題名が入る', async () => {
    const D = await openApp({ context: ctx }, server.origin, '?devinput=1&countdown=0&nosw=1');
    const p = D.page;
    await D.loadScript(makeScript({ slides: 3, projectId: 'proj-aiexp02', title: 'Continuous deck' }));
    const sessionId = await D.newSession('proj-aiexp02', { mode: 'continuous' });
    await D.press('record');
    await D.feed(makePcm(RATE * 3, { seed: 8 }), {});
    await D.press('ok');
    await D.press('pause');
    await p.click('#btn-back');
    // Project cards may list an older per-slide session before the continuous sessions.
    await p.locator(`[data-session="${sessionId}"] [data-act=export-session]`).first().click();
    await p.waitForSelector('#dlg-export[open]');
    await p.click('#export-start');
    await p.waitForSelector('[data-act=save-volume]', { timeout: 30000 });
    const dl = p.waitForEvent('download');
    await p.click('[data-act=save-volume]');
    const file = (await dl).suggestedFilename();
    await p.click('[data-act=confirm-volume]');
    await p.waitForSelector('#export-ai-prompt-copy', { timeout: 30000 });
    await p.click('#export-ai-prompt-copy');
    await p.waitForFunction(() => document.getElementById('export-ai-prompt-msg').textContent === 'コピーしました');
    const text = await clipboard(p);
    assert.ok(text.includes(file), file);
    assert.match(text, /Recording: continuous/);
    assert.match(text, /Script shown in the app while recording: "Continuous deck"/);
    assert.match(text, /transcribe, align, render, build, verify/);
    assert.doesNotMatch(text, /with a kept recording/);
    assert.deepEqual(D.errors, []);
    await p.close();
  });

  test('7 書き出しの manifest：通しは recording: continuous、スライド区切りモードは per-slide（台本の枚数に関わらず）', async () => {
    const D = await openApp({ context: ctx }, server.origin, '?devinput=1&countdown=0&nosw=1');
    const p = D.page;
    const manifestOf = async () => {
      await p.evaluate(() => window.__lap.exportStart({ kind: 'full' }));
      const built = await p.evaluate(() => window.__lap.exportBuild(1));
      const b64 = await p.evaluate((n) => window.__lap.exportReadVolume(1, 0, n), built.bytes);
      const u8 = new Uint8Array(Buffer.from(b64, 'base64'));
      const read = async (a, b) => u8.slice(a, b);
      const dir = await readZipDirectory(read, u8.length);
      const parts = [];
      for await (const c of readZipEntry(read, dir.find((e) => e.name === 'manifest.json'))) parts.push(Buffer.from(c));
      const script = [];
      for await (const c of readZipEntry(read, dir.find((e) => e.name === 'script.json'))) script.push(Buffer.from(c));
      return { manifest: JSON.parse(Buffer.concat(parts).toString('utf8')), script: JSON.parse(Buffer.concat(script).toString('utf8')) };
    };
    await D.loadScript(makeScript({ slides: 1, projectId: 'proj-mani001' })); // 台本が 1 枚だけでも、区切りモードは通しとみなさない
    await D.newSession('proj-mani001', { mode: 'per-slide' });
    await D.press('record'); await D.feed(makePcm(RATE * 2, { seed: 3 }), {}); await D.press('ok'); await D.press('pause');
    const per = await manifestOf();
    assert.equal(per.manifest.recording, 'per-slide');
    assert.equal(per.script.slides[0].slideId, 's0001');
    await D.press('pause').catch(() => {});
    await p.evaluate(() => window.__lap.closeSession());
    await D.newSession('proj-mani001', { mode: 'continuous' });
    await D.press('record'); await D.feed(makePcm(RATE * 2, { seed: 4 }), {}); await D.press('ok'); await D.press('pause');
    const cont = await manifestOf();
    assert.equal(cont.manifest.recording, 'continuous');
    assert.deepEqual(cont.script.slides.map((x) => [x.slideId, x.title, x.text, x.recordable]), [['free', '通し録音', '', true]]);
    assert.equal(cont.script.projectId, 'proj-mani001');
    assert.equal(cont.manifest.projectId, 'proj-mani001');
    assert.deepEqual(D.errors, []);
    await p.close();
  });
});
