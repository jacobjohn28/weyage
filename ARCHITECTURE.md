# Weyage — Architecture & Solution Design

> **Purpose of this document:** complete context for a new Claude Code session.
> Read this before touching `index.html`. It covers the mental model, data
> schema, rendering pipeline, key design decisions, and the common gotchas that
> have already burned us once.

---

## 1. What Weyage Is

A **private, two-person trip planner** for France (May 28 – June 14 2026) across
five towns: Paris → Annecy → Nice → Aix-en-Provence → Fontainebleau.

Key constraints that shape every technical decision:

| Constraint | Why it matters |
|---|---|
| **Single HTML file** (`index.html`) | No build step, no npm, no bundler. Everything — HTML, CSS, JS — lives in one file (~4 600 lines). |
| **No backend** | Firebase handles persistence and auth. No server to deploy or maintain. |
| **Two users only** | Access is controlled by a hard-coded email allowlist. No multi-tenancy, no roles. |
| **Offline-capable** | Service worker + Firestore's IndexedDB persistence mean it works on the plane. |
| **Mobile-first** | Both travelers use it on their phones. Every UI decision defaults to mobile. |

---

## 2. File Map

```
Weyage/
├── index.html       ← The entire application (~4 600 lines)
├── manifest.json    ← PWA manifest (name, icons, theme colour)
├── sw.js            ← Service worker (cache-first shell, network-first Firebase)
├── .nojekyll        ← Empty file — tells GitHub Pages to skip Jekyll processing
├── SETUP.md         ← One-time Firebase project setup walkthrough
├── ARCHITECTURE.md  ← This file
└── HANDOFF.md       ← Session-by-session implementation notes (historical)
```

### `index.html` internal structure

The file is divided into three major blocks, in order:

```
<head>
  <style>          ← All CSS (~1 700 lines). Design tokens at the top,
                     component styles below. No external CSS framework.

<body>
  App shell HTML   ← Static DOM: auth screen, sidebar, nav, view containers,
                     modals, drawer, AI panel overlay. (~700 lines)

  <script type="module">
    Constants       ← FIREBASE_CONFIG, GEMINI_CONFIG, ALLOWED_EMAILS,
                       TRIP_ID, TRIP_SEED, TOWN_SEEDS
    State store     ← state object + setState/subscribe/notify
    Firebase init   ← dynamic ESM imports from gstatic CDN
    Auth            ← Google sign-in, allowlist gate, showApp/showAuthScreen
    Seeding         ← seedTripIfNeeded — writes trip + towns on first login
    Listeners       ← listenToTrip — three onSnapshot subscriptions
    Utilities       ← date formatters, escapeHtml, localDateStr, etc.
    Renderers       ← one function per view (renderDashboard*, renderItinerary,
                       renderBudget, renderFood, renderDocuments)
    CRUD            ← saveSpot, removeSpot, toggleSpotVisited, saveAccommodation
    Modal           ← openModal / closeModal / applyTransportToggle
    Drawer          ← openDrawer / closeDrawer
    Attachments     ← compressImage, addAttachment, toggleAttachmentPin, deleteAttachment
    Budget          ← aggregateBudget, renderBudget, Chart.js integration
    AI              ← buildRecommendationContext, callGeminiRecommendations,
                       renderRecommendationCards, openRecommendationsPanel
    init()          ← Boot sequence
    PWA             ← service worker registration
```

---

## 3. Firebase Architecture

### Services used

| Service | Purpose |
|---|---|
| **Firebase Auth** | Google Sign-In. Only the two allowlisted emails can get past the gate. |
| **Firestore** | All trip data — real-time sync, offline persistence via IndexedDB. |
| ~~Storage~~ | *Originally scoped; not used. Attachments are stored as base64 in Firestore instead (see §8).* |

### Loading strategy — dynamic ESM imports

Firebase is **not** bundled. It is loaded at runtime from Google's CDN:

```js
const FIREBASE_VERSION = "10.13.2";
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
```

`initFirebase()` does four sequential `import()` calls (app → auth → firestore →
persistence), then assigns the destructured exports to **module-level `let`
variables** (`doc`, `updateDoc`, `setDoc`, `deleteDoc`, `collection`, `getDocs`,
`onSnapshot`, `writeBatch`, `serverTimestamp`, etc.).

