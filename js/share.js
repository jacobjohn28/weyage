import { state, activeTripId, setActiveTripId } from "./state.js";
import {
  db, doc, updateDoc, collection, getDocs, query, where, arrayUnion,
  auth, onAuthStateChanged, signInAnonymously, initFirebase,
} from "./firebase.js";
import { escapeHtml, fmtTime12, fmtDateRange, nightsBetween, mapsLink, mapsSearchBtn } from "./utils.js";
import { buildCityPhotoStrip, wireCityPhotoStrip } from "./gallery.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerShareCallbacks({ showShareSection, listenToTrip, waitForShareData }) {
  Object.assign(cb, { showShareSection, listenToTrip, waitForShareData });
}

/* ─────────────────────────────────────────────────────────────
   SHARE LINK UTILITIES
   ───────────────────────────────────────────────────────────── */
export async function generateAndCopyShareLink(btn) {
  const originalHTML = btn.innerHTML;
  btn.textContent = "Generating…";
  btn.disabled = true;
  try {
    let token = state.trip?.shareToken;
    if (!token) {
      token = crypto.randomUUID();
      await updateDoc(doc(db, "trips", activeTripId), { shareToken: token });
    }
    const url = `${location.origin}${location.pathname}?share=${token}`;
    await navigator.clipboard.writeText(url);
    btn.textContent = "✓ Link copied!";
    setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 2500);
  } catch (err) {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
    console.error("Share link error:", err);
  }
}

