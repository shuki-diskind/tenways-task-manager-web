// Minimal service worker: network-first with cache fallback for the app
// shell only. Supabase API/auth/realtime/attachment requests are left
// completely alone (their URLs are outside this worker's scope path).
var CACHE = 'tenways-tasks-1.11.21';
var BASE = self.registration.scope; // .../webapp/ - only app files live here
var SHELL = [
  'index.html', 'styles.css?v=1.11.21', 'config.js?v=1.11.21', 'manifest.webmanifest?v=1.11.21',
  'js/client.js?v=1.11.21', 'js/app.js?v=1.11.21', 'js/auth.js?v=1.11.21', 'vendor/supabase.js?v=1.11.21',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  // Only handle GETs for the app's own files; everything else (Supabase
  // data, auth, realtime, attachments) goes straight to the network.
  if (e.request.method !== 'GET' || e.request.url.indexOf(BASE) !== 0) return;
  // The page itself is always fetched fresh (bypassing the HTTP cache), so a
  // new deploy is picked up on the next launch instead of lingering for the
  // lifetime of the cache header.
  var isDoc = e.request.mode === 'navigate' || e.request.destination === 'document';
  if (isDoc) {
    e.respondWith(
      fetch(e.request.url, { cache: 'reload', credentials: 'same-origin' })
        .then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return resp;
        })
        .catch(function () {
          return caches.match(e.request).then(function (m) {
            return m || caches.match(BASE + 'index.html');
          });
        })
    );
    return;
  }
  e.respondWith(
    fetch(e.request).then(function (resp) {
      var copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (m) {
        return m || caches.match(BASE + 'index.html');
      });
    })
  );
});
