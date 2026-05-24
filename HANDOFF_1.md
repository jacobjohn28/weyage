# Weyage — Trip Companion: Claude Code Handoff

## Project Overview

A personal trip planner for two travelers (private, invite-only). Single HTML file hosted on GitHub Pages, backed by Firebase (Auth + Firestore). Built for France, May 28 – June 14, 2026 across 5 towns: Paris, Annecy, Nice, Aix-en-Provence, Fontainebleau.

**Live file:** `index.html` in the GitHub repo  
**Hosted at:** GitHub Pages (public repo, data protected by Firestore rules)  
**Firebase project:** `weyage-ed0cb`  
**Allowed user:** `jacobjohn28@gmail.com` (second traveler to be added to `ALLOWED_EMAILS` array + Firestore/Storage rules)

---

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Single HTML file + Firebase | Portable, no build step, easy to update via GitHub |
| Hosting | GitHub Pages (public repo) | Free HTTPS; data secured by Firestore rules not repo visibility |
| Auth | Firebase Google sign-in + email allowlist | Real auth, no passwords, enforced server-side by Firestore rules |
| Database | Firestore with offline persistence (IndexedDB) | Real-time sync, offline-first, generous free tier |
| File storage | Deferred — Firebase Storage requires Blaze (paid) | Phase 4 will use base64 in Firestore docs with client-side compression |
| Images | Wikipedia REST API (`/api/rest_v1/page/summary/{article}`) | Reliable, CORS-enabled, canonical lead images; results cached in `localStorage` |
| Custom image override | `customImage` field in seed/Firestore | Aix-en-Provence uses a specific Wikimedia Commons URL |
| Drag-and-drop | SortableJS via CDN | Touch support, lightweight, handles mobile well |
| Maps | Leaflet + OpenStreetMap | Free, no API key required |
| Charts | Chart.js via CDN | Budget visualisation |
| Currency | Single currency, EUR | One trip, one destination currency; no conversion needed |
| Budget | Actual spend tracked; planned amount is optional | Keeps data entry light |
| Offline | Firestore offline persistence + future service worker | Phase 5 adds service worker + map tile pre-caching |
| Dark mode | Supported; auto-detects system preference, manual override persists in `localStorage` | Both travelers use mobile; dark mode important |

---

## Technical Architecture

### Stack

```
Browser (GitHub Pages)
  └── index.html (single file, ~54KB)
        ├── CSS (design tokens, layout, components, dark mode, responsive)
        ├── HTML (boot screen, auth screen, app shell, view containers)
        └── <script type="module">
              ├── Firebase SDK (dynamic imports from gstatic CDN)
              │     ├── firebase-app.js
              │     ├── firebase-auth.js
              │     └── firebase-firestore.js
              ├── State store (reactive object + subscriber set)
              ├── Theme system (CSS tokens + localStorage)
              ├── View router (setView, nav item active states)
              ├── Firestore listeners (onSnapshot → setState)
              ├── Wikipedia image fetcher (REST API + localStorage cache)
              └── Renderers (one per view)
```

### Firebase Firestore Schema

```
/trips/{tripId}
  name, startDate, endDate, currency: "EUR"
  allowedUsers: [emails]
  tags: ["Must-Try", "UNESCO", "Hidden Gem", "Local Favorite", "Splurge", "Reservation"]
  paymentMethods: ["Card", "Cash", "Revolut"]
  categories: ["Food", "Sights", "Transport", "Lodging", "Shopping", "Other"]

/trips/{tripId}/towns/{townId}
  name, country, arrivalDate, departureDate
  lat, lng, order (for sort)
  caption, tagline (editorial copy, managed by seed)
  wikipediaArticle (Wikipedia REST API article title)
  customImage (optional direct URL, overrides Wikipedia)

/trips/{tripId}/spots/{spotId}          ← Phase 2+
  townId, type: "sight"|"restaurant"|"cafe"|"experience"
  name, neighborhood, address, lat, lng
  tags[], scheduledDate, scheduledTime, durationMinutes
  order (integer, for drag-reorder within day)
  notes, visited (bool), visitedAt, rating
  confirmation: { number, bookingUrl, contact }
  expenses[]: { id, amount, plannedAmount?, category, paymentMethod, note, date }
  attachments[]: { id, type, name, mimeType, size, data (base64), addedAt }  ← Phase 4
```

