// Duum PWA Service Worker (DEV MODE)
// Goal: ALWAYS show the latest deployed version while you're iterating.
// - Network-first for navigations (HTML)
// - Minimal caching for offline fallback
// - Immediate activation + cache cleanup

const VERSION = "2026-02-06-03"; // bump this anytime you want to force clients to refresh
const CACHE_NAME = `duum-dev-${VERSION}`;

// Keep this small. It's only for offline fallback.
const OFFLINE_FALLBACK_URL = "/index.html";
const SHELL_ASSETS = [
  "/",               // treat as entry
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL_ASSETS);
    })()
  );
  // Activate immediately (don’t wait for old SW to “let go”)
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete older duum-dev caches
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("duum-dev-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      // Take control immediately
      await self.clients.claim();
    })()
  );
});

// Optional: allow the page to tell SW to skip waiting (belt + suspenders)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 1) For navigations (loading pages), ALWAYS go network-first.
  // This is what fixes "old version until refresh".
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          // no-store helps defeat intermediary caching
          return await fetch(req, { cache: "no-store" });
        } catch (err) {
          // Offline fallback
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(OFFLINE_FALLBACK_URL)) || Response.error();
        }
      })()
    );
    return;
  }

  // 2) For other GET requests (icons/manifest/etc), try cache first, then network.
  // Keep it simple in DEV.
  if (req.method === "GET") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;

        try {
          const res = await fetch(req);
          const url = new URL(req.url);

          // Only cache same-origin assets (avoid caching API calls)
          if (url.origin === self.location.origin) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, res.clone());
          }
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })()
    );
  }
});
