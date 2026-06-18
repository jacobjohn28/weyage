// Firebase SDK is loaded via dynamic import inside initFirebase().
import { FIREBASE_CONFIG, GEMINI_CONFIG, PEXELS_CONFIG } from "./config.js";
import { db, auth, initFirebase, isConfigured, doc, getDoc, setDoc, updateDoc, deleteDoc,
         collection, getDocs, onSnapshot, writeBatch, serverTimestamp, arrayUnion, addDoc,
         query, where, arrayRemove, deleteField,
         GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, signInAnonymously } from "./firebase.js";
import { state, subscribe, notify, setState, activeTripId, setActiveTripId, _tripSettingsId, setTripSettingsId } from "./state.js";
import { applyTheme, initTheme } from "./theme.js";
import { localDateStr, fmtDateRange, fmtSpreadDates, nightsBetween, daysUntil, fmtTime12, fmtDayHeader, escapeHtml, emailToName, mapsLink, mapsSearchBtn, linkifyNotes, wirePhoneCopyBtns, typeIconSVG } from "./utils.js";
import { registerPhotoCallbacks, getPendingBackfill, setPendingBackfill,
         extractTripDestination, resolveTownImage, fetchPexelsPhotos,
         closePhotoPicker, startBackfillForTrip, startPhotoBackfill, openPhotoPicker } from "./photos.js";
import { registerDashboardCallbacks, renderDashboardTowns, renderDashboardMeta, renderDashboardToday, generateCityBriefing } from "./dashboard.js";
import { registerGuidesCallbacks, generateSpotGuide, generateAllGuides, renderGuides, TYPE_COLORS } from "./guides.js";
import { registerDocumentCallbacks, addAttachment, toggleAttachmentPin, deleteAttachment, renderDocuments, openLightbox, lbClose, initLightbox } from "./documents.js";
import { registerDisruptionCallbacks, updateDisruptionBadge, renderDisruption } from "./disruption.js";
import {
  registerBudgetCallbacks, refreshBudgetDrawer,
  aggregateBudget, renderBudget, renderExpenses,
  initBudget, openTownEditModal, CURRENCY_LIST,
} from "./budget.js";
import {
  registerItineraryCallbacks, initItinerary,
  renderItinerary, openDrawer, openAccomDrawer, closeDrawer,
  openModal, openAccomModal, closeModal,
  toggleSpotVisited, saveSpot, spotDocRef,
  currentDrawerSpot, currentDrawerAccomTownId, currentDrawerBudgetMode,
  setCurrentDrawerBudgetMode, setCurrentDrawerSpot, setCurrentDrawerAccomTownId,
  pendingScrollTownId, pendingScrollToToday, pendingGuideSpotId,
  setPendingScrollTownId, setPendingScrollToToday, setPendingGuideSpotId,
} from "./itinerary.js";
import {
  registerShareCallbacks, initSharedView, generateAndCopyShareLink,
  renderSharePage, showInvalidShareLink,
} from "./share.js";
import {
  registerSettingsCallbacks, initSettings,
  openTripSettings, closeTripSettings, saveTripSettings,
  addTripCollaborator, deleteTripFromSettings,
  membersWithCollaborators, MEMBER_COLORS,
} from "./settings.js";
import {
  showKeyEntryForm, openRecommendationsPanel, closeRecommendationsPanel,
  initRecommendations,
} from "./recommendations.js";
import {
  registerUiCallbacks, initUI, setView,
  showAuthScreen, showTripList, showShareSection, showApp,
  setupUserChip, exitToTripList, loadSiteConfig,
  openSiteSettings, closeSiteSettings, saveSiteSettings,
  renderSidebarTripList, renderTripCards, renderSidebarTowns,
  openHelpOverlay, closeHelpOverlay, showOnboardingIfNeeded,
  openCreateTripModal,
  _setStatusOnline, _setStatusSyncing,
} from "./ui.js";

/* ─────────────────────────────────────────────────────────────
   FIRESTORE: SEED + LISTEN
   ───────────────────────────────────────────────────────────── */

// Listener unsubscribe handles — stored so we can detach when switching trips
let _tripUnsub = null, _townsUnsub = null, _spotsUnsub = null, _expensesUnsub = null;
let _allTripsUnsub = null;
let _sharedTripsUnsub = null;
let _myOwnedTrips = [], _mySharedTrips = [];
// Tracks trips that have already had the one-time cityPhotos migration run this session
const _migratedCityPhotos = new Set();

function detachTripListeners() {
  _tripUnsub?.(); _townsUnsub?.(); _spotsUnsub?.(); _expensesUnsub?.();
  _tripUnsub = _townsUnsub = _spotsUnsub = _expensesUnsub = null;
  setState({ expenses: [] });
}

