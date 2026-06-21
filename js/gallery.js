import { db, doc, collection, addDoc, deleteDoc, updateDoc, serverTimestamp, auth } from "./firebase.js";
import { CLOUDINARY_CONFIG } from "./config.js";
import { state, activeTripId } from "./state.js";
import { escapeHtml, localDateStr, btnLoading, btnReset } from "./utils.js";
import { icon } from "./icons.js";

/* ─────────────────────────────────────────────────────────────
   IMAGE RESIZE

   Two decode strategies. createImageBitmap() decodes straight from the
   file bytes, respects EXIF orientation, and succeeds on many files the
   <img> element path fails on (large dimensions, certain Android JPEGs,
   files handed over by Google Photos that aren't fully materialised).
   We try it first and fall back to the classic <img> path.
   ───────────────────────────────────────────────────────────── */
function _fileDiag(file) {
  return `${file.type || "unknown type"}, ${Math.round((file.size || 0) / 1024)}KB`;
}

function _canvasToJpeg(source, scale, quality) {
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve({ blob, w, h }) : reject(new Error("Canvas produced no image data")),
      "image/jpeg", quality
    );
  });
}

async function _resizeImage(file, scale = 0.5, quality = 0.80) {
  // Strategy 1: createImageBitmap — fastest and most tolerant decoder.
  if (typeof createImageBitmap === "function") {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try { bmp = await createImageBitmap(file); } catch { /* fall through */ }
    }
    if (bmp) {
      try {
        const out = await _canvasToJpeg(bmp, scale, quality);
        bmp.close?.();
        return out;
      } catch {
        bmp.close?.();
        // fall through to <img> path
      }
    }
  }

  // Strategy 2: classic <img> element decode.
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      try {
        const out = await _canvasToJpeg(img, scale, quality);
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(new Error(`Couldn't process this image (${_fileDiag(file)})`));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read this image (${_fileDiag(file)})`));
    };
    img.src = url;
  });
}

/* ─────────────────────────────────────────────────────────────
   CLOUDINARY UPLOAD  (unsigned — no auth required)
   ───────────────────────────────────────────────────────────── */
async function _uploadToCloudinary(blob, folder, timeoutMs = 45000) {
  const { cloudName, uploadPreset } = CLOUDINARY_CONFIG;
  if (!cloudName || !uploadPreset) throw new Error("Cloudinary not configured — add cloudName and uploadPreset to config.js.");

  const fd = new FormData();
  fd.append("file", blob);
  fd.append("upload_preset", uploadPreset);
  fd.append("folder", folder);

  // Abort hung uploads so they throw (and get retried) instead of stalling
  // forever — common on flaky mobile connections with large original files.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
  } catch (netErr) {
    // fetch() rejects on network failure (offline, DNS, CORS, drop) or abort/timeout
    if (netErr?.name === "AbortError") throw new Error("Upload timed out — connection too slow.");
    throw new Error("Network error — check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let reason = "";
    try { reason = JSON.parse(detail)?.error?.message || ""; } catch { /* not JSON */ }
    if (!reason) {
      if (res.status === 401 || res.status === 400) reason = "upload rejected by server (check upload preset)";
      else if (res.status === 413) reason = "image too large";
      else if (res.status === 420 || res.status === 429) reason = "rate limited — wait a moment";
      else if (res.status >= 500) reason = "Cloudinary server error — try again";
      else reason = `HTTP ${res.status}`;
    }
    throw new Error(reason);
  }
  const data = await res.json();
  return { publicId: data.public_id, secureUrl: data.secure_url, width: data.width, height: data.height };
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC: UPLOAD PHOTOS  (sequential — avoids memory / rate-limit issues)
   ───────────────────────────────────────────────────────────── */
async function _uploadWithRetry(blob, folder, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await _uploadToCloudinary(blob, folder);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

export async function uploadPhotosForCity(cityId, files, captions, statusCallback) {
  if (!files.length) return;

  const tripId = activeTripId;
  const folder = `weyage/${tripId}/${cityId}`;
  const today = new Date();
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    statusCallback?.(`Photo ${i + 1} of ${files.length}: resizing…`);
    try {
      const { blob, w, h } = await _resizeImage(file);

      statusCallback?.(`Photo ${i + 1} of ${files.length}: uploading…`);
      const { publicId, secureUrl } = await _uploadWithRetry(blob, folder);

      const modDate = new Date(file.lastModified);
      const takenDate = (modDate.getFullYear() < today.getFullYear() ||
        (modDate.getFullYear() === today.getFullYear() && modDate.getMonth() < today.getMonth()))
        ? localDateStr(modDate) : null;

      await addDoc(collection(db, "trips", tripId, "cityGallery"), {
        cityId, publicId, secureUrl,
        name: file.name,
        caption: captions?.[i] || null,
        takenDate, width: w, height: h,
        uploadedBy: auth.currentUser?.uid || null,
        uploadedAt: serverTimestamp(),
      });
      // Photo now live in Firestore — onSnapshot fires and shows it in gallery immediately
    } catch (err) {
      console.error(`Failed: ${file.name}`, err);
      failed.push(file.name);
    }
  }

  if (failed.length) throw new Error(`${failed.length} photo${failed.length > 1 ? "s" : ""} failed: ${failed.join(", ")}`);
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
    // Size to the device instead of serving the full-res original. A phone-camera
    // photo is often 4000px+; decoding that on a phone is what makes the lightbox
    // feel slow. c_limit never upscales, so quality is unaffected for the screen.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(2048, Math.round((window.innerWidth || 1024) * dpr));
    return `https://res.cloudinary.com/${cloudName}/image/upload/c_limit,w_${w},q_auto,f_auto/${photo.publicId}`;
  }
  return photo.secureUrl || "";
}
// Tiny low-quality placeholder (~1-2KB) for the lightbox blur-up while the
// full image loads. Same c_limit aspect as the full image → no layout jump.
export function photoLqipUrl(photo) {
  const { cloudName } = CLOUDINARY_CONFIG;
  if (cloudName && photo.publicId) {
    return `https://res.cloudinary.com/${cloudName}/image/upload/c_limit,w_64,q_auto,f_auto/${photo.publicId}`;
  }
  return photo.secureUrl || "";
}

