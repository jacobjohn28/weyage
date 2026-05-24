# Weyage — Trip Companion: Claude Code Handoff (v2)

## Project Overview

A personal trip planner for two travelers (private, invite-only). Single HTML file hosted on GitHub Pages, backed by Firebase (Auth + Firestore). Built for France, May 28 – June 14, 2026 across 5 towns: Paris, Annecy, Nice, Aix-en-Provence, Fontainebleau.

**Live file:** `index.html` in the GitHub repo  
**Hosted at:** GitHub Pages (public repo, data protected by Firestore rules)  
**Firebase project:** `weyage-ed0cb`  
**Allowed user:** `jacobjohn28@gmail.com` (second traveler added to `ALLOWED_EMAILS` + Firestore rules when ready)

---

## Phase Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, Firebase auth, dashboard with editorial town spreads | ✅ Complete |
| 2 | Spots, itinerary view, detail drawer, SortableJS drag | ✅ Complete |
| 3 | UX improvements, new spot types, food view, dashboard widgets | ⬅ **Next** |
| 4 | Budget view, price/booking on spots, linked spots | Planned |
| 5 | Attachments, documents view | Planned |
| 6 | Offline polish, service worker, PWA manifest | Planned |
| 7 | Map view (Leaflet) | Optional — deprioritised |
| 8 | AI spot recommendations (Claude API) | Optional — deprioritised |

---

## Architecture (unchanged from v1)

### Stack

```
Browser (GitHub Pages)
  └── index.html (single file, ~54KB after Phase 2)
        ├── CSS — design tokens, layout, dark mode, responsive
        ├── HTML — boot, auth, app shell, view containers
        └── <script type="module">
              ├── Firebase SDK (dynamic sequential imports from gstatic CDN)
              ├── State store (reactive object + subscriber set)
              ├── Theme system + localStorage
              ├── View router
              ├── Firestore listeners (onSnapshot → setState)
              ├── Wikipedia image fetcher + localStorage cache
              └── Renderers (one per view)
```

### CDN dependencies

```html
<!-- Loaded: -->
Firebase 10.13.2         gstatic.com (dynamic imports)
Fraunces + Inter         fonts.googleapis.com
SortableJS 1.15.0        cdn.jsdelivr.net  ← added in Phase 2

<!-- Add in Phase 4: -->
Chart.js 4.4.0           cdn.jsdelivr.net

<!-- Add in Phase 7 (optional): -->
Leaflet 1.9.4            unpkg.com
```

### Design tokens (CSS custom properties)

```css
--bg, --surface, --surface-2, --border, --border-strong
--text, --text-2, --text-3
--accent: #C2553D (light) / #E67E4D (dark)   /* terracotta */
--success (sage), --warning (amber), --danger
--tint-sight: cool blue
--tint-food: warm amber
--tint-experience: sage green
--tint-transport: #6B7DB3   /* steel blue — NEW in Phase 3 */
--font-display: 'Fraunces'  /* serif, display headings, captions */
--font-body: 'Inter'        /* all UI text */
--radius-sm: 6px / --radius: 10px / --radius-lg: 16px / --radius-xl: 24px
```

### State store

```js
const state = {
  user,          // Firebase Auth user
  trip,          // /trips/{tripId} doc
  towns,         // sorted array from towns subcollection
  spots,         // array from spots subcollection
  currentView,   // active view name
  focusTownId,   // NEW Phase 3: set by dashboard click, consumed by itinerary render
  theme,
  online,
};
```

### Firestore schema (complete, all phases)