function listenToTrip(tripId) {
  // Trip document — watch metadata for pending-writes sync indicator
  _tripUnsub = onSnapshot(doc(db, "trips", tripId), { includeMetadataChanges: true }, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      setState({ trip: { id: snap.id, ...data } });
      // Update sidebar brand with trip name
      const brandName = document.getElementById("sidebar-trip-name");
      if (brandName) brandName.textContent = data.name || "Trip";
    }
    if (snap.metadata.hasPendingWrites) {
      _setStatusSyncing();
    } else if (state.online) {
      _setStatusOnline();
    }
  });
  // Towns subcollection
  _townsUnsub = onSnapshot(
    collection(db, "trips", tripId, "towns"),
    (snap) => {
      const towns = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      towns.sort((a, b) => (a.order || 0) - (b.order || 0));
      setState({ towns });
      if (getPendingBackfill() && towns.length > 0) {
        setPendingBackfill(false);
        setTimeout(startPhotoBackfill, 600);
      }
      // Sync cityNames onto the trip doc so the trips list can display them without extra fetches.
      const names = towns.map(t => t.name);
      const existing = state.allTrips.find(t => t.id === tripId);
      if (!existing || JSON.stringify(existing.cityNames) !== JSON.stringify(names)) {
        updateDoc(doc(db, "trips", tripId), { cityNames: names }).catch(() => {});
      }
      // One-time migration: populate cityPhotos on the trip doc from existing town photoUrls.
      // Guard with a session-level Set so this never fires more than once per trip per session,
      // regardless of how many snapshot updates arrive.
      if (existing && !existing.cityPhotos && !_migratedCityPhotos.has(tripId)) {
        _migratedCityPhotos.add(tripId);
        const photoMap = {};
        towns.forEach(t => { if (t.photoUrl) photoMap[t.id] = t.photoUrl; });
        if (Object.keys(photoMap).length) {
          updateDoc(doc(db, "trips", tripId), { cityPhotos: photoMap }).catch(() => {});
        }
      }
    },
    (err) => {
      console.error("Towns listener error — check Firestore subcollection rules:", err.code);
      if (state.shareMode) {
        // Shared view: towns subcollection is not readable by anonymous users.
        // The Firestore rules need a match for /trips/{tripId}/towns/{townId} that allows
        // reads when the parent trip has a shareToken.
        const main = document.querySelector(".main");
        if (main) main.innerHTML = `
          <div style="padding:48px 24px;text-align:center;color:var(--text-2);max-width:480px;margin:0 auto">
            <p style="font-size:1rem;font-weight:500;margin-bottom:8px">Couldn't load this shared trip</p>
            <p style="font-size:0.875rem;color:var(--text-3)">The Firestore security rules need to be updated to allow shared viewing of cities and spots. Ask the trip owner to check the setup guide.</p>
          </div>`;
      }
    }
  );
  // Spots subcollection
  _spotsUnsub = onSnapshot(
    collection(db, "trips", tripId, "spots"),
    (snap) => {
      const spots = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setState({ spots });
      // Keep disruption nav badge fresh on every spots update
      updateDisruptionBadge();
      // Re-render disruption hub if it's the active view
      if (state.currentView === "disruption") renderDisruption();
    },
    (err) => {
      console.error("Spots listener error — check Firestore subcollection rules:", err.code);
    }
  );
  // Standalone expenses subcollection
  _expensesUnsub = onSnapshot(
    collection(db, "trips", tripId, "expenses"),
    (snap) => {
      const expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      expenses.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      setState({ expenses });
      if (state.currentView === "budget") renderBudget();
      if (state.currentView === "expenses") renderExpenses();
      // Keep open budget drawer in sync (e.g. after save/edit)
      if (document.getElementById("spot-drawer-overlay")?.classList.contains("visible") && currentDrawerBudgetMode) {
        refreshBudgetDrawer();
      }
    },
    (err) => {
      console.error("Expenses listener error:", err.code);
    }
  );
}

// ── All-trips listener ──────────────────────────────────────────────────────
// Attaches once after login, stays alive for the whole session.
// On the first snapshot it decides where to route the user.
let _initialTripRouted = false;

function _mergeAllTrips() {
  const ownedIds = new Set(_myOwnedTrips.map(t => t.id));
  const merged = [
    ..._myOwnedTrips.map(t => ({ ...t, _role: "owner" })),
    ..._mySharedTrips
      .filter(t => !ownedIds.has(t.id))
      .map(t => ({ ...t, _role: "shared" })),
  ];
  setState({ allTrips: merged });
}