/* ─────────────────────────────────────────────────────────────
   LIGHTBOX
   ───────────────────────────────────────────────────────────── */
let _lbPhotos = [];
let _lbIndex  = 0;

// Lightbox gesture state: pinch-zoom, double-tap zoom, pan, finger-follow swipe.
let _lbScale = 1, _lbTx = 0, _lbTy = 0;
let _lbGesture = null;            // null | "drag" | "pinch"
let _lbAxis = null;              // null | "x" | "y" — locked once per drag
let _lbStartX = 0, _lbStartY = 0, _lbStartTx = 0, _lbStartTy = 0;
let _lbStartDist = 0, _lbStartScale = 1, _lbLastTap = 0;
let _lbImgCache = null;          // cached <img> so live moves skip DOM lookups
let _lbRafPending = false;

function _lbImgEl() {
  return _lbImgCache || document.getElementById("gallery-lightbox")?.querySelector("#lb-img");
}
function _lbApplyTransform(animate) {
  const img = _lbImgEl();
  if (!img) return;
  img.classList.toggle("lb-img-anim", !!animate); // class adds a transform transition
  img.style.transform = `translate(${_lbTx}px, ${_lbTy}px) scale(${_lbScale})`;
}
// Live (per-frame) transform write for smooth dragging — one rAF-batched style
// write, no transition, no DOM lookup. Used during active gestures.
function _lbLiveTransform() {
  if (_lbRafPending) return;
  _lbRafPending = true;
  requestAnimationFrame(() => {
    _lbRafPending = false;
    const img = _lbImgEl();
    if (img) img.style.transform = `translate(${_lbTx}px, ${_lbTy}px) scale(${_lbScale})`;
  });
}
function _lbZoomReset(animate) { _lbScale = 1; _lbTx = 0; _lbTy = 0; _lbApplyTransform(animate); }
function _lbTouchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
function _lbClampPan(wrap) {
  const img = _lbImgEl();
  if (!img || !wrap) return;
  const r = img.getBoundingClientRect();      // visual (already-scaled) box
  const w = wrap.getBoundingClientRect();
  const maxX = Math.max(0, (r.width  - w.width)  / 2);
  const maxY = Math.max(0, (r.height - w.height) / 2);
  _lbTx = Math.max(-maxX, Math.min(maxX, _lbTx));
  _lbTy = Math.max(-maxY, Math.min(maxY, _lbTy));
  _lbApplyTransform(true);
}
function _lbToggleZoom(touch, wrap) {
  if (_lbScale > 1) { _lbZoomReset(true); return; }
  _lbScale = 2.5;
  const r = wrap.getBoundingClientRect();
  _lbTx = -(touch.clientX - (r.left + r.width  / 2)) * (_lbScale - 1);
  _lbTy = -(touch.clientY - (r.top  + r.height / 2)) * (_lbScale - 1);
  _lbApplyTransform(true);
  _lbClampPan(wrap);
}

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
  _lbImgCache = lb.querySelector("#lb-img");
  _lbZoomReset(false); // each photo starts un-zoomed / un-panned
  const photo = _lbPhotos[_lbIndex];
  if (!photo) return;

  const town = state.towns?.find(t => t.id === photo.cityId);
  const dateStr = photo.takenDate
    ? new Date(photo.takenDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "";

  const img = lb.querySelector("#lb-img");
  if (img) {
    img.alt = escapeHtml(photo.caption || photo.name || "");
    const fullUrl = photoFullUrl(photo);
    const full = new Image();
    full.decoding = "async";
    full.src = fullUrl;
    if (full.complete) {
      // Already cached (e.g. a preloaded neighbour) — show sharp instantly.
      img.src = fullUrl;
      img.classList.remove("lb-img-loading");
    } else {
      // Blur-up: tiny placeholder now, swap to sharp once it decodes.
      img.src = photoLqipUrl(photo);
      img.classList.add("lb-img-loading");
      full.onload = () => {
        if (_lbPhotos[_lbIndex] === photo) { // ignore if user already moved on
          img.src = fullUrl;
          img.classList.remove("lb-img-loading");
        }
      };
    }
  }

  // Preload the neighbours so prev/next swaps are instant (already in cache).
  [_lbPhotos[_lbIndex - 1], _lbPhotos[_lbIndex + 1]].forEach(p => {
    if (p) { const pre = new Image(); pre.src = photoFullUrl(p); }
  });

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

  // Caption edit — only for owner in non-share mode. (Deleting a photo lives in
  // the gallery's Select mode, not here.)
  const isOwner = !state.shareMode && !!auth.currentUser && photo.uploadedBy === auth.currentUser.uid;
  const editBtn = lb.querySelector("#lb-caption-edit-btn");
  if (editBtn) editBtn.style.display = isOwner ? "" : "none";
  const editWrap = lb.querySelector("#lb-caption-edit-wrap");
  if (editWrap) editWrap.style.display = "none";
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

  // Touch gestures: pinch-zoom, double-tap zoom, pan when zoomed, finger-follow
  // swipe to change photo when not zoomed. (Verify/tune on a real device.)
  const wrap = lb.querySelector("#lb-image-wrap");
  if (wrap) {
    wrap.addEventListener("touchstart", e => {
      _lbImgCache = wrap.querySelector("#lb-img");
      _lbImgCache?.classList.remove("lb-img-anim"); // live moves must be instant
      if (e.touches.length === 2) {
        _lbGesture = "pinch";
        _lbStartDist = _lbTouchDist(e.touches);
        _lbStartScale = _lbScale;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - _lbLastTap < 300) {           // double-tap → toggle zoom
          _lbLastTap = 0; _lbGesture = null;
          _lbToggleZoom(e.touches[0], wrap);
          return;
        }
        _lbLastTap = now;
        _lbGesture = "drag";
        _lbAxis = null;                          // decide direction on first move
        _lbStartX = e.touches[0].clientX; _lbStartY = e.touches[0].clientY;
        _lbStartTx = _lbTx; _lbStartTy = _lbTy;
      }
    }, { passive: true });

    wrap.addEventListener("touchmove", e => {
      if (_lbGesture === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const ratio = _lbTouchDist(e.touches) / (_lbStartDist || 1);
        _lbScale = Math.max(1, Math.min(4, _lbStartScale * ratio));
        _lbLiveTransform();
      } else if (_lbGesture === "drag" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - _lbStartX;
        const dy = e.touches[0].clientY - _lbStartY;
        if (_lbScale > 1) {                      // pan the zoomed image
          e.preventDefault();
          _lbTx = _lbStartTx + dx; _lbTy = _lbStartTy + dy;
          _lbLiveTransform();
        } else {
          // Lock the axis once so jitter can't flip us mid-swipe (the jerk fix).
          if (_lbAxis === null && Math.hypot(dx, dy) > 6) {
            _lbAxis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
          }
          if (_lbAxis === "x") {                 // finger-follow swipe, 1:1
            e.preventDefault();
            _lbTx = dx;
            _lbLiveTransform();
          }
        }
      }
    }, { passive: false });

    wrap.addEventListener("touchend", () => {
      if (_lbGesture === "pinch") {
        _lbGesture = null;
        if (_lbScale <= 1.05) _lbZoomReset(true); else _lbClampPan(wrap);
        return;
      }
      if (_lbGesture === "drag") {
        _lbGesture = null;
        if (_lbScale > 1) { _lbClampPan(wrap); return; }
        const dx = _lbTx;
        const threshold = Math.max(60, (window.innerWidth || 320) * 0.2);
        if (dx <= -threshold && _lbIndex < _lbPhotos.length - 1) { _lbIndex++; _lbRender(); }
        else if (dx >= threshold && _lbIndex > 0) { _lbIndex--; _lbRender(); }
        else { _lbTx = 0; _lbApplyTransform(true); } // snap back
      }
    }, { passive: true });
  }

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
  // NB: do NOT use the .modal-overlay class here — it sets opacity:0 and
  // pointer-events:none until a .visible class is added, which made this sheet
  // render invisible and unclickable. All styles are inline instead.
  // z-index must also sit above the select bar (8500), otherwise the
  // bottom-aligned sheet renders behind it.
  overlay.style.cssText = "position:fixed;inset:0;z-index:9100;display:flex;align-items:flex-end;background:rgba(0,0,0,0.5);opacity:1;pointer-events:auto";
  overlay.innerHTML = `
    <div id="gsc-move-sheet" style="background:var(--surface);border-radius:var(--radius-lg) var(--radius-lg) 0 0;width:100%;max-height:60vh;overflow-y:auto;padding:20px">
      <div style="font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin-bottom:12px">Move ${_selectedIds.size} photo${_selectedIds.size > 1 ? "s" : ""} to…</div>
      ${towns.map(t => `<button class="nav-item" data-cityid="${escapeHtml(t.id)}" style="width:100%;text-align:left;padding:12px 8px;font-size:1rem">${escapeHtml(t.name)}</button>`).join("")}
      <button class="nav-item" style="width:100%;text-align:left;padding:12px 8px;font-size:0.875rem;color:var(--text-3);margin-top:4px" id="gsc-move-cancel">Cancel</button>
    </div>`;
  overlay.querySelector("#gsc-move-cancel").addEventListener("click", () => overlay.remove());
  // Click-outside-to-close (taps on the dark backdrop, not the sheet)
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
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
export function renderGallery(filterCityId, containerId = "gallery-content") {
  const container = document.getElementById(containerId);
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
      </div>
      <div class="gallery-grid">
        ${photos.map(p => `
          <button class="gallery-thumb${inSelectMode && _selectedIds.has(p.publicId) ? " gallery-thumb-selected" : ""}"
            data-publicid="${escapeHtml(p.publicId)}" data-cityid="${escapeHtml(p.cityId)}"
            title="${escapeHtml(p.caption || p.name || "")}">
            <img src="${photoThumbUrl(p, 400)}" alt="${escapeHtml(p.name || "")}" loading="lazy" decoding="async" />
            ${p.takenDate ? `<span class="gallery-thumb-date">${new Date(p.takenDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>` : ""}
            <span class="gallery-thumb-check" style="display:${inSelectMode && _selectedIds.has(p.publicId) ? "" : "none"}">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
          </button>`).join("")}
        ${!state.shareMode && !inSelectMode ? `<button class="gallery-add-tile gallery-upload-btn" data-cityid="${escapeHtml(town.id)}" title="Add photos" aria-label="Add photos">
          ${icon("add", { size: 26 })}
        </button>` : ""}
      </div>
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   CITY PHOTO STRIP (for itinerary city cards / share drawer)
   ───────────────────────────────────────────────────────────── */
export function buildCityPhotoStrip(cityId) {
  const photos = (state.cityGallery || []).filter(p => p.cityId === cityId);
  const canAdd = !state.shareMode;
  // Share mode with no photos → render nothing. Otherwise always render the strip
  // so the "+" add tile gives an upload affordance even before any photos exist.
  if (!photos.length && !canAdd) return "";
  const visible = photos.slice(0, 5);
  const extra = photos.length - visible.length;
  return `
    <div class="city-photo-strip" data-stripfor="${escapeHtml(cityId)}">
      ${visible.map((p, i) => `
        <button class="city-strip-thumb" data-strippublicid="${escapeHtml(p.publicId)}" data-stripcityid="${escapeHtml(cityId)}" data-stripidx="${i}">
          <img src="${photoThumbUrl(p, 200)}" alt="" loading="lazy" decoding="async" />
        </button>`).join("")}
      ${extra > 0 ? `<button class="city-strip-more" data-stripcityid="${escapeHtml(cityId)}">+${extra}</button>` : ""}
      ${canAdd ? `<button class="city-strip-add" data-stripaddcityid="${escapeHtml(cityId)}" title="Add photos" aria-label="Add photos">${icon("add", { size: 22 })}</button>` : ""}
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
  el.querySelectorAll(".city-strip-add").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      openUploadModal(btn.dataset.stripaddcityid);
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   SINGLE-PHOTO UPLOAD  (used by modal and retry buttons)
   ───────────────────────────────────────────────────────────── */
async function _uploadSinglePhoto(cityId, file, caption) {
  const tripId = activeTripId;
  const folder = `weyage/${tripId}/${cityId}`;
  const today  = new Date();

  // Fast path: resize client-side to a small JPEG (keeps uploads quick).
  // Fallback: some mobile browsers refuse to decode large camera JPEGs that
  // desktop handles fine (memory/dimension limits). Rather than block the
  // upload, send the original — Cloudinary resizes it server-side and the
  // delivery URLs (photoThumbUrl/photoFullUrl) still serve small images.
  let blob, w, h;
  try {
    ({ blob, w, h } = await _resizeImage(file));
  } catch (err) {
    console.warn(`Client-side resize failed for ${file.name}; uploading original. Reason:`, err?.message);
    blob = file;
    w = 0;
    h = 0;
  }
  const { publicId, secureUrl } = await _uploadWithRetry(blob, folder);

  const modDate = new Date(file.lastModified);
  const takenDate = (modDate.getFullYear() < today.getFullYear() ||
    (modDate.getFullYear() === today.getFullYear() && modDate.getMonth() < today.getMonth()))
    ? localDateStr(modDate) : null;

  await addDoc(collection(db, "trips", tripId, "cityGallery"), {
    cityId, publicId, secureUrl,
    name: file.name,
    caption: caption || null,
    takenDate, width: w, height: h,
    uploadedBy: auth.currentUser?.uid || null,
    uploadedAt: serverTimestamp(),
  });
}

/* ─────────────────────────────────────────────────────────────
   UPLOAD MODAL
   ───────────────────────────────────────────────────────────── */
let _uploadCityId = null;
let _uploadFiles  = [];       // kept so retry buttons can reference the original File objects
let _uploadObjectUrls = [];   // tracked for cleanup
let _uploadStarted = false;   // prevents the submit handler re-firing when "Done" is clicked

export function openUploadModal(cityId) {
  _uploadCityId = cityId;
  const modal = document.getElementById("gallery-upload-modal");
  if (!modal) return;
  const town = state.towns.find(t => t.id === cityId);
  modal.querySelector("#upload-modal-city").textContent = town?.name || "City";

  // Revoke old object URLs and reset state
  _uploadObjectUrls.forEach(u => URL.revokeObjectURL(u));
  _uploadObjectUrls = [];
  _uploadFiles = [];
  _uploadStarted = false;

  // Reset file input value so the same files can be re-selected if needed
  const fileInput = modal.querySelector("#upload-file-input");
  if (fileInput) fileInput.value = "";

  modal.querySelector("#upload-preview-strip").innerHTML = "";
  modal.querySelector("#upload-status").textContent = "";
  const btn = modal.querySelector("#upload-submit-btn");
  btn.disabled = true;
  btn.textContent = "Upload";
  modal.classList.add("visible");
}

export function closeUploadModal() {
  document.getElementById("gallery-upload-modal")?.classList.remove("visible");
  _uploadObjectUrls.forEach(u => URL.revokeObjectURL(u));
  _uploadObjectUrls = [];
  _uploadFiles = [];
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

  // ── File picker ──────────────────────────────────────────────
  modal.querySelector("#upload-file-input")?.addEventListener("change", function () {
    _uploadFiles = Array.from(this.files);
    if (!_uploadFiles.length) return;

    _uploadObjectUrls.forEach(u => URL.revokeObjectURL(u));
    _uploadObjectUrls = _uploadFiles.map(f => URL.createObjectURL(f));

    preview.innerHTML = _uploadFiles.map((f, i) => `
      <div class="upload-preview-item" data-idx="${i}">
        <img src="${_uploadObjectUrls[i]}" alt="" />
        <div class="upload-preview-item-info">
          <div class="upload-preview-item-name">${escapeHtml(f.name)}</div>
          <input class="field-input upload-caption-input" type="text"
            placeholder="Caption (optional)" data-idx="${i}" autocomplete="off"
            style="margin-top:4px;font-size:0.8125rem" />
        </div>
        <div class="upload-item-status" data-idx="${i}"></div>
      </div>`).join("");

    submitBtn.disabled = false;
    statusEl.textContent = "";
  });

  // ── Per-item status helpers ───────────────────────────────────
  function setItemStatus(idx, status, errorMsg) {
    const item = preview.querySelector(`.upload-preview-item[data-idx="${idx}"]`);
    const statusEl2 = item?.querySelector(".upload-item-status");
    if (!item || !statusEl2) return;

    if (status === "uploading") {
      item.classList.remove("upload-item-error");
      item.querySelector(".upload-item-error-msg")?.remove();
      statusEl2.innerHTML = `<div class="upload-spinner"></div>`;
    } else if (status === "done") {
      // Clear the spinner immediately — otherwise it lingers in the DOM during
      // the 420ms fade-out and fools refreshGlobalStatus into thinking an upload
      // is still in flight, leaving the modal stuck on "Uploading…".
      statusEl2.innerHTML = "";
      item.classList.add("upload-item-done");
      item.style.transition = "opacity 0.4s, max-height 0.4s, margin 0.4s, padding 0.4s";
      item.style.opacity = "0";
      item.style.maxHeight = "0";
      item.style.overflow = "hidden";
      item.style.marginBottom = "0";
      setTimeout(() => item.remove(), 420);
    } else if (status === "error") {
      item.classList.add("upload-item-error");
      statusEl2.innerHTML = `
        <button class="upload-retry-btn" title="Retry this photo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
          </svg>
        </button>`;
      statusEl2.querySelector(".upload-retry-btn").addEventListener("click", () => runOne(idx));
      // Show error reason below the filename, replacing any previous message
      const info = item.querySelector(".upload-preview-item-info");
      if (info && errorMsg) {
        item.querySelector(".upload-item-error-msg")?.remove();
        const msg = document.createElement("div");
        msg.className = "upload-item-error-msg";
        msg.textContent = errorMsg;
        info.appendChild(msg);
      }
    }
  }

  // ── Recompute the footer status from the live DOM ─────────────
  // Called after every upload attempt (batch run AND individual retries)
  // so the message always reflects the current state, never stale counts.
  function refreshGlobalStatus() {
    // Mid-flight: at least one item still uploading
    if (preview.querySelector(".upload-item-status .upload-spinner")) {
      statusEl.textContent = "Uploading…";
      return;
    }
    const pending = preview.querySelectorAll(".upload-preview-item:not(.upload-item-done)").length;
    const failed  = preview.querySelectorAll(".upload-preview-item.upload-item-error").length;

    if (pending === 0) {
      // Every item uploaded and faded out
      statusEl.textContent = "✓ All photos uploaded!";
      submitBtn.disabled = true;
      setTimeout(closeUploadModal, 1200);
    } else if (failed > 0) {
      statusEl.textContent = `${failed} photo${failed > 1 ? "s" : ""} failed — tap ↺ to retry.`;
      submitBtn.textContent = "Done";
      submitBtn.disabled = false;
    } else {
      statusEl.textContent = "";
    }
  }

  // ── Upload a single item by index ────────────────────────────
  async function runOne(idx) {
    const file = _uploadFiles[idx];
    if (!file || !_uploadCityId) return;
    const caption = preview.querySelector(`.upload-caption-input[data-idx="${idx}"]`)?.value.trim() || null;
    statusEl.textContent = "Uploading…";
    setItemStatus(idx, "uploading");
    try {
      await _uploadSinglePhoto(_uploadCityId, file, caption);
      setItemStatus(idx, "done");
    } catch (err) {
      setItemStatus(idx, "error", err?.message || "Upload failed");
    }
    refreshGlobalStatus();
  }

  // ── Upload all button ────────────────────────────────────────
  submitBtn.addEventListener("click", async () => {
    if (_uploadStarted || !_uploadFiles.length || !_uploadCityId) return;
    _uploadStarted = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Uploading…";
    statusEl.textContent = "";

    for (let i = 0; i < _uploadFiles.length; i++) {
      await runOne(i);
    }
    refreshGlobalStatus();
  });

  // "Done" closes the modal once uploads have settled with failures.
  // Separate from the upload handler so it can't re-trigger a batch upload.
  submitBtn.addEventListener("click", () => {
    if (submitBtn.textContent === "Done") closeUploadModal();
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