**Why module-level `let`?** Every other function in the file references these
names directly — no `window.*` prefix, no passing them as arguments. They start
as `undefined` and are only valid after `initFirebase()` resolves, which happens
before `listenToTrip()` or any CRUD call.

### Firestore data model

```
trips/{TRIP_ID}                        ← Single document for the whole trip
  name, startDate, endDate, currency
  tags[]                               ← Shared tag vocabulary
  paymentMethods[]
  categories[]
  totalBudget                          ← User-set budget target (EUR)
  geminiApiKey                         ← Gemini API key (stored here, never in source)

trips/{TRIP_ID}/towns/{townId}         ← One doc per city (5 total)
  name, country, lat, lng, order
  arrivalDate, departureDate           ← "YYYY-MM-DD" strings
  wikipediaArticle                     ← Used to fetch hero image from Wikipedia API
  customImage                          ← Optional override URL for hero image
  accommodation                        ← Embedded object (NOT a subcollection):
    { name, address, checkIn, checkOut,
      confirmationCode, price, priceEstimated, booked,
      notes, bookingUrl }

trips/{TRIP_ID}/spots/{spotId}         ← One doc per spot/activity (unlimited)
  id, name, type, townId
  scheduledDate                        ← "YYYY-MM-DD" or null (wishlist)
  scheduledTime                        ← "HH:MM" 24h or null
  order                                ← Integer, for manual sort within a day
  neighborhood, notes, bookingUrl
  tags[]                               ← Subset of trip.tags
  visited, visitedAt
  cost, costPaid, paymentMethod, isEstimated, category
  booked
  groupId                              ← Links two adjacent spots (chain icon)
  attachments[]                        ← Array of base64 objects:
    { id, name, type, data, size, pin, addedAt }
  expenses[]                           ← Legacy, replaced by cost fields
  createdAt, updatedAt                 ← serverTimestamp()

  ── Transport-specific fields ──
  transportSubtype                     ← "flight" | "train" | "ferry" | "car" | "bus"
  arrivalTownId                        ← Destination town ID
  arrivalDate, arrivalTime             ← Arrival side of the journey
```

**Key design choice — accommodation on the town doc:** Accommodation is stored as
an embedded object on each town document, not as a spot. This keeps it city-scoped
and avoids it appearing in the spots list. It is written with:
```js
await updateDoc(townRef, { accommodation: { ... } });
```

**Key design choice — transport dual-rendering:** A transport spot belongs to
its *departure* town (`townId`). `getSpotsForTown()` also projects it into the
*arrival* town's timeline as a read-only in-memory copy:
```js
{ ...spot, _arrivalView: true,
  scheduledDate: spot.arrivalDate,
  scheduledTime: spot.arrivalTime }
```
The `_arrivalView` flag is never written to Firestore — it only exists in memory
to suppress drag handles and show an "arrival" badge in `transportCardHTML()`.

---

## 4. State Management

```js
const state = {
  user: null,          // Firebase User object
  trip: null,          // trips/{TRIP_ID} document data
  towns: [],           // trips/{TRIP_ID}/towns/* — sorted by town.order
  spots: [],           // trips/{TRIP_ID}/spots/* — unsorted raw list
  currentView: "itinerary",
  focusTownId: null,   // deprecated — use pendingScrollTownId instead
  theme: "light",
  online: navigator.onLine,
};

const setState = (patch) => { Object.assign(state, patch); notify(); };
```

`setState` does a **shallow merge** and then calls all registered listeners.
Every renderer subscribes once during `showApp()`:

```js
subscribe(() => {
  renderSidebarTowns();
  switch (state.currentView) {
    case "itinerary":  renderItinerary(); break;
    case "overview":   renderDashboard(); break;
    // ...
  }
});
```

So **any** `setState` call re-renders the current view. This is intentional and
fine at this data scale. Don't introduce async rendering optimisations without
understanding all the places that call `setState`.

### `pendingScrollTownId` — module-level, NOT in state

When the user clicks a town in the sidebar, the app needs to scroll to that town
in the itinerary after the next render. Storing this in `state` would cause an
infinite loop: `setState` → render → `setState({ focusTownId: null })` → render
again before the scroll fires.