function listenToAllTrips(userEmail) {
  _myOwnedTrips = [];
  _mySharedTrips = [];
  const email = userEmail.toLowerCase();

  // Query 1: trips where user is an owner / collaborator
  const q1 = query(collection(db, "trips"), where("allowedUsers", "array-contains", email));
  _allTripsUnsub = onSnapshot(q1, (snap) => {
    _myOwnedTrips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _myOwnedTrips.sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
    _mergeAllTrips();

    if (!_initialTripRouted) {
      _initialTripRouted = true;
      const lastId = localStorage.getItem("last-trip-id");
      const lastScreen = localStorage.getItem("last-screen");
      if (lastScreen === "trips") {
        showTripList();
      } else if (lastId && _myOwnedTrips.find(t => t.id === lastId)) {
        switchTrip(lastId);
      } else if (_myOwnedTrips.length === 1) {
        switchTrip(_myOwnedTrips[0].id);
      } else {
        showTripList();
      }
      showOnboardingIfNeeded();
    } else {
      if (!activeTripId) {
        renderSidebarTripList();
        renderTripCards();
      }
    }
  });

  // Query 2: trips shared with this user via share link (view-only)
  const q2 = query(collection(db, "trips"), where("shareViewers", "array-contains", email));
  _sharedTripsUnsub = onSnapshot(q2, (snap) => {
    _mySharedTrips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _mergeAllTrips();
    if (_initialTripRouted && !activeTripId) {
      renderTripCards();
    }
  }, (err) => {
    // Index may not exist yet — fail silently; owned trips still work
    console.warn("shareViewers query:", err.code);
  });
}

// ── Switch into a trip ──────────────────────────────────────────────────────
function switchTrip(tripId) {
  detachTripListeners();
  setActiveTripId(tripId);
  setState({ trip: null, towns: [], spots: [] });
  localStorage.setItem("last-trip-id", tripId);
  localStorage.removeItem("last-screen");
  listenToTrip(tripId);
  showApp();
}

// Waits for the trip document AND towns AND spots snapshots to all fire at least once
// before calling callback — prevents renderSharePage from running with empty subcollection data.
// Falls back after 3 s so the page still renders even if subcollection reads are denied.
function _waitForShareData(prevTowns, prevSpots, callback) {
  let tripFired = false, townsFired = false, spotsFired = false, rendered = false;
  const doRender = () => {
    if (rendered) return;
    rendered = true;
    clearTimeout(timeout);
    unsub();
    callback();
  };
  const timeout = setTimeout(doRender, 3000);
  const unsub = subscribe(() => {
    if (state.trip) tripFired = true;
    if (state.towns !== prevTowns) townsFired = true;
    if (state.spots !== prevSpots) spotsFired = true;
    if (tripFired && townsFired && spotsFired) doRender();
  });
}

function openSharedTrip(tripId) {
  detachTripListeners();
  setActiveTripId(tripId);
  setState({ trip: null, towns: [], spots: [] });
  document.getElementById("sp-page").innerHTML =
    `<div style="padding:60px 20px;text-align:center;color:var(--text-2)">Loading…</div>`;
  showShareSection(true);
  const prevTowns = state.towns;
  const prevSpots = state.spots;
  listenToTrip(tripId);
  _waitForShareData(prevTowns, prevSpots, () => {
    renderSharePage(state.user, state.trip?.allowedUsers || []);
  });
}

/* ─────────────────────────────────────────────────────────────
   SUBSCRIBE — re-render on state changes
   ───────────────────────────────────────────────────────────── */
subscribe(() => {
  renderSidebarTowns();
  renderDashboardTowns();
  renderDashboardMeta();
  renderDashboardToday();
  if (state.currentView === "itinerary") renderItinerary();
  if (state.currentView === "guides") renderGuides();
  if (state.currentView === "budget") renderBudget();
  if (state.currentView === "expenses") renderExpenses();
  if (state.currentView === "documents") renderDocuments();
  // Keep drawer in sync if it's open and the spot was updated
  if (currentDrawerSpot) {
    const updated = state.spots.find(s => s.id === currentDrawerSpot.id);
    if (updated) openDrawer(updated);
    else closeDrawer();
  }
  if (currentDrawerAccomTownId) {
    const updatedTown = state.towns.find(t => t.id === currentDrawerAccomTownId);
    if (updatedTown?.accommodation?.name) openAccomDrawer(updatedTown);
    else closeDrawer();
  }
});

/* ─────────────────────────────────────────────────────────────
   MODAL HISTORY (back-gesture interception)
   ───────────────────────────────────────────────────────────── */
let _handlingPopstate = false;

function pushModalHistory() {
  history.pushState({ weyageModal: true }, "");
}

function popModalHistory() {
  if (!_handlingPopstate && history.state?.weyageModal) {
    history.back();
  }
}

