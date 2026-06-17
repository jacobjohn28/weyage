import { GEMINI_CONFIG } from "./config.js";
import { state, activeTripId } from "./state.js";
import { db, doc, setDoc, serverTimestamp } from "./firebase.js";
import { currencySymbol, escapeHtml } from "./utils.js";
import { currentUserMemberId } from "./budget.js";

const LAYOVER_MS = 6 * 60 * 60 * 1000; // 6 hours

/* ─────────────────────────────────────────────────────────────
   ENTRY POINT
   ───────────────────────────────────────────────────────────── */
export function triggerTicketImport() {
  if (!GEMINI_CONFIG.apiKey) {
    alert("Gemini API key not configured. Add it in Settings.");
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    _showDrawer(null); // loading state
    try {
      const { base64, mimeType } = await _readAsBase64(file);
      const legs = await _parseTicketImage(base64, mimeType);
      if (!legs || legs.length === 0) {
        _showDrawer({ error: "Unable to extract any transport information, try uploading another image." });
        return;
      }
      _showDrawer({ legs: _tagLayovers(legs) });
    } catch (err) {
      console.error("Ticket import:", err);
      _showDrawer({ error: "Something went wrong parsing the image. Please try again." });
    }
  });
  input.click();
}

/* ─────────────────────────────────────────────────────────────
   FILE → BASE64
   ───────────────────────────────────────────────────────────── */
function _readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mimeType: file.type || "image/jpeg" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ─────────────────────────────────────────────────────────────
   GEMINI VISION CALL
   ───────────────────────────────────────────────────────────── */