### Seeding & Migration Pattern

`seedTripIfNeeded()` runs on every sign-in:
- **First run:** creates trip doc + all 5 town docs from `TOWN_SEEDS`
- **Subsequent runs (backfill):** updates seed-managed editorial fields (`caption`, `tagline`, `wikipediaArticle`, `customImage`) on existing docs; never overwrites user data

`TOWN_SEEDS` in the HTML file is the source of truth for editorial copy. Changing it and redeploying propagates on next sign-in.

### Image Resolution Order (per town, at render time)

```
1. t.customImage        → hardcoded URL (e.g. Aix lavender Wikimedia URL)
2. imgCache[article]    → resolved Wikipedia URL cached in localStorage
3. ""                   → show gradient fallback, trigger async Wikipedia fetch
                          → on success: inject <img> into DOM, cache URL
```

Cache key: `"trip-wiki-img-cache"` in `localStorage`. Clear it to force fresh Wikipedia lookups.

### State Store

```js
const state = {
  user,       // Firebase Auth user object
  trip,       // /trips/{tripId} document
  towns,      // sorted array from towns subcollection
  spots,      // array from spots subcollection
  currentView,
  theme,
  online,
};
```

Reactive: `subscribe(fn)` registers a listener called on every `setState(patch)`. Renderers subscribe and re-render on state changes.

### Design Tokens (CSS Custom Properties)

```css
/* Light / Dark mode aware */
--bg, --surface, --surface-2
--border, --border-strong
--text, --text-2, --text-3
--accent: #C2553D (light) / #E67E4D (dark)   /* muted terracotta */
--accent-soft, --accent-bg
--success: sage green
--warning: amber
--tint-sight: cool blue
--tint-food: warm amber
--tint-experience: sage green

/* Typography */
--font-display: 'Fraunces' (serif, used for titles, captions, chapter marks)
--font-body: 'Inter' (sans, used for all UI text)

/* Spacing / Shape */
--radius-sm: 6px  --radius: 10px  --radius-lg: 16px  --radius-xl: 24px
--shadow-sm, --shadow-md, --shadow-lg
```

### Layout

**Desktop:** 240px sidebar + 1fr main content  
**Mobile (≤768px):** full-width + sticky bottom nav (5 tabs), safe-area insets

---

## Current State: Phase 1 Complete

**Working now:**
- Firebase init with sequential dynamic imports (fixes `auth has not been registered` error)
- Google sign-in flow with email allowlist gate (client + server-side via Firestore rules)
- Firestore offline persistence via IndexedDB
- Auto-seed of trip + 5 towns on first sign-in; backfill migration on subsequent sign-ins
- Dashboard view: editorial hero (`bon voyage en / France`), magazine-style spreads per town
- Town spreads: vertical city name spine (alternates left/right), wide 5:2 cinematic image, italic caption overlay, date/nights meta row
- Wikipedia image fetching with localStorage cache; `customImage` override for Aix
- Light/dark theme with system detection + manual toggle
- Responsive layout: sidebar → bottom nav on mobile; 4:3 image aspect ratio on mobile
- Connection status indicator
- Placeholder views for all remaining tabs

**CDN dependencies loaded (all via CDN, no npm/build):**
- Firebase 10.13.2 (dynamic imports from `gstatic.com`)
- Fraunces + Inter fonts from Google Fonts

**Not yet loaded (add in relevant phase):**
- SortableJS (Phase 2)
- Leaflet + OpenStreetMap (Phase 3)
- Chart.js (Phase 4)

---

## Phases 2–5: Implementation Plan

### Phase 2 — Spots & Itinerary

**Goal:** Add, edit, and view spots. The core daily planning loop.

**New views:**
- **Itinerary view** — grouped by town → day → draggable time-ordered spot cards
- **Detail drawer** — right slide-in on desktop, bottom sheet on mobile

**Add/edit spot modal fields:**
- Type (sight / restaurant / café / experience) → affects icon and tint color
- Name, neighborhood, address
- Scheduled date + time, duration
- Tags (multi-select from trip-level tag list)
- Notes (free text)
- Visited toggle