**Fix:** use a plain module-level variable:
```js
let pendingScrollTownId = null;
```
`renderItinerary()` reads it, clears it immediately (no `setState`), then fires
the scroll inside a double `requestAnimationFrame` to let the DOM settle:
```js
const townId = pendingScrollTownId;
pendingScrollTownId = null;
requestAnimationFrame(() => requestAnimationFrame(() => {
  // scroll .main to the town element
}));
```

---

## 5. Boot Sequence

```
init()
  └─ initTheme()               reads localStorage "theme"
  └─ isConfigured()            checks FIREBASE_CONFIG fields are filled
  └─ initFirebase()            dynamic ESM imports, enableIndexedDbPersistence
  └─ onAuthStateChanged()
       ├─ no user → showAuthScreen()
       ├─ email not allowed → signOut + showAuthScreen()
       └─ allowed user →
            setState({ user })
            setupUserChip()
            seedTripIfNeeded()   ← writes trip + towns if they don't exist
            listenToTrip()       ← attaches three onSnapshot listeners
            showApp()            ← hides auth screen, shows app shell
                                    subscribes renderer to state changes
                                    triggers first render
```

`seedTripIfNeeded()` uses `getDoc` + `setDoc` to write `TRIP_SEED` and
`TOWN_SEEDS` only on the very first sign-in. Subsequent logins skip it.

---

## 6. Rendering Pipeline

All rendering is **full re-render on state change** — no virtual DOM, no diffing.
Each view has one top-level renderer that rebuilds `innerHTML` from scratch.

### View routing

`setView(viewName)` sets `state.currentView` and shows/hides the relevant
`<div id="view-*">` containers. The subscriber then calls the right renderer.

Views: `overview` | `itinerary` | `food` | `budget` | `documents`

### `renderItinerary()` — the most complex renderer

1. Groups spots by `scheduledDate` per town using `getSpotsForTown(townId)`
2. Sorts spots within each day by `scheduledTime` then `order`
3. Builds HTML string: town header → accom card → day rows → wishlist row
4. Sets `container.innerHTML`
5. Attaches all event listeners (accom card, add buttons, ✨ AI buttons, spot cards, SortableJS)
6. Initialises SortableJS drag with `group: "spots"` for cross-day/cross-town drag
7. Fires `pendingScrollTownId` scroll if set

**Important:** SortableJS instances are stored in `sortableInstances[]` and
destroyed before each re-render to prevent memory leaks and double-binding.

### Date handling — `localDateStr(d)`

**Never use `d.toISOString().slice(0, 10)` for local dates.** `toISOString()`
outputs UTC — in UTC+ timezones this subtracts a day. Always use:
```js
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
```
`getDaysForTown(town)` uses this to generate the list of `YYYY-MM-DD` keys for
a town's date range. The range is **inclusive on both ends** (`d <= end`), so
the departure date appears in both the departing and arriving town's timeline.

---

## 7. Key UI Components

### Spot modal (`openModal`)

Opens for both **create** (no `spot` argument) and **edit** (passes existing spot).
Internal state is held in module-level variables:
```js
let modalEditId = null;      // null = create, string = edit
let selectedType = "sight";
let selectedTags = new Set();
let visitedState = false;
let priceEstimatedState = true;
let bookedState = false;
```

**Critical ordering in `openModal`:** `applyTransportToggle(type)` **must** be
called *after* `renderTagsGrid()`. If called before, `renderTagsGrid()` overwrites
the display:none that `applyTransportToggle` set on `tags-field`. This was a
hard-to-find bug — keep the order.

### Transport fields

`applyTransportToggle(type)` shows/hides the transport-specific field group and
the standard spot fields. It also populates the arrival-town `<select>` from
`state.towns`, excluding the current departure town.

### Spot drawer (`openDrawer`)

Read-only detail panel. Shows adjacent-spot navigation buttons (↑ prev / ↓ next)
based on spots scheduled on the same day, sorted by time then order. Editing
opens the modal from the drawer.

### Accommodation card (`renderAccomCard`)

Pinned above the day rows for each town. Clicking opens `openAccomModal(town)`.
If no accommodation is set, shows an "+ Add accommodation" link instead.

### Day header ✨ button

