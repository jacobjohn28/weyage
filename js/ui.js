import { state, setState, activeTripId, setActiveTripId } from "./state.js";
import { escapeHtml, fmtDateRange, localDateStr, btnLoading, btnReset } from "./utils.js";
import {
  db, doc, getDoc, setDoc, auth,
  isConfigured, GoogleAuthProvider, signInWithPopup, signOut, serverTimestamp,
} from "./firebase.js";
import { GEMINI_CONFIG, PEXELS_CONFIG } from "./config.js";
import {
  pendingScrollTownId, setPendingScrollTownId, setPendingScrollToToday,
  renderItinerary,
} from "./itinerary.js";
import { renderGuides, generateAllGuides } from "./guides.js";
import { renderBudget, renderExpenses, CURRENCY_LIST } from "./budget.js";
import { renderDocuments } from "./documents.js";
import { renderDisruption } from "./disruption.js";
import { renderGallery, initGalleryLightbox, initUploadModal, openUploadModal, closeUploadModal } from "./gallery.js";
import { openTripSettings } from "./settings.js";
import { contactNameForEmail, initContactsPanel, renderContactsPanel } from "./contacts.js";
import { closePhotoPicker, startBackfillForTrip } from "./photos.js";
import { generateAndCopyShareLink } from "./share.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerUiCallbacks({ pushModalHistory, switchTrip, openSharedTrip, detachTripListeners }) {
  Object.assign(cb, { pushModalHistory, switchTrip, openSharedTrip, detachTripListeners });
}

/* ─────────────────────────────────────────────────────────────
   MODULE-LEVEL STATE
   ───────────────────────────────────────────────────────────── */
let tripSearchQuery = "";
const collapsedYears = new Set();

/* ─────────────────────────────────────────────────────────────
   ONLINE / OFFLINE STATUS
   ───────────────────────────────────────────────────────────── */
export function updateStatusIndicator(className, text) {
  ["status-indicator", "status-indicator-mobile"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const mobile = id === "status-indicator-mobile";
    el.className = "status-dot" + (mobile ? " status-dot-mobile" : "") + (className ? " " + className : "");
    el.textContent = text;
  });
}
export function _setStatusOnline() { updateStatusIndicator("", "Synced"); }
export function _setStatusOffline() { updateStatusIndicator("offline", "Offline"); }
export function _setStatusSyncing() { updateStatusIndicator("syncing", "Saving…"); }

/* ─────────────────────────────────────────────────────────────
   VIEW ROUTING
   ───────────────────────────────────────────────────────────── */
export function setView(viewName) {
  if (viewName === "more") return;
  state.currentView = viewName;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const el = document.getElementById("view-" + viewName);
  if (el) el.classList.add("active");
  document.querySelectorAll(".nav-item, .bottom-nav-item").forEach(b => {
    b.classList.toggle("active", b.dataset.view === viewName);
  });
  const titles = { dashboard: "Overview", itinerary: "Itinerary", guides: "Guides", budget: "Budget", expenses: "Expenses", documents: "Documents", disruption: "Disruptions", gallery: "Gallery" };
  document.getElementById("topbar-title").textContent = titles[viewName] || "Dashboard";
  if (viewName === "itinerary") {
    if (!pendingScrollTownId) {
      const todayIso = localDateStr(new Date());
      const { startDate, endDate } = state.trip || {};
      if (startDate && endDate && todayIso >= startDate && todayIso <= endDate) {
        setPendingScrollToToday(true);
      }
    }
    renderItinerary();
  }
  if (viewName === "guides") renderGuides();
  if (viewName === "budget") renderBudget();
  if (viewName === "expenses") renderExpenses();
  if (viewName === "documents") renderDocuments();
  if (viewName === "disruption") renderDisruption();
  if (viewName === "gallery") renderGallery();
}

/* ─────────────────────────────────────────────────────────────
   AUTH FLOW
   ───────────────────────────────────────────────────────────── */