**Itinerary card design:**
- Thin left border in type tint color (blue/amber/green)
- Title, time, one row of tag pills
- Drag handle (visible on long-press mobile, visible on hover desktop)
- Tap → opens detail drawer
- Visited state: subtle opacity reduction + checkmark, card stays visible

**Drag-and-drop (SortableJS):**
```html
<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
```
- Reorder within a day: updates `order` field on affected spots (writeBatch)
- Move between days: updates `scheduledDate` + `order`
- Touch delay: `delay: 150` to avoid triggering on scroll

**Detail drawer:**
- Slides in from right (desktop) / slides up from bottom (mobile)
- Sections: Overview, Notes, Expenses (Phase 4), Documents (Phase 4)
- Close on backdrop click or swipe down

**Firestore writes on drag:**
```js
// After reorder, batch update all spots in affected day
const batch = writeBatch(db);
reorderedSpots.forEach((spot, idx) => {
  batch.update(doc(db, "trips", TRIP_ID, "spots", spot.id), { order: idx });
});
await batch.commit();
```

---

### Phase 3 — Map, Food, Dashboard Widgets

**Map view (Leaflet):**
```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```
- Single global map, OpenStreetMap tiles
- Markers colored by type (sight=blue, food=amber, experience=green)
- Tag-based filter bar above map
- Cluster markers when zoomed out (Leaflet.markercluster)
- "Focus on town" button per town in sidebar
- Tile pre-cache button: loads visible tiles at zoom levels 12–16 into browser cache (offline prep)
- Town center markers shown always; spot markers shown when spots exist

**Food view:**
- Same card model as itinerary, filtered to `type: "restaurant" | "cafe"`
- Sections: Scheduled meals (have a date) + Wishlist (no date)
- Group by town; within town, group by neighborhood
- Quick-add from food view (type pre-set to restaurant)

**Dashboard widgets (replace placeholders):**
- Countdown to departure (days remaining, "Bon voyage" on day 0)
- Progress ring: spots visited / spots planned
- Next up: today's scheduled spots (or next scheduled if none today)
- Budget snapshot: spent / planned bar (if any expenses logged)
- Quick links to each town's itinerary day

---

### Phase 4 — Attachments & Budget

**Attachments (base64 in Firestore, no Storage required):**

Per-spot `attachments` subcollection or array. Each document:
```js
{ id, name, mimeType, size, data: "data:image/jpeg;base64,...", addedAt }
```

Client-side compression before save:
```js
async function compressImage(file, maxDim = 1600, quality = 0.8) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.src = URL.createObjectURL(file);
  });
}
```

Firestore 1MB document limit: warn user if attachment > 900KB after compression. Storage usage indicator in settings.

Attachment types in detail drawer: QR codes, ticket screenshots, confirmation PDFs (as images), booking reference numbers (text field).

**Budget view:**
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

Expenses live on each spot (`spot.expenses[]`). Budget view aggregates:
- Trip total: planned (sum of plannedAmount where set) vs. actual (sum of amount)
- By category: horizontal bar chart (Food / Sights / Transport / Lodging / Shopping / Other)
- By payment method: donut chart (Card / Cash / Revolut)
- By town: table with per-town totals
- Per-spot expense list with inline add/edit

All in EUR. `plannedAmount` is optional on each expense entry.

**Documents view:**
- Consolidated list of all attachments across all spots
- Grouped by town, then spot
- "Pin" functionality for airport-critical docs (QR codes, boarding passes)
- Pinned docs shown first, full-screen on tap

---

### Phase 5 — Offline Polish & Service Worker

**Service worker** (`sw.js`, registered from `index.html`):
- Cache-first strategy for the HTML file itself
- Network-first with cache fallback for CDN resources (Firebase SDK, fonts, Leaflet, Chart.js)
- Firestore handles its own offline queue (already enabled via `enableIndexedDbPersistence`)

**Map tile pre-caching:**
- Button in map view: "Cache tiles for offline use"
- Downloads tiles at zoom 12–16 for a bounding box around each town
- Stores in Cache API
- Progress indicator + estimated size warning (~10MB for 5 towns)