```
/trips/{tripId}
  name, startDate, endDate, currency: "EUR"
  allowedUsers: [emails]
  tags: ["Must-Try", "UNESCO", "Hidden Gem", "Local Favorite", "Splurge", "Reservation"]
  paymentMethods: ["Card", "Cash", "Revolut"]
  categories: ["Food", "Sights", "Transport", "Lodging", "Shopping", "Other"]

/trips/{tripId}/towns/{townId}
  name, country, arrivalDate, departureDate
  lat, lng, order
  caption, tagline, wikipediaArticle, customImage   ← editorial, seed-managed
  accommodation: {                                  ← NEW Phase 3, stored on town doc
    name, address, checkIn, checkOut,
    bookingRef, price, notes, booked
  }

/trips/{tripId}/spots/{spotId}
  townId
  type: "sight" | "restaurant" | "cafe" | "experience" | "transport"   ← transport NEW Phase 3
  subtype: "train" | "plane" | "ferry" | "bus"    ← transport only
  name, neighborhood, address, lat, lng
  tags[]
  scheduledDate, scheduledTime, durationMinutes
  order                                            ← integer, position within day
  groupId                                          ← NEW Phase 4, UUID shared by linked spots
  notes, visited (bool), visitedAt, rating
  price                                            ← NEW Phase 4, EUR number
  priceEstimated (bool)                            ← NEW Phase 4, true = expected, false = actual
  booked (bool)                                    ← NEW Phase 4, confirmed reservation
  bookingRef                                       ← NEW Phase 4, confirmation number
  confirmation: { bookingUrl, contact }
  expenses[]: { id, amount, category, paymentMethod, note, date }  ← incidentals only, not per-spot cost
  attachments[]: { id, type, name, mimeType, size, data, addedAt } ← Phase 5, base64

  Transport-specific extra fields:
    from, to, carrier, departureTime, arrivalTime, seat
    arrivalTownId    ← destination town ID; spot also appears in that town's timeline
    arrivalDate      ← optional ISO date, defaults to scheduledDate (covers overnight travel)
```

---

## Phase 3 — UX Improvements + New Types + Food + Dashboard

### 3a. Day placeholders (implement first — structural)

This changes how the itinerary renders. Currently spots are grouped by date. Day placeholders generate the day rows from the town's date range regardless of whether spots exist.

**Day generation:**
```js
function getDaysForTown(town) {
  const days = [];
  const start = new Date(town.arrivalDate + "T00:00:00");
  const end   = new Date(town.departureDate + "T00:00:00");
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10)); // "YYYY-MM-DD"
  }
  return days;
}
```

**Itinerary render structure (revised):**
```
Town section  [id="itinerary-town-{townId}"]
  Accommodation card (if set)        ← pinned at top
  Day: Thu 28 May
    Spot card (draggable)
    Spot card (draggable)
    [+ Add spot]  ← inline button, pre-fills townId + date
  Day: Fri 29 May
    [Drop here or + Add]             ← empty day placeholder
  Day: Sat 30 May
    ...
  Wishlist (unscheduled spots)       ← spots with no scheduledDate
    Spot card
    [+ Add to wishlist]
```

**Empty day placeholder HTML:**
```html
<div class="day-empty" data-date="2026-05-29" data-town="paris">
  <span>Drop a spot here</span>
  <button class="add-spot-inline">+ Add</button>
</div>
```

**SortableJS cross-day drag setup:**
```js
// One Sortable instance per day container
const sortables = [];
document.querySelectorAll('.day-spot-list').forEach(el => {
  sortables.push(Sortable.create(el, {
    group: 'spots',              // same group = cross-list drag enabled
    animation: 150,
    delay: 150,
    delayOnTouchOnly: true,
    handle: '.drag-handle',
    ghostClass: 'spot-ghost',
    onEnd(evt) {
      const spotId = evt.item.dataset.spotId;
      const newDate = evt.to.dataset.date;        // target day container's date
      const newTownId = evt.to.dataset.townId;
      handleSpotDrop(spotId, newDate, newTownId, evt.newIndex);
    }
  }));
});

async function handleSpotDrop(spotId, newDate, newTownId, newIndex) {
  const spot = state.spots.find(s => s.id === spotId);
  const batch = writeBatch(db);

  // If spot is in a group, move all group members to same date
  const toMove = spot.groupId
    ? state.spots.filter(s => s.groupId === spot.groupId)
    : [spot];

  toMove.forEach((s, i) => {
    batch.update(doc(db, "trips", TRIP_ID, "spots", s.id), {
      scheduledDate: newDate,
      townId: newTownId,
      order: newIndex + i,
    });
  });

  // Re-index remaining spots in affected days to keep order clean
  await batch.commit();
}
```

