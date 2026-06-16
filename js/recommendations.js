import { state } from "./state.js";
import { GEMINI_CONFIG } from "./config.js";
import { db, doc, setDoc } from "./firebase.js";
import { escapeHtml, mapsSearchBtn } from "./utils.js";
import { TYPE_COLORS } from "./guides.js";
import { saveSpot, getSpotsForTown } from "./itinerary.js";
import { extractTripDestination } from "./photos.js";

/* ─────────────────────────────────────────────────────────────
   CONTEXT BUILDER
   ───────────────────────────────────────────────────────────── */
function buildRecommendationContext(townId, date) {
  const town = state.towns.find(t => t.id === townId);
  if (!town) return null;

  const allTownSpots = getSpotsForTown(townId)
    .filter(s => !s._arrivalView && s.type !== "transport");

  const daySpots = allTownSpots
    .filter(s => s.scheduledDate === date)
    .sort((a, b) => (a.scheduledTime || "").localeCompare(b.scheduledTime || "") || (a.order ?? 9999) - (b.order ?? 9999));

  const alreadyNames = allTownSpots.map(s => s.name).filter(Boolean);

  const tripStart = new Date(state.trip?.startDate + "T00:00:00");
  const thisDay = new Date(date + "T00:00:00");
  const tripDay = Math.floor((thisDay - tripStart) / 86400000) + 1;

  const townStart = new Date(town.arrivalDate + "T00:00:00");
  const townDay = Math.floor((thisDay - townStart) / 86400000) + 1;
  const totalTownDays = Math.floor(
    (new Date(town.departureDate + "T00:00:00") - townStart) / 86400000
  ) + 1;

  const energyLevel = townDay === 1 ? "fresh, first full day in the city"
    : townDay === totalTownDays ? "last day, winding down"
    : "mid-stay, settled rhythm";

  const dayPlanSummary = daySpots.length > 0
    ? daySpots.map(s => {
        const time = s.scheduledTime ? `${s.scheduledTime} ` : "";
        return `${time}${s.name}${s.neighborhood ? ` (${s.neighborhood})` : ""}`;
      }).join(", ")
    : "Nothing planned yet — open slate";

  const lastSpot = daySpots[daySpots.length - 1] || null;

  return {
    town: town.name,
    country: town.country || extractTripDestination(state.trip?.name || "") || "",
    date,
    tripDay,
    townDay,
    totalTownDays,
    energyLevel,
    dayPlanSummary,
    lastSpotName: lastSpot?.name || null,
    lastSpotNeighborhood: lastSpot?.neighborhood || null,
    alreadyPlanned: alreadyNames,
  };
}

/* ─────────────────────────────────────────────────────────────
   GEMINI API CALL
   ───────────────────────────────────────────────────────────── */
