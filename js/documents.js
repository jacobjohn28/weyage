import { state } from "./state.js";
import { db, doc, updateDoc } from "./firebase.js";
import { activeTripId } from "./state.js";
import { escapeHtml } from "./utils.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerDocumentCallbacks({ pushModalHistory, popModalHistory, setView, setPendingScrollTownId }) {
  Object.assign(cb, { pushModalHistory, popModalHistory, setView, setPendingScrollTownId });
}

/* ─────────────────────────────────────────────────────────────
   ATTACHMENTS
   ───────────────────────────────────────────────────────────── */
async function compressImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = img.width  * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.src = URL.createObjectURL(file);
  });
}

export async function addAttachment(spotId, file) {
  let data;
  if (file.type.startsWith("image/")) {
    data = await compressImage(file);
  } else {
    data = await new Promise(r => {
      const fr = new FileReader();
      fr.onload = e => r(e.target.result);
      fr.readAsDataURL(file);
    });
  }
  const attachment = {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type,
    data,
    pinned: false,
    addedAt: new Date().toISOString(),
  };
  const spot = state.spots.find(s => s.id === spotId);
  const attachments = [...(spot.attachments || []), attachment];
  await updateDoc(doc(db, "trips", activeTripId, "spots", spotId), { attachments });
}

export async function toggleAttachmentPin(spotId, attachId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot) return;
  const attachments = (spot.attachments || []).map(a =>
    a.id === attachId ? { ...a, pinned: !a.pinned } : a
  );
  await updateDoc(doc(db, "trips", activeTripId, "spots", spotId), { attachments });
}

export async function deleteAttachment(spotId, attachId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot) return;
  const attachments = (spot.attachments || []).filter(a => a.id !== attachId);
  await updateDoc(doc(db, "trips", activeTripId, "spots", spotId), { attachments });
}

/* ─────────────────────────────────────────────────────────────
   DOCUMENTS VIEW
   ───────────────────────────────────────────────────────────── */
