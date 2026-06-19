# Weyage UI Review & Consistency Refresh

> **Status:** Phase 2 — Batch A ✅ QA-PASSED (2026-06-19).
> Done + verified: #1 double headers removed; Disruptions renamed; #8 captions
> under image; #9 full icon migration to `js/icons.js`; add-photos `+` tile.
> QA (Chrome MCP, desktop + forced-mobile): all 6 checks PASS, no console errors,
> no data mutated. Broad token migration (#7 scales) DEFERRED to post-Batch-C.
> Caveats: true sub-768px CSS-viewport not exercised (Chrome tab pinned 1440px,
> verified via media-query injection); itinerary pending-spot discard icon N/A
> (no pending spots existed).
>
> **Batch B ✅ QA-PASSED (2026-06-19).** #2 sticky toolbars + #6 topbar action.
> QA (Chrome MCP): all checks PASS both widths — pinned flush under topbar
> (top:69px desktop / 65px mobile, gap 0), topbar Add shows desktop-only on
> Budget/Expenses & proxies correctly, in-view Add inverts on mobile, no
> regressions, only the benign Firestore persistence warning.
>
> **Batch C ✅ QA-PASSED (2026-06-19).** #3 single-source version (all 3 slots read
> v1.4.1.6) + #4 banner wired (show on APP_UPDATED / Refresh reloads / Dismiss
> hides; resolves dead-code bonus B1+B2). QA verified on a fresh build.
> NEXT: #5 nav restructure, then deferred #7 token migration.
>
> **#5 ✅ QA-PASSED (2026-06-19).** Scope-based nav split. QA (Chrome MCP, mobile
> forced + desktop): mobile topbar title opens meta drawer (All trips/Share/Help)
> w/ rotating chevron; More sheet decluttered to trip content + version; desktop
> = plain title + sidebar; outside-click closes; All Trips dropdown unchanged; no
> console errors. NON-BLOCKING: Share "Link copied!" toast unobservable under
> automation (Clipboard API hangs headless) — verify with a real phone tap before
> release. NEXT: only deferred #7 token migration remains.
>
> **QA infra note:** on localhost the service worker + browser HTTP disk cache
> both serve stale JS/CSS. Clearing SW caches is NOT enough — bust the HTTP cache
> too (navigate with a `?nocache=<ts>` query / `cache:'reload'`). Caveat: cache
> clearing wipes the Firebase auth session, so the user must re-sign-in after a
> QA run that clears caches.
> **Contract:** This doc is the source of truth for the refresh. Each issue has a
> recommendation and a ☐ decision box. Frontend (Phase 2) only implements what's
> approved here; QA (Phase 3) verifies against the acceptance checks.
>
> **Constraints (locked):** Stay vanilla (no framework/bundler). Consistency
> comes from CSS design tokens + shared component classes + one icon set.
> Mobile-first. Single `styles/main.css` + `index.html` + ES modules in `js/`.

---

## How to read this

Each item: **Current state** (with file refs from the audit) → **Recommendation**
→ **Decision** (tick one) → **Acceptance check** (what QA verifies).

Batches, ordered by risk:
- **Batch A — pure CSS, zero behavior risk:** #1, #7, #8, #9
- **Batch B — layout behavior:** #2, #6, #5
- **Batch C — JS / navigation / lifecycle:** #3, #4, plus bonus B1/B2

Ship A → QA → B → QA → C → QA.

---

## #1 — Double headers (Expenses, Documents, Disruptions, Gallery)

**Current state.** Every view sets the global topbar title in `js/ui.js:64-65`,
AND four views also render a static `<h1 class="section-title">`:
- Expenses `index.html:472`, Documents `index.html:489`,
  Disruptions `index.html:506` ("Disruption Hub" — also a wording mismatch),
  Gallery `index.html:513`.
The topbar is never hidden on mobile (`styles/main.css:1054`), so both stack.
Itinerary/Overview/Guides/Budget do **not** duplicate → no convention exists.

**Recommendation.** Make the topbar the single page title for all views; delete
the four duplicate `section-title` h1s. Move any action buttons currently next to
those h1s into the sticky toolbar (see #2). Fix "Disruption Hub" → "Disruptions"
(or rename the topbar title to match — your call on wording).

- ☐ A) Keep topbar title, remove the 4 duplicate h1s **(recommended)**
- ☐ B) Keep per-view h1s, hide topbar title on those views
- ☐ C) Other: __________

**Acceptance:** On mobile, each of the 4 views shows exactly one title.

---

## #2 — Filters / Add buttons scroll out of reach

**Current state.** Every top-of-page toolbar scrolls away. Not sticky: Expenses
add+filter/sort (`js/budget.js:1428-1474`), Budget add (`index.html:461`),
Documents search (`index.html:491`), Guides search (`index.html:450`), Gallery
Select (`index.html:512`), per-city Add photos (`js/gallery.js:527`). Only the
*bottom* selection bars are pinned.

