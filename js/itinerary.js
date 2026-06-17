import { state, activeTripId } from "./state.js";
import { db, doc, updateDoc, setDoc, deleteDoc, serverTimestamp, writeBatch } from "./firebase.js";
import { GEMINI_CONFIG } from "./config.js";
import {
  escapeHtml, localDateStr, fmtDateRange, fmtSpreadDates, nightsBetween,
  daysUntil, fmtTime12, fmtDayHeader, mapsLink, mapsSearchBtn,
  linkifyNotes, wirePhoneCopyBtns, typeIconSVG, emailToName,
} from "./utils.js";
import { generateSpotGuide, TYPE_COLORS } from "./guides.js";
import { resolveTownImage, openPhotoPicker } from "./photos.js";
import {
  renderSpotPayerChips, renderSpotCustomSplits, updateSpotSplitTotalCheck,
  renderAccomPayerChips, renderAccomCustomSplits, updateAccomSplitTotalCheck,
  renderMemberPicker,
  setSpotSplit, setSpotMemberIds, setAccomSplit, setAccomMemberIds,
  _spotPayerId, _spotSplitMode, _spotCustomSplits, _spotMemberIds,
  _accomPayerId, _accomSplitMode, _accomCustomSplits, _accomMemberIds,
  applySpotTimeMode, populateCurrencySelect, linkSpots, unlinkSpot,
  currentUserMemberId, showTransitSheet, openTownEditModal,
} from "./budget.js";
import { renderDisruption, updateDisruptionBadge } from "./disruption.js";
import { addAttachment, deleteAttachment, toggleAttachmentPin, openLightbox } from "./documents.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerItineraryCallbacks({ pushModalHistory, popModalHistory, setView, openRecommendationsPanel }) {
  Object.assign(cb, { pushModalHistory, popModalHistory, setView, openRecommendationsPanel });
}

/* ─────────────────────────────────────────────────────────────
   SHARED MUTABLE STATE (exported as live bindings + setters)
   ───────────────────────────────────────────────────────────── */
export let currentDrawerSpot = null;
export let currentDrawerAccomTownId = null;
export let currentDrawerBudgetMode = false;
export function setCurrentDrawerSpot(s) { currentDrawerSpot = s; }
export function setCurrentDrawerAccomTownId(id) { currentDrawerAccomTownId = id; }
export function setCurrentDrawerBudgetMode(v) { currentDrawerBudgetMode = v; }

export let pendingScrollTownId = null;
export let pendingScrollToToday = false;
export let pendingGuideSpotId = null;
export function setPendingScrollTownId(id) { pendingScrollTownId = id; }
export function setPendingScrollToToday(v) { pendingScrollToToday = v; }
export function setPendingGuideSpotId(id) { pendingGuideSpotId = id; }

/* ─────────────────────────────────────────────────────────────
   DAY COLLAPSE PERSISTENCE
   ───────────────────────────────────────────────────────────── */
const DAY_COLLAPSE_KEY = "day-collapse-overrides";
function loadDayCollapse() { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(DAY_COLLAPSE_KEY) || "{}"))); } catch { return new Map(); } }
function saveDayCollapse(map) { try { localStorage.setItem(DAY_COLLAPSE_KEY, JSON.stringify(Object.fromEntries(map))); } catch {} }
const dayCollapseOverrides = loadDayCollapse();

/* ─────────────────────────────────────────────────────────────
   SPOT CRUD
   ───────────────────────────────────────────────────────────── */
export function spotDocRef(id) { return doc(db, "trips", activeTripId, "spots", id); }

export async function saveSpot(data, existingId) {
  if (existingId) {
    await updateDoc(spotDocRef(existingId), { ...data, updatedAt: serverTimestamp() });
  } else {
    const id = crypto.randomUUID();
    const sameDay = state.spots.filter(
      s => s.townId === data.townId && s.scheduledDate === data.scheduledDate
    );
    await setDoc(spotDocRef(id), {
      id, ...data,
      order: sameDay.length,
      visited: data.visited || false,
      expenses: [],
      createdAt: serverTimestamp(),
    });
    if (data.type !== "transport" && GEMINI_CONFIG.apiKey) {
      generateSpotGuide(id, data).catch(err => console.error("Guide gen failed:", err));
    }
  }
}

async function removeSpot(id) {
  await deleteDoc(spotDocRef(id));
}

function showVisitPricePrompt(spot) {
  return new Promise(resolve => {
    const overlay = document.getElementById("visit-price-overlay");
    const spotEl  = document.getElementById("visit-price-spot");
    const input   = document.getElementById("visit-price-input");
    const currSel = document.getElementById("visit-price-currency");

    spotEl.textContent = spot.name || "";
    input.value = spot.price ? spot.price.toFixed(2) : "";
    populateCurrencySelect(currSel, spot.priceCurrency);

    overlay.classList.add("open");
    setTimeout(() => input.focus(), 300);

    function close(result) {
      overlay.classList.remove("open");
      document.getElementById("visit-price-save").onclick = null;
      document.getElementById("visit-price-skip").onclick = null;
      overlay.onclick = null;
      resolve(result);
    }

    document.getElementById("visit-price-save").onclick = () => {
      const price = parseFloat(input.value);
      close(price > 0 ? { price, currency: currSel.value } : null);
    };
    document.getElementById("visit-price-skip").onclick = () => close(null);
    overlay.onclick = e => { if (e.target === overlay) close(null); };
  });
}

export async function toggleSpotVisited(spot) {
  const markingVisited = !spot.visited;
  const update = {
    visited: markingVisited,
    visitedAt: markingVisited ? serverTimestamp() : null,
  };

  if (markingVisited) {
    const priceData = await showVisitPricePrompt(spot);
    if (priceData) {
      update.price = priceData.price;
      update.priceCurrency = priceData.currency;
      update.booked = true;
      update.priceEstimated = false;
    } else if (spot.price) {
      update.booked = true;
      update.priceEstimated = false;
    }
  }

  await updateDoc(spotDocRef(spot.id), update);
}

/* ─────────────────────────────────────────────────────────────
   ITINERARY RENDERER
   ───────────────────────────────────────────────────────────── */
function getDaysForTown(town) {
  const days = [];
  const start = new Date(town.arrivalDate + "T00:00:00");
  const end   = new Date(town.departureDate + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1))
    days.push(localDateStr(d));
  return days;
}

export function getSpotsForTown(townId) {
  const own = state.spots.filter(s => s.townId === townId);
  const arrivals = state.spots
    .filter(s => s.type === "transport" && s.arrivalTownId === townId && s.townId !== townId)
    .map(s => ({ ...s, _arrivalView: true,
      scheduledDate: s.arrivalDate || s.scheduledDate || null,
      scheduledTime: s.arrivalTime || null }));
  return [...own, ...arrivals];
}

const _townFingerprints = new Map(); // townId → fingerprint string
const _townSortables    = new Map(); // townId → Sortable[]

