// 録音アプリのページを開き、window.__lap を呼ぶ補助。
import { toBase64 } from './fixtures.js';

export async function openApp(chrome, origin, query = '?devinput=1&countdown=0', { requests } = {}) {
  const page = await chrome.context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  if (requests) page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), type: r.resourceType() }));
  // 画面の既定は英語。これらの試験は日本語の文言を確かめるので、lang の指定が無ければ日本語で開く
  const q = /[?&]lang=/.test(query) ? query : `${query}${query.includes("?") ? "&" : "?"}lang=ja`;
  await page.goto(`${origin}/app/index.html${q}`);
  await page.waitForFunction(() => window.__lap, null, { timeout: 15000 });
  const lap = {
    page,
    errors,
    loadScript: (script) => page.evaluate((s) => window.__lap.loadScript(s), script),
    newSession: (projectId, opts) => page.evaluate(([p, o]) => window.__lap.newSession(p, o), [projectId, opts]),
    openSession: (id) => page.evaluate((i) => window.__lap.openSession(i), id),
    press: (name, arg) => page.evaluate(([n, a]) => window.__lap.press(n, a), [name, arg]),
    state: () => page.evaluate(() => window.__lap.state()),
    events: () => page.evaluate(() => window.__lap.events()),
    durable: () => page.evaluate(() => window.__lap.durable()),
    feed: (i16, opts) => page.evaluate(([b, o]) => window.__lap.feed(b, o), [toBase64(i16), opts || {}]),
    readRaw: async (name) => Buffer.from(await page.evaluate((n) => window.__lap.readRawBase64(n), name), 'base64'),
    rawSizesOnDisk: (id) => page.evaluate((i) => window.__lap.rawSizesOnDisk(i), id),
    eventsOnDisk: (id) => page.evaluate((i) => window.__lap.eventsOnDisk(i), id),
    sessions: () => page.evaluate(() => window.__lap.sessions()),
  };
  return lap;
}