**Recommendation.** Introduce a shared `.view-toolbar` component that is
`position:sticky; top:<topbar height>` so filter/sort/add controls stay reachable
while scrolling. Apply to Expenses, Documents, Guides, Gallery.

- ☑ A) Sticky toolbars under the topbar **(LOCKED)**
- ☐ B) Only make the *filter/sort* sticky, leave Add inline
- ☐ C) Other: __________

**Acceptance:** Scroll any list view to the bottom; filter/add controls remain visible.

**Progress (Batch B, code-complete):** `--topbar-h` measured at runtime
(`syncTopbarHeight()` in `js/ui.js`, on resize + each `setView`). Sticky
`top:var(--topbar-h)` applied to `.docs-search-wrap`, `.guides-search-wrap`,
`#view-gallery>.section-header`, `#view-budget>.section-header`, `.exp-controls`
(expenses filter/sort). Expenses Add header relies on `.exp-controls` for sticky
on mobile (Add moved to topbar on desktop, see #6).

---

## #3 — Show version number (mobile hamburger + desktop sidebar)

**Current state.** `v1.4.1.6` lives in `sw.js:5` and the Settings modal
`index.html:1795`. Not shown in the mobile more-sheet (`index.html:547-582`) or
the desktop `.sidebar-foot` (`index.html:361-378`).

**Recommendation.** Add a small muted version label at the bottom of the desktop
`.sidebar-foot` and at the bottom of the mobile more-sheet. **Single source:**
define the version once (e.g. `APP_VERSION` in `js/config.js`) and render it in
all three places (sidebar, sheet, settings) so it can't drift. (See bonus B2.)

- ☑ A) Single `APP_VERSION` constant, rendered in both navs + settings **(LOCKED)**
- ☐ B) Just hardcode the label in the two nav spots
- ☐ C) Other: __________

**Acceptance:** Version visible at bottom of sidebar (desktop) and more-sheet (mobile).

**Progress (Batch C):** `APP_VERSION` added to `js/config.js`; `main.js` init
fills every `.app-version` slot (`#app-version-sidebar`, `#app-version-sheet`,
`#app-version-settings`) with `v{APP_VERSION}`. Resolves bonus B2 (de-duped).
Note: `sw.js` CACHE_NAME still bumped manually per release.

---

## #4 — Manual refresh button as backup to auto-update

**Current state.** Auto-update works via `controllerchange` silent reload
(`index.html:1451-1472`). There is already a `#update-banner` with a Refresh
button in the DOM (`index.html:1436-1441`) **but it's dead code** — no JS consumes
the `APP_UPDATED` message `sw.js:100` posts; banner never shows.

**Recommendation.** Wire the existing banner: listen for `APP_UPDATED` /
`waiting` SW, show the banner, and have Refresh call `skipWaiting` + reload. This
gives a manual backup using markup that already exists (low effort).

- ☑ A) Wire the existing `#update-banner` Refresh button **(LOCKED)**
- ☐ B) Also add a persistent manual "Check for updates" in Settings
- ☐ C) Other: __________

**Acceptance:** When a new SW is waiting, banner appears; Refresh reloads to new version.

**Progress (Batch C):** SW-registration script now listens for the `APP_UPDATED`
message and shows `#update-banner`; Refresh sets `_swRefreshing` (avoids double
reload) then reloads; Dismiss hides it. Resolves bonus B1 (was dead code).

---

## #5 — Inconsistent navigation (All Trips drawer vs. in-trip "More")

**Current state.** All Trips uses a **top heading dropdown/drawer** for
Trips/Contacts (`index.html:169-184`, `:211-227`). Inside a trip, secondary nav
is the **bottom-nav "More" sheet** (rightmost item `index.html:541`, sheet
`:547-582`). Two different paradigms. (Note: it's a bottom-nav item, not a true
floating FAB.)

**DECISION (locked): Scope-based split.** One consistent *rule*, contents differ
by scope:
- **Top heading drawer = jump scope / meta actions.** Reused as one shared,
  aesthetically-upgraded component in both contexts.
  - On **All Trips**: Trips, Contacts, Gallery-across-trips *(future)*, Site settings.
  - **Inside a trip**: All trips, Share itinerary, Help. (Heading = trip name;
    a full trip-switcher in this drawer is a *future* enhancement, not now.)
- **Bottom nav = work within the current trip.** **5 buttons with Itinerary
  centered (position 3)** for prominence: `Overview · Budget · [Itinerary] ·
  <4th> · More`. The 4th direct tab is TBD (Gallery or Documents — decide in
  Batch C). After the meta items move up into the top drawer, the in-trip
  **More** sheet holds ONLY remaining trip content (e.g. Documents, Disruptions,
  Gallery, Guides minus whatever is promoted to the 4th tab). (Desktop keeps its
  sidebar.)