function _townFingerprint(town) {
  const spots = getSpotsForTown(town.id);
  const collapseKeys = [...dayCollapseOverrides.entries()]
    .filter(([k]) => k.startsWith(town.id + ":"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
  const spotsFP = spots.map(s =>
    [s.id, s.name, s.type, s.scheduledDate, s.scheduledTime,
     s.order ?? "", s.booked ?? "", s.isCancelled ?? "",
     s.transportSubtype ?? "", s.groupId ?? "", s._arrivalView ?? ""].join("|")
  ).join(";");
  return JSON.stringify(town) + "\0" + spotsFP + "\0" + collapseKeys;
}

function _buildTownHTML(town) {
  const townSpots = getSpotsForTown(town.id);
  const days = getDaysForTown(town);
  const nights = nightsBetween(town.arrivalDate, town.departureDate);

  const byDate = {};
  for (const spot of townSpots) {
    const key = spot.scheduledDate || "unscheduled";
    (byDate[key] = byDate[key] || []).push(spot);
  }
  for (const key of Object.keys(byDate)) {
    byDate[key].sort((a, b) => {
      const aTime = a.scheduledTime;
      const bTime = b.scheduledTime;
      if (aTime && bTime) return aTime.localeCompare(bTime);
      if (aTime) return -1;
      if (bTime) return 1;
      if (a._arrivalView && !b._arrivalView) return -1;
      if (!a._arrivalView && b._arrivalView) return 1;
      return (a.order ?? 9999) - (b.order ?? 9999);
    });
  }
  const unscheduled = byDate["unscheduled"] || [];
  const townImgUrl = resolveTownImage(town);
  const showPhoto = !!townImgUrl && !town.hidePhoto;

  const editBtn = `<button class="town-edit-btn icon-btn" data-town-id="${escapeHtml(town.id)}" title="Edit city" style="padding:4px;opacity:0.55;margin-right:2px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="15" height="15"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>`;
  const photoBanner = showPhoto ? `
      <div class="town-photo-banner">
        <img src="${escapeHtml(townImgUrl)}" alt="${escapeHtml(town.name)}" loading="lazy"
             onerror="this.closest('.town-photo-banner').style.display='none'">
        <div class="town-photo-banner-overlay">
          <div style="position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:2">
            <button class="town-edit-btn icon-btn" data-town-id="${escapeHtml(town.id)}" title="Edit city"
              style="padding:5px;background:rgba(0,0,0,0.38);border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;backdrop-filter:blur(6px)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="change-photo-btn icon-btn" data-town-id="${escapeHtml(town.id)}" title="Change photo"
              style="padding:5px;background:rgba(0,0,0,0.38);border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;backdrop-filter:blur(6px)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </button>
          </div>
        </div>
      </div>` : "";

  return `
      <div class="town-group" id="itinerary-town-${escapeHtml(town.id)}" data-town="${escapeHtml(town.id)}">
        ${photoBanner}
        <div class="town-group-header"${showPhoto ? ' style="margin-top:-4px;border-radius:0 0 12px 12px"' : ""}>
          ${!showPhoto ? `<div class="town-header-img" style="background-image:url('${escapeHtml(townImgUrl)}')"></div>` : ""}
          <span class="town-group-dot"></span>
          <span class="town-group-name">${escapeHtml(town.name)}</span>
          <span class="town-group-dates">${fmtSpreadDates(town.arrivalDate, town.departureDate)} &middot; ${nights}n</span>
          ${showPhoto ? "" : editBtn}
        </div>
        ${renderAccomCard(town)}
        ${(() => {
          const todayKey = localDateStr(new Date());
          return days.map(dk => {
            const daySpots = byDate[dk] || [];
            const { dow, full } = fmtDayHeader(dk);
            const isEmpty = daySpots.length === 0;
            const key = `${town.id}:${dk}`;
            const override = dayCollapseOverrides.get(key);
            const isPast = dk < todayKey;
            const isCollapsed = override !== undefined ? override : isPast;
            const spotSummary = daySpots.length === 0 ? "No spots" : `${daySpots.length} spot${daySpots.length !== 1 ? "s" : ""}`;
            return `
              <div class="day-group${isCollapsed ? " collapsed" : ""}" data-day-key="${escapeHtml(key)}">
                <div class="day-header">
                  <span class="day-label">${dow}</span>
                  <span class="day-date-full">${full}</span>
                  <span class="day-spot-count">${spotSummary}</span>
                  <div class="day-rule"></div>
                  <button class="day-ai-btn" data-date="${dk}" data-town-id="${escapeHtml(town.id)}" title="AI suggestions for this day">✨</button>
                  <span class="day-chevron">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="6 9 12 15 18 9"/></svg>
                  </span>
                </div>
                <div class="day-body">
                  <div class="spot-list" data-date="${dk}" data-town-id="${escapeHtml(town.id)}">
                    ${daySpots.map(s => spotCardHTML(s)).join("")}
                  </div>
                  ${isEmpty
                    ? `<div class="day-empty"><span>Drop a spot here</span><button class="add-spot-inline" data-town-id="${escapeHtml(town.id)}" data-date="${dk}">+ Add</button></div>`
                    : `<button class="add-spot-inline" data-town-id="${escapeHtml(town.id)}" data-date="${dk}" style="margin-top:5px">+ Add to this day</button>`
                  }
                  <button class="transit-day-chip" data-town-id="${escapeHtml(town.id)}" data-date="${dk}">🚌 Transit</button>
                </div>
              </div>`;
          }).join("");
        })()}
        ${state.shareMode ? "" : (() => {
          const wKey = `${town.id}:wishlist`;
          const wOverride = dayCollapseOverrides.get(wKey);
          const wCollapsed = wOverride !== undefined ? wOverride : false;
          const wCount = unscheduled.length;
          return `<div class="day-group${wCollapsed ? " collapsed" : ""}" data-day-key="${wKey}">
            <div class="day-header">
              <span class="day-label" style="color:var(--text-3);font-style:italic;font-family:var(--font-display)">Wishlist</span>
              <span class="day-spot-count">${wCount} spot${wCount !== 1 ? "s" : ""}</span>
              <div class="day-rule"></div>
              <span class="day-chevron">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="6 9 12 15 18 9"/></svg>
              </span>
            </div>
            <div class="day-body">
              <div class="spot-list" data-date="unscheduled" data-town-id="${escapeHtml(town.id)}">
                ${unscheduled.map(s => spotCardHTML(s)).join("")}
              </div>
              <button class="add-spot-inline" data-town-id="${escapeHtml(town.id)}" data-date="" style="margin-top:5px">+ Add to wishlist</button>
            </div>
          </div>`;
        })()}
      </div>`;
}

function _wireTownElement(el) {
  el.querySelectorAll(".accom-card").forEach(card => {
    card.addEventListener("click", () => {
      const town = state.towns.find(t => t.id === card.dataset.townId);
      if (town) openAccomDrawer(town);
    });
  });
  el.querySelectorAll(".add-accom-link").forEach(link => {
    link.addEventListener("click", () => {
      const town = state.towns.find(t => t.id === link.dataset.townId);
      if (town) openAccomModal(town);
    });
  });
  el.querySelectorAll(".town-edit-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const town = state.towns.find(t => t.id === btn.dataset.townId);
      if (town) openTownEditModal(town);
    });
  });
  el.querySelectorAll(".change-photo-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const town = state.towns.find(t => t.id === btn.dataset.townId);
      if (town) openPhotoPicker(town.id, town.name);
    });
  });
  el.querySelectorAll(".day-ai-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      cb.openRecommendationsPanel(btn.dataset.townId, btn.dataset.date);
    });
  });
  el.querySelectorAll(".day-header").forEach(header => {
    header.addEventListener("click", e => {
      if (e.target.closest(".day-ai-btn")) return;
      const group = header.closest(".day-group");
      if (!group?.dataset.dayKey) return;
      const nowCollapsed = group.classList.toggle("collapsed");
      dayCollapseOverrides.set(group.dataset.dayKey, nowCollapsed);
      saveDayCollapse(dayCollapseOverrides);
    });
  });
  el.querySelectorAll(".add-spot-inline").forEach(btn => {
    btn.addEventListener("click", () => {
      const townId = btn.dataset.townId;
      const date = "date" in btn.dataset ? (btn.dataset.date || null) : null;
      openModal(null, { townId, scheduledDate: date });
    });
  });
  el.querySelectorAll(".transit-day-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      showTransitSheet(btn.dataset.townId, btn.dataset.date);
    });
  });
  el.querySelectorAll(".spot-card").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest(".spot-guide-link")) return;
      const spot = state.spots.find(s => s.id === card.dataset.spotId);
      if (spot) openDrawer(spot);
    });
  });
  el.querySelectorAll(".spot-guide-link").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      pendingGuideSpotId = btn.dataset.spotId;
      cb.setView("guides");
    });
  });
}

function _initTownSortables(el, townId, container) {
  if (typeof Sortable === "undefined" || document.body.classList.contains("share-mode")) return;
  const instances = [];
  el.querySelectorAll(".spot-list").forEach(list => {
    const inst = Sortable.create(list, {
      animation: 150,
      draggable: ".spot-card:not([data-draggable='false'])",
      delay: 500,
      delayOnTouchOnly: false,
      touchStartThreshold: 4,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
      group: "spots",
      onChoose: (evt) => {
        const spotId = evt.item.dataset.spotId;
        const spot = state.spots.find(s => s.id === spotId);
        if (spot?.groupId) {
          container.querySelectorAll(".spot-card").forEach(card => {
            const peer = state.spots.find(s => s.id === card.dataset.spotId);
            if (peer?.groupId === spot.groupId && peer.id !== spotId) {
              card.classList.add("drag-linked-peer");
            }
          });
        }
      },
      onUnchoose: () => {
        container.querySelectorAll(".drag-linked-peer").forEach(e => e.classList.remove("drag-linked-peer"));
      },
      onEnd: async (evt) => {
        container.querySelectorAll(".drag-linked-peer").forEach(e => e.classList.remove("drag-linked-peer"));

        const batch = writeBatch(db);
        const spotId = evt.item.dataset.spotId;
        const spot = state.spots.find(s => s.id === spotId);
        const newDateKey = evt.to.dataset.date;
        const newTownId = evt.to.dataset.townId;

        if (spot) {
          const updates = {};
          const oldDateKey = spot.scheduledDate || "unscheduled";
          if (newDateKey !== oldDateKey) {
            updates.scheduledDate = (!newDateKey || newDateKey === "unscheduled") ? null : newDateKey;
          }
          if (newTownId && newTownId !== spot.townId) {
            updates.townId = newTownId;
          }
          if (Object.keys(updates).length) batch.update(spotDocRef(spotId), updates);
        }

        const affectedLists = new Set([evt.from, evt.to]);
        if (spot?.groupId) {
          const peers = state.spots
            .filter(s => s.groupId === spot.groupId && s.id !== spotId)
            .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));

          let insertRef = evt.item.nextSibling;
          for (const peer of peers) {
            const peerCard = container.querySelector(`.spot-card[data-spot-id="${peer.id}"]`);
            if (!peerCard) continue;
            const fromList = peerCard.parentElement;
            if (fromList) affectedLists.add(fromList);
            evt.to.insertBefore(peerCard, insertRef);
            insertRef = peerCard.nextSibling;

            const peerUpdates = {};
            const peerDateKey = peer.scheduledDate || "unscheduled";
            if (newDateKey !== peerDateKey) {
              peerUpdates.scheduledDate = (!newDateKey || newDateKey === "unscheduled") ? null : newDateKey;
            }
            if (newTownId && newTownId !== peer.townId) {
              peerUpdates.townId = newTownId;
            }
            if (Object.keys(peerUpdates).length) batch.update(spotDocRef(peer.id), peerUpdates);
          }
        }

        for (const l of affectedLists) {
          [...l.querySelectorAll(".spot-card:not([data-draggable='false'])")].forEach((card, idx) => {
            batch.update(spotDocRef(card.dataset.spotId), { order: idx });
          });
        }
        await batch.commit().catch(e => console.error("Reorder failed:", e));
      },
    });
    instances.push(inst);
  });
  _townSortables.set(townId, instances);
}

