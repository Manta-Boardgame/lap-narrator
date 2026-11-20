// T3 (4) オフライン（Service Worker）と、(5) 通信の点検。
// - 初回の読み込みのあと、サーバーを止めて（機内モードと同じ）も、台本を開く・録音・復旧まで動く。
// - 録音の間、台本と音声を、自分のオリジンにも送っていない（POST/PUT をしていない）。外部ドメインへの通信がない。
//   サーバー側の記録（届いた要求のすべて）と、ブラウザ側の記録（ページと Worker の要求、CSP の違反）の両方で確かめる。
// ブラウザ：work/B/profile-offline。ポート 8102〜8103。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startStaticServer, REPO_ROOT } from './helpers/static-server.js';
import { launchChrome, chromePath, waitUntil } from './helpers/chrome.js';
import { openApp } from './helpers/app-page.js';
import { acquireBrowserLock, releaseBrowserLock } from './helpers/lock.js';
import { makeScript, makePcm } from './helpers/fixtures.js';

const skip = chromePath() ? false : 'Chrome がない';
const RATE = 48000;

function swPrecache() {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'app', 'sw.js'), 'utf8');
  const m = /\/\/ PRECACHE-BEGIN\s*const PRECACHE = \[([\s\S]*?)\];\s*\/\/ PRECACHE-END/.exec(text);
  assert.ok(m, 'sw.js に PRECACHE の目印がある');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('Service Worker のファイル一覧', () => {
  test('precache の一覧が、実在するファイルと過不足なく一致する（app/ と core/ の .js、画面、アイコン）', () => {
    const listed = swPrecache().map((u) => (u === './' ? 'app/' : path.posix.normalize(`app/${u}`)));
    for (const f of listed) {
      const p = path.join(REPO_ROOT, f);
      assert.ok(f.endsWith('/') ? fs.existsSync(path.join(p, 'index.html')) : fs.existsSync(p), `一覧にあるが存在しない：${f}`);
    }
    const actual = [];
    const walk = (dir, filter) => {
      for (const e of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!(dir === 'app' && ['i18n', 'organizer'].includes(e.name))) walk(rel, filter); } else if (filter(rel)) actual.push(rel);
      }
    };
    walk('app', (f) => f !== 'app/sw.js');
    walk('core', (f) => f.endsWith('.js'));
    const missing = actual.filter((f) => !listed.includes(f));
    assert.deepEqual(missing, [], '存在するが一覧にない（オフラインで読めない）ファイル。node test/app/helpers/update-precache.js で更新する');
  });

  test('app/ のモジュールが読み込む core/ のファイルは、すべて一覧にある', () => {
    const listed = swPrecache();
    const wanted = new Set();
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (e.name.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/from '((?:\.\.\/)+core\/[^']+)'/g)) wanted.add(path.posix.normalize(m[1].replace(/^(\.\.\/)+/, '../')));
      }
    };
    scan(path.join(REPO_ROOT, 'app', 'src'));
    for (const w of wanted) assert.ok(listed.includes(w), `core の読み込み先が一覧にない：${w}`);
  });
});

describe('マニフェスト', () => {
  test('向きを固定しない（縦向きと横向きの両方。設計書 4.1）', () => {
    const m = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'manifest.webmanifest'), 'utf8'));
    assert.equal('orientation' in m, false);
    assert.equal(m.display, 'standalone');
    for (const i of m.icons) assert.ok(fs.existsSync(path.join(REPO_ROOT, 'app', i.src)), i.src);
  });
});

