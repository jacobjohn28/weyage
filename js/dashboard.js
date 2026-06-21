import { GEMINI_CONFIG, PEXELS_CONFIG } from "./config.js";
import { state } from "./state.js";
import { db, doc, updateDoc, serverTimestamp } from "./firebase.js";
import { activeTripId } from "./state.js";
import { escapeHtml, fmtDateRange, fmtSpreadDates, nightsBetween, daysUntil, fmtTime12, localDateStr } from "./utils.js";
import { resolveTownImage, openPhotoPicker } from "./photos.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerDashboardCallbacks({ openTownEditModal, setView, setPendingScrollTownId, aggregateBudget, toggleSpotVisited, toHomeCurrency, tripHomeCurrency, currencySymbol, renderTripCalendar }) {
  Object.assign(cb, { openTownEditModal, setView, setPendingScrollTownId, aggregateBudget, toggleSpotVisited, toHomeCurrency, tripHomeCurrency, currencySymbol, renderTripCalendar });
}

/* ─────────────────────────────────────────────────────────────
   CITY BRIEFING (Gemini)
   ───────────────────────────────────────────────────────────── */
function spreadBriefingHTML(town) {
  const b = town.briefing;
  if (!b || b.status === "idle") {
    return `
      <div class="spread-briefing">
        <div class="spread-briefing-toggle">
          Before you go
          <svg class="spread-briefing-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="spread-briefing-body">
          ${GEMINI_CONFIG.apiKey
            ? `<button class="spread-briefing-gen" data-town-id="${escapeHtml(town.id)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="12" height="12"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>
                Generate briefing
               </button>`
            : `<p style="color:var(--text-3);font-size:0.8125rem;margin:0">Add a Gemini API key in settings to generate briefings.</p>`}
        </div>
      </div>`;
  }
  if (b.status === "pending") {
    return `
      <div class="spread-briefing open">
        <div class="spread-briefing-toggle">
          Before you go
          <svg class="spread-briefing-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="18 15 12 9 6 15"/></svg>
        </div>
        <div class="spread-briefing-body">
          <p style="color:var(--text-3);font-size:0.8125rem;margin:4px 0">Generating…</p>
        </div>
      </div>`;
  }
  if (b.status === "error") {
    return `
      <div class="spread-briefing">
        <div class="spread-briefing-toggle">
          Before you go
          <svg class="spread-briefing-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="spread-briefing-body">
          <p style="color:var(--danger);font-size:0.8125rem;margin:0 0 6px">Generation failed.</p>
          <button class="spread-briefing-gen" data-town-id="${escapeHtml(town.id)}">Retry</button>
        </div>
      </div>`;
  }
  // ready
  const items = (b.content || []).map(tip =>
    `<div class="spread-briefing-item"><div class="spread-briefing-dot"></div><span>${escapeHtml(tip)}</span></div>`
  ).join("");
  return `
    <div class="spread-briefing">
      <div class="spread-briefing-toggle">
        Before you go
        <svg class="spread-briefing-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="spread-briefing-body">
        ${items}
        <button class="spread-briefing-gen" data-town-id="${escapeHtml(town.id)}" style="margin-top:8px;opacity:0.6">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="11" height="11"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          Regenerate
        </button>
      </div>
    </div>`;
}