async function callGeminiRecommendations(ctx) {
  const constraintHeader = ctx.userPrompt ? `\
=== MANDATORY TRAVELLER REQUIREMENT ===
"${ctx.userPrompt}"
Every single suggestion MUST directly satisfy this requirement. Discard any spot that does not clearly and specifically address it — do not include it as a filler or secondary option. This requirement overrides all other preferences.
=======================================

` : "";

  const constraintReminder = ctx.userPrompt
    ? `\nCritical: filter every suggestion against the traveller's requirement: "${ctx.userPrompt}". Only include spots that genuinely satisfy it.`
    : "";

  const prompt = `${constraintHeader}You are a knowledgeable, opinionated travel companion helping plan a trip to ${ctx.town}, ${ctx.country}. Your philosophy:
- Quality over quantity: suggest 3–4 genuinely excellent options, never a generic list
- Local rhythm: match the energy of the day (${ctx.energyLevel})
- Logistics-first: suggest places that flow naturally from what's already planned
- Honest: include why this fits *this specific day*, not a generic description
- Connected: reference the existing day plan when relevant

Day context: Trip day ${ctx.tripDay}. Day ${ctx.townDay} of ${ctx.totalTownDays} in ${ctx.town}.
Already planned today: ${ctx.dayPlanSummary}.
${ctx.lastSpotName ? `Last stop: ${ctx.lastSpotName}${ctx.lastSpotNeighborhood ? ` in ${ctx.lastSpotNeighborhood}` : ""}.` : ""}
Already in itinerary for ${ctx.town}: ${ctx.alreadyPlanned.length > 0 ? ctx.alreadyPlanned.join(", ") : "nothing yet"}.
${constraintReminder}
Suggest spots that are NOT already in the itinerary. Focus on what genuinely fits this day's energy and flow.

Respond ONLY with valid JSON — no markdown fences, no prose before or after. Use this exact structure:
{
  "context_read": "1-2 sentence summary of how you read the day and what you optimised for",
  "spots": [
    {
      "name": "Place name",
      "type": "sight|restaurant|cafe|experience",
      "neighborhood": "Neighbourhood or arrondissement",
      "suggestedTime": "HH:MM",
      "durationMinutes": 90,
      "reason": "Why this fits this specific day",
      "logistics": "How to get there or timing tip",
      "tags": ["Tag1", "Tag2"],
      "notes": "Booking tip or insider detail, or omit field"
    }
  ]
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${GEMINI_CONFIG.apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generation_config: {
      temperature: ctx.userPrompt ? 0.5 : 0.8,
      response_mime_type: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error ${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No recommendations returned — try again.");

  try {
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(clean);
  } catch {
    throw new Error("Couldn't parse recommendations — try again.");
  }
}

/* ─────────────────────────────────────────────────────────────
   RENDER CARDS
   ───────────────────────────────────────────────────────────── */
function renderRecommendationCards(result, townId, date) {
  const body = document.getElementById("ai-panel-body");
  const contextEl = document.getElementById("ai-panel-context");

  if (result.context_read) {
    contextEl.textContent = result.context_read;
    contextEl.style.display = "";
  }

  const townName = state.towns.find(t => t.id === townId)?.name || "";

  const cards = (result.spots || []).map(spot => {
    const color = TYPE_COLORS[spot.type] || "#888";
    const metaChips = [
      spot.neighborhood ? `<span class="ai-reco-meta-chip">${escapeHtml(spot.neighborhood)}</span>` : "",
      spot.suggestedTime ? `<span class="ai-reco-meta-chip">${escapeHtml(spot.suggestedTime)}</span>` : "",
      spot.durationMinutes ? `<span class="ai-reco-meta-chip">${spot.durationMinutes} min</span>` : "",
    ].filter(Boolean).join("");

    const tags = (spot.tags || []).slice(0, 4)
      .map(t => `<span class="ai-reco-tag">${escapeHtml(t)}</span>`).join("");

    return `
      <div class="ai-reco-card" data-spot='${JSON.stringify(spot).replace(/'/g, "&#39;")}'>
        <div class="ai-reco-card-top">
          <div class="ai-reco-type-dot" style="background:${color}"></div>
          <span class="ai-reco-name">${escapeHtml(spot.name)}</span>
        </div>
        ${metaChips ? `<div class="ai-reco-meta">${metaChips}</div>` : ""}
        <div class="ai-reco-reason">${escapeHtml(spot.reason || "")}</div>
        ${spot.logistics ? `<div class="ai-reco-logistics">${escapeHtml(spot.logistics)}</div>` : ""}
        ${tags ? `<div class="ai-reco-tags">${tags}</div>` : ""}
        ${spot.notes ? `<div class="ai-reco-logistics" style="font-style:italic">${escapeHtml(spot.notes)}</div>` : ""}
        <div class="ai-reco-actions">
          ${mapsSearchBtn(spot.name, townName)}
          <button class="ai-reco-add-btn" data-date="${escapeHtml(date)}" data-town-id="${escapeHtml(townId)}">
            + Add to ${new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
          </button>
        </div>
      </div>`;
  }).join("");

  body.innerHTML = cards || `<div class="ai-panel-error"><strong>No suggestions</strong>Try again or adjust your day plan.</div>`;

  body.querySelectorAll(".ai-reco-add-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".ai-reco-card");
      const spot = JSON.parse(card.dataset.spot);
      const targetDate = btn.dataset.date;
      const targetTownId = btn.dataset.townId;

      btn.disabled = true;
      btn.textContent = "Adding…";

      try {
        const validTags = (spot.tags || []).filter(t => state.trip?.tags?.includes(t));
        await saveSpot({
          name: spot.name,
          type: spot.type || "sight",
          townId: targetTownId,
          scheduledDate: targetDate || null,
          scheduledTime: spot.suggestedTime || null,
          neighborhood: spot.neighborhood || "",
          notes: [spot.reason, spot.logistics, spot.notes].filter(Boolean).join("\n\n"),
          tags: validTags,
          bookingUrl: "",
          cost: null,
          costPaid: false,
          paymentMethod: "",
        });
        btn.textContent = "✓ Added";
        btn.style.background = "var(--success, #4aaa8b)";
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Add failed — retry";
        console.error("AI add spot error:", err);
      }
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   PANEL VIEWS
   ───────────────────────────────────────────────────────────── */
export function showKeyEntryForm(onSave) {
  const body = document.getElementById("ai-panel-body");
  const contextEl = document.getElementById("ai-panel-context");
  contextEl.style.display = "none";
  body.innerHTML = `
    <div class="ai-key-form">
      <p>To use AI suggestions, paste your <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio API key</a> below. It will be saved to your trip and never stored in the source code.</p>
      <input class="ai-key-input" id="ai-key-input" type="password" placeholder="AIza…" autocomplete="off" spellcheck="false">
      <button class="ai-key-save-btn" id="ai-key-save-btn">Save &amp; get suggestions</button>
    </div>`;

  const input = document.getElementById("ai-key-input");
  const saveBtn = document.getElementById("ai-key-save-btn");

  input.focus();
  input.addEventListener("keydown", e => { if (e.key === "Enter") saveBtn.click(); });

  saveBtn.addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await setDoc(doc(db, "config", "site"), { geminiApiKey: key }, { merge: true });
      GEMINI_CONFIG.apiKey = key;
      onSave();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save & get suggestions";
      body.insertAdjacentHTML("beforeend", `<div class="ai-panel-error" style="margin-top:8px"><strong>Couldn't save key</strong>${escapeHtml(err.message)}</div>`);
    }
  });
}

