/* Service worker: caches the app shell so the PWA opens offline.
   Data requests to Supabase are never cached here; the app keeps its own
   last-known copy and an offline queue. Bump VERSION on every release. */
const VERSION = "ft-v2.14.8";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "receipt-parser.js",
  "ocr-worker.js",
  "config.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
];
const CACHEABLE_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // one missing file must not block install
      // CDN files are fetched in CORS mode: the page loads them with integrity=, and an
      // opaque (no-cors) cached copy cannot answer a CORS request.
      .then((cache) => Promise.all(SHELL.map((url) =>
        cache.add(url.startsWith("https://") ? new Request(url, { mode: "cors" }) : url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) return; // Supabase etc: straight to network

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      // App files: network first, so an update shows on the next load; cache only when offline.
      if (sameOrigin) {
        try {
          const res = await fetch(req, { cache: "no-cache" });
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match(req, { ignoreSearch: true }))
            || (req.mode === "navigate" && (await cache.match("index.html")))
            || Response.error();
        }
      }
      // Pinned CDN libraries and fonts: answer from cache, refresh in the background.
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok || res.type === "opaque") cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const res = await network;
      return res || Response.error();
    })
  );
});