window.addEventListener("popstate", () => {
  _handlingPopstate = true;
  try {
    if (document.getElementById("trips-screen")?.classList.contains("visible")) {
      if (activeTripId) {
        localStorage.removeItem("last-screen");
        showApp();
      }
      return;
    }
    if (document.getElementById("site-settings-overlay")?.classList.contains("visible")) {
      closeSiteSettings(); return;
    }
    if (document.getElementById("photo-picker-overlay")?.classList.contains("visible")) {
      closePhotoPicker(true); return;
    }
    if (document.getElementById("help-overlay")?.classList.contains("visible")) {
      closeHelpOverlay(); return;
    }
    const lb = document.getElementById("lightbox-overlay");
    if (lb?.classList.contains("open")) { lbClose(); return; }
    const transit = document.getElementById("transit-overlay");
    if (transit?.classList.contains("open")) { transit.classList.remove("open"); return; }
    const visitPrice = document.getElementById("visit-price-overlay");
    if (visitPrice?.classList.contains("open")) { visitPrice.classList.remove("open"); return; }
    const tripSettings = document.getElementById("trip-settings-overlay");
    if (tripSettings?.classList.contains("visible")) { closeTripSettings(); return; }
    const drawer = document.getElementById("spot-drawer-overlay");
    if (drawer?.classList.contains("visible")) { closeDrawer(); return; }
  } finally {
    _handlingPopstate = false;
  }
});

/* ─────────────────────────────────────────────────────────────
   APP INIT
   ───────────────────────────────────────────────────────────── */
// Wire up callbacks for modules that have forward references
registerPhotoCallbacks({ closeSiteSettings, switchTrip, pushModalHistory });
registerDashboardCallbacks({
  openTownEditModal,
  setView,
  setPendingScrollTownId,
  aggregateBudget,
  toggleSpotVisited,
});
registerGuidesCallbacks({
  spotDocRef,
  showKeyEntryForm,
  getPendingGuideSpotId: () => pendingGuideSpotId,
  setPendingGuideSpotId,
});
registerDocumentCallbacks({
  pushModalHistory,
  popModalHistory,
  setView,
  setPendingScrollTownId,
});
registerDisruptionCallbacks({ spotDocRef });
registerBudgetCallbacks({
  pushModalHistory,
  popModalHistory,
  getDrawerBudgetMode: () => currentDrawerBudgetMode,
  setDrawerBudgetMode: setCurrentDrawerBudgetMode,
  clearDrawerContext: () => { setCurrentDrawerSpot(null); setCurrentDrawerAccomTownId(null); },
  openModal,
  openAccomModal,
  openPhotoPicker,
});
registerItineraryCallbacks({
  pushModalHistory,
  popModalHistory,
  setView,
  openRecommendationsPanel,
});
registerShareCallbacks({
  showShareSection,
  listenToTrip,
  waitForShareData: _waitForShareData,
});
registerUiCallbacks({ pushModalHistory, switchTrip, openSharedTrip, detachTripListeners });
registerSettingsCallbacks({ exitToTripList });
initLightbox();
initBudget();
initItinerary();
initSettings();
initRecommendations();
initUI();

async function init() {
  initTheme();
  _setStatusOnline();

  // Share link: skip auth, show read-only itinerary
  const shareToken = new URLSearchParams(location.search).get("share");
  if (shareToken) {
    await initSharedView(shareToken);
    return;
  }

  if (!isConfigured()) {
    showAuthScreen("Setup required: open this file and fill in FIREBASE_CONFIG. See SETUP.md for the full walkthrough.");
    return;
  }

  await initFirebase();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Detach all listeners on sign-out so they don't bleed into the next session
      detachTripListeners();
      _allTripsUnsub?.();
      _allTripsUnsub = null;
      _sharedTripsUnsub?.();
      _sharedTripsUnsub = null;
      _myOwnedTrips = [];
      _mySharedTrips = [];
      setActiveTripId(null);
      setState({ user: null, trip: null, towns: [], spots: [], allTrips: [] });
      showAuthScreen();
      return;
    }
    try {
      const approvalSnap = await getDoc(doc(db, "appUsers", user.email.toLowerCase()));
      if (!approvalSnap.exists()) {
        await signOut(auth);
        showAuthScreen(`${user.email} doesn't have access yet. Ask the owner to add you in Firebase.`);
        return;
      }
    } catch (err) {
      await signOut(auth);
      showAuthScreen("Couldn't verify access. Check your connection and try again.");
      return;
    }
    setState({ user });
    setupUserChip(user);
    _initialTripRouted = false;
    loadSiteConfig(); // load global Pexels key (non-blocking)
    // listenToAllTrips fires first snapshot quickly (IndexedDB cache).
    // On first snapshot it routes to last trip or trip list automatically.
    listenToAllTrips(user.email);
  });
}

init().catch((err) => {
  console.error("Boot error:", err);
  showAuthScreen("Couldn't start the app: " + (err.message || err.code || err));
});