async function callGeminiBriefing(town) {
  const spots = state.spots
    .filter(s => s.townId === town.id && s.type !== "transport")
    .map(s => s.name);
  const spotList = spots.length > 0 ? `\nPlanned spots: ${spots.join(", ")}` : "";
  const tripDates = state.trip
    ? `${state.trip.startDate} to ${state.trip.endDate}`
    : "late May to mid-June 2026";

  const tripLabel = state.trip?.name || "trip";
  const townLocation = [town.name, town.country].filter(Boolean).join(", ");

  const prompt = `You are an expert travel advisor helping travellers plan their ${tripLabel} (${tripDates}).

Generate a "Before you go" briefing for ${townLocation}. Focus on:
- Things that must be pre-booked (tours, tickets, restaurants) with specific lead times
- Seasonal considerations for late May / early June (crowds, weather, events)
- Practical heads-up a first-time visitor would wish they'd known
- Any closures, renovation notices, or gotchas specific to the planned spots${spotList}

Respond ONLY with a JSON array of 5-6 concise, actionable tip strings. No markdown, no prose outside the JSON.
Example format: ["Tip one here", "Tip two here"]

Be specific: real names, real booking URLs (if well-known), real lead times. Avoid generic tourism clichés.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${GEMINI_CONFIG.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generation_config: { temperature: 0.6, response_mime_type: "application/json" },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini error ${res.status}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No briefing content returned.");
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}

export async function generateCityBriefing(townId, town) {
  const townRef = doc(db, "trips", activeTripId, "towns", townId);
  await updateDoc(townRef, { briefing: { status: "pending" } }).catch(() => {});
  try {
    const content = await callGeminiBriefing(town);
    await updateDoc(townRef, { briefing: { status: "ready", content, generatedAt: serverTimestamp() } });
  } catch (err) {
    console.error("Briefing generation error:", err);
    await updateDoc(townRef, { briefing: { status: "error", errorMessage: err.message } }).catch(() => {});
  }
}

/* ─────────────────────────────────────────────────────────────
   DASHBOARD RENDERERS
   ───────────────────────────────────────────────────────────── */
export function renderDashboardTowns() {
  const container = document.getElementById("dashboard-towns");
  if (!container) return;

  if (!state.towns.length) {
    container.innerHTML = `
      <div class="itinerary-empty" style="padding:48px 24px">
        <p style="font-size:1.0625rem;font-weight:500;color:var(--text);margin-bottom:8px">No cities yet</p>
        <p style="margin-bottom:28px">Add your first city to start building your trip overview.</p>
        ${state.shareMode ? "" : `<button class="btn-primary" id="dashboard-add-city-btn" style="padding:10px 22px;font-size:0.9375rem">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right:6px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add a city
        </button>`}
      </div>`;
    container.querySelector("#dashboard-add-city-btn")?.addEventListener("click", () => cb.openTownEditModal());
    return;
  }

  const typeLabel = { sight: "Sights", restaurant: "Restaurants", cafe: "Cafés", experience: "Experiences", transport: "Transport" };
  const typeOrder = ["sight", "restaurant", "cafe", "experience", "transport"];

  container.innerHTML = state.towns.map((t, i) => {
    const nights = nightsBetween(t.arrivalDate, t.departureDate);
    const name = escapeHtml(t.name);
    const nameUpper = escapeHtml(t.name.toUpperCase());
    const caption = escapeHtml(t.caption || "");
    const isRight = i % 2 !== 0;

    const townSpots = state.spots.filter(s => s.townId === t.id && s.type !== "transport");
    const counts = {};
    townSpots.forEach(s => { const ty = s.type || "sight"; counts[ty] = (counts[ty] || 0) + 1; });
    const countPills = typeOrder
      .filter(ty => counts[ty])
      .map(ty => `<span class="spread-count-pill">${counts[ty]} ${typeLabel[ty]}</span>`)
      .join("");

    const cachedUrl = resolveTownImage(t);

    const imgTag = cachedUrl
      ? `<img class="spread-img" src="${escapeHtml(cachedUrl)}" alt="${name}" loading="lazy"
            onload="this.classList.add('loaded')"
            onerror="this.remove()">`
      : "";

    return `
      <article class="spread${isRight ? " spine-right" : ""}" data-town-id="${escapeHtml(t.id)}">
        <div class="spread-spine">
          <h2 class="spine-name">${nameUpper}</h2>
        </div>
        <div class="spread-img-col">
          <div class="spread-img-frame">
            ${!cachedUrl ? `<div class="spread-img-fallback">${name}</div>` : ""}
            ${!cachedUrl && PEXELS_CONFIG.apiKey ? `<button class="choose-photo-btn" data-town-id="${escapeHtml(t.id)}" data-town-name="${escapeHtml(t.name)}" style="margin-top:12px;font-size:0.75rem;opacity:0.7;padding:5px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer">Choose photo</button>` : ""}
            ${imgTag}
            ${caption ? `<div class="spread-caption-overlay">${caption}</div>` : ""}
            ${countPills ? `<div class="spread-spot-counts">${countPills}</div>` : ""}
          </div>
          <div class="spread-meta">
            <span>${fmtSpreadDates(t.arrivalDate, t.departureDate)}</span>
            <span class="spread-nights">${nights} night${nights === 1 ? "" : "s"}</span>
          </div>
          ${spreadBriefingHTML(t)}
        </div>
      </article>
    `;
  }).join("");

  container.querySelectorAll(".spread[data-town-id]").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".spread-briefing")) return;
      if (state.currentView === "itinerary") {
        const target = document.getElementById(`itinerary-town-${card.dataset.townId}`);
        const main = document.querySelector(".main");
        if (target && main) {
          const top = main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top - 80;
          main.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      } else {
        cb.setPendingScrollTownId(card.dataset.townId);
        cb.setView("itinerary");
      }
    });
  });

  container.querySelectorAll(".spread-briefing-toggle").forEach(toggle => {
    toggle.addEventListener("click", e => {
      e.stopPropagation();
      toggle.closest(".spread-briefing").classList.toggle("open");
    });
  });

  container.querySelectorAll(".spread-briefing-gen").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const townId = btn.dataset.townId;
      const town = state.towns.find(t => t.id === townId);
      if (!town) return;
      btn.disabled = true;
      btn.textContent = "Generating…";
      await generateCityBriefing(townId, town);
    });
  });

  container.querySelectorAll(".choose-photo-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPhotoPicker(btn.dataset.townId, btn.dataset.townName);
    });
  });
}

export function renderDashboardMeta() {
  if (state.trip) {
    const heroName = document.getElementById("hero-trip-name");
    if (heroName) heroName.innerHTML = `<em>${escapeHtml(state.trip.name || "")}</em>`;

    const heroCities = document.getElementById("hero-cities");
    if (heroCities) {
      heroCities.textContent = state.towns.length
        ? state.towns.map(t => t.name).join("  ·  ")
        : "";
    }

    const townsCountEl = document.getElementById("hero-towns-count");
    if (townsCountEl) {
      const n = state.towns.length;
      townsCountEl.textContent = n ? `${n} ${n === 1 ? "city" : "cities"}` : "";
    }

    document.getElementById("trip-dates").textContent =
      fmtDateRange(state.trip.startDate, state.trip.endDate);
    const days = daysUntil(state.trip.startDate);
    const cd = document.getElementById("countdown");
    if (days > 0) cd.textContent = `${days} days to go`;
    else if (days === 0) cd.textContent = `Bon voyage`;
    else cd.textContent = `In progress`;

    const durEl = document.getElementById("stat-duration");
    const durSuffix = document.getElementById("stat-duration-suffix");
    if (durEl && state.trip.startDate && state.trip.endDate) {
      const tripDays = Math.round(
        (new Date(state.trip.endDate) - new Date(state.trip.startDate)) / 86400000
      ) + 1;
      durEl.textContent = tripDays;
      if (durSuffix) durSuffix.textContent = tripDays === 1 ? "day" : "days";
    } else if (durEl) {
      durEl.textContent = "—";
      if (durSuffix) durSuffix.textContent = "";
    }

    const townsStatEl = document.getElementById("stat-towns-count");
    if (townsStatEl) townsStatEl.textContent = state.towns.length || "—";
  }

  const total   = state.spots.filter(s => s.type !== "transport").length;
  const visited = state.spots.filter(s => s.visited).length;
  const spotsVisEl  = document.getElementById("stat-spots-visited");
  const spotsSuffix = document.getElementById("stat-spots-suffix");
  if (spotsVisEl) spotsVisEl.textContent = visited;
  if (spotsSuffix) spotsSuffix.textContent = total > 0 ? ` / ${total}` : "";

  // Ongoing total budget, converted to the trip's home currency.
  const entries = cb.aggregateBudget();
  const fmt = n => n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const home = cb.tripHomeCurrency ? cb.tripHomeCurrency() : "EUR";
  const symbol = cb.currencySymbol ? cb.currencySymbol(home) : "";
  let spendTotal = 0, allConverted = true;
  entries.forEach(e => {
    const h = cb.toHomeCurrency ? cb.toHomeCurrency(e.amount, e.currency) : (e.currency === home ? e.amount : null);
    if (h === null || h === undefined) allConverted = false;
    else spendTotal += h;
  });
  const budgetEl    = document.getElementById("stat-budget");
  const budgetLabel = document.getElementById("stat-budget-label");
  if (budgetEl) {
    budgetEl.style.color = "";
    if (entries.length && spendTotal > 0) {
      budgetEl.textContent = `${symbol}${fmt(spendTotal)}`;
      // Flag when some currencies couldn't be converted (missing exchange rates).
      if (budgetLabel) budgetLabel.textContent = allConverted ? "Total spend" : "Total (partial)";
    } else {
      budgetEl.textContent = "—";
      if (budgetLabel) budgetLabel.textContent = "Total spend";
    }
  }
}

// Trip calendar in the overview tab — reuses the shared-page calendar renderer;
// tapping a city span jumps to that city in the itinerary.
export function renderDashboardCalendar() {
  const el = document.getElementById("dash-calendar");
  if (!el) return;
  const ready = cb.renderTripCalendar && state.towns.length && state.trip?.startDate && state.trip?.endDate;
  if (!ready) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="dash-calendar-block">
      <h3 class="dash-calendar-title">Trip calendar</h3>
      <div class="sp-calendar">${cb.renderTripCalendar()}</div>
    </div>`;
  el.querySelectorAll(".sp-cal-span[data-id]").forEach(span => {
    span.addEventListener("click", () => {
      cb.setPendingScrollTownId(span.dataset.id);
      cb.setView("itinerary");
    });
  });
}

