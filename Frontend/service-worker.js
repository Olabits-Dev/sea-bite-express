const CACHE_NAME = "seabite-frontend-cache-v20";

const urlsToCache = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.json"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.map((n) => (n !== CACHE_NAME ? caches.delete(n) : null)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  // Only cache same-origin GET requests (static files)
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request).then((resp) => resp || fetch(event.request))
  );
});