function _membersBadgeHTML(memberIds) {
  const allMembers = state.trip?.members || [];
  if (!memberIds || allMembers.length < 2) return "";
  return `<span class="spot-members-pill">${
    memberIds.slice(0, 5).map(id => {
      const m = allMembers.find(x => x.id === id);
      return m
        ? `<span class="spot-member-dot" style="background:${escapeHtml(m.color || "#888")}" title="${escapeHtml(m.name)}">${escapeHtml(m.name.charAt(0).toUpperCase())}</span>`
        : "";
    }).join("")
  }</span>`;
}

function transportCardHTML(spot) {
  const isArrival = spot._arrivalView || spot.transportDirection === "arriving";
  const depTime = fmtTime12(spot.departureTime);
  const arrTime = fmtTime12(spot.arrivalTime);
  const subtype = spot.transportSubtype ? spot.transportSubtype.charAt(0).toUpperCase() + spot.transportSubtype.slice(1) : "Transport";

  const meta = [];
  if (isArrival) {
    if (arrTime) meta.push(`<span class="spot-time">arrives ${arrTime}</span>`);
    const originLabel = spot.customOrigin || spot.transportFrom;
    if (originLabel) meta.push(`<span class="spot-neighborhood">from ${escapeHtml(originLabel)}</span>`);
  } else {
    if (depTime) meta.push(`<span class="spot-time">departs ${depTime}</span>`);
    const destLabel = spot.customDestination || spot.transportTo;
    if (destLabel) meta.push(`<span class="spot-neighborhood">to ${escapeHtml(destLabel)}</span>`);
  }
  if (spot.carrier) meta.push(`<span class="spot-tag-pill">${escapeHtml(spot.carrier)}</span>`);
  const _tMemberBadge = _membersBadgeHTML(spot.memberIds);
  if (_tMemberBadge) meta.push(_tMemberBadge);

  const draggable = spot._arrivalView ? ` data-draggable="false"` : "";
  const arrivalClass = isArrival ? " arrival-view" : "";
  const cancelledClass = spot.isCancelled ? " cancelled" : "";
  const cancelledBadge = spot.isCancelled ? `<span class="spot-cancelled-badge">Cancelled</span>` : "";
  const rebookedBadge = spot.rebookedFromId ? `<span class="spot-rebooked-badge">Rebooked</span>` : "";

  return `
    <div class="spot-card${arrivalClass}${cancelledClass}" data-spot-id="${spot.id}" data-type="transport"${draggable}>
      <div class="spot-type-bar"></div>
      <div class="spot-card-body">
        <div class="spot-card-row1">
          ${typeIconSVG("transport")}
          <span class="spot-name">${escapeHtml(spot.name || subtype)}</span>
          ${!isArrival && !spot.isCancelled && spot.booked ? `<span class="spot-booked-pill">Booked / paid</span>` : ""}
          ${rebookedBadge}
          ${cancelledBadge}
          ${isArrival && !spot.isCancelled ? `<span class="spot-tag-pill" style="margin-left:auto;font-size:0.625rem;opacity:0.7">arrival</span>` : ""}
        </div>
        ${meta.length ? `<div class="spot-card-row2">${meta.join("")}</div>` : ""}
      </div>
    </div>`;
}

function spotCardHTML(spot) {
  if (spot.type === "transport") return transportCardHTML(spot);
  const type = spot.type || "sight";
  const timeStr    = fmtTime12(spot.scheduledTime);
  const endTimeStr = fmtTime12(spot.scheduledEndTime);
  const timePart   = timeStr && endTimeStr ? `${timeStr} – ${endTimeStr}` : timeStr;
  const durStr     = (!endTimeStr && spot.durationMinutes) ? `· ${spot.durationMinutes}min` : "";
  const hood = spot.neighborhood ? escapeHtml(spot.neighborhood) : "";
  const tags = (spot.tags || []).slice(0, 2)
    .map(t => `<span class="spot-tag-pill">${escapeHtml(t)}</span>`).join("");

  const bookedBadge = spot.booked && !spot.visited
    ? `<span class="spot-booked-pill">Booked / paid</span>`
    : "";
  const chainIcon = spot.groupId
    ? `<svg class="spot-chain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
    : "";

  const memberBadge = _membersBadgeHTML(spot.memberIds);
  const row2Parts = [];
  if (timePart) row2Parts.push(`<span class="spot-time">${timePart}</span>`);
  if (timePart && durStr) row2Parts.push(`<span class="spot-duration">${durStr}</span>`);
  if (hood) row2Parts.push(`<span class="spot-neighborhood">${timePart || durStr ? "·" : ""} ${hood}</span>`);
  if (memberBadge) row2Parts.push(memberBadge);

  const guideLink = `<button class="spot-guide-link" data-spot-id="${spot.id}" title="View guide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="14" height="14"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      </button>`;

  return `
    <div class="spot-card${spot.visited ? " visited" : ""}" data-spot-id="${spot.id}" data-type="${type}">
      ${spot.groupId ? `<div class="spot-group-indicator"></div>` : ""}
      <div class="spot-type-bar"></div>
      <div class="spot-card-body">
        <div class="spot-card-row1">
          ${typeIconSVG(type)}
          <span class="spot-name">${escapeHtml(spot.name)}</span>
          ${chainIcon}
          ${spot.visited ? `<svg class="spot-visited-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>` : ""}
          ${bookedBadge}
        </div>
        ${(row2Parts.length || tags) ? `<div class="spot-card-row2">${row2Parts.join("")}${tags}</div>` : ""}
      </div>
      ${guideLink}
    </div>`;
}

function renderAccomCard(town) {
  const a = town.accommodation;
  if (!a || !a.name) {
    return `<button class="add-accom-link" data-town-id="${escapeHtml(town.id)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      Add accommodation
    </button>`;
  }
  const checkin  = a.checkinDate  ? new Date(a.checkinDate  + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const checkout = a.checkoutDate ? new Date(a.checkoutDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const checkinStr  = [checkin,  a.checkinTime ].filter(Boolean).join(" ");
  const checkoutStr = [checkout, a.checkoutTime].filter(Boolean).join(" ");
  const dateRange = (checkinStr && checkoutStr)
    ? `Check-in ${checkinStr} · Check-out ${checkoutStr}`
    : (checkinStr ? `Check-in ${checkinStr}` : checkoutStr ? `Check-out ${checkoutStr}` : "");
  return `
    <div class="accom-card" data-town-id="${escapeHtml(town.id)}">
      <div class="accom-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </div>
      <div class="accom-body">
        <div class="accom-name">${escapeHtml(a.name)}</div>
        ${a.address ? `<div class="accom-meta" style="font-size:0.75rem">${escapeHtml(a.address)}</div>` : ""}
        ${dateRange ? `<div class="accom-meta">${dateRange}</div>` : ""}
        ${a.bookingRef ? `<div class="accom-meta" style="font-size:0.75rem">Ref: ${escapeHtml(a.bookingRef)}</div>` : ""}
        ${_membersBadgeHTML(a.memberIds) ? `<div class="accom-meta" style="display:flex;align-items:center;gap:4px;margin-top:2px">${_membersBadgeHTML(a.memberIds)}</div>` : ""}
      </div>
      ${a.booked ? `<span class="accom-booked">Booked / paid</span>` : ""}
    </div>`;
}

export function renderItinerary() {
  const container = document.getElementById("itinerary-content");
  if (!container) return;

  if (state.towns.length === 0) {
    _townSortables.forEach(arr => arr.forEach(s => s.destroy()));
    _townSortables.clear();
    _townFingerprints.clear();
    if (!state.trip) {
      container.innerHTML = `<div class="itinerary-empty"><p>Loading…</p></div>`;
    } else {
      container.innerHTML = `
        <div class="itinerary-empty">
          <p style="font-size:1.0625rem;font-weight:500;color:var(--text);margin-bottom:8px">No cities yet</p>
          <p style="margin-bottom:28px">Add your first city to start planning your trip.</p>
          ${state.shareMode ? "" : `<button class="btn-primary" id="itinerary-add-city-btn" style="padding:10px 22px;font-size:0.9375rem">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right:6px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add a city
          </button>`}
        </div>`;
      container.querySelector("#itinerary-add-city-btn")?.addEventListener("click", () => openTownEditModal());
    }
    return;
  }

  // Clear empty-state placeholder when transitioning from 0 → N towns
  container.querySelector(".itinerary-empty")?.remove();

  // Remove DOM elements for towns that no longer exist
  const currentTownIds = new Set(state.towns.map(t => t.id));
  container.querySelectorAll(".town-group[data-town]").forEach(el => {
    const id = el.dataset.town;
    if (!currentTownIds.has(id)) {
      _townSortables.get(id)?.forEach(s => s.destroy());
      _townSortables.delete(id);
      _townFingerprints.delete(id);
      el.remove();
    }
  });

  // Process each town in order — only rebuild sections whose fingerprint changed
  let prevEl = null;
  for (const town of state.towns) {
    const fp = _townFingerprint(town);
    let el = document.getElementById(`itinerary-town-${town.id}`);

    if (el && _townFingerprints.get(town.id) === fp) {
      // Unchanged — verify DOM ordering and move if necessary
      const expected = prevEl ? prevEl.nextElementSibling : container.firstElementChild;
      if (expected !== el) {
        if (prevEl) prevEl.after(el);
        else container.prepend(el);
      }
      prevEl = el;
      continue;
    }

    // Build replacement element
    const tmp = document.createElement("div");
    tmp.innerHTML = _buildTownHTML(town);
    const newEl = tmp.firstElementChild;

    _townSortables.get(town.id)?.forEach(s => s.destroy());
    _townSortables.delete(town.id);

    if (el) {
      el.replaceWith(newEl);
    } else if (prevEl) {
      prevEl.after(newEl);
    } else {
      const footer = container.querySelector("#itinerary-add-city-footer-btn")?.closest("div");
      if (footer) container.insertBefore(newEl, footer);
      else container.prepend(newEl);
    }
    el = newEl;

    _wireTownElement(el);
    _initTownSortables(el, town.id, container);
    _townFingerprints.set(town.id, fp);
    prevEl = el;
  }

  // Ensure "Add city" footer exists once at the end
  if (!state.shareMode && !container.querySelector("#itinerary-add-city-footer-btn")) {
    const footer = document.createElement("div");
    footer.style.cssText = "padding:8px 0 32px;text-align:center";
    footer.innerHTML = `<button class="btn-secondary" id="itinerary-add-city-footer-btn" style="font-size:0.875rem;padding:9px 20px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="margin-right:6px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add city
    </button>`;
    footer.querySelector("button").addEventListener("click", () => openTownEditModal());
    container.append(footer);
  }

  if (pendingScrollTownId) {
    const townId = pendingScrollTownId;
    pendingScrollTownId = null;
    requestAnimationFrame(() => {
      const target = document.getElementById(`itinerary-town-${townId}`);
      const main = document.querySelector(".main");
      if (target && main) {
        const top = main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top - 80;
        main.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
    });
  }

  if (pendingScrollToToday) {
    pendingScrollToToday = false;
    const todayIso = localDateStr(new Date());
    requestAnimationFrame(() => {
      const todayList = container.querySelector(`.spot-list[data-date="${todayIso}"]`);
      if (!todayList) return;
      const dayGroup = todayList.closest(".day-group") || todayList.parentElement;
      const main = document.querySelector(".main");
      if (dayGroup && main) {
        const top = main.scrollTop + dayGroup.getBoundingClientRect().top - main.getBoundingClientRect().top - 80;
        main.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
    });
  }
}

/* ─────────────────────────────────────────────────────────────
   DRAWERS
   ───────────────────────────────────────────────────────────── */
export function openAccomDrawer(town) {
  currentDrawerSpot = null;
  currentDrawerAccomTownId = town.id;
  const a = town.accommodation || {};

  const badge = document.getElementById("drawer-type-badge");
  badge.textContent = "Accommodation";
  badge.dataset.type = "accommodation";

  document.getElementById("drawer-spot-name").textContent = a.name || "Accommodation";

  const rows = [];
  const fmtD = iso => iso
    ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    : null;

  {
    const accomTownName = town?.name || "";
    const accomName = a.name || "Accommodation";
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Location</div>
        <div class="drawer-meta-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${a.address ? mapsLink(a.address) : escapeHtml(accomTownName)}
        </div>
        ${!a.address ? `<div>${mapsSearchBtn(accomName, accomTownName)}</div>` : ""}
      </div>`);
  }

  const checkinDate  = fmtD(a.checkinDate);
  const checkoutDate = fmtD(a.checkoutDate);
  const checkinTime  = fmtTime12(a.checkinTime);
  const checkoutTime = fmtTime12(a.checkoutTime);
  if (checkinDate || checkinTime || checkoutDate || checkoutTime) {
    const ciLine = [checkinDate,  checkinTime ].filter(Boolean).join(" · ");
    const coLine = [checkoutDate, checkoutTime].filter(Boolean).join(" · ");
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Stay</div>
        ${ciLine ? `<div class="drawer-meta-row" style="margin-bottom:4px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span style="color:var(--text-3);font-size:0.8125rem;flex-shrink:0">Check-in</span>
          ${escapeHtml(ciLine)}
        </div>` : ""}
        ${coLine ? `<div class="drawer-meta-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span style="color:var(--text-3);font-size:0.8125rem;flex-shrink:0">Check-out</span>
          ${escapeHtml(coLine)}
        </div>` : ""}
      </div>`);
  }

  if (a.booked || a.bookingRef) {
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Booking</div>
        ${a.booked
          ? `<div class="drawer-meta-row" style="color:var(--success)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              Booked / paid${a.bookingRef ? ` · Ref: ${escapeHtml(a.bookingRef)}` : ""}
            </div>`
          : `<div class="drawer-meta-sub">Ref: ${escapeHtml(a.bookingRef)}</div>`}
      </div>`);
  }

  if (a.notes) {
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Notes</div>
        <div class="drawer-notes">${linkifyNotes(a.notes)}</div>
      </div>`);
  }

  const accomBodyEl = document.getElementById("drawer-body");
  accomBodyEl.innerHTML = rows.join("") ||
    `<p class="drawer-empty">No details yet — tap edit to add accommodation info.</p>`;
  wirePhoneCopyBtns(accomBodyEl);

  document.getElementById("drawer-visited-btn").style.display = "none";

  cb.pushModalHistory();
  document.getElementById("spot-drawer-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
}

export function openDrawer(spot) {
  currentDrawerSpot = spot;
  const badge = document.getElementById("drawer-type-badge");
  badge.textContent = spot.type || "sight";
  badge.dataset.type = spot.type || "sight";
  document.getElementById("drawer-spot-name").textContent = spot.name;

  const rows = [];

  if (spot.type === "transport") {
    const subtypeLabel = spot.transportSubtype
      ? spot.transportSubtype.charAt(0).toUpperCase() + spot.transportSubtype.slice(1)
      : "Transport";
    badge.textContent = subtypeLabel;

    const fromTown    = state.towns.find(t => t.id === spot.townId);
    const arrivalTown = state.towns.find(t => t.id === spot.arrivalTownId);
    const origin      = spot.customOrigin      || spot.transportFrom || fromTown?.name    || "";
    const destination = spot.customDestination || spot.transportTo   || arrivalTown?.name || "";

    if (origin || destination) {
      rows.push(`
        <div class="drawer-section">
          <div class="drawer-section-label">Route</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:4px;flex-wrap:wrap">
            <div style="font-size:1rem;font-weight:500;color:var(--text)">${escapeHtml(origin || "—")}</div>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="16" height="16" style="flex-shrink:0;color:var(--tint-transport)"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <div style="font-size:1rem;font-weight:500;color:var(--text)">${escapeHtml(destination || "—")}</div>
          </div>
          ${arrivalTown && arrivalTown.id !== fromTown?.id
            ? `<div class="drawer-meta-sub" style="margin-top:4px">Arriving in ${escapeHtml(arrivalTown.name)}</div>` : ""}
        </div>`);
    }

    const fmtJourneyDate = iso => iso
      ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
      : null;
    const depDate = fmtJourneyDate(spot.scheduledDate);
    const arrDate = fmtJourneyDate(spot.arrivalDate);
    const depTime = fmtTime12(spot.departureTime);
    const arrTime = fmtTime12(spot.arrivalTime);

    if (depDate || depTime || arrDate || arrTime) {
      const depLine = [depDate, depTime].filter(Boolean).join(" · ");
      const arrLine = [arrDate, arrTime].filter(Boolean).join(" · ");
      rows.push(`
        <div class="drawer-section">
          <div class="drawer-section-label">Journey</div>
          ${depLine ? `<div class="drawer-meta-row" style="margin-bottom:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span style="color:var(--text-3);font-size:0.8125rem;flex-shrink:0">Departs</span>
            ${escapeHtml(depLine)}
          </div>` : ""}
          ${arrLine ? `<div class="drawer-meta-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span style="color:var(--text-3);font-size:0.8125rem;flex-shrink:0">Arrives</span>
            ${escapeHtml(arrLine)}
          </div>` : ""}
        </div>`);
    }

    if (spot.carrier || spot.seat) {
      rows.push(`
        <div class="drawer-section">
          <div class="drawer-section-label">Details</div>
          ${spot.carrier ? `<div class="drawer-meta-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
            ${escapeHtml(spot.carrier)}
          </div>` : ""}
          ${spot.seat ? `<div class="drawer-meta-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M20.2 7.8l-7.7 7.7-4-4-5.7 5.7"/><path d="M15 7h6v6"/></svg>
            Seat ${escapeHtml(spot.seat)}
          </div>` : ""}
        </div>`);
    }

  } else {
    const spotTown = state.towns.find(t => t.id === spot.townId);
    const spotTownName = spotTown?.name || "";
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Location</div>
        ${spot.neighborhood ? `<div class="drawer-meta-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${escapeHtml(spot.neighborhood)}
        </div>` : ""}
        ${spot.address
          ? `<div class="drawer-meta-sub">${mapsLink(spot.address)}</div>`
          : `<div>${mapsSearchBtn(spot.name, spotTownName)}</div>`}
      </div>`);
    if (spot.scheduledDate || spot.scheduledTime) {
      const dateLine = spot.scheduledDate
        ? new Date(spot.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
        : "";
      const timeLine    = fmtTime12(spot.scheduledTime);
      const endTimeLine = spot.scheduledEndTime ? ` – ${fmtTime12(spot.scheduledEndTime)}` : "";
      const durLine     = (spot.durationMinutes && !spot.scheduledEndTime) ? ` · ${spot.durationMinutes} min` : "";
      rows.push(`
        <div class="drawer-section">
          <div class="drawer-section-label">Schedule</div>
          <div class="drawer-meta-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${escapeHtml(dateLine)}${timeLine ? ` at ${timeLine}${endTimeLine}` : ""}${escapeHtml(durLine)}
          </div>
        </div>`);
    }
    if (spot.tags && spot.tags.length) {
      rows.push(`
        <div class="drawer-section">
          <div class="drawer-section-label">Tags</div>
          <div class="drawer-tags">${spot.tags.map(t => `<span class="spot-tag-pill">${escapeHtml(t)}</span>`).join("")}</div>
        </div>`);
    }
  }

  if (spot.notes) {
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Notes</div>
        <div class="drawer-notes">${linkifyNotes(spot.notes)}</div>
      </div>`);
  }
  if (spot.bookingRef || spot.booked) {
    rows.push(`
      <div class="drawer-section">
        <div class="drawer-section-label">Booking</div>
        ${spot.booked ? `<div class="drawer-meta-row" style="color:var(--success)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Booked / paid${spot.bookingRef ? ` · Ref: ${escapeHtml(spot.bookingRef)}` : ""}
        </div>` : spot.bookingRef ? `<div class="drawer-meta-sub">Ref: ${escapeHtml(spot.bookingRef)}</div>` : ""}
      </div>`);
  }

  const attachments = spot.attachments || [];
  const attachHtml = attachments.map(att => {
    const isImg = att.mimeType && att.mimeType.startsWith("image/");
    const thumb = isImg
      ? `<img class="attach-thumb" src="${att.data}" alt="${escapeHtml(att.name)}">`
      : `<div class="attach-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`;
    return `<div class="attach-thumb-row" data-attach-id="${att.id}">
      ${thumb}
      <span class="attach-name">${escapeHtml(att.name)}</span>
      <button class="attach-delete-btn" data-delete-attach="${att.id}" title="Remove">✕</button>
    </div>`;
  }).join("");

  const sameDaySorted = state.spots
    .filter(s => s.townId === spot.townId && s.scheduledDate === spot.scheduledDate && s.type !== "transport")
    .sort((a, b) => (a.scheduledTime || "").localeCompare(b.scheduledTime || "") || (a.order ?? 9999) - (b.order ?? 9999));
  const idx = sameDaySorted.findIndex(s => s.id === spot.id);
  const prevSpot = idx > 0 ? sameDaySorted[idx - 1] : null;
  const nextSpot = idx < sameDaySorted.length - 1 ? sameDaySorted[idx + 1] : null;
  const linkedNames = spot.groupId
    ? state.spots.filter(s => s.groupId === spot.groupId && s.id !== spot.id).map(s => escapeHtml(s.name)).join(", ")
    : "";

  const alreadyLinked = (s) => spot.groupId && s.groupId === spot.groupId;

  let linkBody = "";
  if (spot.groupId) {
    linkBody = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="13" height="13" style="color:var(--accent);flex-shrink:0"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span style="font-size:0.8125rem;color:var(--text-2);flex:1">${linkedNames || "another spot"}</span>
      <button class="btn-ghost" id="drawer-unlink-btn" style="padding:3px 8px;font-size:0.8125rem">Unlink</button>
    </div>`;
  } else {
    const btns = [];
    if (prevSpot && !alreadyLinked(prevSpot)) btns.push(`<button class="btn-ghost drawer-link-adj-btn" data-link-id="${prevSpot.id}" style="padding:5px 10px;font-size:0.8125rem;text-align:left">↑ Add ${escapeHtml(prevSpot.name)}</button>`);
    if (nextSpot && !alreadyLinked(nextSpot)) btns.push(`<button class="btn-ghost drawer-link-adj-btn" data-link-id="${nextSpot.id}" style="padding:5px 10px;font-size:0.8125rem;text-align:left">↓ Add ${escapeHtml(nextSpot.name)}</button>`);
    linkBody = btns.length
      ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">${btns.join("")}</div>`
      : `<p style="font-size:0.8125rem;color:var(--text-3);margin-top:6px">No adjacent spots on this day to link.</p>`;
  }
  const linkSection = `
    <div class="drawer-link-section">
      <div class="drawer-section-label">Link to adjacent spot</div>
      ${linkBody}
    </div>`;

  rows.push(`
    <div class="drawer-section" style="padding-bottom:0">
      <div class="drawer-section-label">Attachments</div>
      ${attachHtml}
      <div class="attach-upload-row" id="drawer-upload-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <div>
          <div>Add photo or screenshot</div>
          <div style="font-size:0.75rem;opacity:0.7;margin-top:1px">JPG or PNG recommended · keep under 500 KB · PDFs may exceed Firestore limits</div>
        </div>
      </div>
      ${linkSection}
    </div>`);

  const bodyEl = document.getElementById("drawer-body");
  bodyEl.innerHTML = rows.join("") ||
    `<p class="drawer-empty">No details yet — tap edit to add notes, schedule, or tags.</p>`;
  wirePhoneCopyBtns(bodyEl);

  bodyEl.querySelector("#drawer-upload-row")?.addEventListener("click", () => {
    const input = document.getElementById("attach-file-input");
    input.value = "";
    input.onchange = async () => {
      if (!input.files[0]) return;
      try { await addAttachment(spot.id, input.files[0]); }
      catch (e) { console.error("Attach failed:", e); }
    };
    input.click();
  });

  bodyEl.querySelectorAll(".attach-thumb-row").forEach((row, rowIdx) => {
    row.addEventListener("click", e => {
      if (e.target.closest(".attach-delete-btn")) return;
      const imgAttachments = (spot.attachments || []).filter(a => a.mimeType?.startsWith("image/"));
      const attId = row.dataset.attachId;
      const lbStart = imgAttachments.findIndex(a => a.id === attId);
      if (lbStart >= 0) openLightbox(imgAttachments, lbStart, spot.name);
    });
  });

  bodyEl.querySelectorAll("[data-delete-attach]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm("Remove this attachment?")) return;
      await deleteAttachment(spot.id, btn.dataset.deleteAttach);
    });
  });

  bodyEl.querySelectorAll(".drawer-link-adj-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await linkSpots(spot.id, btn.dataset.linkId);
    });
  });

  bodyEl.querySelector("#drawer-unlink-btn")?.addEventListener("click", async () => {
    await unlinkSpot(spot.id);
  });

  const visitedBtn = document.getElementById("drawer-visited-btn");
  if (spot.visited) {
    visitedBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg> Visited`;
    visitedBtn.style.background = "var(--success)";
  } else {
    visitedBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg> Mark visited`;
    visitedBtn.style.background = "";
  }

  const cancelBtn = document.getElementById("drawer-cancel-transport-btn");
  if (spot.type === "transport" && !spot._arrivalView) {
    cancelBtn.style.display = "";
    if (spot.isCancelled) {
      cancelBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg> Restore transport`;
      cancelBtn.classList.add("is-cancelled");
    } else {
      cancelBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Mark as Cancelled`;
      cancelBtn.classList.remove("is-cancelled");
    }
  } else {
    cancelBtn.style.display = "none";
  }

  cb.pushModalHistory();
  document.getElementById("spot-drawer-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
}

