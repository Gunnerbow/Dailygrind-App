// DailyGrind service worker.
//
// Goal: the app opens instantly and works fully offline, while still picking
// up new versions pushed to GitHub Pages without the user re-adding anything.
//
// Strategy for the app page itself ("stale-while-revalidate" with a notice):
//   1. Serve the cached copy of the page immediately (or the network copy on
//      the very first visit, when nothing is cached yet).
//   2. In the background, fetch the latest page from the network. If it
//      differs from the cached copy, store it and tell any open app window,
//      which shows an "Update available" banner. Tapping it reloads, and the
//      reload is served the fresh copy from cache.
// Nothing here touches app data: that lives in localStorage, which is
// separate from this cache and is never cleared by updates.
//
// The page also asks for a check whenever it comes back to the foreground
// (see the 'check-update' message), since a home-screen app is often resumed
// rather than freshly loaded.
//
// Bump CACHE_NAME only if the caching scheme itself changes; normal app
// releases do NOT need a new service worker, because update detection
// compares page content, not this file.

var CACHE_NAME = 'dailygrind-cache-v1';
var STATIC_ASSETS = ['manifest.webmanifest', 'icon-180.png'];
var MIN_CHECK_INTERVAL_MS = 60 * 1000;
var lastCheck = 0;

function scopeUrl() {
  return self.registration.scope; // e.g. https://user.github.io/Repo/
}

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all([
        // Page is fetched fresh at install so the cache starts current.
        fetch(scopeUrl(), { cache: 'no-store' }).then(function(res) {
          if (res.ok) return cache.put(scopeUrl(), res);
        }).catch(function() {}),
        Promise.all(STATIC_ASSETS.map(function(a) {
          return cache.add(new URL(a, scopeUrl()).toString()).catch(function() {});
        }))
      ]);
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) {
        return k.indexOf('dailygrind-cache-') === 0 && k !== CACHE_NAME;
      }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

// Fetch the latest page from the network, store it, and notify open windows
// if it changed. Resolves quietly when offline.
function refreshPage(force) {
  var now = Date.now();
  if (!force && now - lastCheck < MIN_CHECK_INTERVAL_MS) return Promise.resolve();
  lastCheck = now;
  return caches.open(CACHE_NAME).then(function(cache) {
    return Promise.all([
      cache.match(scopeUrl()),
      fetch(scopeUrl(), { cache: 'no-store' })
    ]).then(function(results) {
      var cached = results[0], fresh = results[1];
      if (!fresh || !fresh.ok) return;
      return Promise.all([
        cached ? cached.text() : Promise.resolve(null),
        fresh.clone().text()
      ]).then(function(texts) {
        if (texts[0] === texts[1]) return;
        return cache.put(scopeUrl(), fresh).then(function() {
          if (texts[0] === null) return; // first cache fill, nothing to announce
          return self.clients.matchAll({ type: 'window' }).then(function(clients) {
            clients.forEach(function(c) { c.postMessage({ type: 'update-available' }); });
          });
        });
      });
    });
  }).catch(function() {});
}

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(scopeUrl()).then(function(cached) {
          if (cached) {
            event.waitUntil(refreshPage(true));
            return cached;
          }
          return fetch(req).then(function(res) {
            if (res.ok) cache.put(scopeUrl(), res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  // Static assets (manifest, icon): cache first, network fallback.
  event.respondWith(
    caches.match(req).then(function(hit) { return hit || fetch(req); })
  );
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'check-update') {
    event.waitUntil(refreshPage(false));
  }
});
