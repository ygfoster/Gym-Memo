// キャッシュのバージョン名（UIを大きく更新したときは v2, v3 に変更する）
const CACHE_NAME = 'gym-memo-cache-v2';

// オフライン時でも即座に表示するためにキャッシュしておく静的ファイル
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.png',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@500;700&display=swap'
];

// 1. インストール時にアプリの骨組みをスマホ端末に保存
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 2. 古いバージョンのキャッシュを自動クリーンアップ
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. 通信発生時の制御（ネットワークファースト ＋ キャッシュフォールバック）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Google Apps Script (GAS) への通信はキャッシュせず常に最新を取りに行く
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent.com')) {
    return;
  }

  // アプリ本体のファイルは「ネットワーク優先、ダメならキャッシュから一瞬で開く」
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // 取得成功したらキャッシュを最新化
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // オフライン・圏外の時はキャッシュから返す
        return caches.match(event.request);
      })
  );
});
