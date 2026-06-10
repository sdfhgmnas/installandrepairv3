// Service worker — app shell caching with network-first for HTML so updates
// arrive quickly, and stale-while-revalidate for JS/CSS so the app loads
// fast offline. Supabase API calls are never cached (always live).
const VERSION = "v2.5.0";
const SHELL = `gps-tracker-shell-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Skip non-GET and cross-origin API calls.
  if (event.request.method !== "GET") return;
  if (
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("supabase.io") ||
    url.hostname.includes("cdn.jsdelivr.net")
  ) {
    return; // Let the network handle it directly.
  }

  // HTML: network-first, fallback to cache.
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
