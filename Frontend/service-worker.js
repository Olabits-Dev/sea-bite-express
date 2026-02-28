const CACHE_NAME = "seabite-frontend-cache-v200"; // bump when you want to force reset cache

const CORE_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "manifest.json"
];

// script.js will be handled separately (network-first)
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response("Offline", { status: 503 });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  // ✅ Network-first for script.js so updates apply quickly
  if (url.pathname.endsWith("/script.js") || url.pathname.endsWith("script.js")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // ✅ Cache-first for core offline assets
  if (
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/style.css") ||
    url.pathname.endsWith("/manifest.json")
  ) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Default: cache-first
  event.respondWith(cacheFirst(event.request));
});