This also resolves the "More sheet = junk drawer" problem (it currently mixes
working views with All Trips/Help/Share).

**Drawer aesthetic spec:** heading + rotating chevron as a single tap target;
backdrop scrim; rounded sheet; icon+label rows; clear active state; spring-in
animation. Identical component in both contexts.

**Acceptance:** Top drawer is the same component in both contexts; in-trip More
sheet contains only Documents/Disruptions/Gallery/Guides; All Trips/Share/Help
live in the in-trip top drawer.

**Progress (code-complete):** Bottom nav was ALREADY 5 buttons w/ Itinerary
centered (Overview·Guides·Itinerary·Budget·More) — kept as-is. Added an in-trip
top drawer reusing `.trips-top-drawer`/`.ttd-item`/chevron: the topbar title is
now a tappable heading (mobile only — chevron hidden + click no-op on desktop,
which keeps the sidebar) opening All trips / Share itinerary / Help. Removed
those 3 from the More sheet (now: Expenses·Documents·Disruptions·Gallery + version).
Removed dead handlers (`sheet-share/help/all-trips-btn`). Outside-click close,
mirrors the All Trips drawer. DEFERRED (future): Gallery-across-trips + Site
Settings inside the All Trips drawer (Site Settings already has a gear icon).

---

## #6 — Top bar under-utilized

**Current state.** Topbar holds only the title + a mobile-only sync dot + theme
toggle (`index.html:383-392`); the sync dot is hidden on desktop, so desktop
topbar is title + theme toggle only.

**Recommendation.** This depends on #1/#2/#5 outcomes. Candidate uses: surface
the current view's primary action (e.g. Add) on desktop, show sync status on
desktop too, or a contextual breadcrumb (Trip name › View). **Lowest-risk:**
move the per-view primary "Add" action into the topbar-actions on desktop.

- ☑ A) Desktop: show primary action (Add) + sync status in topbar **(LOCKED)**
- ☐ B) Breadcrumb (Trip name › View) in topbar
- ☐ C) Defer — decide after #1/#2 land
- ☐ D) Other: __________

**Progress (Batch B, code-complete):** Added `#topbar-action` button; `setView`
shows it for Budget/Expenses ("Add expense", desktop) and proxy-clicks the
existing in-view handler. In-view Add headers hidden on desktop, shown on mobile.
Sync status already exists on desktop (sidebar `#status-indicator`), so not
duplicated. Gallery "Select" kept in-view (mode toggle w/ changing label).

**Acceptance:** Topbar has a clear purpose on both desktop and mobile; no dead space.

---

## #7 — Alignment / margins / extra vertical scroll + Add-photos tile

**Current state.** Tokens exist for color/radius/shadow (`styles/main.css:4-50`)
but **no spacing or font-size tokens**. 759 hardcoded px margins/paddings; radius
tokens bypassed ~50%; 18+ ad-hoc font sizes; 229 inline `style=` in
`index.html` + heavy inline styles in JS templates. Add-photos is a header-row
button (`js/gallery.js:527`) that adds a row of vertical height per city.

**Recommendation.**
1. Add `--space-*` and `--font-size-*` token scales to `:root`; migrate the most
   visible components to them (full migration is large — do high-traffic views first).
2. Standardize button/header vertical rhythm via a shared class to kill the extra
   scroll the audit flagged.
3. Convert "Add photos" to a `+` tile (dotted rounded border) as the last item in
   `.gallery-grid` instead of a header button — exactly your suggestion.

- ☑ A) Add token scales + migrate high-traffic views + add-photos tile (target)
- ☐ B) Add-photos tile only; defer the token migration
- ☐ C) Full token migration across all files (larger effort)
- ☐ D) Other: __________

**SEQUENCING (locked):** add-photos `+` tile lands in Batch A now. The broad
`--space-*`/`--font-size-*` token migration is DEFERRED to its own focused pass
(after Batch C) to keep diffs reviewable.

**Progress:**
- ✅ Add-photos `+` tile (Gallery) — removed the header "Add photos" button;
  appended a `.gallery-add-tile` (dashed rounded border, centered plus) as the
  last item in `.gallery-grid`. Hidden in select/share mode.
- ✅ Add-photos `+` tile (Itinerary) — converted the `.city-add-photos-btn` text
  button into a `.city-strip-add` "+" tile inside the city photo strip
  (`buildCityPhotoStrip`); strip now renders even with 0 photos (non-share) so the
  affordance always exists; removed the `.city-photo-actions` row + dead wiring +
  orphaned CSS. Mirrors the gallery pattern.
- ☐ DEFERRED (future, separate pass): `--space-*`/`--font-size-*` token scales +
  high-traffic view migration. Per user, NOT done in this refresh.