export function showInvalidShareLink() {
  document.getElementById("boot-screen").classList.add("hidden");
  cb.showShareSection(false);
  document.getElementById("sp-page").innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:16px;color:var(--text-3);padding:40px;text-align:center">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <strong style="color:var(--text);font-size:1.1rem">Link not found</strong>
      <span style="font-size:0.875rem;max-width:280px">This share link may have expired or been removed. Ask the trip organiser to generate a new one.</span>
    </div>`;
}

export async function initSharedView(token) {
  await initFirebase();

  // Wait for Firebase to determine auth state (handles persistence restoration)
  const existingUser = await new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, u => { unsub(); resolve(u); });
  });

  // Ensure we have some auth identity for Firestore reads.
  // Only sign in anonymously if not already signed in — never override a Google session.
  if (!existingUser) {
    try {
      await signInAnonymously(auth);
    } catch (err) {
      document.getElementById("boot-screen").classList.add("hidden");
      document.getElementById("auth-screen").classList.add("visible");
      document.getElementById("auth-error").textContent = "Couldn't load shared itinerary. Try the link again.";
      return;
    }
  }

  // Look up the trip by share token.
  // Firestore rule required: allow read if request.auth != null && resource.data.shareToken != null
  let tripDocId, tripAllowedUsers;
  try {
    const snap = await getDocs(query(collection(db, "trips"), where("shareToken", "==", token)));
    if (snap.empty) { showInvalidShareLink(); return; }
    tripDocId = snap.docs[0].id;
    tripAllowedUsers = snap.docs[0].data().allowedUsers || [];
  } catch (err) {
    console.error("Share token lookup failed:", err);
    showInvalidShareLink();
    return;
  }

  setActiveTripId(tripDocId);
  const currentUser = auth.currentUser;

  // For signed-in Google users who are NOT collaborators, record the view
  const _isAuthNonCollab = currentUser && !currentUser.isAnonymous &&
    !tripAllowedUsers.includes(currentUser.email.toLowerCase());
  let _showWelcomeBanner = false;
  if (currentUser && !currentUser.isAnonymous) {
    const email = currentUser.email.toLowerCase();
    if (!tripAllowedUsers.includes(email)) {
      try {
        await updateDoc(doc(db, "trips", activeTripId), { shareViewers: arrayUnion(email) });
      } catch (_) { /* non-fatal — rules may not allow this yet */ }
      // Show welcome banner only on the first visit
      const seenKey = `sp-seen-${tripDocId}`;
      _showWelcomeBanner = !localStorage.getItem(seenKey);
      if (_showWelcomeBanner) localStorage.setItem(seenKey, "1");
    }
  }

  // Always show the share page for share link visits.
  // Collaborators see an "Open in Weyage" button; anonymous users see a clean view.
  document.getElementById("boot-screen").classList.add("hidden");
  document.getElementById("sp-page").innerHTML =
    `<div style="padding:60px 20px;text-align:center;color:var(--text-2)">Loading…</div>`;

  // Authenticated non-collaborators always get the All Trips button (url-share mode
  // means the click reloads the page rather than calling showTripList).
  if (_isAuthNonCollab) {
    cb.showShareSection(true);
    const _backBtn = document.getElementById("sp-back-btn");
    if (_backBtn) _backBtn.dataset.spMode = "url-share";
  } else {
    cb.showShareSection(false);
  }

  const prevTowns = state.towns;
  const prevSpots = state.spots;
  cb.listenToTrip(activeTripId);
  cb.waitForShareData(prevTowns, prevSpots, () => {
    const viewerUser = (currentUser && !currentUser.isAnonymous) ? currentUser : null;
    renderSharePage(viewerUser, tripAllowedUsers, _showWelcomeBanner);
  });
}

function _openFullTripFromShare() {
  localStorage.setItem("last-trip-id", activeTripId);
  localStorage.removeItem("last-screen");
  // Reload without the ?share= param so init() runs the normal auth flow
  location.href = location.pathname;
}

/* ─────────────────────────────────────────────────────────────
   SHARE PAGE — DRAWER & VIEW CONTROLS
   ───────────────────────────────────────────────────────────── */
let _spViewMode = "list";
let _spDrawerHistory = [];
const _spCityColors = ["#4F74FF","#F25D4E","#0FA676","#E87D1D","#8B5CF6","#D946EF"];

function spCloseDrawer() {
  const el = document.getElementById("sp-drawer");
  if (!el || !el.classList.contains("open")) return;
  const panel = el.querySelector(".sp-drawer-panel");
  panel.classList.add("sp-anim-out");
  setTimeout(() => { el.classList.remove("open"); panel.classList.remove("sp-anim-out"); _spDrawerHistory = []; }, 200);
}
// Inline onclick in index.html requires global references
window.spCloseDrawer = spCloseDrawer;

function _spShowDrawer(bodyHTML, icon, title, subtitle) {
  const el = document.getElementById("sp-drawer");
  if (!el) return;
  el.querySelector("#sp-drawer-icon").textContent = icon;
  el.querySelector("#sp-drawer-title").textContent = title;
  const subEl = el.querySelector("#sp-drawer-sub");
  subEl.textContent = subtitle || "";
  subEl.style.display = subtitle ? "" : "none";
  el.querySelector("#sp-drawer-body").innerHTML = bodyHTML;
  el.querySelector("#sp-drawer-back-btn").style.display = _spDrawerHistory.length ? "" : "none";
  if (!el.classList.contains("open")) {
    el.classList.add("open");
    const panel = el.querySelector(".sp-drawer-panel");
    panel.classList.add("sp-anim-in");
    setTimeout(() => panel.classList.remove("sp-anim-in"), 260);
  }
}

function spDrawerBack() {
  if (!_spDrawerHistory.length) return;
  const prev = _spDrawerHistory.pop();
  _spShowDrawer(prev.body, prev.icon, prev.title, prev.subtitle);
}
window.spDrawerBack = spDrawerBack;

function _spPushDrawer(bodyHTML, icon, title, subtitle) {
  const el = document.getElementById("sp-drawer");
  if (!el) return;
  _spDrawerHistory.push({
    body:     el.querySelector("#sp-drawer-body")?.innerHTML || "",
    icon:     el.querySelector("#sp-drawer-icon")?.textContent || "",
    title:    el.querySelector("#sp-drawer-title")?.textContent || "",
    subtitle: el.querySelector("#sp-drawer-sub")?.textContent || ""
  });
  _spShowDrawer(bodyHTML, icon, title, subtitle);
}

function _spTransportDetailHTML(spotId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot) return "";
  const from = spot.customOrigin || spot.transportFrom || state.towns.find(t => t.id === spot.townId)?.name || "";
  const to   = spot.customDestination || spot.transportTo || state.towns.find(t => t.id === spot.arrivalTownId)?.name || "";
  const depDate = spot.scheduledDate ? new Date(spot.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  const arrDate = spot.arrivalDate   ? new Date(spot.arrivalDate   + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  const depTime = fmtTime12(spot.departureTime);
  const arrTime = fmtTime12(spot.arrivalTime);
  const depFull = [depDate, depTime].filter(Boolean).join(" · ");
  const arrFull = [arrDate, arrTime].filter(Boolean).join(" · ");
  let html = "";
  if (from || to) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Route</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px">
      <span style="font-size:1.0625rem;font-weight:600">${escapeHtml(from || "—")}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="18" height="18" style="color:var(--accent);flex-shrink:0"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      <span style="font-size:1.0625rem;font-weight:600">${escapeHtml(to || "—")}</span>
    </div></div>`;
  if (depFull || arrFull) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Journey</div>
    ${depFull ? `<div class="sp-drawer-row"><span class="sp-drawer-row-sub">Departs</span>${escapeHtml(depFull)}</div>` : ""}
    ${arrFull ? `<div class="sp-drawer-row"><span class="sp-drawer-row-sub">Arrives&nbsp;</span>${escapeHtml(arrFull)}</div>` : ""}
    </div>`;
  if (spot.carrier || spot.seat) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Details</div>
    ${spot.carrier ? `<div class="sp-drawer-row">${escapeHtml(spot.carrier)}</div>` : ""}
    ${spot.seat ? `<div class="sp-drawer-row"><span class="sp-drawer-row-sub">Seat</span>${escapeHtml(spot.seat)}</div>` : ""}
    </div>`;
  if (spot.notes) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Notes</div><div class="sp-drawer-notes">${escapeHtml(spot.notes)}</div></div>`;
  if (spot.booked || spot.bookingRef) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Booking</div>
    ${spot.booked ? `<div class="sp-drawer-row sp-drawer-booked">✓ Confirmed${spot.bookingRef ? ` · Ref: ${escapeHtml(spot.bookingRef)}` : ""}</div>` : `<div class="sp-drawer-row">Ref: ${escapeHtml(spot.bookingRef)}</div>`}
    </div>`;
  return html || `<div style="padding:24px;text-align:center;font-size:.875rem;color:var(--text-3)">No details available</div>`;
}

