/* OnSite app-shell service worker — offline v1 (doc-80 §8). Precaches the static shell so /app OPENS
 * in a basement. Strategy (documented choice): NETWORK-FIRST for navigations with cache fallback, and a
 * waiting-SW "ny versjon — last på nytt" hint (no skipWaiting on install — the app offers the reload).
 * The Supabase API is NEVER cached here — data honesty lives in the outbox/read-cache (offline.js), not
 * in HTTP caching. No Background Sync API dependency (iOS): draining is foreground (open/online/visible).
 * Same-origin only — the strict CSP is untouched (worker-src falls back to script-src 'self'). */
var CACHE = "onsite-app-v20";   // bump WITH the asset versions in index.html — old caches are purged on activate
var SHELL = [
  "./",
  "app.css?v=9",
  "offline.js?v=5",
  "app.js?v=20",
  "boot.mjs?v=3",
  "core.bundle.js?v=3",
  "vendor/supabase-js.min.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  // NO skipWaiting — the new version waits; the app shows the quiet hint and the user chooses the reload.
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("onsite-app-") === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;                       // writes go through supabase-js, never cached
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Supabase API/storage: straight to network, always
  if (req.mode === "navigate") {
    // network-first HTML: fresh when online, the cached shell in the basement
    e.respondWith(fetch(req).then(function (r) {
      var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put("./", copy); });
      return r;
    }).catch(function () { return caches.match("./"); }));
    return;
  }
  // static shell assets: cache-first (they are content-addressed by ?v=N), network fallback + backfill
  e.respondWith(caches.match(req, { ignoreSearch: false }).then(function (hit) {
    return hit || fetch(req).then(function (r) {
      if (r && r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return r;
    });
  }));
});