describe('オフラインと通信の点検', { skip }, () => {
  let server; let chrome;
  before(async () => {
    await acquireBrowserLock(); // ブラウザを使う試験ファイルは 1 つずつ動かす
    server = await startStaticServer({ port: 8102 });
    chrome = await launchChrome({ name: 'offline', port: 8103 });
  });
  after(async () => {
    if (chrome) await chrome.close();
    if (server) await server.close();
    releaseBrowserLock();
  });

  let sessionId; let projectId;
  const requests = [];

  test('通信の点検：録音の間、POST/PUT などをせず、外部ドメインへの通信がなく、CSP の違反がない', async () => {
    const app = await openApp(chrome, server.origin, '?devinput=1&countdown=0&durableMs=500', { requests });
    const page = app.page;
    await waitUntil(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))), { what: 'Service Worker の有効化', timeoutMs: 15000 });
    await waitUntil(() => page.evaluate(() => !!navigator.serviceWorker.controller), { what: 'ページの制御', timeoutMs: 15000 });

    projectId = await app.loadScript(makeScript({ slides: 3, projectId: 'proj-offl001' }));
    sessionId = await app.newSession(projectId);
    // ここから録音の間の通信を数える
    const mark = server.mark();
    const reqMark = requests.length;
    await app.press('record');
    await app.feed(makePcm(RATE * 3, { seed: 61 }), { speed: 8 });
    await app.press('ok');
    await app.feed(makePcm(RATE, { seed: 62 }), { speed: 8 });
    await app.press('retake');
    await app.press('record');
    await app.feed(makePcm(RATE * 2, { seed: 63 }), { speed: 8 });
    await app.press('next');
    await app.press('undo');
    await app.press('pause');
    const during = server.since(mark);
    const duringBrowser = requests.slice(reqMark);
    assert.deepEqual(during.map((r) => `${r.method} ${r.url}`), [], '録音の間は、サーバーへの要求が 1 つもない');
    assert.deepEqual(duringBrowser.map((r) => `${r.method} ${r.url}`), [], 'ブラウザ側の記録にも要求がない');

    // 全体を通して：自分のオリジンへの GET だけ。本体のないもの、問い合わせに台本や音声を載せたものがない
    for (const r of server.log) {
      assert.ok(r.method === 'GET' || r.method === 'HEAD', `${r.method} ${r.url} は送信（POST/PUT など）ではない`);
      assert.equal(r.bodyBytes, 0, `${r.url} に本体がない`);
      assert.equal(r.host, `127.0.0.1:${server.port}`);
      assert.ok(r.url.length < 200, `${r.url} は短い（データを載せていない）`);
      assert.match(r.url.split('?')[0], /^\/(app|core)\//, `${r.url} は配布物の取得だけ`);
    }
    for (const r of requests) {
      if (/^(blob|data|about|chrome-extension):/.test(r.url)) continue;
      assert.ok(r.url.startsWith(server.origin), `外部への要求がない：${r.url}`);
      assert.ok(r.method === 'GET', `${r.method} ${r.url}`);
    }
    assert.equal(await page.evaluate(() => window.__lap.violations.length), 0, 'CSP の違反がない');
    assert.deepEqual(app.errors, []);

    // CSP が実際に外部への接続を止める（保険の確認）
    const blocked = await page.evaluate(async () => {
      try { await fetch('http://example.invalid/collect', { method: 'POST', body: 'x' }); return 'sent'; } catch (e) { return 'blocked'; }
    });
    assert.equal(blocked, 'blocked');
    await waitUntil(() => page.evaluate(() => window.__lap.violations.some((v) => v.directive.startsWith('connect-src'))), { what: 'CSP の違反の報告' });
    await page.close();
  });

  test('オフライン（サーバーを止める）：台本を開く、録音、保存、復旧の手順まで動く', async () => {
    await server.close(); // 機内モードと同じ：これ以後、サーバーには届かない
    await chrome.context.setOffline(true);
    const offlineRequests = [];
    const app = await openApp(chrome, `http://127.0.0.1:${server.port}`, '?devinput=1&countdown=0&durableMs=500', { requests: offlineRequests });
    const page = app.page;
    assert.equal(await page.title(), 'lap-narrator');
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'Service Worker から配られている');
    // 前に保存した台本と録音が、そのまま見える
    const projects = await app.page.evaluate(() => window.__lap.projects());
    assert.ok(projects.some((p) => p.projectId === projectId));
    assert.ok((await app.sessions()).some((s) => s.sessionId === sessionId));
    // 新しい台本を（貼り付けで）開く
    const script2 = makeScript({ slides: 2, projectId: 'proj-offl002' });
    await page.evaluate(() => { document.querySelector('details.paste').open = true; });
    await page.fill('#paste-json', JSON.stringify(script2));
    await page.click('#btn-paste');
    await waitUntil(async () => /保存しました/.test(await page.textContent('#open-msg')), { what: '台本を開いたメッセージ' });
    // 新しい録音：録音、OK、一時停止（保存）
    const id2 = await app.newSession('proj-offl002');
    await app.press('record');
    await app.feed(makePcm(RATE * 2, { seed: 71 }), { speed: 8 });
    await app.press('ok');
    await app.press('pause');
    const st = await app.state();
    assert.equal(st.rawFiles[0].samples, RATE * 2);
    assert.equal(st.checkpoints.length, 1);
    // 前のセッションを開き直せる
    await app.press('pause').catch(() => {});
    const reopened = await app.openSession(sessionId);
    assert.equal(reopened.recovery, null);
    assert.ok((await app.state()).rawFiles.length >= 2);
    assert.equal(id2.length, 12);
    assert.deepEqual(offlineRequests.filter((r) => !r.url.startsWith(`http://127.0.0.1:${server.port}`) && !/^(blob|data|about):/.test(r.url)), []);
    assert.deepEqual(app.errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)), []);
    await chrome.context.setOffline(false);
  });
});