function _spAccomDetailHTML(townId) {
  const town = state.towns.find(t => t.id === townId);
  if (!town?.accommodation?.name) return "";
  const a = town.accommodation;
  const ci = a.checkinDate  ? new Date(a.checkinDate  + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  const co = a.checkoutDate ? new Date(a.checkoutDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  let html = `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Location</div>
    <div class="sp-drawer-row" style="font-weight:500">${escapeHtml(town.name)}</div>
    ${a.address
      ? `<div class="sp-drawer-row" style="color:var(--text-2)">${mapsLink(a.address)}</div>`
      : `<div class="sp-drawer-row">${mapsSearchBtn(a.name, town.name)}</div>`}
    </div>`;
  if (ci || co || a.checkinTime || a.checkoutTime) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Dates</div>
    ${(ci || a.checkinTime) ? `<div class="sp-drawer-row"><span class="sp-drawer-row-sub">Check-in&nbsp;</span>${escapeHtml([ci, a.checkinTime].filter(Boolean).join(" "))}</div>` : ""}
    ${(co || a.checkoutTime) ? `<div class="sp-drawer-row"><span class="sp-drawer-row-sub">Check-out</span>${escapeHtml([co, a.checkoutTime].filter(Boolean).join(" "))}</div>` : ""}
    </div>`;
  if (a.booked || a.bookingRef) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Booking</div>
    ${a.booked ? `<div class="sp-drawer-row sp-drawer-booked">✓ Confirmed${a.bookingRef ? ` · Ref: ${escapeHtml(a.bookingRef)}` : ""}</div>` : `<div class="sp-drawer-row">Ref: ${escapeHtml(a.bookingRef)}</div>`}
    </div>`;
  if (a.notes) html += `<div class="sp-drawer-section"><div class="sp-drawer-section-lbl">Notes</div><div class="sp-drawer-notes">${escapeHtml(a.notes)}</div></div>`;
  return html;
}

function spOpenTransportDetail(spotId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot) return;
  const typeIcons = { train:"🚂", flight:"✈️", bus:"🚌", ferry:"⛴️", car:"🚗", taxi:"🚕", metro:"🚇", tram:"🚊" };
  const icon = typeIcons[spot.transportSubtype] || "🚌";
  const label = spot.transportSubtype ? spot.transportSubtype.charAt(0).toUpperCase() + spot.transportSubtype.slice(1) : "Transport";
  _spDrawerHistory = [];
  _spShowDrawer(_spTransportDetailHTML(spotId), icon, spot.name || label, "");
}

function spOpenAccomDetail(townId) {
  const town = state.towns.find(t => t.id === townId);
  if (!town?.accommodation?.name) return;
  _spDrawerHistory = [];
  _spShowDrawer(_spAccomDetailHTML(townId), "🏨", town.accommodation.name, town.name);
}

/* Called from within city drawer — pushes so user can navigate back to city level */
function _spDrillTransportDetail(spotId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot) return;
  const typeIcons = { train:"🚂", flight:"✈️", bus:"🚌", ferry:"⛴️", car:"🚗", taxi:"🚕", metro:"🚇", tram:"🚊" };
  const icon = typeIcons[spot.transportSubtype] || "🚌";
  const label = spot.transportSubtype ? spot.transportSubtype.charAt(0).toUpperCase() + spot.transportSubtype.slice(1) : "Transport";
  _spPushDrawer(_spTransportDetailHTML(spotId), icon, spot.name || label, "");
}