async function fetchAndRenderRecommendations(townId, date, userPrompt = "") {
  const body = document.getElementById("ai-panel-body");
  const contextEl = document.getElementById("ai-panel-context");
  contextEl.style.display = "none";
  contextEl.textContent = "";
  body.innerHTML = `<div class="ai-panel-loading"><div class="ai-spinner"></div><span>Thinking about your day…</span></div>`;
  try {
    const ctx = buildRecommendationContext(townId, date);
    if (userPrompt) ctx.userPrompt = userPrompt;
    const result = await callGeminiRecommendations(ctx);
    renderRecommendationCards(result, townId, date);
  } catch (err) {
    body.innerHTML = `<div class="ai-panel-error"><strong>Couldn't get suggestions</strong>${escapeHtml(err.message)}</div>`;
    console.error("Gemini error:", err);
  }
}

function showPromptInputForm(townId, date) {
  const body = document.getElementById("ai-panel-body");
  const contextEl = document.getElementById("ai-panel-context");
  contextEl.style.display = "none";
  body.innerHTML = `
    <div class="ai-key-form">
      <p style="margin:0;font-size:0.8125rem;color:var(--text-2);line-height:1.6">Any specific needs for this day? Leave blank to get general suggestions.</p>
      <textarea id="ai-user-prompt" class="ai-key-input" rows="3" placeholder="e.g. We want something relaxed in the morning, and a good dinner spot near the centre" style="font-family:inherit;resize:vertical;min-height:80px"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn-ghost" id="ai-prompt-skip-btn" style="flex:1;justify-content:center">Skip</button>
        <button class="ai-key-save-btn" id="ai-prompt-go-btn" style="flex:2;text-align:center">Get suggestions</button>
      </div>
    </div>`;
  const go = () => {
    const prompt = document.getElementById("ai-user-prompt")?.value.trim() || "";
    fetchAndRenderRecommendations(townId, date, prompt);
  };
  document.getElementById("ai-prompt-skip-btn").addEventListener("click", () => fetchAndRenderRecommendations(townId, date, ""));
  document.getElementById("ai-prompt-go-btn").addEventListener("click", go);
  document.getElementById("ai-user-prompt").addEventListener("keydown", e => { if (e.key === "Enter" && e.metaKey) go(); });
}

export async function openRecommendationsPanel(townId, date) {
  const town = state.towns.find(t => t.id === townId);
  if (!town) return;

  const overlay = document.getElementById("ai-panel-overlay");
  const title = document.getElementById("ai-panel-title");
  const dateLabel = new Date(date + "T00:00:00")
    .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  title.textContent = `${town.name} · ${dateLabel}`;

  overlay.classList.add("visible");

  if (!GEMINI_CONFIG.apiKey) {
    showKeyEntryForm(() => showPromptInputForm(townId, date));
  } else {
    showPromptInputForm(townId, date);
  }
}

export function closeRecommendationsPanel() {
  document.getElementById("ai-panel-overlay").classList.remove("visible");
}

export function initRecommendations() {
  document.getElementById("ai-panel-close-btn").addEventListener("click", closeRecommendationsPanel);
  document.getElementById("ai-panel-backdrop").addEventListener("click", closeRecommendationsPanel);
  document.getElementById("ai-panel-key-btn").addEventListener("click", () => {
    showKeyEntryForm(() => {
      const overlay = document.getElementById("ai-panel-overlay");
      if (overlay.classList.contains("visible")) {
        closeRecommendationsPanel();
      }
    });
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && document.getElementById("ai-panel-overlay").classList.contains("visible")) {
      closeRecommendationsPanel();
    }
  });
}
