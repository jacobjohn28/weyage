/* ============================================================
   Weyage Service Worker
   Deployed at: /weyage/ subdirectory on GitHub Pages
   ============================================================ */
const CACHE_NAME = "weyage-v1.4.0.0";

// Static assets that rarely change — cache-first
const STATIC_ASSETS = [
  "/weyage/",
  "/weyage/index.html",
  "/weyage/styles/main.css",
  "/weyage/js/config.js",
  "/weyage/js/state.js",
  "/weyage/js/theme.js",
  "/weyage/js/utils.js",
  "/weyage/js/firebase.js",
  "/weyage/js/photos.js",
  "/weyage/js/dashboard.js",
  "/weyage/js/guides.js",
  "/weyage/js/documents.js",
  "/weyage/js/disruption.js",
  "/weyage/js/budget.js",
  "/weyage/js/itinerary.js",
  "/weyage/js/share.js",
  "/weyage/js/settings.js",
  "/weyage/js/recommendations.js",
  "/weyage/js/ticketImport.js",
  "/weyage/js/gallery.js",
  "/weyage/js/contacts.js",
  "/weyage/js/ui.js",
  "/weyage/js/main.js",
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
  "https://api.cloudinary.com/v1_1/",
  "https://res.cloudinary.com/",
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

  // Stale-while-revalidate for the app shell (index.html):
  // Serve the cached version immediately so the app appears instantly,
  // then fetch a fresh copy in the background and update the cache.
  // The user gets the new version on their next load.
  if (url.origin === self.location.origin &&
      (url.pathname === "/weyage/" || url.pathname === "/weyage/index.html")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        // Always kick off a background refresh
        const networkFetch = fetch(request).then(async response => {
          if (response.ok) {
            await cache.put(request, response.clone());
            // If we served a cached version, tell the page a fresh one is now ready
            if (cached) {
              const clients = await self.clients.matchAll({ type: "window" });
              clients.forEach(c => c.postMessage({ type: "APP_UPDATED" }));
            }
          }
          return response;
        }).catch(() => null);
        // Return cached instantly if available; wait for network only on first visit
        return cached || networkFetch;
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