async function _parseTicketImage(base64, mimeType) {
  const prompt = `You are a travel assistant. Analyze this travel ticket or app screenshot and extract every transport leg.

For each leg return a JSON object with these exact keys:
- "subtype": lowercase string — "flight", "train", "ferry", "bus", or another transport type you identify
- "carrier": operator name (e.g. "Ryanair", "Eurostar") or null
- "reference": booking/ticket/flight number code or null
- "seat": seat number if visible or null
- "from": full departure station/terminal/airport name (e.g. "London Gatwick Airport")
- "fromCity": departure CITY name only (e.g. "London")
- "fromCode": IATA or station code if visible (e.g. "LGW") or null
- "to": full arrival station/terminal/airport name
- "toCity": arrival CITY name only
- "toCode": IATA or station code if visible or null
- "departureDate": departure date in YYYY-MM-DD format or null
- "departureTime": departure time in HH:MM 24h format or null
- "arrivalDate": arrival date in YYYY-MM-DD format or null
- "arrivalTime": arrival time in HH:MM 24h format or null
- "price": numeric price amount only (no currency symbol) or null
- "priceCurrency": ISO 4217 3-letter currency code (e.g. "GBP", "EUR") or null

Rules:
- Return each leg separately even for connecting flights
- Use null for any field not visible
- For dates without a year, infer the most plausible upcoming year
- Convert all times to 24h format
- fromCity/toCity should be the city, not airport or station name

Respond ONLY with a valid JSON array. No markdown fences, no prose.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${GEMINI_CONFIG.apiKey}`;
  const body = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: prompt },
      ],
    }],
    generation_config: {
      temperature: 0.1,
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
    throw new Error(err?.error?.message || `Gemini error ${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────
   LAYOVER DETECTION
   Tags legs where from/to city is a layover (<6 h stop).
   ───────────────────────────────────────────────────────────── */
function _tagLayovers(legs) {
  const layoverCities = new Set();
  for (let i = 0; i < legs.length - 1; i++) {
    const curr = legs[i];
    const next = legs[i + 1];
    const sameCity = curr.toCity && next.fromCity &&
      curr.toCity.toLowerCase() === next.fromCity.toLowerCase();
    if (!sameCity) continue;
    if (!curr.arrivalDate || !curr.arrivalTime || !next.departureDate || !next.departureTime) continue;
    const arrMs  = new Date(`${curr.arrivalDate}T${curr.arrivalTime}`).getTime();
    const depMs  = new Date(`${next.departureDate}T${next.departureTime}`).getTime();
    const diffMs = depMs - arrMs;
    if (diffMs >= 0 && diffMs < LAYOVER_MS) {
      layoverCities.add(curr.toCity.toLowerCase());
    }
  }
  return legs.map(leg => ({
    ...leg,
    _fromIsLayover: leg.fromCity ? layoverCities.has(leg.fromCity.toLowerCase()) : false,
    _toIsLayover:   leg.toCity   ? layoverCities.has(leg.toCity.toLowerCase())   : false,
  }));
}

/* ─────────────────────────────────────────────────────────────
   REVIEW DRAWER
   ───────────────────────────────────────────────────────────── */
const SUBTYPE_ICON = {
  flight: "✈",
  train:  "🚂",
  ferry:  "⛴",
  bus:    "🚌",
};

function _subtypeIcon(s) { return SUBTYPE_ICON[s] || "🚗"; }
function _subtypeLabel(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Transport"; }

function _legTitle(leg) {
  const from = leg.fromCity || leg.from || "?";
  const to   = leg.toCity   || leg.to   || "?";
  return `${_subtypeLabel(leg.subtype)} from ${from} to ${to}`;
}

function _fieldMissing(v) { return v === null || v === undefined || v === ""; }

function _inputAttrs(leg, field) {
  const v = leg[field];
  return _fieldMissing(v) ? 'data-missing="true"' : `value="${escapeHtml(String(v))}"`;
}

function _renderLegCard(leg, idx, members, myMemberId) {
  const missingCls = (f) => _fieldMissing(leg[f]) ? " ticket-field-missing" : "";

  const memberOptions = members.map(m =>
    `<option value="${escapeHtml(m.id)}"${m.id === myMemberId ? " selected" : ""}>${escapeHtml(m.name)}</option>`
  ).join("");

  const paidByRow = members.length >= 2 ? `
    <div class="ticket-field">
      <label class="ticket-label">Paid by</label>
      <select class="form-input ticket-input" data-field="paidBy" data-idx="${idx}">
        ${memberOptions}
      </select>
    </div>` : "";

  return `
    <div class="ticket-leg-card" data-leg-idx="${idx}">
      <div class="ticket-leg-header">
        <span class="ticket-leg-icon">${_subtypeIcon(leg.subtype)}</span>
        <span class="ticket-leg-mode">${escapeHtml(_legTitle(leg))}</span>
        <button class="icon-btn ticket-leg-remove" data-idx="${idx}" title="Remove leg" style="margin-left:auto;opacity:0.5;font-size:1rem">✕</button>
      </div>

      <div class="ticket-fields-grid">
        <div class="ticket-field${missingCls("departureDate")}">
          <label class="ticket-label">Dep date</label>
          <input type="date" class="form-input ticket-input${missingCls("departureDate")}" data-field="departureDate" data-idx="${idx}" ${_inputAttrs(leg, "departureDate")}>
        </div>
        <div class="ticket-field${missingCls("departureTime")}">
          <label class="ticket-label">Dep time</label>
          <input type="time" class="form-input ticket-input${missingCls("departureTime")}" data-field="departureTime" data-idx="${idx}" ${_inputAttrs(leg, "departureTime")}>
        </div>
        <div class="ticket-field${missingCls("arrivalDate")}">
          <label class="ticket-label">Arr date</label>
          <input type="date" class="form-input ticket-input${missingCls("arrivalDate")}" data-field="arrivalDate" data-idx="${idx}" ${_inputAttrs(leg, "arrivalDate")}>
        </div>
        <div class="ticket-field${missingCls("arrivalTime")}">
          <label class="ticket-label">Arr time</label>
          <input type="time" class="form-input ticket-input${missingCls("arrivalTime")}" data-field="arrivalTime" data-idx="${idx}" ${_inputAttrs(leg, "arrivalTime")}>
        </div>
        <div class="ticket-field${missingCls("carrier")}">
          <label class="ticket-label">Carrier</label>
          <input type="text" class="form-input ticket-input${missingCls("carrier")}" data-field="carrier" data-idx="${idx}" placeholder="Carrier" ${_inputAttrs(leg, "carrier")}>
        </div>
        <div class="ticket-field${missingCls("reference")}">
          <label class="ticket-label">Ref</label>
          <input type="text" class="form-input ticket-input${missingCls("reference")}" data-field="reference" data-idx="${idx}" placeholder="Reference" ${_inputAttrs(leg, "reference")}>
        </div>
        <div class="ticket-field${missingCls("seat")}">
          <label class="ticket-label">Seat</label>
          <input type="text" class="form-input ticket-input${missingCls("seat")}" data-field="seat" data-idx="${idx}" placeholder="Seat" ${_inputAttrs(leg, "seat")}>
        </div>
        <div class="ticket-field">
          <label class="ticket-label">Price</label>
          <div style="display:flex;gap:4px">
            <input type="number" class="form-input ticket-input${missingCls("price")}" data-field="price" data-idx="${idx}" placeholder="0.00" min="0" step="0.01" style="flex:1" ${_inputAttrs(leg, "price")}>
            <input type="text"   class="form-input ticket-input${missingCls("priceCurrency")}" data-field="priceCurrency" data-idx="${idx}" placeholder="EUR" maxlength="3" style="width:54px;text-transform:uppercase" ${_inputAttrs(leg, "priceCurrency")}>
          </div>
        </div>
        ${paidByRow}
      </div>
    </div>`;
}

function _showDrawer(state_) {
  // Reuse existing overlay if present
  let overlay = document.getElementById("ticket-import-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "ticket-import-overlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);
  }

  if (!state_) {
    // Loading state
    overlay.innerHTML = `
      <div class="ticket-import-drawer">
        <div class="ticket-drawer-header">
          <span class="ticket-drawer-title">Import from ticket</span>
          <button class="icon-btn" id="ticket-import-close">✕</button>
        </div>
        <div class="ticket-drawer-body" style="display:flex;align-items:center;justify-content:center;padding:48px 0;gap:10px;color:var(--text-2)">
          <span class="ticket-spinner"></span>
          <span>Reading your ticket…</span>
        </div>
      </div>`;
    overlay.classList.add("open");
    overlay.querySelector("#ticket-import-close").addEventListener("click", _closeDrawer);
    return;
  }

  if (state_.error) {
    overlay.innerHTML = `
      <div class="ticket-import-drawer">
        <div class="ticket-drawer-header">
          <span class="ticket-drawer-title">Import from ticket</span>
          <button class="icon-btn" id="ticket-import-close">✕</button>
        </div>
        <div class="ticket-drawer-body" style="padding:32px 20px;color:var(--text-2);text-align:center;font-size:0.9375rem">
          ${escapeHtml(state_.error)}
        </div>
        <div class="ticket-drawer-footer">
          <button class="btn-secondary" id="ticket-import-retry">Try another image</button>
        </div>
      </div>`;
    overlay.querySelector("#ticket-import-close").addEventListener("click", _closeDrawer);
    overlay.querySelector("#ticket-import-retry").addEventListener("click", () => {
      _closeDrawer();
      triggerTicketImport();
    });
    return;
  }

  // Main review state
  const legs = state_.legs;
  const members = state.trip?.members || [];
  const myMemberId = currentUserMemberId();

  // Mutable copy of leg data (edited in-place via input listeners)
  const legData = legs.map(l => ({ ...l }));
  let removedIndices = new Set();

  function _countVisible() {
    return legData.filter((_, i) => !removedIndices.has(i)).length;
  }

  function _renderAll() {
    const count = _countVisible();
    const confirmBtn = overlay.querySelector("#ticket-import-confirm");
    if (confirmBtn) {
      confirmBtn.textContent = `Add ${count === 1 ? "leg" : `all ${count} legs`}`;
      confirmBtn.disabled = count === 0;
    }
    // Re-render leg cards
    const body = overlay.querySelector(".ticket-drawer-legs");
    if (!body) return;
    body.innerHTML = legData.map((leg, idx) => {
      if (removedIndices.has(idx)) return "";
      return _renderLegCard(leg, idx, members, myMemberId);
    }).join("");
    _wireDrawerInputs();
  }

  function _wireDrawerInputs() {
    overlay.querySelectorAll(".ticket-input").forEach(input => {
      input.addEventListener("input", () => {
        const idx = parseInt(input.dataset.idx);
        const field = input.dataset.field;
        let val = input.value.trim() || null;
        if (field === "price") val = val ? parseFloat(val) : null;
        legData[idx][field] = val;
        input.dataset.missing = _fieldMissing(val) ? "true" : "false";
        input.classList.toggle("ticket-field-missing", _fieldMissing(val));
      });
    });
    overlay.querySelectorAll(".ticket-leg-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        removedIndices.add(parseInt(btn.dataset.idx));
        _renderAll();
      });
    });
  }

  const legsCount = legs.length;
  overlay.innerHTML = `
    <div class="ticket-import-drawer">
      <div class="ticket-drawer-header">
        <div>
          <span class="ticket-drawer-title">Import from ticket</span>
          <span class="ticket-drawer-subtitle">${legsCount} leg${legsCount !== 1 ? "s" : ""} detected</span>
        </div>
        <button class="icon-btn" id="ticket-import-close">✕</button>
      </div>
      <div class="ticket-drawer-body">
        <div class="ticket-drawer-legs">
          ${legData.map((leg, idx) => _renderLegCard(leg, idx, members, myMemberId)).join("")}
        </div>
      </div>
      <div class="ticket-drawer-footer">
        <button class="btn-primary" id="ticket-import-confirm">
          Add all ${legsCount} leg${legsCount !== 1 ? "s" : ""}
        </button>
      </div>
    </div>`;

  overlay.querySelector("#ticket-import-close").addEventListener("click", _closeDrawer);
  overlay.querySelector("#ticket-import-confirm").addEventListener("click", async () => {
    const toSave = legData.filter((_, i) => !removedIndices.has(i));
    const confirmBtn = overlay.querySelector("#ticket-import-confirm");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving…";
    try {
      await _saveLegs(toSave);
      _closeDrawer();
    } catch (err) {
      console.error("Ticket save error:", err);
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Add all ${_countVisible()} legs`;
      alert("Failed to save some legs. Please try again.");
    }
  });

  _wireDrawerInputs();
}

