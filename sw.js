/* ============================================================
   Weyage Service Worker
   Deployed at: /weyage/ subdirectory on GitHub Pages
   ============================================================ */
const CACHE_NAME = "weyage-v2";

// App shell — adjust if the repo name changes
const SHELL_URLS = [
  "/weyage/",
  "/weyage/index.html",
  "/weyage/manifest.json",
  "/weyage/icon.svg",
];

// CDN assets — cache on first fetch
const CDN_ORIGINS = [
  "https://cdn.jsdelivr.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

// Firebase / live API — always network-first
const NETWORK_FIRST_PREFIXES = [
  "https://www.gstatic.com/firebasejs",
  "https://firestore.googleapis.com",
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://generativelanguage.googleapis.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.protocol === "chrome-extension:") return;

  // Always network-first for Firebase and Gemini
  if (NETWORK_FIRST_PREFIXES.some(p => request.url.startsWith(p))) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // Cache-first for CDN assets
  if (CDN_ORIGINS.some(o => request.url.startsWith(o))) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Cache-first for same-origin shell (index.html, manifest, icon)
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
  }
});
