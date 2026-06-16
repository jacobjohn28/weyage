import { GEMINI_CONFIG } from "./config.js";
import { state } from "./state.js";
import { db, doc, updateDoc, serverTimestamp } from "./firebase.js";
import { activeTripId } from "./state.js";
import { escapeHtml, localDateStr, extractTripDestination } from "./utils.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerGuidesCallbacks({ spotDocRef, showKeyEntryForm, getPendingGuideSpotId, setPendingGuideSpotId }) {
  Object.assign(cb, { spotDocRef, showKeyEntryForm, getPendingGuideSpotId, setPendingGuideSpotId });
}

/* ─────────────────────────────────────────────────────────────
   SHARED CONSTANTS
   ───────────────────────────────────────────────────────────── */
export const TYPE_COLORS = {
  sight: "#7c6af7", restaurant: "#e07b54", cafe: "#c4963a",
  experience: "#4aaa8b", transport: "#7a9ec4",
};

/* ─────────────────────────────────────────────────────────────
   GUIDES COLLAPSE STATE (localStorage, guides-only)
   ───────────────────────────────────────────────────────────── */
const GUIDES_COLLAPSE_KEY = "guides-city-collapsed";
const GUIDES_EXPAND_KEY   = "guides-city-expanded";
function loadSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); } }
function saveSet(key, set) { try { localStorage.setItem(key, JSON.stringify([...set])); } catch {} }
const guidesUserCollapsed = loadSet(GUIDES_COLLAPSE_KEY);
const guidesUserExpanded  = loadSet(GUIDES_EXPAND_KEY);

/* ─────────────────────────────────────────────────────────────
   GEMINI GUIDE GENERATION
   ───────────────────────────────────────────────────────────── */