export function renderDocuments() {
  const container = document.getElementById("docs-content");
  if (!container) return;

  const query = (document.getElementById("docs-search")?.value || "").trim().toLowerCase();

  const allSpotsWithDocs = state.spots.filter(s => s.attachments && s.attachments.length > 0);
  if (allSpotsWithDocs.length === 0) {
    container.innerHTML = `<div class="itinerary-empty"><p>No documents yet. Open any spot's detail drawer and tap <strong>Attach</strong> to add a screenshot or photo.</p><p style="font-size:0.8125rem;color:var(--text-3);margin-top:8px">Tip: upload images (JPEG, PNG, WebP) rather than PDFs — they load faster and use less storage. Screenshot your PDFs first.</p></div>`;
    return;
  }

  const html = [];
  let totalShown = 0;

  for (const town of state.towns) {
    const townSpots = allSpotsWithDocs.filter(s => s.townId === town.id);
    if (!townSpots.length) continue;

    const townHtml = [];
    for (const spot of townSpots) {
      const sorted = [...spot.attachments].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

      const matchingAtts = query
        ? sorted.filter(att =>
            spot.name.toLowerCase().includes(query) ||
            att.name.toLowerCase().includes(query) ||
            town.name.toLowerCase().includes(query))
        : sorted;
      if (!matchingAtts.length) continue;

      const dateMeta = spot.scheduledDate
        ? new Date(spot.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })
        : "";
      townHtml.push(`
        <div class="docs-spot-group">
          <div class="docs-spot-header" data-spot-id="${escapeHtml(spot.id)}">
            <span class="docs-spot-header-name">${escapeHtml(spot.name)}</span>
            ${dateMeta ? `<span class="docs-spot-header-meta">${dateMeta}</span>` : ""}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="13" height="13"><polyline points="9 18 15 12 9 6"/></svg>
          </div>`);

      for (const att of matchingAtts) {
        const isImg = att.mimeType && att.mimeType.startsWith("image/");
        const thumb = isImg
          ? `<img class="doc-thumb" src="${escapeHtml(att.data)}" alt="${escapeHtml(att.name)}" loading="lazy">`
          : `<div class="doc-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`;
        townHtml.push(`
          <div class="doc-card${att.pinned ? " pinned" : ""}" data-spot-id="${escapeHtml(spot.id)}" data-attach-id="${escapeHtml(att.id)}">
            ${thumb}
            <div class="doc-body">
              <div class="doc-attach-name" style="font-size:0.9375rem;color:var(--text)">${escapeHtml(att.name)}</div>
              ${isImg ? `<div class="doc-attach-name" style="margin-top:2px">Image</div>` : `<div class="doc-attach-name">File</div>`}
            </div>
            <button class="doc-pin-btn${att.pinned ? " active" : ""}" data-pin="true" title="${att.pinned ? "Unpin" : "Pin"}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            </button>
          </div>`);
        totalShown++;
      }
      townHtml.push(`</div>`);
    }

    if (!townHtml.length) continue;
    html.push(`<div class="docs-town-group"><div class="docs-town-label">${escapeHtml(town.name)}</div>${townHtml.join("")}</div>`);
  }

  if (!totalShown) {
    container.innerHTML = `<p style="color:var(--text-3);font-size:0.9375rem">No documents matching "${escapeHtml(query)}".</p>`;
    return;
  }
  container.innerHTML = html.join("");

  container.querySelectorAll(".docs-spot-header").forEach(header => {
    header.addEventListener("click", () => {
      const spot = state.spots.find(s => s.id === header.dataset.spotId);
      if (spot) {
        cb.setPendingScrollTownId(spot.townId);
        cb.setView("itinerary");
      }
    });
  });

  container.querySelectorAll(".doc-card").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest(".doc-pin-btn")) return;
      const spot = state.spots.find(s => s.id === card.dataset.spotId);
      const att  = spot?.attachments?.find(a => a.id === card.dataset.attachId);
      if (!att) return;
      if (att.mimeType?.startsWith("image/")) {
        const imgAtts = (spot.attachments || []).filter(a => a.mimeType?.startsWith("image/"));
        const idx = imgAtts.findIndex(a => a.id === att.id);
        openLightbox(imgAtts, idx, spot.name);
      }
    });
    card.querySelector(".doc-pin-btn")?.addEventListener("click", async e => {
      e.stopPropagation();
      await toggleAttachmentPin(card.dataset.spotId, card.dataset.attachId);
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   LIGHTBOX
   ───────────────────────────────────────────────────────────── */
let lbSlides = [], lbIdx = 0, lbZoom = 1;
let lbPan = { x: 0, y: 0 };
let lbDrag = null;
let lbLastTap = 0;

export function openLightbox(attachments, startIndex, spotName) {
  lbSlides = (attachments || []).filter(a => a.mimeType?.startsWith("image/"));
  if (!lbSlides.length) return;
  lbIdx = Math.max(0, Math.min(startIndex ?? 0, lbSlides.length - 1));
  lbZoom = 1; lbPan = { x: 0, y: 0 }; lbDrag = null;
  cb.pushModalHistory();
  document.getElementById("lightbox-overlay").classList.add("open");
  document.body.style.overflow = "hidden";
  lbRender();
}

export function lbClose() {
  document.getElementById("lightbox-overlay").classList.remove("open");
  document.body.style.overflow = "";
  lbZoom = 1; lbPan = { x: 0, y: 0 }; lbDrag = null;
  cb.popModalHistory();
}

function lbRender() {
  const att = lbSlides[lbIdx];
  const img = document.getElementById("lb-img");
  img.src = att.data; img.alt = att.name;
  img.classList.remove("zoomed", "dragging");
  img.style.transform = "none";
  document.getElementById("lb-caption").textContent = att.name;
  document.getElementById("lb-counter").textContent =
    lbSlides.length > 1 ? `${lbIdx + 1} / ${lbSlides.length}` : "";
  document.getElementById("lb-prev").disabled = lbIdx === 0;
  document.getElementById("lb-next").disabled = lbIdx === lbSlides.length - 1;
  lbZoom = 1; lbPan = { x: 0, y: 0 };
}

function lbApply() {
  const img = document.getElementById("lb-img");
  if (!img) return;
  if (lbZoom <= 1) {
    lbZoom = 1; lbPan = { x: 0, y: 0 };
    img.style.transform = "none";
    img.classList.remove("zoomed");
  } else {
    img.style.transform = `translate(${lbPan.x}px, ${lbPan.y}px) scale(${lbZoom})`;
    img.classList.add("zoomed");
  }
}

export function initLightbox() {
  document.getElementById("lb-close").addEventListener("click", lbClose);
  document.getElementById("lb-prev").addEventListener("click", e => {
    e.stopPropagation();
    if (lbIdx > 0) { lbIdx--; lbRender(); }
  });
  document.getElementById("lb-next").addEventListener("click", e => {
    e.stopPropagation();
    if (lbIdx < lbSlides.length - 1) { lbIdx++; lbRender(); }
  });
  document.getElementById("lb-scroll").addEventListener("click", e => {
    if (e.target === e.currentTarget) lbClose();
  });
  document.addEventListener("keydown", e => {
    const overlay = document.getElementById("lightbox-overlay");
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") lbClose();
    if (e.key === "ArrowLeft"  && lbIdx > 0) { lbIdx--; lbRender(); }
    if (e.key === "ArrowRight" && lbIdx < lbSlides.length - 1) { lbIdx++; lbRender(); }
  });
  document.getElementById("lb-scroll").addEventListener("wheel", e => {
    if (!document.getElementById("lightbox-overlay").classList.contains("open")) return;
    e.preventDefault();
    lbZoom = Math.max(1, Math.min(5, lbZoom + (e.deltaY < 0 ? 0.25 : -0.25)));
    lbApply();
  }, { passive: false });
  document.getElementById("lb-img").addEventListener("click", () => {
    const now = Date.now();
    if (now - lbLastTap < 320) {
      lbZoom = lbZoom > 1.05 ? 1 : 2.5;
      lbPan = { x: 0, y: 0 };
      lbApply();
    }
    lbLastTap = now;
  });
  document.getElementById("lb-img").addEventListener("mousedown", e => {
    if (lbZoom <= 1) return;
    e.preventDefault();
    lbDrag = { sx: e.clientX, sy: e.clientY, px: lbPan.x, py: lbPan.y };
    document.getElementById("lb-img").classList.add("dragging");
  });
  document.addEventListener("mousemove", e => {
    if (!lbDrag) return;
    lbPan.x = lbDrag.px + (e.clientX - lbDrag.sx);
    lbPan.y = lbDrag.py + (e.clientY - lbDrag.sy);
    lbApply();
  });
  document.addEventListener("mouseup", () => {
    if (lbDrag) {
      lbDrag = null;
      document.getElementById("lb-img")?.classList.remove("dragging");
    }
  });

  // Touch: pinch-to-zoom + drag-to-pan
  let lbPinchDist0 = 0, lbPinchZoom0 = 1, lbTouchDrag = null;
  document.getElementById("lb-img").addEventListener("touchstart", e => {
    if (e.touches.length === 2) {
      lbPinchDist0 = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      lbPinchZoom0 = lbZoom;
      lbTouchDrag = null;
    } else if (e.touches.length === 1 && lbZoom > 1) {
      lbTouchDrag = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, px: lbPan.x, py: lbPan.y };
    }
  }, { passive: true });
  document.getElementById("lb-img").addEventListener("touchmove", e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      lbZoom = Math.max(1, Math.min(5, lbPinchZoom0 * (d / lbPinchDist0)));
      lbApply();
    } else if (e.touches.length === 1 && lbTouchDrag) {
      lbPan.x = lbTouchDrag.px + (e.touches[0].clientX - lbTouchDrag.sx);
      lbPan.y = lbTouchDrag.py + (e.touches[0].clientY - lbTouchDrag.sy);
      lbApply();
    }
  }, { passive: false });
  document.getElementById("lb-img").addEventListener("touchend", e => {
    if (e.touches.length < 2) lbTouchDrag = null;
    if (lbZoom < 1.05) { lbZoom = 1; lbPan = { x: 0, y: 0 }; lbApply(); }
  }, { passive: true });
}
