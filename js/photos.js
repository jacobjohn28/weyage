import { PEXELS_CONFIG } from "./config.js";
import { state } from "./state.js";
import { db, doc, updateDoc } from "./firebase.js";
import { activeTripId } from "./state.js";
import { escapeHtml } from "./utils.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   Functions not yet in their own modules are injected here at
   startup via registerPhotoCallbacks() in index.html.
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerPhotoCallbacks({ closeSiteSettings, switchTrip, pushModalHistory }) {
  Object.assign(cb, { closeSiteSettings, switchTrip, pushModalHistory });
}

/* ─────────────────────────────────────────────────────────────
   PENDING BACKFILL FLAG
   Read by listenToTrip in index.html — exported via getter/setter.
   ───────────────────────────────────────────────────────────── */
let _pendingBackfill = false;
export function getPendingBackfill() { return _pendingBackfill; }
export function setPendingBackfill(val) { _pendingBackfill = val; }

/* ─────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────── */
export function extractTripDestination(name) {
  const filler = new Set(["spring","summer","autumn","fall","winter","trip","tour","holiday","vacation","travel","adventure","my"]);
  const words = name.split(/\s+/).filter(w => !/^\d+$/.test(w) && !filler.has(w.toLowerCase()));
  return words.join(" ").trim() || name;
}

export function resolveTownImage(town) {
  return town.photoUrl || town.customImage || town.image || "";
}

export async function fetchPexelsPhotos(query, count = 3) {
  if (!PEXELS_CONFIG.apiKey) return [];
  try {
    const resp = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
      { headers: { Authorization: PEXELS_CONFIG.apiKey } }
    );
    if (!resp.ok) { console.warn("Pexels error", resp.status); return []; }
    const data = await resp.json();
    return (data.photos || []).map(p => ({
      url: p.src.large2x || p.src.large,
      thumb: p.src.medium,
      credit: p.photographer,
      creditUrl: p.photographer_url
    }));
  } catch (err) {
    console.warn("Pexels fetch failed:", err);
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────
   PHOTO PICKER
   ───────────────────────────────────────────────────────────── */
let _photoPickerTownId   = null;
let _photoPickerTownName = null;
let _backfillQueue   = [];
let _backfillTotal   = 0;

export function closePhotoPicker(cancelBackfill = false) {
  document.getElementById("photo-picker-overlay").classList.remove("visible");
  document.body.style.overflow = "";
  _photoPickerTownId   = null;
  _photoPickerTownName = null;

  if (cancelBackfill || !_backfillQueue.length) {
    _backfillQueue = [];
    _backfillTotal = 0;
    return;
  }

  const next = _backfillQueue.shift();
  setTimeout(() => openPhotoPicker(next.id, next.name), 180);
}

export function startBackfillForTrip(tripId) {
  if (!tripId) return;
  if (!PEXELS_CONFIG.apiKey) {
    const hint = document.getElementById("site-settings-backfill-hint");
    hint.textContent = "No Pexels API key configured — add pexelsApiKey to config/site in Firestore first.";
    hint.style.display = "block";
    return;
  }
  cb.closeSiteSettings();
  _pendingBackfill = true;
  setTimeout(() => cb.switchTrip(tripId), 150);
}

export function startPhotoBackfill() {
  if (!PEXELS_CONFIG.apiKey) {
    alert("No Pexels API key configured. Add pexelsApiKey to config/site in Firestore.");
    return;
  }
  const missing = (state.towns || []).filter(t => !t.photoUrl);
  if (!missing.length) {
    alert("All cities already have a photo assigned — nothing to backfill.");
    return;
  }

  _backfillQueue = missing.map(t => ({ id: t.id, name: t.name }));
  _backfillTotal = _backfillQueue.length;
  const first = _backfillQueue.shift();
  setTimeout(() => openPhotoPicker(first.id, first.name), 320);
}

export async function openPhotoPicker(townId, townName) {
  if (!PEXELS_CONFIG.apiKey) return;
  _photoPickerTownId   = townId;
  _photoPickerTownName = townName;

  const overlay = document.getElementById("photo-picker-overlay");
  document.getElementById("photo-picker-city-name").textContent = townName;
  document.getElementById("photo-picker-grid").innerHTML = "";
  document.getElementById("photo-picker-loading").style.display = "block";
  document.getElementById("photo-picker-error").style.display = "none";

  const progressEl = document.getElementById("photo-picker-progress");
  if (_backfillTotal > 1) {
    const current = _backfillTotal - _backfillQueue.length;
    progressEl.textContent = `City ${current} of ${_backfillTotal}`;
    progressEl.style.display = "";
    document.getElementById("photo-picker-skip").textContent =
      _backfillQueue.length ? "Skip this city →" : "Skip";
  } else {
    progressEl.style.display = "none";
    document.getElementById("photo-picker-skip").textContent = "Skip for now";
  }

  overlay.classList.add("visible");
  document.body.style.overflow = "hidden";
  cb.pushModalHistory();

  const photos = await fetchPexelsPhotos(`${townName} travel city`);

  document.getElementById("photo-picker-loading").style.display = "none";

  if (!photos.length) {
    document.getElementById("photo-picker-error").style.display = "block";
    return;
  }

  const grid = document.getElementById("photo-picker-grid");
  grid.innerHTML = photos.map((p, i) => `
    <div class="photo-picker-item" data-index="${i}">
      <div class="photo-picker-img-wrap">
        <img src="${escapeHtml(p.thumb)}" alt="${escapeHtml(p.credit)}" loading="lazy" class="photo-picker-img">
        <div class="photo-picker-select-overlay">
          <button class="photo-picker-select-btn btn-primary" data-index="${i}" style="font-size:0.8125rem;padding:7px 16px">Use this photo</button>
        </div>
      </div>
      <div class="photo-picker-credit">
        Photo by <a href="${escapeHtml(p.creditUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.credit)}</a> on Pexels
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".photo-picker-select-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.index);
      const photo = photos[idx];
      const tid = _photoPickerTownId;
      closePhotoPicker();
      try {
        await updateDoc(doc(db, "trips", activeTripId, "towns", tid), {
          photoUrl: photo.url,
          photoCredit: photo.credit,
          photoCreditUrl: photo.creditUrl
        });
        // Mirror the URL on the parent trip doc so trip cards can show a collage
        // without additional Firestore reads
        updateDoc(doc(db, "trips", activeTripId), {
          [`cityPhotos.${tid}`]: photo.url
        }).catch(() => {});
      } catch (err) {
        console.error("Failed to save photo:", err);
      }
    });
  });
}