**Sync status indicator (already in Phase 1 UI, needs wiring):**
- Green: Firestore connected, all writes synced
- Amber + animation: writes queued (offline), syncing
- Grey: offline, reads from IndexedDB cache

**IndexedDB image cache for attachments:**
- On first load of detail drawer, cache attachment base64 in IndexedDB
- Subsequent opens serve from IndexedDB (no Firestore read)
- Invalidated when attachment is updated

**PWA manifest** (add to `<head>` in index.html):
```html
<link rel="manifest" href="manifest.json">
```
```json
{
  "name": "Weyage · France 2026",
  "short_name": "Weyage",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0F0F10",
  "theme_color": "#0F0F10",
  "icons": [{ "src": "icon-192.png", "sizes": "192x192", "type": "image/png" }]
}
```

---

## Critical Implementation Notes

**Never use `localStorage` for Firestore data.** Firestore's IndexedDB persistence handles offline. `localStorage` is only used for theme preference and Wikipedia image URL cache.

**SortableJS touch handling.** Set `delay: 150, delayOnTouchOnly: true` to prevent drag triggering on scroll. Set `animation: 150` for smooth reorder.

**Firestore security rules** must be kept in sync with `ALLOWED_EMAILS`. When adding the second traveler:
1. Add email to `ALLOWED_EMAILS` in `index.html`
2. Update `isAllowed()` function in Firestore rules
3. Update `isAllowed()` function in Storage rules (when Storage is enabled)

**ID generation for new spots:**
```js
const id = crypto.randomUUID(); // stable, collision-free
```

**Firestore batch limit:** 500 operations per batch. For drag reorder, only write spots that actually changed `order` value (compare before/after).

**Image `onerror` pattern** (already implemented for town images):
```js
img.onerror = () => img.remove(); // removes broken img, fallback stays visible
img.onload = () => img.classList.add("loaded"); // fade-in transition
```

**Fraunces variable font axes** for display headings:
- Use `font-style: italic` for the characteristic soft italic
- Optical size (`opsz`) auto-adjusts at different sizes via the variable font range 9–144

**Bottom sheet on mobile** (detail drawer):
- `position: fixed; bottom: 0; left: 0; right: 0`
- `border-radius: var(--radius-xl) var(--radius-xl) 0 0`
- Drag handle: 32×4px centered pill
- `overscroll-behavior: contain` on the sheet's scroll container
- Animate with `transform: translateY(100%)` → `translateY(0)` at 300ms ease-out

---

## File Structure Reference

All code lives in a single `index.html`. Internal organization:

```
<head>
  meta tags (viewport, theme-color, PWA)
  <style>
    /* 1. Design tokens (:root and [data-theme="dark"]) */
    /* 2. Reset & base */
    /* 3. Boot screen */
    /* 4. Auth screen */
    /* 5. App shell (sidebar, main, topbar, bottom-nav) */
    /* 6. Dashboard (hero, route-essay spreads, stats-band) */
    /* 7. Placeholder views */
    /* 8. [Phase 2+] Spot cards, detail drawer, modal */
    /* 9. [Phase 3+] Map, food view */
    /* 10. [Phase 4+] Budget charts, attachment gallery */
    /* 11. Responsive (@media max-width: 768px) */
  </style>
</head>
<body>
  #boot-screen
  #auth-screen
  #app
    .sidebar (desktop)
    .main
      .topbar
      .content
        #view-dashboard
        #view-itinerary    ← Phase 2
        #view-food         ← Phase 3
        #view-map          ← Phase 3
        #view-budget       ← Phase 4
        #view-documents    ← Phase 4
      .bottom-nav (mobile)

  <link> Google Fonts (loaded after body for performance)

  <script type="module">
    // Firebase SDK version + base URL
    // FIREBASE_CONFIG (filled)
    // ALLOWED_EMAILS (filled)
    // TRIP_ID, TRIP_SEED, TOWN_SEEDS
    // State store
    // Theme system
    // Online/offline detection
    // View router
    // Firebase init (dynamic sequential imports)
    // Auth flow
    // Wikipedia image fetcher + localStorage cache
    // Firestore seed + backfill
    // Firestore listeners
    // Renderers (one function per view)
    // init() entry point
    // init().catch(err => showAuthScreen(err))
  </script>
</body>
```