Rendered in each day group header during `renderItinerary()`. Click handler:
```js
container.querySelectorAll(".day-ai-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    openRecommendationsPanel(btn.dataset.townId, btn.dataset.date);
  });
});
```

---

## 8. Attachments

Attachments are stored as **base64 strings in Firestore**, not in Firebase
Storage. This was chosen for simplicity (no Storage CORS setup, no separate
bucket rules), but has a hard constraint:

- **Firestore document limit: 1 MB**
- Each spot document holds all its attachments in an `attachments[]` array
- Images are compressed before storage via `compressImage()` (canvas resize to
  1600px max, quality 0.82)
- PDFs are stored raw — large PDFs will exceed the 1 MB limit and fail silently

`renderDocuments()` aggregates all attachments across all spots, groups them by
town/spot, and renders them with a pin toggle (pinned items appear first).

---

## 9. Budget

`aggregateBudget()` collects cost entries from two sources:
1. `spot.cost` fields on all spots (with `spot.category`, `spot.paymentMethod`, etc.)
2. `town.accommodation.price` for each town

`renderBudget()` shows:
- An editable total budget target (written to `trips/{TRIP_ID}.totalBudget`)
- Two stacked progress bars: planned spend vs target, paid spend vs target
- A Chart.js horizontal bar chart (`budgetChartInstance`) breaking down by category

Chart.js 4.4.0 is loaded from CDN via a `<script>` tag in the HTML body. The
chart instance is destroyed and recreated on each render to avoid canvas reuse errors.

---

## 10. AI Recommendations (Phase 8)

### API

**Google Gemini** via REST (`generativelanguage.googleapis.com/v1beta`).

Model: `gemini-2.0-flash-lite` (set in `GEMINI_CONFIG.model`).

**Regional note:** The Gemini API free tier is not available in the EU/EEA. You
will get `limit: 0` errors regardless of which model or key you use. Fix: enable
billing on the Google Cloud project (costs ~$0.0001 per call at this token scale).

### Key storage (security)

The API key is **never stored in source code**. Flow:

1. `GEMINI_CONFIG.apiKey` starts as `""` in the source
2. On trip `onSnapshot`, if `data.geminiApiKey` exists:
   `GEMINI_CONFIG.apiKey = data.geminiApiKey`
3. First ✨ click with no key → `showKeyEntryForm()` renders a password input
   inside the AI panel
4. On save → `updateDoc(tripRef, { geminiApiKey: key })` → Firestore syncs to
   both users via `onSnapshot` → `GEMINI_CONFIG.apiKey` updated on both devices

The gear ⚙ icon in the AI panel header lets either user update the key at any time.

### Recommendation flow

```
openRecommendationsPanel(townId, date)
  ├─ if no apiKey → showKeyEntryForm(callback)
  └─ fetchAndRenderRecommendations(townId, date)
       ├─ buildRecommendationContext(townId, date)
       │    └─ assembles: town, date, tripDay, townDay, totalTownDays,
       │         energyLevel, dayPlanSummary, lastSpotName, alreadyPlanned[]
       ├─ callGeminiRecommendations(ctx)
       │    └─ sends a single user message with full context + JSON schema
       │         in the prompt body (no function calling — better compatibility)
       │         response_mime_type: "application/json" for structured output
       │    └─ parses JSON from response text (strips ```json fences if present)
       └─ renderRecommendationCards(result, townId, date)
            └─ renders spot cards with type colour dot, reason, logistics, tags
            └─ "Add to [day]" button calls saveSpot() with pre-filled data
                 (reason + logistics + notes packed into spot.notes field)