export function showAuthScreen(errorMessage) {
  document.getElementById("boot-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.add("visible");
  document.getElementById("app").classList.remove("visible");
  document.getElementById("trips-screen")?.classList.remove("visible");
  const err = document.getElementById("auth-error");
  if (errorMessage) {
    err.textContent = errorMessage;
    err.classList.add("visible");
  } else {
    err.classList.remove("visible");
  }
}

export function showTripList() {
  document.getElementById("boot-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("visible");
  document.getElementById("app").classList.remove("visible");
  document.getElementById("view-share").classList.remove("visible");
  document.getElementById("trips-screen").classList.add("visible");
  localStorage.setItem("last-screen", "trips");
  renderSidebarTripList();
  renderTripCards();
}

export function showShareSection(showBack) {
  document.getElementById("boot-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("visible");
  document.getElementById("trips-screen").classList.remove("visible");
  document.getElementById("app").classList.remove("visible");
  document.getElementById("view-share").classList.add("visible");
  const backBtn = document.getElementById("sp-back-btn");
  if (backBtn) backBtn.style.display = showBack ? "" : "none";
}

export function showApp() {
  document.getElementById("boot-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("visible");
  document.getElementById("trips-screen").classList.remove("visible");
  document.getElementById("view-share").classList.remove("visible");
  document.getElementById("app").classList.add("visible");
  const backBtn = document.getElementById("sidebar-back-btn");
  if (backBtn) backBtn.style.display = "";
  const tripsPanel = document.getElementById("sidebar-trips-panel");
  if (tripsPanel) tripsPanel.style.display = "none";
}

export function setupUserChip(user) {
  const initials = user.photoURL
    ? `<img src="${user.photoURL}" alt="">`
    : escapeHtml((user.displayName || user.email || "?").charAt(0).toUpperCase());

  const avatar = document.getElementById("user-avatar");
  const name = document.getElementById("user-name");
  if (avatar) avatar.innerHTML = initials;
  if (name) name.textContent = user.displayName || user.email;

  const tAvatar = document.getElementById("trips-user-avatar");
  const tName = document.getElementById("trips-user-name");
  if (tAvatar) tAvatar.innerHTML = initials;
  if (tName) tName.textContent = user.displayName || user.email;
}

/* ─────────────────────────────────────────────────────────────
   EXIT TO TRIP LIST
   ───────────────────────────────────────────────────────────── */
export function exitToTripList() {
  cb.detachTripListeners();
  setActiveTripId(null);
  setState({ trip: null, towns: [], spots: [] });
  localStorage.removeItem("last-trip-id");
  showTripList();
}

/* ─────────────────────────────────────────────────────────────
   SITE-LEVEL CONFIG  (config/site Firestore doc)
   ───────────────────────────────────────────────────────────── */
export async function loadSiteConfig() {
  try {
    const snap = await getDoc(doc(db, "config", "site"));
    if (snap.exists()) {
      const d = snap.data();
      if (d.pexelsApiKey) PEXELS_CONFIG.apiKey = d.pexelsApiKey;
      if (d.geminiApiKey) GEMINI_CONFIG.apiKey = d.geminiApiKey;
    }
  } catch (err) {
    console.warn("Site config unavailable:", err);
  }
}

export function openSiteSettings() {
  document.getElementById("site-settings-gemini-key").value = GEMINI_CONFIG.apiKey || "";
  document.getElementById("site-settings-error").style.display = "none";
  const btn = document.getElementById("site-settings-save-btn");
  btn.textContent = "Save"; btn.disabled = false;

  const select = document.getElementById("site-settings-trip-select");
  select.innerHTML = '<option value="">Select a trip…</option>';
  (state.allTrips || []).forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name || "Untitled trip";
    select.appendChild(opt);
  });
  document.getElementById("site-settings-backfill-btn").disabled = true;
  document.getElementById("site-settings-backfill-hint").style.display = "none";

  document.getElementById("site-settings-backfill-section").style.display =
    PEXELS_CONFIG.apiKey ? "" : "none";

  document.getElementById("site-settings-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
  cb.pushModalHistory();
}

export function closeSiteSettings() {
  document.getElementById("site-settings-overlay").classList.remove("visible");
  document.body.style.overflow = "";
}

export async function saveSiteSettings() {
  const geminiKey = document.getElementById("site-settings-gemini-key").value.trim();
  const errEl = document.getElementById("site-settings-error");
  const btn = document.getElementById("site-settings-save-btn");
  errEl.style.display = "none";
  btn.textContent = "Saving…"; btn.disabled = true;
  try {
    await setDoc(doc(db, "config", "site"), { geminiApiKey: geminiKey }, { merge: true });
    GEMINI_CONFIG.apiKey = geminiKey;
    btn.textContent = "Saved!";
    setTimeout(() => closeSiteSettings(), 900);
  } catch (err) {
    btn.textContent = "Save"; btn.disabled = false;
    errEl.textContent = "Failed to save: " + (err.message || err.code || "permission denied");
    errEl.style.display = "block";
  }
}

/* ─────────────────────────────────────────────────────────────
   TRIP LIST RENDERERS
   ───────────────────────────────────────────────────────────── */
export function renderSidebarTripList() {
  const container = document.getElementById("trips-sidebar-list");
  if (!container) return;
  const ownedTrips  = state.allTrips.filter(t => t._role !== "shared");
  const sharedTrips = state.allTrips.filter(t => t._role === "shared");

  if (!ownedTrips.length && !sharedTrips.length) {
    container.innerHTML = `<div style="padding:12px;font-size:0.8125rem;color:var(--text-3);font-style:italic">No trips yet</div>`;
    return;
  }

  const itemHTML = (t, role) => {
    const sharedBy = role === "shared" ? (contactNameForEmail(t.createdBy) || t.createdBy || "") : "";
    return `
    <button class="trips-sidebar-item" data-trip-id="${escapeHtml(t.id)}" data-role="${role}">
      <div class="trips-sidebar-item-name">${escapeHtml(t.name)}</div>
      <div class="trips-sidebar-item-dates">${t.startDate ? fmtDateRange(t.startDate, t.endDate) : "Dates TBD"}</div>
      ${sharedBy ? `<div class="trips-sidebar-item-sharedby">Shared by ${escapeHtml(sharedBy)}</div>` : ""}
    </button>`;
  };

  let html = "";
  if (ownedTrips.length) {
    html += `<div class="trips-sidebar-section-label">My Trips</div>`;
    html += ownedTrips.map(t => itemHTML(t, "owner")).join("");
  }

  if (sharedTrips.length) {
    html += `<div class="trips-sidebar-section-label">Shared with me</div>`;
    html += sharedTrips.map(t => itemHTML(t, "shared")).join("");
  }

  container.innerHTML = html;

  container.querySelectorAll(".trips-sidebar-item").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.role === "shared") cb.openSharedTrip(btn.dataset.tripId);
      else cb.switchTrip(btn.dataset.tripId);
    });
  });
}

