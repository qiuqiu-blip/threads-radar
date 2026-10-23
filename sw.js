// 小球脆雷達：讓網頁可以「安裝到桌面」用。不做快取，永遠拿最新版。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