```

**Why not function calling?** Gemini function calling (`tool_config`) has
inconsistent support across model versions and free-tier regions. Using a plain
JSON prompt with `response_mime_type: "application/json"` is more compatible and
produces the same structured output.

---

## 11. PWA

`manifest.json` — name, short_name, icons (placeholder), theme/background colour,
`display: standalone`, `start_url: "."`.

`sw.js` — two-strategy service worker:
- **Cache-first** for the app shell (`/`, `index.html`, `manifest.json`,
  `sw.js`): serves from cache immediately, updates cache in background
- **Network-first** for Firebase and Google API calls: tries network, falls back
  to cache if offline

Registration in `index.html`:
```js
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
```

**GitHub Pages note:** `.nojekyll` must be present at the repo root. Without it,
GitHub Pages runs Jekyll, which mangles the service worker path and causes a 404.

---

## 12. Theme System

CSS custom properties (`--bg`, `--surface`, `--text-1`, `--accent`, etc.) are
defined in `:root` for light mode and overridden in `[data-theme="dark"]` on
`<body>`. `initTheme()` reads `localStorage("theme")` or falls back to
`prefers-color-scheme`. `applyTheme(theme)` sets the body attribute and saves
to localStorage.

Design language: warm off-whites (`#FBFBFA`), editorial type (Fraunces serif for
display, Inter for UI), minimal chrome, generous whitespace.

---

## 13. Wikipedia Hero Images

`fetchWikipediaImage(article)` calls the Wikipedia REST API to get the page
thumbnail for each town. Results are cached in localStorage under `trip-wiki-img-cache`
to avoid repeated fetches. The `inflightFetches` Map de-duplicates concurrent
requests for the same article. Town documents can override the image with
`customImage` (a direct URL).

---

## 14. Common Gotchas

| Gotcha | Detail |
|---|---|
| **Date timezone** | Never `toISOString().slice(0,10)` for local dates. Use `localDateStr(d)`. |
| **`applyTransportToggle` order** | Must run *after* `renderTagsGrid()`, or the tags field reappears. |
| **`pendingScrollTownId`** | Module-level variable, NOT in state. Putting it in state causes re-render loops. |
| **Firebase imports** | All Firestore functions (`doc`, `updateDoc`, etc.) are module-level `let` variables filled by `initFirebase()`. They are `undefined` before that resolves. |
| **Accommodation ref** | Uses `doc(db, "trips", TRIP_ID, "towns", townId)` — NOT `spotDocRef()`. Stored on the town document, not in spots. |
| **Transport dual-render** | `_arrivalView: true` is an in-memory flag only. Never write it to Firestore. |
| **SortableJS cleanup** | Instances must be destroyed before re-render. Stored in `sortableInstances[]`. |
| **Chart.js reuse** | Destroy `budgetChartInstance` before creating a new one, or the canvas throws. |
| **Attachments 1 MB cap** | Firestore document limit. PDFs can exceed it silently. Warn users to keep files small. |
| **Gemini EU free tier** | `limit: 0` for all models in EU/EEA. Must enable billing. Not a code issue. |
| **GitHub Pages Jekyll** | `.nojekyll` file must exist at repo root. Without it, Pages breaks the service worker. |
| **`body.appendChild(element)`** | Don't store references to DOM nodes that will be removed by `innerHTML = ""`. Recreate them inline instead (this was the AI panel loading spinner bug). |

---

## 15. Making Common Changes

### Add a new spot field

1. Add the input to the modal HTML (inside `<div id="spot-modal-overlay">`)
2. Read it in `openModal`'s save handler → pass to `saveSpot(data)`
3. Display it in `spotCardHTML()` and/or `openDrawer()`
4. If it affects budget, update `aggregateBudget()`

### Add a new town

Update `TOWN_SEEDS` in the constants block. `seedTripIfNeeded()` only runs if the
trip document doesn't exist — to re-seed, delete the Firestore trip document first
(data loss warning) or manually write the new town document in the Firestore console.

### Change the Gemini model

Edit `GEMINI_CONFIG.model` (around line 2344). The model must support
`response_mime_type: "application/json"` — all Gemini 1.5+ and 2.0 models do.

### Add a new view

1. Add a `<div id="view-newname" class="view">` in the HTML body
2. Add a nav button wired to `setView("newname")`
3. Add `case "newname": renderNewView(); break;` in the subscriber switch
4. Write `renderNewView()` as a function in the script block

---

## 16. Deployment

The app is hosted on **GitHub Pages** from the `main` branch, root folder.
Push `index.html` (and `manifest.json`, `sw.js`, `.nojekyll`) to main.
Pages deploys automatically. No CI, no build step.

URL pattern: `https://<username>.github.io/<repo-name>/`

For local testing: open `index.html` directly in a browser, or use any static
server (`python3 -m http.server`). Firebase Auth allows `localhost` by default.
