/* ============================================================
   Weyage Service Worker
   Deployed at: /weyage/ subdirectory on GitHub Pages
   ============================================================ */
const CACHE_NAME = "weyage-v3";

// Static assets that rarely change — cache-first
const STATIC_ASSETS = [
  "/weyage/manifest.json",
  "/weyage/icon.svg",
  "/weyage/icon-192.png",
  "/weyage/icon-512.png",
];

// Firebase / live API — always network-first, fall back to cache if offline
const NETWORK_FIRST_PREFIXES = [
  "https://www.gstatic.com/firebasejs",
  "https://firestore.googleapis.com",
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://generativelanguage.googleapis.com",
];

// CDN assets — cache on first fetch (versioned, never change)
const CDN_ORIGINS = [
  "https://cdn.jsdelivr.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
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

  // Network-first for the app shell (index.html) — ensures every deploy is picked up immediately
  if (url.origin === self.location.origin &&
      (url.pathname === "/weyage/" || url.pathname === "/weyage/index.html")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          const cached = await cache.match(request);
          return cached || fetch(request);
        }
      })
    );
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

  // Cache-first for all other same-origin assets (icons, manifest)
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
