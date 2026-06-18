/* ─────────────────────────────────────────────────────────────
   STATE STORE — tiny reactive object
   ───────────────────────────────────────────────────────────── */
export const state = {
  user: null,
  trip: null,
  towns: [],
  spots: [],
  expenses: [],
  cityGallery: [],
  allTrips: [],
  currentView: "itinerary",
  focusTownId: null,
  theme: "light",
  online: navigator.onLine,
  shareMode: false,
};

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => listeners.forEach(fn => fn(state));
export const setState = (patch) => { Object.assign(state, patch); notify(); };

/* ─────────────────────────────────────────────────────────────
   MODULE-LEVEL VARS — set by switchTrip(), read by Firestore helpers
   ───────────────────────────────────────────────────────────── */
// activeTripId is kept outside state to avoid re-render loops
export let activeTripId = null;
export function setActiveTripId(id) { activeTripId = id; }

export let _tripSettingsId = null; // trip whose settings drawer is currently open
export function setTripSettingsId(id) { _tripSettingsId = id; }