export function renderDashboardToday() {
  const container = document.getElementById("dash-today");
  if (!container || !state.trip) return;

  const today = localDateStr(new Date());
  const tripStart = state.trip.startDate;
  const tripEnd   = state.trip.endDate;
  const days = daysUntil(tripStart);

  const startMs = new Date(tripStart + "T00:00:00").getTime();
  const endMs   = new Date(tripEnd   + "T00:00:00").getTime();
  const nowMs   = new Date(today     + "T00:00:00").getTime();
  const totalDays   = Math.round((endMs - startMs) / 86400000);
  const tripDayNum  = Math.max(1, Math.round((nowMs - startMs) / 86400000) + 1);
  const tripPct     = totalDays > 0 ? Math.min(Math.round((Math.min(tripDayNum - 1, totalDays) / totalDays) * 100), 100) : 0;

  const progressBar = `<div class="today-trip-bar"><div class="today-trip-fill" style="width:${tripPct}%"></div></div>`;

  if (days > 0) {
    const startLabel = new Date(tripStart + "T00:00:00")
      .toLocaleDateString("en-GB", { day: "numeric", month: "short" });

    const spotsAhead = [...state.spots]
      .filter(s => s.scheduledDate && s.scheduledDate >= tripStart && s.type !== "transport")
      .sort((a, b) =>
        a.scheduledDate.localeCompare(b.scheduledDate) ||
        (a.scheduledTime || "").localeCompare(b.scheduledTime || "") ||
        (a.order ?? 9999) - (b.order ?? 9999)
      );

    const dayMap = new Map();
    spotsAhead.forEach(s => {
      if (!dayMap.has(s.scheduledDate)) dayMap.set(s.scheduledDate, []);
      dayMap.get(s.scheduledDate).push(s);
    });
    const previewDays = [...dayMap.entries()].slice(0, 3);

    const previewHTML = previewDays.length > 0 ? `
      <div class="today-preview-days">
        ${previewDays.map(([date, spots]) => {
          const label = new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
          const chips = spots.slice(0, 4).map(s => `<span class="today-preview-chip">${escapeHtml(s.name)}</span>`).join("");
          const more = spots.length > 4 ? `<span class="today-preview-chip" style="color:var(--text-3)">+${spots.length - 4} more</span>` : "";
          return `<div class="today-preview-day">
            <div class="today-preview-date">${label}</div>
            <div class="today-preview-spots">${chips}${more}</div>
          </div>`;
        }).join("")}
      </div>` : `<p style="color:var(--text-3);font-size:0.875rem;margin:0">No spots scheduled yet for the first days.</p>`;

    container.innerHTML = `
      <div class="today-card">
        <div class="today-card-header">
          <span class="today-card-day">${days} day${days === 1 ? "" : "s"} to go</span>
          <span class="today-card-city">· France · from ${startLabel}</span>
        </div>
        <div class="today-trip-bar"><div class="today-trip-fill" style="width:0%"></div></div>
        ${previewHTML}
      </div>`;

  } else if (today > tripEnd) {
    const visited = state.spots.filter(s => s.visited).length;
    const total   = state.spots.filter(s => s.type !== "transport").length;
    container.innerHTML = `
      <div class="today-card">
        <div class="today-card-header">
          <span class="today-card-day">Trip complete</span>
          <span class="today-card-city">· ${visited} of ${total} spots visited</span>
        </div>
        <div class="today-trip-bar"><div class="today-trip-fill" style="width:100%;background:var(--success)"></div></div>
      </div>`;

  } else {
    const currentTown = state.towns.find(t => t.arrivalDate <= today && today < t.departureDate)
      || state.towns.find(t => t.arrivalDate <= today);
    const dateLabel = new Date(today + "T00:00:00")
      .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

    const todaySpots = state.spots
      .filter(s => s.scheduledDate === today && s.type !== "transport")
      .sort((a, b) =>
        (a.scheduledTime || "ZZ").localeCompare(b.scheduledTime || "ZZ") ||
        (a.order ?? 9999) - (b.order ?? 9999)
      );

    const spotsHTML = todaySpots.length > 0
      ? todaySpots.map(s => `
          <div class="today-spot-row${s.visited ? " visited" : ""}" data-spot-id="${escapeHtml(s.id)}">
            <div class="today-spot-check">
              ${s.visited ? `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" width="10" height="10"><path d="M20 6L9 17l-5-5"/></svg>` : ""}
            </div>
            <span class="today-spot-name">${escapeHtml(s.name)}</span>
            ${s.scheduledTime ? `<span class="today-spot-time">${fmtTime12(s.scheduledTime)}</span>` : ""}
          </div>`).join("")
      : `<p style="color:var(--text-3);font-size:0.875rem;margin:4px 0">Nothing scheduled — enjoy some spontaneous exploration.</p>`;

    container.innerHTML = `
      <div class="today-card">
        <div class="today-card-header">
          <span class="today-card-day">Day ${Math.min(tripDayNum, totalDays)} of ${totalDays}</span>
          ${currentTown ? `<span class="today-card-city">· ${escapeHtml(currentTown.name)}</span>` : ""}
          <span class="today-card-date">${dateLabel}</span>
        </div>
        ${progressBar}
        <div id="today-spots-list">${spotsHTML}</div>
      </div>`;

    container.querySelectorAll(".today-spot-row").forEach(row => {
      row.addEventListener("click", async () => {
        const spot = state.spots.find(s => s.id === row.dataset.spotId);
        if (!spot) return;
        await cb.toggleSpotVisited(spot);
      });
    });
  }
}
