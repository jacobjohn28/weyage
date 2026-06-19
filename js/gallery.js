import { db, doc, collection, addDoc, deleteDoc, updateDoc, serverTimestamp, auth } from "./firebase.js";
import { CLOUDINARY_CONFIG } from "./config.js";
import { state, activeTripId } from "./state.js";
import { escapeHtml, localDateStr, btnLoading, btnReset } from "./utils.js";

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
   CLOUDINARY UPLOAD  (unsigned — no auth required)
   ───────────────────────────────────────────────────────────── */
async function _uploadToCloudinary(blob, folder) {
  const { cloudName, uploadPreset } = CLOUDINARY_CONFIG;
  if (!cloudName || !uploadPreset) throw new Error("Cloudinary not configured — add cloudName and uploadPreset to config.js.");

  const fd = new FormData();
  fd.append("file", blob);
  fd.append("upload_preset", uploadPreset);
  fd.append("folder", folder);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Cloudinary upload failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return { publicId: data.public_id, secureUrl: data.secure_url, width: data.width, height: data.height };
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC: UPLOAD PHOTOS  (sequential — avoids memory / rate-limit issues)
   ───────────────────────────────────────────────────────────── */
export async function uploadPhotosForCity(cityId, files, captions, statusCallback) {
  if (!files.length) return;

  const tripId = activeTripId;
  const folder = `weyage/${tripId}/${cityId}`;
  const today = new Date();

  // Step 1: resize sequentially (avoids memory spikes from parallel canvas ops)
  statusCallback?.("Preparing photos…");
  const resized = [];
  for (let i = 0; i < files.length; i++) {
    statusCallback?.(`Preparing ${i + 1} of ${files.length}…`);
    resized.push(await _resizeImage(files[i], 1200, 0.80));
  }

  // Step 2: upload all to Cloudinary in parallel (main speed win)
  statusCallback?.(`Uploading ${files.length} photo${files.length !== 1 ? "s" : ""}…`);
  const uploaded = await Promise.all(resized.map(({ blob }) => _uploadToCloudinary(blob, folder)));

  // Step 3: write all Firestore docs in parallel
  statusCallback?.("Saving…");
  await Promise.all(files.map((file, i) => {
    const modDate = new Date(file.lastModified);
    const takenDate = (modDate.getFullYear() < today.getFullYear() ||
      (modDate.getFullYear() === today.getFullYear() && modDate.getMonth() < today.getMonth()))
      ? localDateStr(modDate) : null;
    return addDoc(collection(db, "trips", tripId, "cityGallery"), {
      cityId,
      publicId: uploaded[i].publicId,
      secureUrl: uploaded[i].secureUrl,
      name: file.name,
      caption: captions?.[i] || null,
      takenDate,
      width: resized[i].w,
      height: resized[i].h,
      uploadedBy: auth.currentUser?.uid || null,
      uploadedAt: serverTimestamp(),
    });
  }));
}

/* ─────────────────────────────────────────────────────────────
   URL HELPERS
   ───────────────────────────────────────────────────────────── */
export function photoThumbUrl(photo, size = 400) {
  const { cloudName } = CLOUDINARY_CONFIG;
  if (cloudName && photo.publicId) {
    return `https://res.cloudinary.com/${cloudName}/image/upload/w_${size},c_fill,q_auto,f_auto/${photo.publicId}`;
  }
  return photo.secureUrl || "";
}
export function photoFullUrl(photo) {
  const { cloudName } = CLOUDINARY_CONFIG;
  if (cloudName && photo.publicId) {
    return `https://res.cloudinary.com/${cloudName}/image/upload/q_auto,f_auto/${photo.publicId}`;
  }
  return photo.secureUrl || "";
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
  // Open first, then render — ensures lightbox is visible even if render has an issue
  const lb = document.getElementById("gallery-lightbox");
  if (!lb) return;
  lb.classList.add("visible");
  document.body.style.overflow = "hidden";
  try { _lbRender(); } catch (e) { console.error("Lightbox render:", e); }
}

export function galleryLightboxClose() {
  document.getElementById("gallery-lightbox")?.classList.remove("visible");
  document.body.style.overflow = "";
  _lbPhotos = [];
  _lbIndex = 0;
}

function _lbRender() {
  const lb = document.getElementById("gallery-lightbox");
  if (!lb) return;
  const photo = _lbPhotos[_lbIndex];
  if (!photo) return;

  const town = state.towns?.find(t => t.id === photo.cityId);
  const dateStr = photo.takenDate
    ? new Date(photo.takenDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "";

  const img = lb.querySelector("#lb-img");
  if (img) { img.src = photoFullUrl(photo); img.alt = escapeHtml(photo.caption || photo.name || ""); }

  const captionEl = lb.querySelector("#lb-caption-text");
  if (captionEl) {
    captionEl.textContent = photo.caption || "";
    captionEl.style.display = photo.caption ? "" : "none";
  }

  const metaEl = lb.querySelector("#lb-meta");
  if (metaEl) metaEl.textContent = [town?.name, dateStr].filter(Boolean).join(" · ");

  const counterEl = lb.querySelector("#lb-counter");
  if (counterEl) counterEl.textContent = `${_lbIndex + 1} / ${_lbPhotos.length}`;

  const prevBtn = lb.querySelector("#lb-prev");
  if (prevBtn) prevBtn.style.visibility = _lbIndex > 0 ? "visible" : "hidden";
  const nextBtn = lb.querySelector("#lb-next");
  if (nextBtn) nextBtn.style.visibility = _lbIndex < _lbPhotos.length - 1 ? "visible" : "hidden";

  // Caption edit & delete — only for owner in non-share mode
  const isOwner = !state.shareMode && !!auth.currentUser && photo.uploadedBy === auth.currentUser.uid;
  const editBtn = lb.querySelector("#lb-caption-edit-btn");
  if (editBtn) editBtn.style.display = isOwner ? "" : "none";
  const editWrap = lb.querySelector("#lb-caption-edit-wrap");
  if (editWrap) editWrap.style.display = "none";
  const delBtn = lb.querySelector("#lb-delete-btn");
  if (delBtn) delBtn.style.display = isOwner ? "" : "none";
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

  document.addEventListener("keydown", e => {
    if (!lb.classList.contains("visible")) return;
    if (e.key === "ArrowLeft" && _lbIndex > 0) { _lbIndex--; _lbRender(); }
    if (e.key === "ArrowRight" && _lbIndex < _lbPhotos.length - 1) { _lbIndex++; _lbRender(); }
    if (e.key === "Escape") galleryLightboxClose();
  });

  lb.addEventListener("touchstart", e => { _lbTouchStartX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - _lbTouchStartX;
    if (Math.abs(dx) < 40) return;
    if (dx < 0 && _lbIndex < _lbPhotos.length - 1) { _lbIndex++; _lbRender(); }
    if (dx > 0 && _lbIndex > 0) { _lbIndex--; _lbRender(); }
  }, { passive: true });

  // Caption editing
  lb.querySelector("#lb-caption-edit-btn")?.addEventListener("click", e => {
    e.stopPropagation();
    const photo = _lbPhotos[_lbIndex];
    const inputEl = lb.querySelector("#lb-caption-input");
    if (inputEl) inputEl.value = photo?.caption || "";
    lb.querySelector("#lb-caption-edit-wrap").style.display = "";
    inputEl?.focus();
  });
  lb.querySelector("#lb-caption-cancel-btn")?.addEventListener("click", () => {
    lb.querySelector("#lb-caption-edit-wrap").style.display = "none";
  });
  lb.querySelector("#lb-caption-save-btn")?.addEventListener("click", async () => {
    const photo = _lbPhotos[_lbIndex];
    if (!photo?.id) return;
    const newCaption = (lb.querySelector("#lb-caption-input")?.value || "").trim() || null;
    try {
      await updateDoc(doc(db, "trips", activeTripId, "cityGallery", photo.id), { caption: newCaption });
      photo.caption = newCaption;
    } catch (e) { console.error("Caption save:", e); }
    _lbRender();
  });

  // Delete
  lb.querySelector("#lb-delete-btn")?.addEventListener("click", async () => {
    const photo = _lbPhotos[_lbIndex];
    if (!photo?.id) return;
    if (!confirm("Delete this photo? This cannot be undone.")) return;
    try {
      await deleteDoc(doc(db, "trips", activeTripId, "cityGallery", photo.id));
      _lbPhotos.splice(_lbIndex, 1);
      if (!_lbPhotos.length) { galleryLightboxClose(); return; }
      _lbIndex = Math.min(_lbIndex, _lbPhotos.length - 1);
      _lbRender();
    } catch (e) { alert("Delete failed: " + e.message); }
  });
}

/* ─────────────────────────────────────────────────────────────
   MULTI-SELECT STATE
   ───────────────────────────────────────────────────────────── */
let _selectMode = false;
let _selectedIds = new Set();

export function enterSelectMode() {
  _selectMode = true;
  _selectedIds = new Set();
  const btn = document.getElementById("gallery-select-btn");
  if (btn) btn.textContent = "Cancel";
  _renderSelectBar();
  renderGallery();
}

export function exitSelectMode() {
  _selectMode = false;
  _selectedIds.clear();
  const btn = document.getElementById("gallery-select-btn");
  if (btn) btn.textContent = "Select";
  document.getElementById("gallery-select-bar")?.remove();
  renderGallery();
}

function _toggleSelect(photoId) {
  if (_selectedIds.has(photoId)) _selectedIds.delete(photoId);
  else _selectedIds.add(photoId);
  _renderSelectBar();
  // Update overlay checkmarks without full re-render
  document.querySelectorAll(".gallery-thumb").forEach(btn => {
    const selected = _selectedIds.has(btn.dataset.publicid);
    btn.classList.toggle("gallery-thumb-selected", selected);
    const chk = btn.querySelector(".gallery-thumb-check");
    if (chk) chk.style.display = selected ? "" : "none";
  });
}

function _renderSelectBar() {
  let bar = document.getElementById("gallery-select-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "gallery-select-bar";
    bar.className = "gallery-select-bar";
    // Insert as fixed overlay — attach to body
    document.body.appendChild(bar);
  }
  const n = _selectedIds.size;
  bar.innerHTML = `
    <button class="gallery-select-bar-cancel" id="gsc-cancel">Cancel</button>
    <span class="gallery-select-bar-count">${n} selected</span>
    <div style="display:flex;gap:8px">
      <button class="gallery-select-bar-btn" id="gsc-move" ${n === 0 ? "disabled" : ""}>Move to…</button>
      <button class="gallery-select-bar-btn gallery-select-bar-delete" id="gsc-delete" ${n === 0 ? "disabled" : ""}>Delete</button>
    </div>`;
  bar.querySelector("#gsc-cancel").addEventListener("click", exitSelectMode);
  bar.querySelector("#gsc-delete").addEventListener("click", _deleteSelected);
  bar.querySelector("#gsc-move").addEventListener("click", _showMoveModal);
}

async function _deleteSelected() {
  const ids = [..._selectedIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} photo${ids.length > 1 ? "s" : ""}? This cannot be undone.`)) return;
  const tripId = activeTripId;
  try {
    await Promise.all(ids.map(publicId => {
      const photo = (state.cityGallery || []).find(p => p.publicId === publicId);
      return photo?.id ? deleteDoc(doc(db, "trips", tripId, "cityGallery", photo.id)) : Promise.resolve();
    }));
    exitSelectMode();
  } catch (e) { alert("Delete failed: " + e.message); }
}

function _showMoveModal() {
  const towns = state.towns || [];
  if (!towns.length) return;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:8000;display:flex;align-items:flex-end;background:rgba(0,0,0,0.5)";
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-lg) var(--radius-lg) 0 0;width:100%;max-height:60vh;overflow-y:auto;padding:20px">
      <div style="font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin-bottom:12px">Move to city</div>
      ${towns.map(t => `<button class="nav-item" data-cityid="${escapeHtml(t.id)}" style="width:100%;text-align:left;padding:12px 8px;font-size:1rem">${escapeHtml(t.name)}</button>`).join("")}
      <button class="nav-item" style="width:100%;text-align:left;padding:12px 8px;font-size:0.875rem;color:var(--text-3);margin-top:4px" id="gsc-move-cancel">Cancel</button>
    </div>`;
  overlay.querySelector("#gsc-move-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll("[data-cityid]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const newCityId = btn.dataset.cityid;
      overlay.remove();
      await _moveSelected(newCityId);
    });
  });
  document.body.appendChild(overlay);
}