function _spDrillAccomDetail(townId) {
  const town = state.towns.find(t => t.id === townId);
  if (!town?.accommodation?.name) return;
  _spPushDrawer(_spAccomDetailHTML(townId), "🏨", town.accommodation.name, town.name);
}

function _spCityDrawerBodyHTML(town) {
  const typeIcons = { train:"🚂", flight:"✈️", bus:"🚌", ferry:"⛴️", car:"🚗", taxi:"🚕", metro:"🚇", tram:"🚊" };
  const spotTypeEmoji = { sight:"👁", restaurant:"🍽", cafe:"☕", experience:"⭐" };
  const townTransport = state.spots.filter(s => s.type === "transport" && !s._arrivalView && !s.isCancelled && s.townId === town.id);
  const townDaySpots = state.spots.filter(s => s.type !== "transport" && s.townId === town.id);
  const a = town.accommodation;
  let html = "";

  html += `<div class="sp-drawer-cat">Transport</div>`;
  if (townTransport.length) {
    townTransport.forEach(spot => {
      const subtype = spot.transportSubtype || "";
      const icon = typeIcons[subtype] || "🚌";
      const label = subtype ? subtype.charAt(0).toUpperCase() + subtype.slice(1) : "Transport";
      const from = spot.customOrigin || spot.transportFrom || "";
      const to   = spot.customDestination || spot.transportTo || "";
      const depTime = fmtTime12(spot.departureTime);
      const depDateStr = spot.scheduledDate ? new Date(spot.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      const meta = [from && to ? `${from} → ${to}` : (from || to), depTime ? `departs ${depTime}` : "", depDateStr].filter(Boolean).join(" · ");
      html += `<div class="sp-drawer-item" data-action="drill-transport" data-id="${escapeHtml(spot.id)}">
        <div class="sp-drawer-item-inner">
          <div class="sp-drawer-item-icon">${icon}</div>
          <div class="sp-drawer-item-body">
            <div class="sp-drawer-item-name">${escapeHtml(spot.name || label)}</div>
            ${meta ? `<div class="sp-drawer-item-meta">${meta}</div>` : ""}
            ${spot.carrier ? `<div class="sp-drawer-item-meta">${escapeHtml(spot.carrier)}</div>` : ""}
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0;color:var(--text-3);align-self:center"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>`;
    });
  } else {
    html += `<div class="sp-empty-note">No outbound transport added</div>`;
  }

  html += `<div class="sp-drawer-cat">Accommodation</div>`;
  if (a?.name) {
    const ci = a.checkinDate  ? new Date(a.checkinDate  + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    const co = a.checkoutDate ? new Date(a.checkoutDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    const ciStr = [ci, a.checkinTime].filter(Boolean).join(" ");
    const coStr = [co, a.checkoutTime].filter(Boolean).join(" ");
    const ds = ciStr && coStr ? `${ciStr} → ${coStr}` : (ciStr || coStr || "");
    html += `<div class="sp-drawer-item" data-action="drill-accom" data-id="${escapeHtml(town.id)}">
      <div class="sp-drawer-item-inner">
        <div class="sp-drawer-item-icon">🏨</div>
        <div class="sp-drawer-item-body">
          <div class="sp-drawer-item-name">${escapeHtml(a.name)}</div>
          ${ds ? `<div class="sp-drawer-item-meta">${ds}</div>` : ""}
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0;color:var(--text-3);align-self:center"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>`;
  } else {
    html += `<div class="sp-empty-note">No accommodation added</div>`;
  }

  if (townDaySpots.length) {
    html += `<div class="sp-drawer-cat">${townDaySpots.length} Visit${townDaySpots.length === 1 ? "" : "s"}</div>`;
    const visitDates = [...new Set(townDaySpots.map(s => s.scheduledDate).filter(Boolean))].sort();
    visitDates.forEach(date => {
      const dLabel = new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      const list = townDaySpots.filter(s => s.scheduledDate === date).sort((a, b) => (a.scheduledTime || "").localeCompare(b.scheduledTime || "") || (a.order ?? 9999) - (b.order ?? 9999));
      html += `<div style="padding:4px 16px 8px">
        <div style="font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin-bottom:6px">${dLabel}</div>
        ${list.map(spot => `<div style="display:flex;gap:10px;padding:5px 0;font-size:.8125rem;align-items:flex-start">
          <span style="color:var(--text-3);min-width:44px;flex-shrink:0">${escapeHtml(fmtTime12(spot.scheduledTime))}</span>
          <span style="flex-shrink:0">${spotTypeEmoji[spot.type] || "📍"}</span>
          <div><div>${escapeHtml(spot.name || "")}</div>${spot.neighborhood ? `<div style="font-size:.75rem;color:var(--text-3)">${escapeHtml(spot.neighborhood)}</div>` : ""}${spot.name ? mapsSearchBtn(spot.name, town.name) : ""}</div>
        </div>`).join("")}
      </div>`;
    });
  }
  // Photo strip
  const photoStrip = buildCityPhotoStrip(town.id);
  if (photoStrip) {
    html += `<div class="sp-drawer-cat">Photos</div><div style="padding:0 14px 12px">${photoStrip}</div>`;
  }

  return html;
}

function spOpenCityDrawer(townId) {
  const town = state.towns.find(t => t.id === townId);
  if (!town) return;
  _spDrawerHistory = [];
  const arrDate = town.arrivalDate   ? new Date(town.arrivalDate   + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const depDate = town.departureDate ? new Date(town.departureDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const nights = (town.arrivalDate && town.departureDate) ? nightsBetween(town.arrivalDate, town.departureDate) : null;
  const subtitle = [arrDate && depDate ? `${arrDate} – ${depDate}` : (arrDate || depDate), nights !== null ? `${nights} night${nights === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  _spShowDrawer(_spCityDrawerBodyHTML(town), "📍", town.name, subtitle);
  // Wire photo strip lightbox after drawer body is set
  const strip = document.querySelector(`[data-stripfor="${townId}"]`);
  if (strip) wireCityPhotoStrip(strip, townId);
}

function spToggleVisits(el) {
  el.classList.toggle("open");
  el.nextElementSibling?.classList.toggle("open");
}

function spSwitchView(view) {
  _spViewMode = view;
  document.querySelectorAll(".sp-view-tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  const lv = document.getElementById("sp-list-view");
  const cv = document.getElementById("sp-cal-view");
  if (lv) lv.style.display = view === "list" ? "" : "none";
  if (cv) cv.style.display = view === "calendar" ? "" : "none";
}

function _renderSpCalendar() {
  const { trip, towns } = state;
  if (!towns.length || !trip?.startDate || !trip?.endDate) {
    return `<div style="padding:24px;text-align:center;font-size:.875rem;color:var(--text-3)">No dates set for this trip</div>`;
  }
  const startD = new Date(trip.startDate + "T00:00:00");
  const endD   = new Date(trip.endDate   + "T00:00:00");
  const months = [];
  let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
  const endMonth = new Date(endD.getFullYear(), endD.getMonth(), 1);
  while (cur <= endMonth) { months.push(new Date(cur)); cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); }
  const dowLabels = ["Mo","Tu","We","Th","Fr","Sa","Su"];
  const chevron = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="8" height="8" style="flex-shrink:0;opacity:.9"><polyline points="9 18 15 12 9 6"/></svg>`;
  return months.map(monthStart => {
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const monthName = monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    const weeks = [];
    let week = new Array(7).fill(null);
    let dow = firstDow;
    for (let day = 1; day <= daysInMonth; day++) {
      const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      week[dow] = { day, ds };
      if (++dow === 7) { weeks.push([...week]); week = new Array(7).fill(null); dow = 0; }
    }
    if (dow > 0) weeks.push([...week]);
    const weeksHTML = weeks.map(slots => {
      const dayRowHTML = slots.map(s =>
        s ? `<div class="sp-cal-cell"><div class="sp-cal-day-num">${s.day}</div></div>`
          : `<div class="sp-cal-cell sp-cal-cell-empty"></div>`
      ).join("");
      const spans = [];
      towns.forEach((town, tIdx) => {
        if (!town.arrivalDate || !town.departureDate) return;
        let start = -1, end = -1;
        slots.forEach((s, i) => {
          if (s && s.ds >= town.arrivalDate && s.ds <= town.departureDate) {
            if (start === -1) start = i;
            end = i;
          }
        });
        if (start === -1) return;
        const color = _spCityColors[tIdx % _spCityColors.length];
        const showLabel = slots[start]?.ds === town.arrivalDate || start === 0;
        const name = town.name.length > 10 ? town.name.slice(0, 9) + "…" : town.name;
        spans.push(`<div class="sp-cal-span" style="grid-column:${start+1}/span ${end-start+1};background:${color}" data-action="open-city-drawer" data-id="${escapeHtml(town.id)}" title="${escapeHtml(town.name)}"><span class="sp-cal-span-label">${showLabel ? escapeHtml(name) : ""}</span>${chevron}</div>`);
      });
      return `<div class="sp-cal-week"><div class="sp-cal-week-days">${dayRowHTML}</div>${spans.length ? `<div class="sp-cal-week-events">${spans.join("")}</div>` : ""}</div>`;
    }).join("");
    return `<div class="sp-cal-month-hd">${monthName}</div>
      <div class="sp-cal-grid">${dowLabels.map(d => `<div class="sp-cal-dow">${d}</div>`).join("")}${weeksHTML}</div>`;
  }).join("");
}

/* ─────────────────────────────────────────────────────────────
   SHARE PAGE RENDERER
   ───────────────────────────────────────────────────────────── */
export function renderSharePage(viewerUser, tripAllowedUsers, showWelcomeBanner = false) {
  const container = document.getElementById("sp-page");
  if (!container || !state.trip) return;

  const trip = state.trip;
  const towns = state.towns;
  const spots = state.spots;

  const dateStr0 = (trip.startDate && trip.endDate) ? fmtDateRange(trip.startDate, trip.endDate) : "";
  document.title = dateStr0 ? `${trip.name || "Trip"} · ${dateStr0}` : (trip.name || "Weyage");
  const daySpots = spots.filter(s => s.type !== "transport");
  const totalNights = (trip.startDate && trip.endDate) ? nightsBetween(trip.startDate, trip.endDate) : null;
  const totalDays = totalNights !== null ? totalNights + 1 : null;
  const coverPhoto = Object.values(trip.cityPhotos || {}).find(Boolean) || null;
  const typeIcons = { train:"🚂", flight:"✈️", bus:"🚌", ferry:"⛴️", car:"🚗", taxi:"🚕", metro:"🚇", tram:"🚊" };
  const spotTypeEmoji = { sight:"👁", restaurant:"🍽", cafe:"☕", experience:"⭐" };

  // Banner
  const allowedUsers = tripAllowedUsers || trip.allowedUsers || [];
  let bannerHTML = "";
  if (viewerUser) {
    const email = viewerUser.email?.toLowerCase() || "";
    const isCollab = allowedUsers.includes(email);
    if (isCollab) {
      bannerHTML = `<div class="sp-banner" style="display:flex;align-items:center;gap:10px">
        <span style="flex:1">You have full access to this trip.</span>
        <button data-action="open-full-trip" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:0.8125rem;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap">Open in Weyage</button>
      </div>`;
    } else if (showWelcomeBanner) {
      bannerHTML = `<div class="sp-banner">Viewing as <strong>${escapeHtml(viewerUser.displayName || viewerUser.email)}</strong>. This trip has been saved to your Shared Trips list.</div>`;
    }
  }

  // Hero
  const heroImgHTML = coverPhoto
    ? `<div class="sp-hero-img"><img src="${escapeHtml(coverPhoto)}" alt="" loading="lazy"><div class="sp-hero-img-overlay"></div></div>`
    : `<div class="sp-hero-img"></div>`;
  const dateStr = (trip.startDate && trip.endDate) ? fmtDateRange(trip.startDate, trip.endDate) : "";
  const heroHTML = `<div class="sp-hero">
    ${heroImgHTML}
    <div class="sp-hero-body">
      <div class="sp-hero-name">${escapeHtml(trip.name || "Trip")}</div>
      ${dateStr ? `<div class="sp-hero-dates">${dateStr}</div>` : ""}
      <div class="sp-stats">
        ${totalDays ? `<div class="sp-stat"><div class="sp-stat-n">${totalDays}</div><div class="sp-stat-l">Days</div></div>` : ""}
        <div class="sp-stat"><div class="sp-stat-n">${towns.length}</div><div class="sp-stat-l">Cities</div></div>
        ${totalNights ? `<div class="sp-stat"><div class="sp-stat-n">${totalNights}</div><div class="sp-stat-l">Nights</div></div>` : ""}
        <div class="sp-stat"><div class="sp-stat-n">${daySpots.length}</div><div class="sp-stat-l">Spots</div></div>
      </div>
    </div>
  </div>`;

  // Per-city cards (list view)
  const listHTML = towns.length ? towns.map(town => {
    const townTransport = spots.filter(s => s.type === "transport" && !s._arrivalView && !s.isCancelled && s.townId === town.id);
    const townDaySpots = daySpots.filter(s => s.townId === town.id);
    const arrDate = town.arrivalDate   ? new Date(town.arrivalDate   + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    const depDate = town.departureDate ? new Date(town.departureDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    const nights = (town.arrivalDate && town.departureDate) ? nightsBetween(town.arrivalDate, town.departureDate) : null;
    const meta = [arrDate && depDate ? `${arrDate} – ${depDate}` : (arrDate || depDate), nights !== null ? `${nights} night${nights === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    const chevR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0;color:var(--text-3)"><polyline points="9 18 15 12 9 6"/></svg>`;

    // Transport cards
    const transportItemsHTML = townTransport.length ? townTransport.map(spot => {
      const subtype = spot.transportSubtype || "";
      const icon = typeIcons[subtype] || "🚌";
      const label = subtype ? subtype.charAt(0).toUpperCase() + subtype.slice(1) : "Transport";
      const from = spot.customOrigin || spot.transportFrom || "";
      const to   = spot.customDestination || spot.transportTo || "";
      const depTime = fmtTime12(spot.departureTime);
      const depDateStr = spot.scheduledDate ? new Date(spot.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      const m = [from && to ? `${from} → ${to}` : (from || to), depTime ? `departs ${depTime}` : "", depDateStr].filter(Boolean).join(" · ");
      return `<div class="sp-item"><div class="sp-item-summary expandable" data-action="open-transport" data-id="${escapeHtml(spot.id)}">
        <div class="sp-item-icon">${icon}</div>
        <div class="sp-item-body">
          <div class="sp-item-name">${escapeHtml(spot.name || label)}</div>
          ${m ? `<div class="sp-item-meta">${m}</div>` : ""}
          ${spot.carrier ? `<div class="sp-item-meta">${escapeHtml(spot.carrier)}</div>` : ""}
        </div>${chevR}
      </div></div>`;
    }).join("") : `<div class="sp-item"><div class="sp-item-summary"><div class="sp-item-icon" style="opacity:.35">—</div><div class="sp-item-body"><div class="sp-item-meta">No outbound transport added</div></div></div></div>`;

    // Accommodation card
    const a = town.accommodation;
    const accomItemHTML = a?.name ? (() => {
      const ci = a.checkinDate  ? new Date(a.checkinDate  + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      const co = a.checkoutDate ? new Date(a.checkoutDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      const ds = [ci && co ? `${ci} – ${co}` : (ci || co), a.checkinTime ? `from ${a.checkinTime}` : ""].filter(Boolean).join(" · ");
      return `<div class="sp-item"><div class="sp-item-summary expandable" data-action="open-accom" data-id="${escapeHtml(town.id)}">
        <div class="sp-item-icon">🏨</div>
        <div class="sp-item-body">
          <div class="sp-item-name">${escapeHtml(a.name)}</div>
          ${ds ? `<div class="sp-item-meta">${ds}</div>` : ""}
        </div>${chevR}
      </div></div>`;
    })() : `<div class="sp-item"><div class="sp-item-summary"><div class="sp-item-icon" style="opacity:.35">—</div><div class="sp-item-body"><div class="sp-item-meta">No accommodation added</div></div></div></div>`;

    // Visits (expandable by day)
    const visitDates = [...new Set(townDaySpots.map(s => s.scheduledDate).filter(Boolean))].sort();
    const visitsBodyHTML = visitDates.length ? visitDates.map(date => {
      const dLabel = new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      const list = townDaySpots.filter(s => s.scheduledDate === date).sort((a, b) => (a.scheduledTime || "").localeCompare(b.scheduledTime || "") || (a.order ?? 9999) - (b.order ?? 9999));
      return `<div class="sp-day-section">
        <div class="sp-day-header" data-action="toggle-day">
          <span class="sp-day-date">${dLabel}</span>
          <svg class="sp-day-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="sp-day-body">${list.length ? list.map(spot => `
          <div class="sp-day-spot">
            <div class="sp-day-spot-time">${escapeHtml(fmtTime12(spot.scheduledTime))}</div>
            <div class="sp-day-spot-icon">${spotTypeEmoji[spot.type] || "📍"}</div>
            <div class="sp-day-spot-body">
              <div class="sp-day-spot-name">${escapeHtml(spot.name || "")}</div>
              ${spot.neighborhood ? `<div class="sp-day-spot-meta">${escapeHtml(spot.neighborhood)}</div>` : ""}
              ${spot.name ? mapsSearchBtn(spot.name, town.name) : ""}
            </div>
          </div>`).join("") : `<p style="font-size:.8125rem;color:var(--text-3);padding:4px 0;margin:0">Nothing planned</p>`}
        </div>
      </div>`;
    }).join("") : `<div style="padding:10px 16px;font-size:.8125rem;color:var(--text-3)">No spots added yet</div>`;

    return `<div class="sp-city-card">
      <div class="sp-city-card-head">
        <div class="sp-city-card-name">${escapeHtml(town.name)}</div>
        ${meta ? `<div class="sp-city-card-meta">${meta}</div>` : ""}
      </div>
      <div class="sp-city-section-lbl">Transport</div>
      <div class="sp-item-list">${transportItemsHTML}</div>
      <div class="sp-city-section-lbl">Accommodation</div>
      <div class="sp-item-list">${accomItemHTML}</div>
      ${townDaySpots.length ? `<div class="sp-visits-toggle" data-action="toggle-visits">
        <span style="flex:1">📍 ${townDaySpots.length} Visit${townDaySpots.length === 1 ? "" : "s"}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="sp-visits-body">${visitsBodyHTML}</div>` : ""}
    </div>`;
  }).join("") : `<div style="padding:24px;text-align:center;font-size:.875rem;color:var(--text-3)">No cities added to this trip</div>`;

  _initShareEventDelegation();
  container.innerHTML = `
    ${bannerHTML}
    ${heroHTML}
    <div class="sp-view-toggle">
      <button class="sp-view-tab" data-view="list" data-action="switch-view">List</button>
      <button class="sp-view-tab active" data-view="calendar" data-action="switch-view">Calendar</button>
    </div>
    <div id="sp-list-view" class="sp-city-cards" style="display:none">${listHTML}</div>
    <div id="sp-cal-view" class="sp-calendar">${_renderSpCalendar()}</div>`;
}

/* ─────────────────────────────────────────────────────────────
   DELEGATED EVENT LISTENER (replaces inline onclick handlers)
   ───────────────────────────────────────────────────────────── */
let _shareEventsInitialized = false;
function _initShareEventDelegation() {
  if (_shareEventsInitialized) return;
  _shareEventsInitialized = true;
  document.addEventListener("click", e => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const { action, id, view } = target.dataset;
    switch (action) {
      case "drill-transport":   _spDrillTransportDetail(id); break;
      case "drill-accom":       _spDrillAccomDetail(id); break;
      case "open-city-drawer":  spOpenCityDrawer(id); break;
      case "open-full-trip":    _openFullTripFromShare(); break;
      case "open-transport":    spOpenTransportDetail(id); break;
      case "open-accom":        spOpenAccomDetail(id); break;
      case "toggle-day": {
        target.nextElementSibling?.classList.toggle("open");
        target.querySelector(".sp-day-chevron")?.classList.toggle("open");
        break;
      }
      case "toggle-visits":     spToggleVisits(target); break;
      case "switch-view":       spSwitchView(view); break;
    }
  });
}
