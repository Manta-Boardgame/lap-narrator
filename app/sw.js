// Service Worker：初回の読み込みのあとは、機内モードでも、台本を開く・録音・復旧・ZIP の保存までできるようにする。
// 自分のオリジンの GET だけを扱う。外部へは何も取りに行かない（CSP でも接続先は自分のオリジンだけ）。
//
// 更新の手順：app/ か core/ のファイルを変えたら、VERSION を変える。ファイルを足したら PRECACHE を更新する
// （node test/app/helpers/update-precache.js。test/app/offline.test.js が過不足を確かめる）。

const VERSION = 'v2-2026-11-18a';
const CACHE = `lap-narrator-${VERSION}`;

// PRECACHE-BEGIN
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './prompts/video-prompt.md',
  './src/ai-prompt-ui.js',
  './src/ai-prompt.js',
  './src/app.js',
  './src/backend.js',
  './src/build-info.js',
  './src/capture.js',
  './src/config.js',
  './src/dev-api.js',
  './src/devsource.js',
  './src/events-io.js',
  './src/export-ui.js',
  './src/export.js',
  './src/main.js',
  './src/opfs.js',
  './src/player.js',
  './src/posmap.js',
  './src/script-pack.js',
  './src/session.js',
  './src/strings.js',
  './src/tracker.js',
  './src/ui.js',
  './src/util.js',
  './src/worker/recorder-worker.js',
  './src/worklet/capture-processor.js',
  '../core/boundaries.js',
  '../core/constants.js',
  '../core/importer.js',
  '../core/index.js',
  '../core/json.js',
  '../core/loudness.js',
  '../core/reduce.js',
  '../core/render/tables.js',
  '../core/render.js',
  '../core/schemas.js',
  '../core/script.js',
  '../core/sha256.js',
  '../core/timeline.js',
  '../core/types.js',
  '../core/validate.js',
  '../core/wav.js',
  '../core/zip.js',
];
// PRECACHE-END

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // HTTP キャッシュを通さず、いま配られている版を取る
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('lap-narrator-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(answer(req));
});

async function answer(req) {
  const cache = await caches.open(CACHE);
  // ?devinput=1 などの問い合わせ部分は無視して、同じファイルとして扱う
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw e;
  }
}
