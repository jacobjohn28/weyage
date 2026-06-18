import { db, doc, collection, addDoc, deleteDoc, serverTimestamp, GoogleAuthProvider, signInWithPopup, auth } from "./firebase.js";
import { state, activeTripId } from "./state.js";
import { escapeHtml, localDateStr, btnLoading, btnReset } from "./utils.js";

/* ─────────────────────────────────────────────────────────────
   DRIVE TOKEN
   ───────────────────────────────────────────────────────────── */
let _driveToken = null;
let _driveTokenExpiry = 0;

async function _acquireDriveToken() {
  if (_driveToken && Date.now() < _driveTokenExpiry - 60_000) return _driveToken;
  const provider = new GoogleAuthProvider();
  provider.addScope("https://www.googleapis.com/auth/drive.file");
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error("Could not get Drive access token.");
  _driveToken = credential.accessToken;
  _driveTokenExpiry = Date.now() + 3_600_000;
  return _driveToken;
}

/* ─────────────────────────────────────────────────────────────
   IMAGE RESIZE
   ───────────────────────────────────────────────────────────── */
function _resizeImage(file, maxPx = 2000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve({ blob, w, h }) : reject(new Error("Canvas toBlob failed")), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

/* ─────────────────────────────────────────────────────────────
   DRIVE UPLOAD
   ───────────────────────────────────────────────────────────── */
async function _uploadFileToDrive(blob, name, token) {
  const meta = { name, mimeType: "image/jpeg" };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  form.append("file", blob);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
  const { id } = await res.json();

  // Make publicly readable so view users can access without auth
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!permRes.ok) throw new Error(`Drive permission set failed (${permRes.status})`);

  return id;
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC: UPLOAD PHOTOS
   ───────────────────────────────────────────────────────────── */
export async function uploadPhotosForCity(cityId, files, statusCallback) {
  if (!files.length) return;
  let token;
  try {
    token = await _acquireDriveToken();
  } catch (err) {
    throw new Error("Drive access not granted — please try again.");
  }

  const tripId = activeTripId;
  const townName = state.towns.find(t => t.id === cityId)?.name || "City";

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    statusCallback?.(`Uploading ${i + 1}/${files.length}…`);
    const { blob, w, h } = await _resizeImage(file);
    const safeName = `Weyage - ${townName} - ${file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const fileId = await _uploadFileToDrive(blob, safeName, token);

    // Extract date: prefer file lastModified if it looks plausible (not today)
    const modDate = new Date(file.lastModified);
    const today = new Date();
    const takenDate = (modDate.getFullYear() < today.getFullYear() ||
      (modDate.getFullYear() === today.getFullYear() && modDate.getMonth() < today.getMonth()))
      ? localDateStr(modDate)
      : null;

    await addDoc(collection(db, "trips", tripId, "cityGallery"), {
      cityId,
      fileId,
      name: file.name,
      caption: null,
      takenDate,
      width: w,
      height: h,
      uploadedBy: auth.currentUser?.uid || null,
      uploadedAt: serverTimestamp(),
    });
  }
}

/* ─────────────────────────────────────────────────────────────
   URL HELPERS
   ───────────────────────────────────────────────────────────── */
export function driveThumbUrl(fileId, size = 400) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}
export function driveFullUrl(fileId) {
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

/* ─────────────────────────────────────────────────────────────
   LIGHTBOX
   ───────────────────────────────────────────────────────────── */
let _lbPhotos = [];
let _lbIndex  = 0;
let _lbTouchStartX = 0;

function _lbShow(photos, index) {
  _lbPhotos = photos;
  _lbIndex  = Math.max(0, Math.min(index, photos.length - 1));
  _lbRender();
  document.getElementById("gallery-lightbox").classList.add("visible");
  document.body.style.overflow = "hidden";
}

export function galleryLightboxClose() {
  document.getElementById("gallery-lightbox")?.classList.remove("visible");
  document.body.style.overflow = "";
  _lbPhotos = [];
}

function _lbRender() {
  const lb = document.getElementById("gallery-lightbox");
  if (!lb) return;
  const photo = _lbPhotos[_lbIndex];
  if (!photo) return;

  const town = state.towns.find(t => t.id === photo.cityId);
  const dateStr = photo.takenDate
    ? new Date(photo.takenDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "";

  lb.querySelector("#lb-img").src = driveFullUrl(photo.fileId);
  lb.querySelector("#lb-img").alt = escapeHtml(photo.caption || photo.name || "");
  lb.querySelector("#lb-caption").textContent = photo.caption || "";
  lb.querySelector("#lb-meta").textContent = [town?.name, dateStr].filter(Boolean).join(" · ");
  lb.querySelector("#lb-counter").textContent = `${_lbIndex + 1} / ${_lbPhotos.length}`;
  lb.querySelector("#lb-prev").style.visibility = _lbIndex > 0 ? "visible" : "hidden";
  lb.querySelector("#lb-next").style.visibility = _lbIndex < _lbPhotos.length - 1 ? "visible" : "hidden";

  // Delete button — only for owner
  const delBtn = lb.querySelector("#lb-delete-btn");
  if (delBtn) delBtn.style.display = (!state.shareMode && photo.uploadedBy === (auth.currentUser?.uid || null)) ? "" : "none";
}

export function initGalleryLightbox() {
  const lb = document.getElementById("gallery-lightbox");
  if (!lb) return;

  lb.querySelector("#lb-close")?.addEventListener("click", galleryLightboxClose);
  lb.addEventListener("click", e => { if (e.target === lb) galleryLightboxClose(); });

  lb.querySelector("#lb-prev")?.addEventListener("click", e => {
    e.stopPropagation();
    if (_lbIndex > 0) { _lbIndex--; _lbRender(); }
  });
  lb.querySelector("#lb-next")?.addEventListener("click", e => {
    e.stopPropagation();
    if (_lbIndex < _lbPhotos.length - 1) { _lbIndex++; _lbRender(); }
  });

  // Keyboard
  document.addEventListener("keydown", e => {
    if (!lb.classList.contains("visible")) return;
    if (e.key === "ArrowLeft" && _lbIndex > 0) { _lbIndex--; _lbRender(); }
    if (e.key === "ArrowRight" && _lbIndex < _lbPhotos.length - 1) { _lbIndex++; _lbRender(); }
    if (e.key === "Escape") galleryLightboxClose();
  });

  // Touch swipe
  lb.addEventListener("touchstart", e => { _lbTouchStartX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - _lbTouchStartX;
    if (Math.abs(dx) < 40) return;
    if (dx < 0 && _lbIndex < _lbPhotos.length - 1) { _lbIndex++; _lbRender(); }
    if (dx > 0 && _lbIndex > 0) { _lbIndex--; _lbRender(); }
  }, { passive: true });

  // Delete
  lb.querySelector("#lb-delete-btn")?.addEventListener("click", async () => {
    const photo = _lbPhotos[_lbIndex];
    if (!photo) return;
    if (!confirm("Delete this photo? This cannot be undone.")) return;
    await deleteDoc(doc(db, "trips", activeTripId, "cityGallery", photo.id));
    // Remove from local array and advance/close
    _lbPhotos.splice(_lbIndex, 1);
    if (_lbPhotos.length === 0) { galleryLightboxClose(); return; }
    _lbIndex = Math.min(_lbIndex, _lbPhotos.length - 1);
    _lbRender();
  });
}

/* ─────────────────────────────────────────────────────────────
   RENDER GALLERY VIEW
   ───────────────────────────────────────────────────────────── */
export function renderGallery(filterCityId) {
  const container = document.getElementById("gallery-content");
  if (!container) return;

  const photos = (state.cityGallery || []);
  const towns = state.towns || [];

  if (photos.length === 0) {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:60px 24px;color:var(--text-3);text-align:center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <div>
          <div style="font-size:1.0625rem;font-weight:600;color:var(--text);margin-bottom:6px">No photos yet</div>
          <div style="font-size:0.875rem;max-width:280px">Open a city in the Itinerary and tap "Add photos" to upload images from your device.</div>
        </div>
      </div>`;
    return;
  }

  // Group by city, sorted by city order
  const byCity = {};
  for (const p of photos) {
    if (filterCityId && p.cityId !== filterCityId) continue;
    if (!byCity[p.cityId]) byCity[p.cityId] = [];
    byCity[p.cityId].push(p);
  }

  // Sort photos within each city by takenDate then uploadedAt
  for (const arr of Object.values(byCity)) {
    arr.sort((a, b) => {
      const da = a.takenDate || "";
      const db2 = b.takenDate || "";
      if (da !== db2) return da.localeCompare(db2);
      return 0;
    });
  }

  const sortedCities = towns.filter(t => byCity[t.id]);
  if (filterCityId) {
    // Single city mode
    const singleCityPhotos = byCity[filterCityId] || [];
    const town = towns.find(t => t.id === filterCityId);
    container.innerHTML = _buildCitySection(town, singleCityPhotos, true);
  } else {
    container.innerHTML = sortedCities.map(t => _buildCitySection(t, byCity[t.id], false)).join("");
  }

  // Wire click handlers
  container.querySelectorAll(".gallery-thumb").forEach(thumb => {
    thumb.addEventListener("click", () => {
      const cityId = thumb.dataset.cityid;
      const fileId = thumb.dataset.fileid;
      const cityPhotos = byCity[cityId] || [];
      const idx = cityPhotos.findIndex(p => p.fileId === fileId);
      _lbShow(cityPhotos, idx);
    });
  });

  // Wire upload buttons
  if (!state.shareMode) {
    container.querySelectorAll(".gallery-upload-btn").forEach(btn => {
      btn.addEventListener("click", () => openUploadModal(btn.dataset.cityid));
    });
  }
}