export function renderTripCards() {
  const grid = document.getElementById("trips-grid");
  if (!grid) return;
  const { allTrips } = state;

  const myTrips = allTrips.filter(t => t._role !== "shared");
  const sharedTrips = allTrips.filter(t => t._role === "shared");

  const q = tripSearchQuery.trim().toLowerCase();
  const filterFn = t => !q || t.name?.toLowerCase().includes(q) || t.cityNames?.some(c => c.toLowerCase().includes(q));
  const filteredMy = myTrips.filter(filterFn);
  const filteredShared = sharedTrips.filter(filterFn);

  if (!filteredMy.length && !filteredShared.length) {
    grid.innerHTML = allTrips.length
      ? `<div class="trips-empty"><div class="trips-empty-title">No results</div><p style="font-size:0.9375rem;margin-top:8px">No trips match "<em>${escapeHtml(q)}</em>".</p></div>`
      : `<div class="trips-empty"><div class="trips-empty-title">No trips yet</div><p style="font-size:0.9375rem;margin-top:8px">Create your first trip to get started.</p></div>`;
    return;
  }

  const cardHTML = t => {
    const photoUrls = Object.values(t.cityPhotos || {}).filter(Boolean).slice(0, 5);
    const imgArea = photoUrls.length
      ? `<div class="trip-card-collage">${photoUrls.map(url =>
          `<div class="trip-card-collage-strip"><img src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.closest('.trip-card-collage-strip').style.display='none'"></div>`
        ).join("")}</div>`
      : `<div class="trip-card-img-placeholder">${escapeHtml((t.name || "T").charAt(0))}</div>`;
    const actionEl = t._role === "shared"
      ? `<span class="trip-card-shared-badge">Shared</span>`
      : `<button class="trip-card-menu-btn" data-trip-id="${escapeHtml(t.id)}" title="Trip settings" aria-label="Trip settings">⋯</button>`;
    return `
    <div class="trip-card" data-trip-id="${escapeHtml(t.id)}" data-role="${escapeHtml(t._role || 'owner')}">
      <div class="trip-card-img">
        ${imgArea}
        ${actionEl}
      </div>
      <div class="trip-card-body">
        <div class="trip-card-name">${escapeHtml(t.name)}</div>
        <div class="trip-card-dates">${t.startDate ? fmtDateRange(t.startDate, t.endDate) : "Dates TBD"}</div>
        ${t.cityNames?.length ? `<div class="trip-card-cities">${t.cityNames.map(escapeHtml).join(" | ")}</div>` : ""}
        ${t._role === "shared" && t.createdBy ? `<div class="trip-card-sharedby">Shared by ${escapeHtml(contactNameForEmail(t.createdBy) || t.createdBy)}</div>` : ""}
        <div class="trip-card-meta"><span>${escapeHtml(t.currency || "")}</span></div>
      </div>
    </div>`;
  };

  let myHTML = "";
  if (filteredMy.length) {
    const byYear = {};
    filteredMy.forEach(t => {
      const year = t.startDate ? t.startDate.slice(0, 4) : "Upcoming";
      if (!byYear[year]) byYear[year] = [];
      byYear[year].push(t);
    });
    const years = Object.keys(byYear).sort((a, b) => {
      if (a === "Upcoming") return -1;
      if (b === "Upcoming") return 1;
      return Number(b) - Number(a);
    });
    myHTML = years.map(year => {
      const collapsed = collapsedYears.has(year);
      return `
        <div class="trips-year-section" data-year="${escapeHtml(year)}">
          <div class="trips-year-header">
            <span class="trips-year-label">${escapeHtml(year)}</span>
            <span class="trips-year-count">${byYear[year].length}</span>
            <svg class="trips-year-chevron${collapsed ? " collapsed" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="trips-year-cards${collapsed ? " hidden" : ""}">${byYear[year].map(cardHTML).join("")}</div>
        </div>`;
    }).join("");
  }

  let sharedHTML = "";
  if (filteredShared.length) {
    sharedHTML = `
      <div class="trips-section-header">Shared with me</div>
      <div class="trips-year-cards">${filteredShared.map(cardHTML).join("")}</div>`;
  }

  const myHeader = filteredMy.length && filteredShared.length
    ? `<div class="trips-section-header">My Trips</div>`
    : "";

  grid.innerHTML = myHeader + myHTML + sharedHTML;

  grid.querySelectorAll(".trips-year-header").forEach(header => {
    header.addEventListener("click", () => {
      const year = header.closest(".trips-year-section").dataset.year;
      if (collapsedYears.has(year)) collapsedYears.delete(year);
      else collapsedYears.add(year);
      renderTripCards();
    });
  });
  grid.querySelectorAll(".trip-card").forEach(card => {
    card.addEventListener("click", () => {
      if (card.dataset.role === "shared") cb.openSharedTrip(card.dataset.tripId);
      else cb.switchTrip(card.dataset.tripId);
    });
  });
  grid.querySelectorAll(".trip-card-menu-btn").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); openTripSettings(btn.dataset.tripId); });
  });
}

export function renderMobileTripList() {
  const container = document.getElementById("trips-mobile-list");
  if (!container) return;
  const { allTrips } = state;

  const q = tripSearchQuery.trim().toLowerCase();
  const filtered = q
    ? allTrips.filter(t =>
        t.name?.toLowerCase().includes(q) ||
        t.cityNames?.some(c => c.toLowerCase().includes(q)))
    : allTrips;

  if (!filtered.length) {
    container.innerHTML = allTrips.length
      ? `<div style="text-align:center;padding:40px 24px;color:var(--text-2);font-style:italic">No trips match "<em>${escapeHtml(q)}</em>"</div>`
      : `<div style="text-align:center;padding:40px 24px;color:var(--text-2);font-style:italic">No trips yet</div>`;
    return;
  }

  const byYear = {};
  filtered.forEach(t => {
    const year = t.startDate ? t.startDate.slice(0, 4) : "Upcoming";
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(t);
  });
  const years = Object.keys(byYear).sort((a, b) => {
    if (a === "Upcoming") return -1;
    if (b === "Upcoming") return 1;
    return Number(b) - Number(a);
  });

  const mobileCardHTML = t => {
    const photoUrls = Object.values(t.cityPhotos || {}).filter(Boolean).slice(0, 3);
    const thumbArea = photoUrls.length
      ? `<div class="trips-mobile-card-thumb">${photoUrls.map(url =>
          `<div class="trips-mobile-card-thumb-strip"><img src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.closest('.trips-mobile-card-thumb-strip').style.display='none'"></div>`
        ).join("")}</div>`
      : `<div class="trips-mobile-card-thumb"><div class="trips-mobile-card-thumb-placeholder">${escapeHtml((t.name || "T").charAt(0))}</div></div>`;
    return `
    <div class="trips-mobile-card" data-trip-id="${escapeHtml(t.id)}">
      ${thumbArea}
      <div class="trips-mobile-card-info">
        <div class="trips-mobile-card-name">${escapeHtml(t.name)}</div>
        <div class="trips-mobile-card-dates">${t.startDate ? fmtDateRange(t.startDate, t.endDate) : "Dates TBD"}</div>
        ${t.cityNames?.length ? `<div class="trips-mobile-card-cities">${t.cityNames.map(escapeHtml).join(" | ")}</div>` : ""}
      </div>
      <button class="trips-mobile-card-menu-btn" data-trip-id="${escapeHtml(t.id)}" title="Trip settings" aria-label="Trip settings">⋯</button>
    </div>`;
  };

  container.innerHTML = years.map(year => {
    const collapsed = collapsedYears.has(year);
    return `
      <div class="trips-mobile-year-section" data-year="${escapeHtml(year)}">
        <div class="trips-mobile-year-header">
          <span class="trips-year-label">${escapeHtml(year)}</span>
          <span class="trips-year-count">${byYear[year].length}</span>
          <svg class="trips-year-chevron${collapsed ? " collapsed" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="trips-mobile-year-cards${collapsed ? " hidden" : ""}">${byYear[year].map(mobileCardHTML).join("")}</div>
      </div>`;
  }).join("");

  container.querySelectorAll(".trips-mobile-year-header").forEach(header => {
    header.addEventListener("click", () => {
      const year = header.closest(".trips-mobile-year-section").dataset.year;
      if (collapsedYears.has(year)) collapsedYears.delete(year);
      else collapsedYears.add(year);
      renderMobileTripList();
    });
  });
  container.querySelectorAll(".trips-mobile-card").forEach(card => {
    card.addEventListener("click", () => {
      closeMobileTripOverlay();
      cb.switchTrip(card.dataset.tripId);
    });
  });
  container.querySelectorAll(".trips-mobile-card-menu-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMobileTripOverlay();
      openTripSettings(btn.dataset.tripId);
    });
  });
}

function openMobileTripOverlay() {
  showTripList();
  history.pushState({ weyageTripsOverlay: true }, "");
}
function closeMobileTripOverlay() {
  // Kept for call-site compatibility; trips-screen is hidden by showApp() / switchTrip()
}

export function renderSidebarTowns() {
  const container = document.getElementById("sidebar-towns");
  container.innerHTML = state.towns.map(t => `
    <button class="nav-item" data-town="${t.id}">
      <span class="town-dot"></span>
      ${escapeHtml(t.name)}
    </button>
  `).join("");
  container.querySelectorAll(".nav-item[data-town]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (state.currentView === "itinerary") {
        const target = document.getElementById(`itinerary-town-${btn.dataset.town}`);
        const main = document.querySelector(".main");
        if (target && main) {
          const top = main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top - 80;
          main.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      } else {
        setPendingScrollTownId(btn.dataset.town);
        setView("itinerary");
      }
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   HELP / ONBOARDING OVERLAY
   ───────────────────────────────────────────────────────────── */
const ONBOARDING_KEY = "weyage-onboarding-v1";

export function openHelpOverlay() {
  document.getElementById("help-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
  cb.pushModalHistory();
}

export function closeHelpOverlay() {
  document.getElementById("help-overlay").classList.remove("visible");
  document.body.style.overflow = "";
  localStorage.setItem(ONBOARDING_KEY, "1");
}

export function showOnboardingIfNeeded() {
  if (!localStorage.getItem(ONBOARDING_KEY)) {
    setTimeout(openHelpOverlay, 900);
  }
}

/* ─────────────────────────────────────────────────────────────
   TRIP CREATION
   ───────────────────────────────────────────────────────────── */
export function openCreateTripModal() {
  const overlay = document.getElementById("create-trip-overlay");
  if (!overlay) return;
  document.getElementById("ct-name").value = "";
  document.getElementById("ct-start").value = "";
  document.getElementById("ct-end").value = "";
  const ctCurrSel = document.getElementById("ct-currency");
  ctCurrSel.innerHTML = CURRENCY_LIST.map(c =>
    `<option value="${c.code}"${c.code === "EUR" ? " selected" : ""}>${c.label}</option>`
  ).join("");
  document.getElementById("ct-error").style.display = "none";
  overlay.classList.add("visible");
  document.getElementById("ct-name").focus();
  history.pushState({ weyageModal: true }, "");
}

function closeCreateTripModal() {
  document.getElementById("create-trip-overlay").classList.remove("visible");
}

async function saveNewTrip() {
  const name = document.getElementById("ct-name").value.trim();
  const startDate = document.getElementById("ct-start").value;
  const endDate = document.getElementById("ct-end").value;
  const currency = document.getElementById("ct-currency").value;
  const errEl = document.getElementById("ct-error");

  if (!name) { errEl.textContent = "Trip name is required."; errEl.style.display = "block"; return; }
  if (!startDate || !endDate) { errEl.textContent = "Start and end dates are required."; errEl.style.display = "block"; return; }
  if (endDate < startDate) { errEl.textContent = "End date must be after start date."; errEl.style.display = "block"; return; }

  errEl.style.display = "none";
  const saveBtn = document.getElementById("create-trip-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Creating…";

  try {
    const year = new Date(startDate + "T00:00:00").getFullYear();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const tripId = `${slug}-${year}`;

    await setDoc(doc(db, "trips", tripId), {
      name,
      startDate,
      endDate,
      currency,
      allowedUsers: [state.user.email.toLowerCase()],
      createdBy: state.user.email.toLowerCase(),
      tags: ["Must-Try", "Hidden Gem", "Local Favourite", "Splurge", "Reservation", "Booked"],
      paymentMethods: ["Card", "Cash"],
      categories: ["Food", "Sights", "Transport", "Lodging", "Shopping", "Other"],
      createdAt: serverTimestamp(),
    });

    closeCreateTripModal();
    cb.switchTrip(tripId);
  } catch (err) {
    console.error("Create trip failed:", err);
    errEl.textContent = "Failed to create trip: " + (err.message || err.code);
    errEl.style.display = "block";
    saveBtn.disabled = false;
    saveBtn.textContent = "Create trip";
  }
}

/* ─────────────────────────────────────────────────────────────
   INIT — wire all UI event listeners
   ───────────────────────────────────────────────────────────── */
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

export function initUI() {
  // Nav items
  document.querySelectorAll(".nav-item, .bottom-nav-item").forEach(btn => {
    if (btn.dataset.view) btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  // Mobile "More" sheet
  const moreSheet = document.getElementById("mobile-more-sheet");
  document.getElementById("mobile-more-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "";
  });
  document.getElementById("mobile-more-backdrop")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
  });
  document.getElementById("sheet-expenses-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
    setView("expenses");
  });
  document.getElementById("sheet-documents-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
    setView("documents");
  });
  document.getElementById("sheet-disruption-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
    setView("disruption");
  });
  document.getElementById("sheet-gallery-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
    setView("gallery");
  });

  // Gallery lightbox + upload modal
  try { initGalleryLightbox(); } catch (e) { console.error("Gallery lightbox init:", e); }
  try { initUploadModal(); } catch (e) { console.error("Gallery upload modal init:", e); }
  initContactsPanel();
  document.getElementById("upload-cancel-btn")?.addEventListener("click", closeUploadModal);

  // Online / offline status
  window.addEventListener("online", () => { state.online = true; _setStatusOnline(); });
  window.addEventListener("offline", () => { state.online = false; _setStatusOffline(); });

  // Auth buttons
  document.getElementById("google-signin").addEventListener("click", async () => {
    if (!isConfigured()) {
      showAuthScreen("Firebase isn't configured yet. Open this file in an editor and follow the SETUP.md instructions, then add your Firebase config and your two Google emails.");
      return;
    }
    const btn = document.getElementById("google-signin");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
      // Popup closed — show spinner while onAuthStateChanged fires and app loads
      btnLoading(btn, "Signing in…");
    } catch (err) {
      console.error(err);
      btnReset(btn);
      showAuthScreen("Sign-in failed: " + (err.message || err.code));
    }
  });
  document.getElementById("signout-btn").addEventListener("click", () => signOut(auth));
  document.getElementById("sp-back-btn")?.addEventListener("click", () => {
    if (document.getElementById("sp-back-btn").dataset.spMode === "url-share") {
      location.href = location.pathname;
    } else {
      cb.detachTripListeners();
      setActiveTripId(null);
      setState({ trip: null, towns: [], spots: [] });
      showTripList();
    }
  });

  // Help overlay
  document.getElementById("help-close-btn")?.addEventListener("click", closeHelpOverlay);
  document.getElementById("help-done-btn")?.addEventListener("click", closeHelpOverlay);
  document.getElementById("help-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("help-overlay")) closeHelpOverlay();
  });

  // Photo picker buttons
  document.getElementById("photo-picker-close")?.addEventListener("click", () => closePhotoPicker(true));
  document.getElementById("photo-picker-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("photo-picker-overlay")) closePhotoPicker(true);
  });
  document.getElementById("photo-picker-skip")?.addEventListener("click", () => closePhotoPicker(false));

  // Site settings
  document.getElementById("trips-site-settings-btn")?.addEventListener("click", openSiteSettings);
  document.getElementById("trips-site-settings-btn-mobile")?.addEventListener("click", openSiteSettings);
  document.getElementById("site-settings-close")?.addEventListener("click", closeSiteSettings);
  document.getElementById("site-settings-cancel-btn")?.addEventListener("click", closeSiteSettings);
  document.getElementById("site-settings-save-btn")?.addEventListener("click", saveSiteSettings);
  document.getElementById("site-settings-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("site-settings-overlay")) closeSiteSettings();
  });
  document.getElementById("site-settings-trip-select")?.addEventListener("change", (e) => {
    document.getElementById("site-settings-backfill-btn").disabled = !e.target.value;
  });
  document.getElementById("site-settings-backfill-btn")?.addEventListener("click", () => {
    const tripId = document.getElementById("site-settings-trip-select").value;
    startBackfillForTrip(tripId);
  });

  // Sidebar help button (desktop)
  document.getElementById("sidebar-help-btn")?.addEventListener("click", openHelpOverlay);

  // Mobile hamburger help button
  document.getElementById("sheet-help-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
    openHelpOverlay();
  });

  // Trip creation
  document.getElementById("create-trip-close")?.addEventListener("click", closeCreateTripModal);
  document.getElementById("create-trip-cancel")?.addEventListener("click", closeCreateTripModal);
  document.getElementById("create-trip-save")?.addEventListener("click", saveNewTrip);
  document.getElementById("create-trip-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCreateTripModal();
  });

  // Guides search + generate all
  const debouncedRenderGuides = debounce(() => renderGuides(), 250);
  document.getElementById("guides-search")?.addEventListener("input", debouncedRenderGuides);
  document.getElementById("guides-generate-all-btn")?.addEventListener("click", () => generateAllGuides());

  // Documents search
  const debouncedRenderDocuments = debounce(() => renderDocuments(), 250);
  document.getElementById("docs-search")?.addEventListener("input", e => {
    const clearBtn = document.getElementById("docs-search-clear");
    if (clearBtn) clearBtn.style.display = e.target.value ? "" : "none";
    debouncedRenderDocuments();
  });
  document.getElementById("docs-search-clear")?.addEventListener("click", () => {
    const input = document.getElementById("docs-search");
    if (input) { input.value = ""; input.dispatchEvent(new Event("input")); input.focus(); }
  });

  // Share buttons
  ["sidebar-share-btn", "sheet-share-btn"].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => generateAndCopyShareLink(btn));
  });

  // Sidebar back → trip list
  document.getElementById("sidebar-back-btn")?.addEventListener("click", exitToTripList);

  // Mobile "All Trips" sheet button
  document.getElementById("sheet-all-trips-btn")?.addEventListener("click", () => {
    moreSheet.style.display = "none";
    openMobileTripOverlay();
  });

  // Contacts page (desktop sidebar nav + mobile heading drawer)
  function _closeTopDrawer() {
    const drawer = document.getElementById("trips-top-drawer");
    if (drawer) drawer.style.display = "none";
    document.getElementById("trips-heading-dropdown-btn")?.setAttribute("aria-expanded", "false");
  }

  function _setTripsPageActive(isContacts) {
    _closeTopDrawer();
    document.getElementById("trips-contacts-nav-btn")?.classList.toggle("trips-sidebar-page-btn-active", isContacts);
    document.getElementById("trips-nav-trips-btn")?.classList.toggle("trips-sidebar-page-btn-active", !isContacts);
    document.getElementById("ttd-contacts")?.classList.toggle("ttd-active", isContacts);
    document.getElementById("ttd-trips")?.classList.toggle("ttd-active", !isContacts);
    const lbl = document.getElementById("trips-heading-label");
    if (lbl) lbl.textContent = isContacts ? "Contacts" : "My Trips";
  }

  function openContactsPage() {
    renderContactsPanel();
    _setTripsPageActive(true);
    document.getElementById("trips-contacts-page").style.display = "flex";
    document.getElementById("trips-main").style.display = "none";
  }
  function closeContactsPage() {
    _setTripsPageActive(false);
    document.getElementById("trips-contacts-page").style.display = "none";
    document.getElementById("trips-main").style.display = "";
  }

  // Heading dropdown toggle
  document.getElementById("trips-heading-dropdown-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const drawer = document.getElementById("trips-top-drawer");
    const isOpen = drawer.style.display !== "none";
    drawer.style.display = isOpen ? "none" : "";
    document.getElementById("trips-heading-dropdown-btn").setAttribute("aria-expanded", String(!isOpen));
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("trips-mobile-heading-wrap")?.contains(e.target)) _closeTopDrawer();
  });

  document.getElementById("trips-nav-trips-btn")?.addEventListener("click", closeContactsPage);
  document.getElementById("trips-contacts-nav-btn")?.addEventListener("click", openContactsPage);
  document.getElementById("tcp-back-btn")?.addEventListener("click", closeContactsPage);
  document.getElementById("ttd-trips")?.addEventListener("click", closeContactsPage);
  document.getElementById("ttd-contacts")?.addEventListener("click", openContactsPage);

  // Trips screen buttons
  document.getElementById("trips-new-btn-sidebar")?.addEventListener("click", () => { closeContactsPage(); openCreateTripModal(); });
  document.getElementById("trips-new-btn-main")?.addEventListener("click", openCreateTripModal);
  document.getElementById("trips-signout-btn")?.addEventListener("click", () => signOut(auth));
  document.getElementById("trips-main-signout-btn")?.addEventListener("click", () => signOut(auth));
  const debouncedRenderTripCards = debounce(() => renderTripCards(), 250);
  document.getElementById("trips-search-input")?.addEventListener("input", e => {
    tripSearchQuery = e.target.value;
    debouncedRenderTripCards();
  });
}