async function callGeminiGuide(spot, town) {
  const townName = town?.name || "";
  const country = town?.country || extractTripDestination(state.trip?.name || "") || "";
  const typeLabel = {
    sight: "historical sight / landmark",
    restaurant: "restaurant",
    cafe: "café",
    experience: "experience / activity",
  }[spot.type] || "place";
  const notesLine = spot.notes ? `\nContext from trip notes: ${spot.notes}` : "";

  const prompt = `You are an exceptionally passionate and knowledgeable walking tour guide — the kind who knows which stone Napoleon tripped on and why the architect was fired. You write with infectious enthusiasm, weave in nerdy historical facts and pop culture references naturally, and always give the kind of insider tips only someone who's been there a hundred times would know.

Write a travel guide for the following:
Name: ${spot.name}
Type: ${typeLabel}
Location: ${townName}, ${country}${notesLine}

Respond ONLY with valid JSON — no markdown, no prose outside the JSON. Use exactly this structure:
{
  "overview": "2-3 punchy sentences. Hook the reader immediately. What makes this place unmissable? Walking tour energy — present tense, vivid.",
  "history": "3-5 sentences. When was it built/founded and by whom? Key historical moments. Notable people connected to it. Any references in literature, film, or pop culture. Be specific: real dates, real names, real stories.",
  "highlights": [
    "Specific must-do or must-see — be concrete, not generic",
    "Specific must-do or must-see",
    "Specific must-do or must-see"
  ],
  "gettingThere": "Specific metro lines and stop names, tram/bus options, walking distance from a recognisable nearby landmark. One or two sentences, practically useful.",
  "practicalTips": "Entry fees (exact if known), whether booking ahead is needed, best time of day to beat crowds, any dress code, photography restrictions, or other gotchas a first-timer would wish they'd known.",
  "nearby": [
    "Nearby place worth combining in the same half-day — name + one-line reason why it pairs well"
  ],
  "eatAndDrink": "1-2 specific recommendations. Value spots popular with locals. Include the name, what to order, and a one-liner on why. Don't be afraid to mention somewhere slightly further if it's genuinely worth the walk."
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${GEMINI_CONFIG.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generation_config: { temperature: 0.75, response_mime_type: "application/json" },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error ${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No guide content returned.");
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}

export async function generateSpotGuide(spotId, spotData) {
  await updateDoc(cb.spotDocRef(spotId), { guide: { status: "pending" } }).catch(() => {});
  try {
    const town = state.towns.find(t => t.id === spotData.townId);
    const content = await callGeminiGuide(spotData, town);
    await updateDoc(cb.spotDocRef(spotId), {
      guide: { status: "ready", content, generatedAt: serverTimestamp() },
    });
  } catch (err) {
    console.error("Guide generation error:", err);
    await updateDoc(cb.spotDocRef(spotId), {
      guide: { status: "error", errorMessage: err.message },
    }).catch(() => {});
  }
}

export async function generateAllGuides() {
  const btn = document.getElementById("guides-generate-all-btn");
  const pending = state.spots.filter(s =>
    s.type !== "transport" &&
    (!s.guide || s.guide.status === "error" || s.guide.status === undefined)
  );
  if (!pending.length) return;

  if (btn) { btn.disabled = true; btn.textContent = `Generating 0 / ${pending.length}…`; }

  for (let i = 0; i < pending.length; i++) {
    const spot = pending[i];
    if (btn) btn.textContent = `Generating ${i + 1} / ${pending.length}…`;
    await generateSpotGuide(spot.id, spot);
    if (i < pending.length - 1) await new Promise(r => setTimeout(r, 1200));
  }

  if (btn) { btn.disabled = false; btn.style.display = "none"; }
}

/* ─────────────────────────────────────────────────────────────
   GUIDE CARD HTML
   ───────────────────────────────────────────────────────────── */
function guideCardHTML(spot) {
  const color = TYPE_COLORS[spot.type] || "#888";
  const typeLabel = { sight: "Sight", restaurant: "Restaurant", cafe: "Café", experience: "Experience" }[spot.type] || spot.type;
  const guide = spot.guide;
  const status = guide?.status;
  const content = guide?.content;
  const hasGuide = status === "ready" && content;

  const chevron = hasGuide ? `
    <button class="guide-card-chevron" aria-label="Expand guide">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><polyline points="6 9 12 15 18 9"/></svg>
    </button>` : "";

  let stateHTML = "";
  if (!guide || status === undefined || status === "error") {
    stateHTML = `
      <div class="guide-pending-state">
        ${status === "error" ? `<span class="guide-error-msg">Generation failed —&nbsp;</span>` : ""}
        <button class="guide-generate-btn" data-spot-id="${escapeHtml(spot.id)}">${status === "error" ? "Retry" : "✦ Generate guide"}</button>
      </div>`;
  } else if (status === "pending") {
    stateHTML = `
      <div class="guide-skeleton">
        <div class="guide-skeleton-line" style="width:88%"></div>
        <div class="guide-skeleton-line" style="width:74%"></div>
        <div class="guide-skeleton-line" style="width:60%"></div>
      </div>`;
  }

  let bodyHTML = "";
  if (hasGuide) {
    const sections = [
      { key: "overview",      label: "Overview",           list: false },
      { key: "history",       label: "History",            list: false },
      { key: "highlights",    label: "What to see & do",   list: true  },
      { key: "gettingThere",  label: "Getting there",      list: false },
      { key: "practicalTips", label: "Practical tips",     list: false },
      { key: "nearby",        label: "Nearby",             list: true  },
      { key: "eatAndDrink",   label: "Eat & drink nearby", list: false },
    ];

    const sectionsHTML = sections.map(({ key, label, list }) => {
      const val = content[key];
      if (!val || (Array.isArray(val) && !val.length)) return "";
      const inner = list && Array.isArray(val)
        ? `<ul class="guide-highlights">${val.map(item => `<li><span class="guide-highlight-bullet">→</span>${escapeHtml(item)}</li>`).join("")}</ul>`
        : `<div class="guide-section-text">${escapeHtml(String(val))}</div>`;
      return `<div class="guide-section"><div class="guide-section-label">${label}</div>${inner}</div>`;
    }).join("");

    bodyHTML = `
      <div class="guide-card-body">
        ${sectionsHTML}
        <div class="guide-regen-row">
          <button class="guide-regen-btn" data-spot-id="${escapeHtml(spot.id)}">↻ Regenerate</button>
        </div>
      </div>`;
  }

  return `
    <div class="guide-card" data-spot-id="${escapeHtml(spot.id)}">
      <div class="guide-card-header${hasGuide ? "" : " no-guide"}">
        <div class="guide-type-bar" style="background:${color}"></div>
        <div class="guide-card-title-group">
          <div class="guide-card-name">${escapeHtml(spot.name)}</div>
          <div class="guide-card-meta">${escapeHtml(typeLabel)}</div>
        </div>
        ${chevron}
      </div>
      ${stateHTML}
      ${bodyHTML}
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   GUIDES RENDERER
   ───────────────────────────────────────────────────────────── */
export function renderGuides() {
  const container = document.getElementById("guides-content");
  if (!container) return;

  const query = (document.getElementById("guides-search")?.value || "").toLowerCase().trim();
  const allSpots = state.spots.filter(s => s.type !== "transport");
  const spots = query ? allSpots.filter(s => s.name.toLowerCase().includes(query)) : allSpots;

  const needsGuide = allSpots.filter(s => !s.guide || s.guide.status === "error" || s.guide.status === undefined);
  const genAllBtn = document.getElementById("guides-generate-all-btn");
  if (genAllBtn && !genAllBtn.disabled) {
    genAllBtn.style.display = needsGuide.length ? "" : "none";
    genAllBtn.textContent = `✦ Generate all (${needsGuide.length})`;
  }

  if (allSpots.length === 0) {
    container.innerHTML = `
      <div class="itinerary-empty">
        <p style="font-family:var(--font-display);font-style:italic;font-size:1.75rem;color:var(--text-3);margin-bottom:12px">Your guides await.</p>
        <p>Add sights, experiences, and restaurants to your itinerary — a guide will be generated for each one.</p>
      </div>`;
    return;
  }

  if (spots.length === 0) {
    container.innerHTML = `<div class="guides-no-results">No guides match "${escapeHtml(query)}"</div>`;
    return;
  }

  const todayKey = localDateStr(new Date());

  function guidePriority(s) {
    if (s.visited || (s.scheduledDate && s.scheduledDate < todayKey)) return 2;
    if (!s.scheduledDate) return 1;
    return 0;
  }

  let html = "";
  for (const town of state.towns) {
    const townSpots = spots.filter(s => s.townId === town.id);
    if (!townSpots.length) continue;

    const upcoming = townSpots
      .filter(s => guidePriority(s) === 0)
      .sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || "") || (a.order ?? 9999) - (b.order ?? 9999));
    const wishlist = townSpots
      .filter(s => guidePriority(s) === 1)
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    const done = townSpots
      .filter(s => guidePriority(s) === 2)
      .sort((a, b) => (b.scheduledDate || "").localeCompare(a.scheduledDate || "") || (a.order ?? 9999) - (b.order ?? 9999));

    let sections = upcoming.map(s => guideCardHTML(s)).join("");
    if (wishlist.length) {
      if (upcoming.length) sections += `<div class="guides-section-divider">Wishlist</div>`;
      sections += wishlist.map(s => guideCardHTML(s)).join("");
    }
    if (done.length) {
      if (upcoming.length || wishlist.length) sections += `<div class="guides-section-divider">Done</div>`;
      sections += done.map(s => guideCardHTML(s)).join("");
    }

    const allDone = upcoming.length === 0 && wishlist.length === 0 && done.length > 0;
    const isCollapsed = guidesUserCollapsed.has(town.id) || (allDone && !guidesUserExpanded.has(town.id));

    const parts = [];
    if (upcoming.length) parts.push(`${upcoming.length} upcoming`);
    if (wishlist.length) parts.push(`${wishlist.length} wishlist`);
    if (done.length) parts.push(`${done.length} done`);
    const countLabel = parts.join(" · ");

    html += `
      <div class="guides-town-group${isCollapsed ? " collapsed" : ""}" data-town-id="${escapeHtml(town.id)}">
        <div class="guides-town-header">
          <span class="guides-town-label">${escapeHtml(town.name)}</span>
          <span class="guides-town-count">${countLabel}</span>
          <span class="guides-town-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
        </div>
        <div class="guides-town-body">${sections}</div>
      </div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll(".guides-town-header").forEach(header => {
    header.addEventListener("click", () => {
      const group = header.closest(".guides-town-group");
      const townId = group.dataset.townId;
      const nowCollapsed = group.classList.toggle("collapsed");
      if (nowCollapsed) {
        guidesUserCollapsed.add(townId);
        guidesUserExpanded.delete(townId);
      } else {
        guidesUserExpanded.add(townId);
        guidesUserCollapsed.delete(townId);
      }
      saveSet(GUIDES_COLLAPSE_KEY, guidesUserCollapsed);
      saveSet(GUIDES_EXPAND_KEY, guidesUserExpanded);
    });
  });

  container.querySelectorAll(".guide-card-header:not(.no-guide)").forEach(header => {
    header.addEventListener("click", () => {
      header.closest(".guide-card").classList.toggle("expanded");
    });
  });

  container.querySelectorAll(".guide-generate-btn, .guide-regen-btn").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const spotId = btn.dataset.spotId;
      const spot = state.spots.find(s => s.id === spotId);
      if (!spot) return;
      if (!GEMINI_CONFIG.apiKey) {
        cb.showKeyEntryForm(() => generateSpotGuide(spotId, spot).catch(() => {}));
        document.getElementById("ai-panel-overlay").classList.add("visible");
        document.getElementById("ai-panel-title").textContent = "Add API key";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Generating…";
      generateSpotGuide(spotId, spot).catch(() => {});
    });
  });

  const pendingGuideSpotId = cb.getPendingGuideSpotId?.();
  if (pendingGuideSpotId) {
    cb.setPendingGuideSpotId(null);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const card = container.querySelector(`.guide-card[data-spot-id="${CSS.escape(pendingGuideSpotId)}"]`);
      if (!card) return;
      if (!card.classList.contains("expanded")) {
        const header = card.querySelector(".guide-card-header:not(.no-guide)");
        if (header) header.click();
      }
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }
}