async function _moveSelected(newCityId) {
  const ids = [..._selectedIds];
  const tripId = activeTripId;
  try {
    await Promise.all(ids.map(publicId => {
      const photo = (state.cityGallery || []).find(p => p.publicId === publicId);
      return photo?.id ? updateDoc(doc(db, "trips", tripId, "cityGallery", photo.id), { cityId: newCityId }) : Promise.resolve();
    }));
    exitSelectMode();
  } catch (e) { alert("Move failed: " + e.message); }
}

/* ─────────────────────────────────────────────────────────────
   RENDER GALLERY VIEW
   ───────────────────────────────────────────────────────────── */
export function renderGallery(filterCityId) {
  const container = document.getElementById("gallery-content");
  if (!container) return;

  const photos = state.cityGallery || [];
  const towns = state.towns || [];

  if (!photos.length) {
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

  // Group by city
  const byCity = {};
  for (const p of photos) {
    if (filterCityId && p.cityId !== filterCityId) continue;
    if (!byCity[p.cityId]) byCity[p.cityId] = [];
    byCity[p.cityId].push(p);
  }

  // Sort photos within each city chronologically (oldest first)
  for (const arr of Object.values(byCity)) {
    arr.sort((a, b) => {
      const da = a.takenDate || "";
      const db2 = b.takenDate || "";
      if (da !== db2) return da.localeCompare(db2);
      const ta = a.uploadedAt?.seconds ?? 0;
      const tb = b.uploadedAt?.seconds ?? 0;
      return ta - tb;
    });
  }

  const sortedCities = towns.filter(t => byCity[t.id]);
  if (filterCityId) {
    container.innerHTML = _buildCitySection(towns.find(t => t.id === filterCityId), byCity[filterCityId] || [], true);
  } else {
    container.innerHTML = sortedCities.map(t => _buildCitySection(t, byCity[t.id], false)).join("");
  }

  // Wire thumbnails
  container.querySelectorAll(".gallery-thumb").forEach(thumb => {
    const publicId = thumb.dataset.publicid;
    const cityId = thumb.dataset.cityid;

    thumb.addEventListener("click", () => {
      if (_selectMode) {
        _toggleSelect(publicId);
        return;
      }
      const cityPhotos = byCity[cityId] || [];
      const idx = cityPhotos.findIndex(p => p.publicId === publicId);
      _lbShow(cityPhotos, Math.max(0, idx));
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
  const inSelectMode = _selectMode;
  return `
    <div class="gallery-city-section" data-cityid="${escapeHtml(town.id)}">
      <div class="gallery-city-header">
        <span class="gallery-city-name">${escapeHtml(town.name)}</span>
        <span class="gallery-city-count">${photos.length} photo${photos.length !== 1 ? "s" : ""}</span>
        ${!state.shareMode && !inSelectMode ? `<button class="btn-ghost gallery-upload-btn" data-cityid="${escapeHtml(town.id)}" style="font-size:0.8125rem;padding:5px 12px;margin-left:auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="margin-right:5px;vertical-align:-1px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add photos
        </button>` : ""}
      </div>
      <div class="gallery-grid">
        ${photos.map(p => `
          <button class="gallery-thumb${inSelectMode && _selectedIds.has(p.publicId) ? " gallery-thumb-selected" : ""}"
            data-publicid="${escapeHtml(p.publicId)}" data-cityid="${escapeHtml(p.cityId)}"
            title="${escapeHtml(p.caption || p.name || "")}">
            <img src="${photoThumbUrl(p, 400)}" alt="${escapeHtml(p.name || "")}" loading="lazy" />
            ${p.takenDate ? `<span class="gallery-thumb-date">${new Date(p.takenDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>` : ""}
            <span class="gallery-thumb-check" style="display:${inSelectMode && _selectedIds.has(p.publicId) ? "" : "none"}">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
          </button>`).join("")}
      </div>
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   CITY PHOTO STRIP (for itinerary city cards / share drawer)
   ───────────────────────────────────────────────────────────── */
export function buildCityPhotoStrip(cityId) {
  const photos = (state.cityGallery || []).filter(p => p.cityId === cityId);
  if (!photos.length) return "";
  const visible = photos.slice(0, 5);
  const extra = photos.length - visible.length;
  return `
    <div class="city-photo-strip" data-stripfor="${escapeHtml(cityId)}">
      ${visible.map((p, i) => `
        <button class="city-strip-thumb" data-strippublicid="${escapeHtml(p.publicId)}" data-stripcityid="${escapeHtml(cityId)}" data-stripidx="${i}">
          <img src="${photoThumbUrl(p, 200)}" alt="" loading="lazy" />
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
let _onUploadFileChange = () => {};

export function openUploadModal(cityId) {
  _uploadCityId = cityId;
  const modal = document.getElementById("gallery-upload-modal");
  if (!modal) return;
  const town = state.towns.find(t => t.id === cityId);
  modal.querySelector("#upload-modal-city").textContent = town?.name || "City";

  // Fully reset file input by replacing the element
  const oldInput = modal.querySelector("#upload-file-input");
  const newInput = oldInput.cloneNode(true);
  oldInput.replaceWith(newInput);
  newInput.addEventListener("change", _onUploadFileChange);

  modal.querySelector("#upload-preview-strip").innerHTML = "";
  modal.querySelector("#upload-status").textContent = "";
  const btn = modal.querySelector("#upload-submit-btn");
  btn.disabled = true;
  btn.textContent = "Upload";
  modal.classList.add("visible");
}

export function closeUploadModal() {
  document.getElementById("gallery-upload-modal")?.classList.remove("visible");
  _uploadCityId = null;
}

export function initUploadModal() {
  const modal = document.getElementById("gallery-upload-modal");
  if (!modal) return;

  const preview   = modal.querySelector("#upload-preview-strip");
  const submitBtn = modal.querySelector("#upload-submit-btn");
  const statusEl  = modal.querySelector("#upload-status");

  modal.querySelector("#upload-modal-close")?.addEventListener("click", closeUploadModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeUploadModal(); });
  modal.querySelector("#upload-modal-sheet")?.addEventListener("click", e => e.stopPropagation());

  _onUploadFileChange = () => {
    const fileInput = modal.querySelector("#upload-file-input");
    const files = Array.from(fileInput.files);
    if (!files.length) return;

    // Build vertical list: thumbnail + caption input per photo
    preview.innerHTML = files.map((f, i) => `
      <div class="upload-preview-item">
        <img src="${URL.createObjectURL(f)}" alt="" />
        <div class="upload-preview-item-info">
          <div class="upload-preview-item-name">${escapeHtml(f.name)}</div>
          <input class="field-input upload-caption-input" type="text"
            placeholder="Caption (optional)" data-idx="${i}"
            style="margin-top:4px;font-size:0.8125rem" />
        </div>
      </div>`).join("");

    submitBtn.disabled = false;
    statusEl.textContent = `${files.length} photo${files.length !== 1 ? "s" : ""} selected`;
  };

  modal.querySelector("#upload-file-input")?.addEventListener("change", _onUploadFileChange);

  submitBtn.addEventListener("click", async () => {
    const fileInput = modal.querySelector("#upload-file-input");
    const files = Array.from(fileInput.files);
    if (!files.length || !_uploadCityId) return;
    const captions = Array.from(preview.querySelectorAll(".upload-caption-input")).map(el => el.value.trim() || null);
    btnLoading(submitBtn, "Uploading…");
    statusEl.textContent = "";
    try {
      await uploadPhotosForCity(_uploadCityId, files, captions, msg => { statusEl.textContent = msg; });
      statusEl.textContent = `✓ ${files.length} photo${files.length !== 1 ? "s" : ""} uploaded!`;
      setTimeout(closeUploadModal, 1400);
    } catch (err) {
      statusEl.textContent = err.message;
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