function _closeDrawer() {
  const overlay = document.getElementById("ticket-import-overlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  setTimeout(() => overlay.remove(), 300);
}

/* ─────────────────────────────────────────────────────────────
   TOWN RESOLUTION
   ───────────────────────────────────────────────────────────── */
// Cache new towns created during a single import session so we don't
// double-create if the same city appears in multiple legs.
const _sessionTownCache = new Map(); // cityName.lower → townId

async function _resolveOrCreateTown(cityName, allLegs) {
  if (!cityName) return null;
  const key = cityName.toLowerCase().trim();

  if (_sessionTownCache.has(key)) return _sessionTownCache.get(key);

  // Match against existing towns (substring both ways)
  const existing = state.towns.find(t => {
    const tn = t.name.toLowerCase().trim();
    return tn === key || tn.includes(key) || key.includes(tn);
  });
  if (existing) {
    _sessionTownCache.set(key, existing.id);
    return existing.id;
  }

  // Infer dates from the full leg list
  const arrLegs = allLegs.filter(l => l.toCity?.toLowerCase() === key && l.arrivalDate);
  const depLegs = allLegs.filter(l => l.fromCity?.toLowerCase() === key && l.departureDate);
  const arrivalDate   = arrLegs.length ? arrLegs.map(l => l.arrivalDate).sort()[0]   : null;
  const departureDate = depLegs.length ? depLegs.map(l => l.departureDate).sort()[0] : null;

  const maxOrder = state.towns.length > 0 ? Math.max(...state.towns.map(t => t.order ?? 0)) : -1;
  const id = crypto.randomUUID();

  await setDoc(doc(db, "trips", activeTripId, "towns", id), {
    id,
    name: cityName,
    arrivalDate:   arrivalDate   || null,
    departureDate: departureDate || null,
    country: "",
    order: maxOrder + 1,
    createdAt: serverTimestamp(),
  });

  _sessionTownCache.set(key, id);
  return id;
}

/* ─────────────────────────────────────────────────────────────
   SAVE LEGS
   ───────────────────────────────────────────────────────────── */
async function _saveLegs(legs) {
  // Clear session cache at start of each save batch
  _sessionTownCache.clear();

  const members = state.trip?.members || [];

  for (const leg of legs) {
    let townId, arrivalTownId, transportDirection;

    if (leg._fromIsLayover) {
      // From-city has no town; store spot in the arrival town as "arriving"
      townId = await _resolveOrCreateTown(leg.toCity, legs);
      arrivalTownId = null;
      transportDirection = "arriving";
    } else {
      townId = await _resolveOrCreateTown(leg.fromCity, legs);
      if (leg._toIsLayover) {
        // To-city is a layover — no arrival town
        arrivalTownId = null;
      } else {
        arrivalTownId = await _resolveOrCreateTown(leg.toCity, legs);
      }
      transportDirection = "departing";
    }

    if (!townId) continue;

    const spotId = crypto.randomUUID();
    const myMemberId = currentUserMemberId();
    const paidBy = leg.paidBy || myMemberId || null;

    // Build splits — "solo" means payer owes everything
    let splits = null;
    if (paidBy && members.length >= 2 && leg.price) {
      splits = members.map(m => ({
        memberId: m.id,
        owed: m.id === paidBy ? leg.price : 0,
      }));
    }

    const sameDay = state.spots.filter(
      s => s.townId === townId && s.scheduledDate === (leg.departureDate || null)
    );

    const spotData = {
      id: spotId,
      type: "transport",
      name: _legTitle(leg),
      townId,
      transportSubtype:    leg.subtype    || "flight",
      transportDirection,
      transportFrom:       leg.from       || leg.fromCity || null,
      transportTo:         leg.to         || leg.toCity   || null,
      scheduledDate:       leg.departureDate              || null,
      departureTime:       leg.departureTime              || null,
      arrivalTownId:       arrivalTownId                  || null,
      arrivalDate:         leg.arrivalDate                || null,
      arrivalTime:         leg.arrivalTime                || null,
      carrier:             leg.carrier                    || null,
      seat:                leg.seat                       || null,
      bookingRef:          leg.reference                  || null,
      price:               leg.price                      || null,
      priceCurrency:       leg.priceCurrency              || null,
      paidBy,
      splitType:           splits ? "solo" : null,
      splits,
      memberIds:           null,
      notes:               null,
      booked:              true,
      visited:             false,
      tags:                [],
      expenses:            [],
      order:               sameDay.length,
      createdAt:           serverTimestamp(),
    };

    await setDoc(doc(db, "trips", activeTripId, "spots", spotId), spotData);
  }
}