export function closeDrawer() {
  document.getElementById("spot-drawer-overlay").classList.remove("visible");
  document.body.style.overflow = "";
  currentDrawerSpot = null;
  currentDrawerAccomTownId = null;
  currentDrawerBudgetMode = false;
  document.getElementById("drawer-edit-btn").style.display = "";
  document.getElementById("drawer-visited-btn").style.display = "";
  document.getElementById("drawer-cancel-transport-btn").style.display = "none";
  cb.popModalHistory();
}

/* ─────────────────────────────────────────────────────────────
   ADD / EDIT MODAL
   ───────────────────────────────────────────────────────────── */
let modalEditId = null;
let _modalReturnView = "itinerary";
let selectedType = "sight";
let selectedTags = new Set();
let visitedState = false;
let priceEstimatedState = true;
let bookedState = false;
let _spotTimeMode = "duration";

export function openModal(spot = null, presets = {}) {
  modalEditId = spot ? spot.id : null;
  _modalReturnView = state.currentView || "itinerary";
  selectedType = spot ? (spot.type || "sight") : (presets.type || "sight");
  selectedTags = new Set(spot ? (spot.tags || []) : []);
  visitedState = spot ? (spot.visited || false) : false;

  document.getElementById("modal-title").textContent = spot ? "Edit spot" : "Add spot";
  document.getElementById("delete-spot-btn").style.display = spot ? "" : "none";
  document.getElementById("spot-name").value = spot ? (spot.name || "") : "";
  document.getElementById("spot-neighborhood").value = spot ? (spot.neighborhood || "") : "";
  document.getElementById("spot-address").value = spot ? (spot.address || "") : "";
  document.getElementById("spot-time").value       = spot ? (spot.scheduledTime    || "") : "";
  document.getElementById("spot-duration").value   = spot ? (spot.durationMinutes || "") : "";
  document.getElementById("spot-end-time").value   = spot ? (spot.scheduledEndTime || "") : "";
  _spotTimeMode = (spot?.scheduledEndTime && !spot?.durationMinutes) ? "endtime" : "duration";
  applySpotTimeMode(_spotTimeMode);
  document.getElementById("spot-notes").value = spot ? (spot.notes || "") : "";

  const presetTownId = spot ? spot.townId : presets.townId;
  const townSel = document.getElementById("spot-town");
  townSel.innerHTML = state.towns.map(t =>
    `<option value="${t.id}"${t.id === presetTownId ? " selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");
  townSel.disabled = !spot && !!presets.townId;

  const dateInput = document.getElementById("spot-date");
  applyTownDateConstraints(presetTownId, dateInput);
  dateInput.value = spot ? (spot.scheduledDate || "") : (presets.scheduledDate || "");

  document.querySelectorAll(".type-option").forEach(btn =>
    btn.classList.toggle("selected", btn.dataset.type === selectedType));

  renderTagsGrid();
  applyTransportToggle(selectedType);

  if (selectedType === "transport") {
    const subtype = (spot && spot.transportSubtype) || "train";
    document.querySelectorAll(".subtype-option").forEach(b =>
      b.classList.toggle("selected", b.dataset.subtype === subtype));
    const direction = (spot && spot.transportDirection) || "departing";
    document.querySelectorAll("#transport-direction-selector .subtype-option").forEach(b =>
      b.classList.toggle("selected", b.dataset.direction === direction));
    document.getElementById("transport-from").value         = (spot && spot.transportFrom)  || "";
    document.getElementById("transport-to").value           = (spot && spot.transportTo)    || "";
    document.getElementById("transport-dep-date").value     = (spot && spot.scheduledDate)  || "";
    document.getElementById("transport-dep-time").value     = (spot && spot.departureTime)  || "";
    document.getElementById("transport-arr-date").value     = (spot && spot.arrivalDate)    || "";
    document.getElementById("transport-arr-time").value     = (spot && spot.arrivalTime)    || "";
    document.getElementById("transport-carrier").value      = (spot && spot.carrier)        || "";
    document.getElementById("transport-seat").value         = (spot && spot.seat)           || "";
    document.getElementById("transport-arrival-town").value = (spot && spot.arrivalTownId) || "";
    document.getElementById("custom-origin").value          = (spot && spot.customOrigin)  || "";
  } else {
    document.querySelectorAll(".subtype-option").forEach((b, i) => b.classList.toggle("selected", i === 0));
  }

  document.getElementById("visited-switch").classList.toggle("on", visitedState);

  document.getElementById("spot-price").value = spot ? (spot.price ?? "") : "";
  populateCurrencySelect(document.getElementById("spot-price-currency"), spot?.priceCurrency);
  document.getElementById("spot-booking-ref").value = spot ? (spot.bookingRef || "") : "";
  priceEstimatedState = spot ? (spot.priceEstimated ?? true) : true;
  bookedState = spot ? (spot.booked ?? false) : false;
  document.getElementById("estimated-switch").classList.toggle("on", priceEstimatedState);
  document.getElementById("booked-switch").classList.toggle("on", bookedState);

  const spotMembers = state.trip?.members || [];
  const spotSplitSection = document.getElementById("spot-split-section");
  if (spotMembers.length >= 2) {
    spotSplitSection.style.display = "block";
    setSpotSplit(spot?.paidBy || currentUserMemberId() || null, spot?.splitType || "equal", spot?.splits);
    renderSpotPayerChips(spotMembers);
    document.querySelectorAll("#spot-split-mode-row .split-mode-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === _spotSplitMode);
    });
    const spotCustomDiv = document.getElementById("spot-custom-splits");
    spotCustomDiv.style.display = _spotSplitMode === "custom" ? "block" : "none";
    if (_spotSplitMode === "custom") renderSpotCustomSplits(spotMembers);
  } else {
    spotSplitSection.style.display = "none";
  }

  const spotMemberSection = document.getElementById("spot-member-section");
  if (spotMembers.length >= 2) {
    spotMemberSection.style.display = "block";
    setSpotMemberIds(spot?.memberIds ? new Set(spot.memberIds) : new Set(spotMembers.map(m => m.id)));
    renderMemberPicker("spot-member-chips", _spotMemberIds, spotMembers);
  } else {
    spotMemberSection.style.display = "none";
  }

  const btn = document.getElementById("modal-save-btn");
  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save spot`;

  document.getElementById("spot-modal-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
  setTimeout(() => document.getElementById("spot-name").focus(), 60);
}

function applyTownDateConstraints(townId, dateInput) {
  const town = townId ? state.towns.find(t => t.id === townId) : null;
  if (town) {
    dateInput.min = town.arrivalDate;
    const last = new Date(town.departureDate + "T00:00:00");
    last.setDate(last.getDate() - 1);
    dateInput.max = last.toISOString().slice(0, 10);
  } else {
    dateInput.min = "";
    dateInput.max = "";
  }
}

export function closeModal() {
  document.getElementById("spot-modal-overlay").classList.remove("visible");
  document.body.style.overflow = "";
  modalEditId = null;
}

/* ─────────────────────────────────────────────────────────────
   ACCOMMODATION MODAL
   ───────────────────────────────────────────────────────────── */
let accomTownId = null;
let accomBooked = false;

export function openAccomModal(town) {
  accomTownId = town.id;
  const a = town.accommodation || {};
  accomBooked = !!a.booked;

  document.getElementById("accom-modal-title").textContent = a.name ? "Edit accommodation" : "Add accommodation";
  document.getElementById("accom-name").value           = a.name || "";
  document.getElementById("accom-address").value        = a.address || "";
  document.getElementById("accom-checkin-date").value   = a.checkinDate || town.arrivalDate || "";
  document.getElementById("accom-checkout-date").value  = a.checkoutDate || town.departureDate || "";
  document.getElementById("accom-checkin-time").value   = a.checkinTime || "";
  document.getElementById("accom-checkout-time").value  = a.checkoutTime || "";
  document.getElementById("accom-booking-ref").value    = a.bookingRef || "";
  document.getElementById("accom-price").value          = a.price != null ? a.price : "";
  populateCurrencySelect(document.getElementById("accom-price-currency"), a.priceCurrency);
  document.getElementById("accom-notes").value          = a.notes || "";

  const sw = document.getElementById("accom-booked-switch");
  sw.classList.toggle("on", accomBooked);

  const accomMembers = state.trip?.members || [];
  const accomSplitSection = document.getElementById("accom-split-section");
  if (accomMembers.length >= 2) {
    accomSplitSection.style.display = "block";
    setAccomSplit(a.paidBy || currentUserMemberId() || null, a.splitType || "equal", a.splits);
    renderAccomPayerChips(accomMembers);
    document.querySelectorAll("#accom-split-mode-row .split-mode-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === _accomSplitMode);
    });
    const accomCustomDiv = document.getElementById("accom-custom-splits");
    accomCustomDiv.style.display = _accomSplitMode === "custom" ? "block" : "none";
    if (_accomSplitMode === "custom") renderAccomCustomSplits(accomMembers);
  } else {
    accomSplitSection.style.display = "none";
  }

  const accomMemberSection = document.getElementById("accom-member-section");
  if (accomMembers.length >= 2) {
    accomMemberSection.style.display = "block";
    setAccomMemberIds(a.memberIds ? new Set(a.memberIds) : new Set(accomMembers.map(m => m.id)));
    renderMemberPicker("accom-member-chips", _accomMemberIds, accomMembers);
  } else {
    accomMemberSection.style.display = "none";
  }

  const saveBtn = document.getElementById("accom-modal-save-btn");
  saveBtn.disabled = false;
  saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
  document.getElementById("accom-save-error").style.display = "none";
  document.getElementById("accom-modal-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
  document.getElementById("accom-name").focus();
}

export function closeAccomModal() {
  document.getElementById("accom-modal-overlay").classList.remove("visible");
  document.body.style.overflow = "";
  accomTownId = null;
}

async function saveAccommodation() {
  const name = document.getElementById("accom-name").value.trim();
  if (!name || !accomTownId) {
    document.getElementById("accom-name").focus();
    return;
  }

  const accomPrice = parseFloat(document.getElementById("accom-price").value) || null;
  const accomMembers = state.trip?.members || [];
  let accomSplitData = {};
  if (accomMembers.length >= 2 && _accomPayerId && accomPrice) {
    accomSplitData.paidBy = _accomPayerId;
    if (_accomSplitMode === "solo") {
      accomSplitData.splitType = "solo";
      accomSplitData.splits = accomMembers.map(m => ({ memberId: m.id, owed: m.id === _accomPayerId ? accomPrice : 0 }));
    } else if (_accomSplitMode === "custom") {
      accomSplitData.splitType = "custom";
      accomSplitData.splits = accomMembers.map(m => ({ memberId: m.id, owed: _accomCustomSplits[m.id] || 0 }));
    } else {
      accomSplitData.splitType = "equal";
      accomSplitData.splits = accomMembers.map(m => ({ memberId: m.id, owed: accomPrice / accomMembers.length }));
    }
  } else {
    accomSplitData = { paidBy: null, splitType: null, splits: null };
  }

  const data = {
    name,
    address:       document.getElementById("accom-address").value.trim()     || null,
    checkinDate:   document.getElementById("accom-checkin-date").value       || null,
    checkoutDate:  document.getElementById("accom-checkout-date").value      || null,
    checkinTime:   document.getElementById("accom-checkin-time").value       || null,
    checkoutTime:  document.getElementById("accom-checkout-time").value      || null,
    bookingRef:    document.getElementById("accom-booking-ref").value.trim() || null,
    price:         accomPrice,
    priceCurrency: document.getElementById("accom-price-currency").value     || "EUR",
    notes:         document.getElementById("accom-notes").value.trim()       || null,
    booked:        accomBooked,
    memberIds: (accomMembers.length >= 2 && _accomMemberIds.size > 0 && _accomMemberIds.size < accomMembers.length)
      ? [..._accomMemberIds]
      : null,
    ...accomSplitData,
  };

  const btn = document.getElementById("accom-modal-save-btn");
  const errEl = document.getElementById("accom-save-error");
  errEl.style.display = "none";
  btn.disabled = true;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Saving…`;

  const townId = accomTownId;
  closeAccomModal();
  const townRef = doc(db, "trips", activeTripId, "towns", townId);
  updateDoc(townRef, { accommodation: data }).catch(err => console.error("saveAccommodation:", err));
}

/* ─────────────────────────────────────────────────────────────
   MODAL FORM HELPERS
   ───────────────────────────────────────────────────────────── */
function renderTagsGrid() {
  const tags = state.trip?.tags || [];
  const field = document.getElementById("tags-field");
  const grid = document.getElementById("tags-grid");
  if (!tags.length) { field.style.display = "none"; return; }
  field.style.display = "";
  grid.innerHTML = tags.map(tag => `
    <button class="tag-toggle${selectedTags.has(tag) ? " selected" : ""}" data-tag="${escapeHtml(tag)}">
      ${escapeHtml(tag)}
    </button>`).join("");
  grid.querySelectorAll(".tag-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      selectedTags.has(tag) ? selectedTags.delete(tag) : selectedTags.add(tag);
      btn.classList.toggle("selected", selectedTags.has(tag));
    });
  });
}

function applyTransportDirection(direction) {
  const isArriving = direction === "arriving";
  const arrivalTownField = document.getElementById("transport-arrival-town")?.closest(".form-field");
  if (arrivalTownField) arrivalTownField.style.display = isArriving ? "none" : "";
  const customDestWrap = document.getElementById("custom-destination-wrap");
  if (customDestWrap) customDestWrap.style.display = isArriving ? "none" : "none";

  document.querySelectorAll("#transport-direction-selector .subtype-option").forEach(b => {
    b.classList.toggle("selected", b.dataset.direction === direction);
  });

  const depTownId = document.getElementById("spot-town")?.value;
  const depTown = state.towns.find(t => t.id === depTownId);
  const cityName = depTown?.name || "city";
  document.getElementById("dir-departing").textContent = `Leaving ${cityName}`;
  document.getElementById("dir-arriving").textContent  = `Arriving in ${cityName}`;
}

function applyTransportToggle(type) {
  const isTransport = type === "transport";
  document.getElementById("transport-fields").classList.toggle("hidden", !isTransport);
  document.getElementById("standard-location-fields").style.display = isTransport ? "none" : "";
  document.getElementById("standard-time-fields").style.display     = isTransport ? "none" : "";
  document.getElementById("tags-field").style.display               = isTransport ? "none" : "";
  document.getElementById("visited-toggle").style.display           = isTransport ? "none" : "";

  if (isTransport) {
    const sel = document.getElementById("transport-arrival-town");
    const depTownId = document.getElementById("spot-town").value;
    sel.innerHTML = `<option value="">— select town —</option>` +
      state.towns.map(t => `<option value="${t.id}"${t.id === depTownId ? " disabled" : ""}>${escapeHtml(t.name)}</option>`).join("");

    const currentDir = document.querySelector("#transport-direction-selector .subtype-option.selected")?.dataset.direction || "departing";
    applyTransportDirection(currentDir);

    document.getElementById("transport-direction-selector").onclick = (e) => {
      const btn = e.target.closest(".subtype-option");
      if (btn) applyTransportDirection(btn.dataset.direction);
    };
  }

  const toggleDestBtn = document.getElementById("toggle-custom-dest-btn");
  const customDestWrap = document.getElementById("custom-destination-wrap");
  if (toggleDestBtn && customDestWrap) {
    toggleDestBtn.onclick = () => {
      const isShowing = customDestWrap.style.display !== "none";
      customDestWrap.style.display = isShowing ? "none" : "";
      toggleDestBtn.textContent = isShowing ? "+ Custom" : "× Custom";
    };
  }
}

/* ─────────────────────────────────────────────────────────────
   INIT — wire all static DOM events
   ───────────────────────────────────────────────────────────── */
export function initItinerary() {
  // Drawer close / backdrop
  document.getElementById("drawer-close-btn").addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);

  // Cancel-transport button
  document.getElementById("drawer-cancel-transport-btn").addEventListener("click", async () => {
    if (!currentDrawerSpot) return;
    const spot = currentDrawerSpot;
    const nowCancelled = !spot.isCancelled;
    try {
      await updateDoc(spotDocRef(spot.id), {
        isCancelled:  nowCancelled,
        cancelledAt:  nowCancelled ? serverTimestamp() : null,
      });
      const updated = state.spots.find(s => s.id === spot.id);
      if (updated) openDrawer(updated);
      updateDisruptionBadge();
    } catch (e) { console.error("Cancel transport failed:", e); }
  });

  // Drawer edit button
  document.getElementById("drawer-edit-btn").addEventListener("click", () => {
    if (currentDrawerAccomTownId) {
      const town = state.towns.find(t => t.id === currentDrawerAccomTownId);
      closeDrawer();
      if (town) openAccomModal(town);
      return;
    }
    if (!currentDrawerSpot) return;
    const spot = currentDrawerSpot;
    closeDrawer();
    openModal(spot);
  });

  // Drawer visited button
  document.getElementById("drawer-visited-btn").addEventListener("click", async () => {
    if (!currentDrawerSpot) return;
    const spot = currentDrawerSpot;
    if (!spot.visited) {
      await toggleSpotVisited(spot);
      closeDrawer();
    } else {
      closeDrawer();
      await toggleSpotVisited(spot);
    }
  });

  // Accommodation modal events
  document.getElementById("accom-modal-close-btn").addEventListener("click", closeAccomModal);
  document.getElementById("accom-modal-cancel-btn").addEventListener("click", closeAccomModal);
  document.getElementById("accom-modal-save-btn").addEventListener("click", saveAccommodation);
  document.getElementById("accom-booked-toggle").addEventListener("click", () => {
    accomBooked = !accomBooked;
    document.getElementById("accom-booked-switch").classList.toggle("on", accomBooked);
  });

  // Type option clicks
  document.querySelectorAll(".type-option").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedType = btn.dataset.type;
      document.querySelectorAll(".type-option").forEach(b => b.classList.toggle("selected", b === btn));
      applyTransportToggle(selectedType);
    });
  });

  // Subtype selector clicks
  document.getElementById("subtype-selector").addEventListener("click", e => {
    const opt = e.target.closest(".subtype-option");
    if (!opt) return;
    document.querySelectorAll(".subtype-option").forEach(b => b.classList.toggle("selected", b === opt));
  });

  // Visited toggle
  document.getElementById("visited-toggle").addEventListener("click", () => {
    visitedState = !visitedState;
    document.getElementById("visited-switch").classList.toggle("on", visitedState);
    if (visitedState && parseFloat(document.getElementById("spot-price").value)) {
      bookedState = true;
      priceEstimatedState = false;
      document.getElementById("booked-switch").classList.add("on");
      document.getElementById("estimated-switch").classList.remove("on");
    }
  });

  // Estimated / Booked toggles
  document.getElementById("estimated-toggle").addEventListener("click", () => {
    priceEstimatedState = !priceEstimatedState;
    document.getElementById("estimated-switch").classList.toggle("on", priceEstimatedState);
    if (priceEstimatedState) {
      bookedState = false;
      document.getElementById("booked-switch").classList.remove("on");
    }
  });
  document.getElementById("booked-toggle").addEventListener("click", () => {
    bookedState = !bookedState;
    document.getElementById("booked-switch").classList.toggle("on", bookedState);
    if (bookedState) {
      priceEstimatedState = false;
      document.getElementById("estimated-switch").classList.remove("on");
    }
  });

  // Modal close
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
  document.getElementById("modal-cancel-btn").addEventListener("click", closeModal);
  document.getElementById("spot-modal-overlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("spot-modal-overlay")) closeModal();
  });

  // Time-mode toggle (Duration ↔ End time)
  document.getElementById("spot-time-mode-toggle")?.addEventListener("click", () => {
    const startTime = document.getElementById("spot-time").value;
    if (_spotTimeMode === "duration") {
      const dur = parseInt(document.getElementById("spot-duration").value);
      if (startTime && dur > 0) {
        const [sh, sm] = startTime.split(":").map(Number);
        const em = sh * 60 + sm + dur;
        document.getElementById("spot-end-time").value =
          `${String(Math.floor(em / 60) % 24).padStart(2,"0")}:${String(em % 60).padStart(2,"0")}`;
      }
      _spotTimeMode = "endtime";
    } else {
      const endTime = document.getElementById("spot-end-time").value;
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        const d = eh * 60 + em - (sh * 60 + sm);
        if (d > 0) document.getElementById("spot-duration").value = d;
      }
      _spotTimeMode = "duration";
    }
    applySpotTimeMode(_spotTimeMode);
  });

  // Town change → update date constraints
  document.getElementById("spot-town").addEventListener("change", (e) => {
    const townSel = document.getElementById("spot-town");
    if (townSel.disabled) return;
    const dateInput = document.getElementById("spot-date");
    applyTownDateConstraints(e.target.value, dateInput);
    if (dateInput.value && (dateInput.value < dateInput.min || dateInput.value > dateInput.max)) {
      dateInput.value = "";
    }
    if (selectedType === "transport") applyTransportToggle("transport");
  });

  // Save spot
  document.getElementById("modal-save-btn").addEventListener("click", async () => {
    const name = document.getElementById("spot-name").value.trim();
    if (!name) { document.getElementById("spot-name").focus(); return; }

    let data;
    if (selectedType === "transport") {
      const subtype = document.querySelector(".subtype-option.selected")?.dataset.subtype || "train";
      data = {
        name,
        type: "transport",
        townId: document.getElementById("spot-town").value,
        transportSubtype:  subtype,
        transportFrom:     document.getElementById("transport-from").value.trim()     || null,
        transportTo:       document.getElementById("transport-to").value.trim()       || null,
        scheduledDate:     document.getElementById("transport-dep-date").value        || null,
        departureTime:     document.getElementById("transport-dep-time").value        || null,
        transportDirection: document.querySelector("#transport-direction-selector .subtype-option.selected")?.dataset.direction || "departing",
        arrivalTownId:     document.getElementById("transport-arrival-town").value    || null,
        customOrigin:      document.getElementById("custom-origin")?.value.trim()     || null,
        customDestination: document.getElementById("custom-destination")?.value.trim() || null,
        arrivalDate:       document.getElementById("transport-arr-date").value        || null,
        arrivalTime:       document.getElementById("transport-arr-time").value        || null,
        carrier:           document.getElementById("transport-carrier").value.trim()  || null,
        seat:              document.getElementById("transport-seat").value.trim()     || null,
        notes:             document.getElementById("spot-notes").value.trim()         || null,
        visited:           false,
        tags:              [],
        price:             parseFloat(document.getElementById("spot-price").value) || null,
        priceCurrency:     document.getElementById("spot-price-currency").value || "EUR",
        priceEstimated:    priceEstimatedState,
        booked:            bookedState,
        bookingRef:        document.getElementById("spot-booking-ref").value.trim() || null,
      };
    } else {
      const _savedStart = document.getElementById("spot-time").value || null;
      let _savedDur = null, _savedEndTime = null;
      if (_spotTimeMode === "duration") {
        _savedDur = parseInt(document.getElementById("spot-duration").value) || null;
        if (_savedStart && _savedDur) {
          const [sh, sm] = _savedStart.split(":").map(Number);
          const em = sh * 60 + sm + _savedDur;
          _savedEndTime = `${String(Math.floor(em / 60) % 24).padStart(2,"0")}:${String(em % 60).padStart(2,"0")}`;
        }
      } else {
        _savedEndTime = document.getElementById("spot-end-time").value || null;
        if (_savedStart && _savedEndTime) {
          const [sh, sm] = _savedStart.split(":").map(Number);
          const [eh, em] = _savedEndTime.split(":").map(Number);
          const d = eh * 60 + em - (sh * 60 + sm);
          _savedDur = d > 0 ? d : null;
        }
      }
      data = {
        name,
        type: selectedType,
        townId: document.getElementById("spot-town").value,
        neighborhood: document.getElementById("spot-neighborhood").value.trim() || null,
        address: document.getElementById("spot-address").value.trim() || null,
        scheduledDate:    document.getElementById("spot-date").value || null,
        scheduledTime:    _savedStart,
        durationMinutes:  _savedDur,
        scheduledEndTime: _savedEndTime,
        tags: [...selectedTags],
        notes: document.getElementById("spot-notes").value.trim() || null,
        visited: visitedState,
        price:          parseFloat(document.getElementById("spot-price").value) || null,
        priceCurrency:  document.getElementById("spot-price-currency").value || "EUR",
        priceEstimated: visitedState && parseFloat(document.getElementById("spot-price").value) ? false : priceEstimatedState,
        booked:         visitedState && parseFloat(document.getElementById("spot-price").value) ? true  : bookedState,
        bookingRef:     document.getElementById("spot-booking-ref").value.trim() || null,
      };
    }

    const splitMembers = state.trip?.members || [];
    if (splitMembers.length >= 2 && _spotPayerId && data.price) {
      data.paidBy = _spotPayerId;
      if (_spotSplitMode === "solo") {
        data.splitType = "solo";
        data.splits = splitMembers.map(m => ({ memberId: m.id, owed: m.id === _spotPayerId ? data.price : 0 }));
      } else if (_spotSplitMode === "custom") {
        data.splitType = "custom";
        data.splits = splitMembers.map(m => ({ memberId: m.id, owed: _spotCustomSplits[m.id] || 0 }));
      } else {
        data.splitType = "equal";
        data.splits = splitMembers.map(m => ({ memberId: m.id, owed: data.price / splitMembers.length }));
      }
    } else {
      data.paidBy    = null;
      data.splitType = null;
      data.splits    = null;
    }

    data.memberIds = (splitMembers.length >= 2 && _spotMemberIds.size > 0 && _spotMemberIds.size < splitMembers.length)
      ? [..._spotMemberIds]
      : null;

    const saveBtn = document.getElementById("modal-save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const editId = modalEditId;
    const returnView = _modalReturnView;
    closeModal();
    cb.setView(returnView);
    saveSpot(data, editId).catch(err => console.error("Save failed:", err));
  });

  // Delete spot
  document.getElementById("delete-spot-btn").addEventListener("click", async () => {
    if (!modalEditId || !confirm("Delete this spot?")) return;
    try { await removeSpot(modalEditId); closeModal(); }
    catch (e) { console.error(e); }
  });
}