function _buildCitySection(town, photos, compact) {
  if (!town || !photos?.length) return "";
  return `
    <div class="gallery-city-section" data-cityid="${escapeHtml(town.id)}">
      <div class="gallery-city-header">
        <span class="gallery-city-name">${escapeHtml(town.name)}</span>
        <span class="gallery-city-count">${photos.length} photo${photos.length !== 1 ? "s" : ""}</span>
        ${!state.shareMode ? `<button class="btn-ghost gallery-upload-btn" data-cityid="${escapeHtml(town.id)}" style="font-size:0.8125rem;padding:5px 12px;margin-left:auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="margin-right:5px;vertical-align:-1px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add photos
        </button>` : ""}
      </div>
      <div class="gallery-grid">
        ${photos.map(p => `
          <button class="gallery-thumb" data-fileid="${escapeHtml(p.fileId)}" data-cityid="${escapeHtml(p.cityId)}" title="${escapeHtml(p.caption || p.name || "")}">
            <img src="${driveThumbUrl(p.fileId, 400)}" alt="${escapeHtml(p.name || "")}" loading="lazy" />
            ${p.takenDate ? `<span class="gallery-thumb-date">${new Date(p.takenDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>` : ""}
          </button>`).join("")}
      </div>
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   CITY PHOTO STRIP (for itinerary city cards)
   ───────────────────────────────────────────────────────────── */
export function buildCityPhotoStrip(cityId) {
  const photos = (state.cityGallery || []).filter(p => p.cityId === cityId);
  if (!photos.length) return "";
  const visible = photos.slice(0, 5);
  const extra = photos.length - visible.length;
  return `
    <div class="city-photo-strip" data-stripfor="${escapeHtml(cityId)}">
      ${visible.map((p, i) => `
        <button class="city-strip-thumb" data-stripfileid="${escapeHtml(p.fileId)}" data-stripcityid="${escapeHtml(cityId)}" data-stripidx="${i}">
          <img src="${driveThumbUrl(p.fileId, 200)}" alt="" loading="lazy" />
        </button>`).join("")}
      ${extra > 0 ? `<button class="city-strip-more" data-stripcityid="${escapeHtml(cityId)}">+${extra}</button>` : ""}
    </div>`;
}

export function wireCityPhotoStrip(el, cityId) {
  el.querySelectorAll(".city-strip-thumb").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const photos = (state.cityGallery || []).filter(p => p.cityId === cityId);
      const idx = parseInt(btn.dataset.stripidx, 10);
      _lbShow(photos, idx);
    });
  });
  el.querySelectorAll(".city-strip-more").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      openGalleryForCity(cityId);
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   UPLOAD MODAL
   ───────────────────────────────────────────────────────────── */
let _uploadCityId = null;

export function openUploadModal(cityId) {
  _uploadCityId = cityId;
  const modal = document.getElementById("gallery-upload-modal");
  if (!modal) return;
  const town = state.towns.find(t => t.id === cityId);
  modal.querySelector("#upload-modal-city").textContent = town?.name || "City";
  modal.querySelector("#upload-file-input").value = "";
  modal.querySelector("#upload-preview-strip").innerHTML = "";
  modal.querySelector("#upload-status").textContent = "";
  modal.querySelector("#upload-submit-btn").disabled = true;
  modal.classList.add("visible");
}

export function closeUploadModal() {
  document.getElementById("gallery-upload-modal")?.classList.remove("visible");
  _uploadCityId = null;
}

export function initUploadModal() {
  const modal = document.getElementById("gallery-upload-modal");
  if (!modal) return;

  const fileInput  = modal.querySelector("#upload-file-input");
  const preview    = modal.querySelector("#upload-preview-strip");
  const submitBtn  = modal.querySelector("#upload-submit-btn");
  const statusEl   = modal.querySelector("#upload-status");

  modal.querySelector("#upload-modal-close")?.addEventListener("click", closeUploadModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeUploadModal(); });
  modal.querySelector("#upload-modal-sheet")?.addEventListener("click", e => e.stopPropagation());

  fileInput?.addEventListener("change", () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;
    preview.innerHTML = files.map(f =>
      `<div style="position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;flex-shrink:0;background:var(--surface-2)">
        <img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover" />
      </div>`
    ).join("");
    submitBtn.disabled = false;
    statusEl.textContent = `${files.length} photo${files.length !== 1 ? "s" : ""} selected`;
  });

  submitBtn.addEventListener("click", async () => {
    const files = Array.from(fileInput.files);
    if (!files.length || !_uploadCityId) return;
    btnLoading(submitBtn, "Uploading…");
    statusEl.textContent = "";
    try {
      await uploadPhotosForCity(_uploadCityId, files, msg => { statusEl.textContent = msg; });
      statusEl.textContent = `${files.length} photo${files.length !== 1 ? "s" : ""} uploaded!`;
      setTimeout(closeUploadModal, 1200);
    } catch (err) {
      statusEl.textContent = "Upload failed: " + err.message;
      btnReset(submitBtn);
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   NAVIGATION HELPER
   ───────────────────────────────────────────────────────────── */
let _galleryNavCallback = null;
export function registerGalleryNavCallback(cb) { _galleryNavCallback = cb; }

export function openGalleryForCity(cityId) {
  _galleryNavCallback?.(cityId);
}