### 3b. Contextual "+" buttons

Remove the global top-right "Add Spot" button. Replace with contextual entry points:

- **Town header "+"** → opens add modal with `townId` pre-filled, date unset (goes to Wishlist)
- **Day row "+"** → opens add modal with `townId` + `scheduledDate` pre-filled
- **Wishlist "+"** → opens add modal with `townId` pre-filled, date unset

```js
// Pass pre-fills into modal opener
function openAddModal({ townId = null, scheduledDate = null, type = null } = {}) {
  // Pre-populate form fields
  // Lock town selector if townId provided
  // Constrain date picker to town's arrivalDate–departureDate range if townId known
  modalEl.querySelector('[name=townId]').value = townId || '';
  modalEl.querySelector('[name=scheduledDate]').value = scheduledDate || '';
  if (type) modalEl.querySelector('[name=type]').value = type;
  showModal();
}
```

Date picker constraint (prevent scheduling a spot on a day outside that town's stay):
```js
const town = state.towns.find(t => t.id === townId);
if (town) {
  dateInput.min = town.arrivalDate;
  dateInput.max = subtractOneDay(town.departureDate); // last night = day before checkout
}
```

### 3c. Dashboard → itinerary navigation

Make each town spread card clickable. On click:

```js
townCard.addEventListener('click', () => {
  setState({ focusTownId: town.id });
  setView('itinerary');
});
```

In `renderItinerary()`, after DOM is written:
```js
if (state.focusTownId) {
  const target = document.getElementById(`itinerary-town-${state.focusTownId}`);
  if (target) {
    // Offset for sticky topbar (~60px)
    const topOffset = target.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: topOffset, behavior: 'smooth' });
  }
  setState({ focusTownId: null });
}
```

Add `cursor: pointer` and a subtle hover lift (`transform: translateY(-2px)`) to `.spread` cards.

### 3d. New spot type: Transport

Add `"transport"` to the type enum. A transport spot is stored **once** under the departure town (`townId`) but rendered in **both** the departure town and the arrival town's itinerary timelines, showing different information in each context.

**Data model choice: single spot, dual rendering (Option A)**
The spot document lives under `townId` = departure town. A new `arrivalTownId` field identifies the destination. The itinerary renderer includes the spot in both towns but renders it in two distinct modes: `departure-view` and `arrival-view`. No duplication, no sync risk, no orphan spots.

**New fields (transport only):**
```
arrivalTownId    ← ID of the destination town
arrivalDate      ← ISO date of arrival; defaults to scheduledDate if not set (covers overnight)
```

**New design token:**
```css
--tint-transport: #6B7DB3;  /* steel blue — distinct from sight/food/experience */
```

**Subtype icons:**
```js
const TRANSPORT_ICONS = {
  train: '🚂', plane: '✈️', ferry: '⛴️', bus: '🚌'
};
```

**Transport-specific form fields** (shown only when type = "transport"):
- Subtype: Train / Plane / Ferry / Bus
- From (departure station/airport/stop name)
- To (arrival station/airport/stop name)
- Departure town: pre-filled from `townId`, not editable in form
- Arrival town: dropdown of other towns — sets `arrivalTownId`
- Departure time (`scheduledTime`)
- Arrival time (`arrivalTime`)
- Arrival date (`arrivalDate`, shown only when could differ from departure date)
- Carrier (e.g. "SNCF", "EasyJet")
- Seat / Coach
- Booking reference

**Itinerary renderer — include transport in both towns:**
```js
function getSpotsForTown(townId) {
  return state.spots.filter(s =>
    s.townId === townId ||
    (s.type === 'transport' && s.arrivalTownId === townId)
  );
}
```

When sorting spots within a day for a given town:
- If `spot.townId === townId` → sort by `scheduledTime` (departure time)
- If `spot.arrivalTownId === townId` → sort by `arrivalTime` (arrival context)

```js
function getEffectiveTime(spot, townId) {
  if (spot.type === 'transport' && spot.arrivalTownId === townId) {
    return spot.arrivalTime || '23:59';  // arrival context → use arrivalTime
  }
  return spot.scheduledTime || '00:00'; // departure context → use scheduledTime
}
```

**Card rendering — two distinct visual modes:**

Departure-view (shown in departure town — draggable, fully editable):
```
[🚂] Paris → Annecy                         SNCF TGV 6201
     Departs 09:42  ·  arrives 12:10         Coach 7, Seat 24
     ≈ 2h 28m
```

Arrival-view (shown in arrival town — non-draggable, read-only, opens same drawer):
```
[🚂] Arriving from Paris                    SNCF TGV 6201
     Arrives 12:10                           Coach 7, Seat 24
     ← Paris 09:42
```

**CSS differentiation for arrival-view cards:**
```css
.spot-card.arrival-view {
  opacity: 0.75;
  border-left-color: var(--tint-transport);
  border-left-style: dashed;   /* dashed = not the "home" town */
  cursor: default;
}
.spot-card.arrival-view .drag-handle { display: none; }
```

**Drag behaviour:** Arrival-view cards have `data-draggable="false"`. The SortableJS `filter` option prevents dragging them:
```js
Sortable.create(dayList, {
  filter: '[data-draggable="false"]',
  onMove: evt => !evt.related.dataset.draggable === 'false',
  // ...rest of options
});
```

**Detail drawer:** Tapping either the departure-view or arrival-view card opens the **same** detail drawer for that spot. The drawer shows all transport fields and allows editing (saving always writes to the single Firestore document under `townId`).

**Duration auto-calculation:**
```js
// Run when either departureTime or arrivalTime changes in the form
function calcDuration(departureTime, arrivalTime, departureDate, arrivalDate) {
  if (!departureTime || !arrivalTime) return null;
  const depDate = departureDate || new Date().toISOString().slice(0, 10);
  const arrDate = arrivalDate || depDate;
  const dep = new Date(`${depDate}T${departureTime}`);
  const arr = new Date(`${arrDate}T${arrivalTime}`);
  return Math.round((arr - dep) / 60000); // minutes
}
```

**Budget:** Transport spots use `spot.price` + `spot.booked` like all other types. Budget category mapping:
```js
function getBudgetCategory(spot) {
  if (spot.type === 'transport') return 'Transport';
  if (spot.type === 'restaurant' || spot.type === 'cafe') return 'Food';
  if (spot.type === 'sight' || spot.type === 'experience') return 'Sights';
  return 'Other';
}
```

**Arrival-view in "Next Up" widget:** Exclude arrival-view projections from the dashboard "Next Up" widget. Next Up should only surface departure-context transport (the action is departing, not arriving):
```js
const upcoming = state.spots.filter(s =>
  s.scheduledDate >= today && !s.visited
  // transport spots appear once under their departure town only
);
```

### 3e. Accommodation (city-level, not day-level)

Accommodation is stored directly on the **town document** (not in the spots collection). It's displayed as a pinned card at the top of the town section in the itinerary.

**Town doc `accommodation` field:**
```js
accommodation: {
  name: "Hôtel du Louvre",
  address: "Place André Malraux, 75001 Paris",
  checkIn: "2026-05-28",         // ISO date
  checkInTime: "15:00",
  checkOut: "2026-06-01",
  checkOutTime: "11:00",
  bookingRef: "BK-123456",
  price: 480,                    // EUR, total for the stay
  booked: true,
  notes: "Breakfast included",
  bookingUrl: ""
}
```

**Accommodation card in itinerary (pinned above day rows):**
```
[🏨] Hôtel du Louvre                             ✓ Booked  €480
     28 May 15:00 check-in · 1 Jun 11:00 check-out
     BK-123456
```

**Edit accommodation:** tapping the accommodation card opens a dedicated modal (not the spot modal). Save writes to `town.accommodation` via `updateDoc`.

**Add accommodation button:** "Add accommodation" link in the town header when `accommodation` is not set.

### 3f. Food view

Filter of the spots collection — no new data model needed.

```js
function renderFoodView() {
  const foodTypes = ['restaurant', 'cafe'];
  const foodSpots = state.spots.filter(s => foodTypes.includes(s.type));

  // Group: Scheduled (have scheduledDate) vs Wishlist (no date)
  // Within scheduled: group by town → by date
  // Within wishlist: group by town → by neighborhood
}
```

**Food view sections per town:**
- Scheduled meals (sorted by date/time)
- Wishlist (unscheduled, sorted by neighborhood)

Quick-add from food view pre-sets type to `"restaurant"`.

### 3g. Dashboard widgets (replace Phase 1 placeholders)

Replace the four stat cells and add live widgets:

```
┌──────────────────────────────────────────────────────┐
│  bon voyage en / France   [hero unchanged]            │
├──────────────────────────────────────────────────────┤
│  5 days to go  ·  17 days  ·  23 spots  ·  —        │
│  [progress bar: 0/23 visited]                        │
├──────────────────────────────────────────────────────┤
│  NEXT UP                                              │
│  [Today's spots or next scheduled spot card]         │
├──────────────────────────────────────────────────────┤
│  [town spread cards — clickable → itinerary nav]     │
└──────────────────────────────────────────────────────┘
```

**Next Up logic:**
```js
function getNextSpot() {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = state.spots
    .filter(s => s.scheduledDate >= today && !s.visited)
    .sort((a, b) => {
      if (a.scheduledDate !== b.scheduledDate) return a.scheduledDate.localeCompare(b.scheduledDate);
      return (a.scheduledTime || '').localeCompare(b.scheduledTime || '');
    });
  return upcoming[0] || null;
}
```

---

## Phase 4 — Budget + Booking Integration + Linked Spots

### 4a. Price and booking status on spots

Add to the spot add/edit modal:

```
Price (€): [_______]   ☐ Estimated   ☑ Booked
Booking ref: [_______]
Booking URL: [_______]
```

**Field semantics:**
- `price` (number): what you paid or expect to pay
- `priceEstimated: true` = not yet paid, just an estimate → shows as "planned" in budget
- `priceEstimated: false` = actual amount paid → shows as "actual" in budget
- `booked: true` = reservation confirmed (can be true even if priceEstimated is true, e.g. free entry booked in advance)

**Show on spot card:** small `€ 48` badge in the card corner. Outlined when estimated, filled/solid when actual.

**Accommodation price** follows the same `booked` / `priceEstimated` pattern — stored in `town.accommodation`.

### 4b. Budget view aggregation

Budget pulls from two sources:
1. **Spot prices** — `state.spots` where `price` is set
2. **Town accommodation prices** — `state.towns` where `accommodation.price` is set
3. **Manual expenses** — `spot.expenses[]` for incidentals not tied to a specific spot's cost

```js
function aggregateBudget() {
  const entries = [];

  // Spot prices
  state.spots.forEach(s => {
    if (s.price) entries.push({
      source: 'spot', spotId: s.id, townId: s.townId,
      name: s.name, type: s.type,
      amount: s.price,
      isEstimated: s.priceEstimated ?? false,
      isBooked: s.booked ?? false,
    });
    // Manual incidental expenses on spots
    (s.expenses || []).forEach(e => entries.push({
      source: 'expense', spotId: s.id, townId: s.townId,
      name: e.note || s.name, type: 'other',
      amount: e.amount,
      isEstimated: false, isBooked: true,
      paymentMethod: e.paymentMethod,
    }));
  });

  // Accommodation
  state.towns.forEach(t => {
    if (t.accommodation?.price) entries.push({
      source: 'accommodation', townId: t.id,
      name: t.accommodation.name || 'Accommodation',
      type: 'accommodation',
      amount: t.accommodation.price,
      isEstimated: t.accommodation.priceEstimated ?? false,
      isBooked: t.accommodation.booked ?? false,
    });
  });

  return entries;
}

function getBudgetSummary() {
  const entries = aggregateBudget();
  return {
    totalActual: entries.filter(e => !e.isEstimated).reduce((s, e) => s + e.amount, 0),
    totalPlanned: entries.reduce((s, e) => s + e.amount, 0),
    byType: groupBy(entries, 'type'),
    byTown: groupBy(entries, 'townId'),
  };
}
```

**Budget view layout:**
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

```
Total:  €1,240 actual  /  €1,840 planned
[━━━━━━━━━━━━━━━━░░░░░░░░░░░]  67% committed

By category (horizontal bar chart):
  Lodging      ████████████  €840
  Food         ████          €280
  Transport    ███           €210
  Sights       █             €80
  Other        ░             €30

By town (table):
  Paris         €640
  Annecy        €320
  ...

Unbooked (estimated):
  [list of spots with priceEstimated=true]
```

### 4c. Linked spots (groupId)

**Linking via detail drawer:**
- "Link to spot…" action button in drawer footer
- Dropdown lists other spots in same town (or same day as priority)
- On link: both spots get the same new `groupId = crypto.randomUUID()`
- Subsequent links to the same spot share the same `groupId` (it's a shared key, not a pair)
- "Unlink" removes `groupId` from that spot only (others in group keep their link)

**Visual treatment:**
- Linked spots get a subtle connecting indicator: a thin vertical line on the left between adjacent linked spots, same colour as the tint
- A small chain icon (🔗) in the top-right of the card
- Linked spots are always sorted to be adjacent (by `groupId` then within-group `order`)

**Drag behavior** (SortableJS `onEnd` handler — extends 3a):
```js
async function handleSpotDrop(spotId, newDate, newTownId, newIndex) {
  const spot = state.spots.find(s => s.id === spotId);
  const batch = writeBatch(db);

  const toMove = spot.groupId
    ? state.spots
        .filter(s => s.groupId === spot.groupId)
        .sort((a, b) => a.order - b.order)
    : [spot];

  toMove.forEach((s, i) => {
    batch.update(doc(db, 'trips', TRIP_ID, 'spots', s.id), {
      scheduledDate: newDate,
      townId: newTownId,
      order: newIndex + i,
    });
  });
  await batch.commit();
}
```

---

## Phase 5 — Attachments & Documents

### Attachments (base64 in Firestore)

Stored in `spot.attachments[]`. Client-side image compression before save:

```js
async function compressImage(file, maxDim = 1600, quality = 0.8) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = img.width  * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = URL.createObjectURL(file);
  });
}
```

Firestore 1MB document limit: warn if attachment > 900KB after compression. Show storage usage indicator.

**Attachment types in detail drawer:**
- Image upload (QR codes, ticket photos, confirmation screenshots)
- Booking reference number (text, already on spot as `bookingRef`)
- URL link (opens in new tab)

### Documents view

Consolidated view of all attachments:
- Grouped by town → spot
- "Pin" toggle: pinned docs show first (useful at airports)
- Full-screen tap to view image
- Pinned docs stored as `attachment.pinned: true`

---

## Phase 6 — Offline & PWA

**Service worker** (add `sw.js` alongside `index.html`):
```js
// Cache-first for shell; network-first for Firestore data (SDK handles it)
const CACHE = 'weyage-v1';
const SHELL = ['/', '/index.html', /* CDN URLs */];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))));
self.addEventListener('fetch', e => e.respondWith(
  caches.match(e.request).then(hit => hit || fetch(e.request))
));
```

**PWA manifest** (`manifest.json`):
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

**Sync status wiring** (UI already exists from Phase 1, needs JS):
```js
// Detect Firestore pending writes via network events
window.addEventListener('online',  () => setStatus('synced'));
window.addEventListener('offline', () => setStatus('offline'));
// For queued writes: hook into Firestore's hasPendingWrites metadata
onSnapshot(doc(db, 'trips', TRIP_ID), { includeMetadataChanges: true }, snap => {
  if (snap.metadata.hasPendingWrites) setStatus('syncing');
  else if (navigator.onLine) setStatus('synced');
});
```

---

## Phase 7 — Map View (Optional, Deprioritised)

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

- Leaflet map with OpenStreetMap tiles
- Markers by type (colour matches CSS tint tokens)
- Filter bar: by town, by type, by tag
- Cluster markers when zoomed out
- Tapping a marker opens the spot's detail drawer
- "Pre-cache tiles" button: loads zoom 12–16 tiles for each town's bounding box before travel

---

## Phase 8 — AI Spot Recommendations (Optional)

### Approach

Use the Anthropic Messages API with web search tool. API key stored in `ANTHROPIC_CONFIG` block alongside `FIREBASE_CONFIG` in `index.html`.

```js
const ANTHROPIC_CONFIG = {
  apiKey: "REPLACE_ME_ANTHROPIC_KEY",
};
```

### Trigger

"Suggest spots" button in each town's itinerary header. Opens a recommendations drawer.

### API call

```js
async function fetchRecommendations(town, existingSpots) {
  const existing = existingSpots
    .filter(s => s.townId === town.id)
    .map(s => `${s.name} (${s.type})`)
    .join(', ');

  const prompt = `I'm planning a trip to ${town.name}, France from ${town.arrivalDate} to ${town.departureDate}.
I already have these spots planned: ${existing || 'none yet'}.
Suggest 5 additional spots (restaurants, sights, experiences, cafés) that complement what I have.
Focus on authentic local experiences, cultural highlights, and notable food.
Respond ONLY with a valid JSON array, no preamble, no markdown:
[{"name":"...","type":"restaurant|cafe|sight|experience","neighborhood":"...","tags":["..."],"rationale":"..."}]`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_CONFIG.apiKey,
                'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}
```

### Recommendations drawer UI

- List of 5 cards: name, type icon, neighborhood, rationale
- Each card: "Add to [Town]" button → creates spot with `name`, `type`, `tags`, `notes` (rationale) pre-filled, `scheduledDate` unset (goes to Wishlist)
- "Refresh" button to get a new set
- Disclaimer: "AI suggestions — verify details before visiting"

---

## Critical Implementation Notes

**Transport spots appear in two towns — write to one.** `getSpotsForTown(townId)` must filter on `s.townId === townId || (s.type === 'transport' && s.arrivalTownId === townId)`. All Firestore writes for a transport spot go to the single document under `townId` (departure town). Never write to or create a second document in the arrival town.

**Arrival-view cards are non-draggable.** Set `data-draggable="false"` on arrival-view cards and use SortableJS `filter: '[data-draggable="false"]'` to exclude them from drag interactions. They should still be tappable (open detail drawer).

**Arrival-view sort key is `arrivalTime`, not `scheduledTime`.** Use `getEffectiveTime(spot, townId)` when building the sorted day list — departure context uses `scheduledTime`, arrival context uses `arrivalTime`.

**Overnight transport:** When `arrivalDate` differs from `scheduledDate` (e.g. a night train), the arrival-view card appears on `arrivalDate` in the arrival town's timeline, not `scheduledDate`. Handle this in `getSpotsForTown` by checking the effective date per context.

**Next Up widget excludes arrival-view.** Filter only on `spot.scheduledDate` (departure date), never on `arrivalDate`. This prevents the same journey showing twice in the dashboard widget.

**Spot type enum (Phase 3 final):**
```js
const SPOT_TYPES = [
  { value: 'sight',       label: 'Sight',       tint: '--tint-sight'      },
  { value: 'restaurant',  label: 'Restaurant',  tint: '--tint-food'       },
  { value: 'cafe',        label: 'Café',         tint: '--tint-food'       },
  { value: 'experience',  label: 'Experience',  tint: '--tint-experience' },
  { value: 'transport',   label: 'Transport',   tint: '--tint-transport'  },
];
```

**Accommodation is NOT a spot.** It lives on the town doc (`town.accommodation`). Do not add it to the spots collection. Update via `updateDoc(townRef, { accommodation: {...} })`.

**Day placeholder containers need data attributes for SortableJS:**
```html
<div class="day-spot-list" data-date="2026-05-29" data-town-id="paris">
```

**Firestore batch limit:** 500 ops. Drag reorder only writes spots where `order` actually changed (diff before/after arrays).

**Cross-town drag:** When a spot is dragged to a different town's day, update both `townId` and `scheduledDate`. Validate that the new date falls within the destination town's stay.

**Linked spots display order:** After fetching spots, sort by:
1. `scheduledDate` ascending
2. Within same date: group spots by `groupId` so linked spots are adjacent
3. Within same groupId: sort by `order`
4. Within same date, unlinked: sort by `scheduledTime` then `order`

**Never use `localStorage` for Firestore data.** `localStorage` is only for: theme preference (`trip-theme`), Wikipedia image URL cache (`trip-wiki-img-cache`).

**ID generation:** `crypto.randomUUID()` for all new spots, groupIds, attachment ids.

**SortableJS settings (established in Phase 2, keep consistent):**
```js
{ group: 'spots', animation: 150, delay: 150, delayOnTouchOnly: true, handle: '.drag-handle' }
```

**Mobile bottom sheet (detail drawer) — Phase 2 established pattern:**
- `position: fixed; bottom: 0; left: 0; right: 0`
- `border-radius: var(--radius-xl) var(--radius-xl) 0 0`
- `transform: translateY(100%) → translateY(0)` at 300ms ease-out
- `overscroll-behavior: contain` on scroll container

**Firestore security rules** — update `isAllowed()` in both Firestore and Storage rules when second traveler email is added:
```
function isAllowed() {
  return request.auth != null && request.auth.token.email in [
    'jacobjohn28@gmail.com',
    'second.traveler@gmail.com'  // add when ready
  ];
}
```

---

## File Structure (updated for Phase 3+)

```
<head>
  <style>
    /* 1. Design tokens */
    /* 2. Reset & base */
    /* 3. Boot + Auth screens */
    /* 4. App shell (sidebar, topbar, bottom-nav) */
    /* 5. Dashboard (hero, spreads, stats-band, widgets) */
    /* 6. Itinerary (town sections, day rows, day-empty, spot cards) */
    /* 7. Food view */
    /* 8. Budget view + chart containers */
    /* 9. Documents view */
    /* 10. Detail drawer + accommodation modal */
    /* 11. Add/edit spot modal */
    /* 12. AI recommendations drawer */
    /* 13. Responsive @media max-width: 768px */
  </style>
</head>

<body>
  #boot-screen
  #auth-screen
  #app
    .sidebar
      [nav items: Dashboard / Itinerary / Food / Budget / Documents]
      [town list in sidebar]
      [status indicator + user chip]
    .main
      .topbar
      .content
        #view-dashboard    ← Phase 1 + Phase 3 widgets
        #view-itinerary    ← Phase 2 + Phase 3 day placeholders + new types
        #view-food         ← Phase 3
        #view-budget       ← Phase 4
        #view-documents    ← Phase 5
        #view-map          ← Phase 7 (optional)
      .bottom-nav

  <!-- Overlays (outside #app, position: fixed) -->
  #detail-drawer          ← Phase 2
  #add-spot-modal         ← Phase 2 + Phase 3 transport fields
  #accommodation-modal    ← Phase 3
  #recommendations-drawer ← Phase 8 (optional)

  <link> Google Fonts
  <script src="SortableJS CDN">          ← Phase 2
  <script src="Chart.js CDN">            ← Phase 4
  <script src="Leaflet CDN">             ← Phase 7 (optional)

  <script type="module">
    // Config: FIREBASE_CONFIG, ALLOWED_EMAILS, ANTHROPIC_CONFIG (Phase 8)
    // Constants: TRIP_ID, TRIP_SEED, TOWN_SEEDS, SPOT_TYPES
    // State store
    // Theme + online/offline
    // View router (with focusTownId scroll)
    // Firebase init
    // Auth flow
    // Wikipedia image fetcher
    // Firestore seed + backfill (incl. transport tint token)
    // Firestore listeners
    // Budget aggregation helpers
    // Renderers: dashboard, itinerary, food, budget, documents
    // Modal handlers: add/edit spot, accommodation
    // Drag handlers (SortableJS onEnd with groupId logic)
    // AI recommendations (Phase 8)
    // init()
    // init().catch(err => showAuthScreen(err))
  </script>
</body>
```