**Acceptance:** No buttons introduce avoidable vertical scroll; add-photos is a grid tile; sampled spacing uses tokens.

---

## #8 — Photo captions appear at the very bottom, off-center

**Current state.** Lightbox `#lb-image-wrap` is `flex:1` so it eats all height
and pushes `#lb-info` to the viewport bottom (`styles/main.css:4361-4393`). The
caption row is left-aligned inside an otherwise centered band (`index.html:1841`).

**Recommendation.** Lay out so the caption sits **directly beneath the image**:
don't let the image-wrap consume all space (size the image to content, place the
caption immediately under it), and align caption consistently (centered to match
the band, or left — pick one).

- ☐ A) Caption directly under image, centered **(recommended)**
- ☐ B) Caption directly under image, left-aligned
- ☐ C) Other: __________

**Acceptance:** Caption renders immediately below the photo, consistently aligned.

---

## #9 — Inconsistent icons (pencil, plus, delete, close, more, back)

**Current state.** Same action rendered as inline SVG, emoji, HTML entity, OR
text glyph depending on the module. Worst offenders:
- **Edit:** Feather SVG pencil most places, but emoji `✏` in budget drawer
  (`js/budget.js:2484,2493`).
- **Delete:** SVG trash (`index.html:965`) / emoji `✕` / text "Delete" — three styles.
- **Close:** SVG X / `×` entity (`js/settings.js:58`) / emoji `✕`.
- **More:** text `⋯` (`js/ui.js:299`) vs. hamburger SVG (`index.html:542`).
- **Add:** SVG plus vs. literal `+` in labels.
- **Back:** chevron-left vs. house icon for "All Trips".
No shared icon module/sprite exists.

**Recommendation.** Create one icon set — an inline SVG sprite or a tiny
`js/icons.js` exporting named SVG strings (`icon('edit')`, `icon('delete')`,
etc.). Replace all emoji/entity/glyph icons with it. Standardize one glyph per
action (Feather set is already dominant). This is the single highest-consistency
win and is pure find-replace risk.

- ☑ A) Central `js/icons.js` (named SVG functions), replace all variants **(LOCKED)**
- ☐ B) SVG `<symbol>` sprite + `<use>` references
- ☐ C) Other: __________

**Acceptance:** Each semantic action uses one identical icon everywhere; no emoji/entity icons remain.

**Progress — COMPLETE (Batch A):**
- ✅ `js/icons.js` created — named set: edit, add, delete, close, more, back,
  forward, filter, search, share, help, home, refresh, chevronDown.
- ✅ budget drawer `✏`/`✕` → edit/delete (`js/budget.js`); settings `×` →
  close (`js/settings.js`); flex-centering added to `.bd-expense-btn`,
  `.ts-member-remove`.
- ✅ `js/itinerary.js` `✕` → close (discard, attach-delete).
- ✅ `js/ticketImport.js` all 4 `✕` → close.
- ✅ `index.html` share drawer close + update-banner dismiss `✕` → inline X SVG.
- ✅ `js/ui.js` `⋯` kebab (both trip-card menus) → `more` icon.
- ✅ All-Trips affordance unified to **back chevron** (sidebar + more-sheet were
  house icons → now chevron, matching share view + planned in-trip drawer).
- Final sweep: zero residual `✏ ✕ ⋯ ×` glyph icons; all edited JS passes
  `node --check`. Importers: budget, settings, gallery, ui, itinerary, ticketImport.
- ☐ DEFERRED (optional, later): text `+` labels → `add` icon (cosmetic, low value).

---

## Bonus items the audit surfaced

### B1 — Orphaned update banner (dead code)
`#update-banner` (`index.html:1436`) + the `APP_UPDATED` postMessage (`sw.js:100`)
are never wired. Resolved by #4 option A (wire it) — or remove if #4 goes another way.

### B2 — Version string duplicated
`v1.4.1.6` is hardcoded in `sw.js:5` and `index.html:1795` and will drift.
Resolved by #3 option A (single `APP_VERSION`). Note: `sw.js` CACHE_NAME must stay
in sync for cache-busting — keep a documented bump step.

---

## Open wording decisions
- Disruptions view: ☑ **"Disruptions"** (LOCKED) — matches nav label and the
  other single-word view names. Replace "Disruption Hub" h1.

---

## Sign-off (all locked 2026-06-19)
Phase 2 (frontend) implements **Batch A, quick wins first**: #1 double headers +
#8 captions + Disruptions rename, then #9 icon set + #7 tokens/add-photos tile.

**QA setup (locked):** After each batch, serve the working tree on localhost,
user signs in once in their Chrome (localhost is a Firebase-authorized domain),
QA agent drives via Chrome MCP at mobile + desktop widths and verifies each
Acceptance line before the next batch starts. Requires the Chrome extension
connected.
