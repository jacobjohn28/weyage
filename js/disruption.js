import { GEMINI_CONFIG } from "./config.js";
import { state } from "./state.js";
import { db, updateDoc } from "./firebase.js";
import { escapeHtml } from "./utils.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerDisruptionCallbacks({ spotDocRef }) {
  Object.assign(cb, { spotDocRef });
}

/* ─────────────────────────────────────────────────────────────
   AIRLINE / CARRIER CONSTANTS
   ───────────────────────────────────────────────────────────── */
const AIRLINE_CLAIM_LINKS = {
  "air france":         "https://wwws.airfrance.com/en/passenger-services/rights-and-duties",
  "british airways":    "https://www.britishairways.com/en-gb/information/about-ba/legal-and-privacy/flight-delay-compensation",
  "lufthansa":          "https://www.lufthansa.com/gb/en/flight-disruptions",
  "klm":                "https://www.klm.com/information/passenger-rights",
  "easyjet":            "https://www.easyjet.com/en/help/compensation",
  "ryanair":            "https://www.ryanair.com/gb/en/plan-trip/flying-with-ryanair/passenger-rights",
  "emirates":           "https://www.emirates.com/english/help/faq/252763/what-are-my-rights-if-my-flight-is-cancelled",
  "delta":              "https://www.delta.com/us/en/customer-service-plan/overview",
  "united":             "https://www.united.com/en/us/fly/travel/policies/customer-commitment.html",
  "american airlines":  "https://www.aa.com/i18n/customer-service/support/customer-service-plan.jsp",
  "southwest":          "https://www.southwest.com/html/customer-service/passengers-rights/index.html",
  "singapore airlines": "https://www.singaporeair.com/en_UK/us/travel-info/baggage/delayed-damaged-and-lost-baggage/",
  "qantas":             "https://www.qantas.com/au/en/support/flight-disruptions.html",
  "iberia":             "https://www.iberia.com/gb/useful-info/passengers-rights/",
  "vueling":            "https://www.vueling.com/en/we-are-vueling/customer-service/passenger-rights",
  "tap air portugal":   "https://www.flytap.com/en-us/passenger-rights",
  "turkish airlines":   "https://www.turkishairlines.com/en-int/legal/passenger-rights/",
  "finnair":            "https://www.finnair.com/en/passenger-rights",
  "sas":                "https://www.flysas.com/en/us/legal/passenger-rights/",
  "eurostar":           "https://www.eurostar.com/uk-en/help/delay-repay",
  "thalys":             "https://www.eurostar.com/uk-en/help/delay-repay",
  "sncf":               "https://www.oui.sncf/en/passenger-rights",
  "trenitalia":         "https://www.trenitalia.com/en/information/passenger-rights.html",
  "renfe":              "https://www.renfe.com/es/en/passengers/policies/passenger-rights",
  "deutsche bahn":      "https://www.bahn.com/en/travel-information/passenger-rights",
};

const EU_CARRIERS = new Set([
  "air france","british airways","lufthansa","klm","easyjet","ryanair","iberia",
  "vueling","tap air portugal","finnair","sas","austrian","swiss","brussels airlines",
  "aegean","lot","wizzair","norwegian","eurowings","transavia","condor","jet2",
]);

const IATA_PROVIDERS = {
  AF:{ name:"Air France",          url:"https://www.airfrance.com" },
  BA:{ name:"British Airways",     url:"https://www.britishairways.com" },
  LH:{ name:"Lufthansa",           url:"https://www.lufthansa.com" },
  KL:{ name:"KLM",                 url:"https://www.klm.com" },
  U2:{ name:"easyJet",             url:"https://www.easyjet.com" },
  EZY:{ name:"easyJet",           url:"https://www.easyjet.com" },
  FR:{ name:"Ryanair",             url:"https://www.ryanair.com" },
  EK:{ name:"Emirates",            url:"https://www.emirates.com" },
  QR:{ name:"Qatar Airways",       url:"https://www.qatarairways.com" },
  SQ:{ name:"Singapore Airlines",  url:"https://www.singaporeair.com" },
  CX:{ name:"Cathay Pacific",      url:"https://www.cathaypacific.com" },
  TK:{ name:"Turkish Airlines",    url:"https://www.turkishairlines.com" },
  VS:{ name:"Virgin Atlantic",     url:"https://www.virginatlantic.com" },
  DL:{ name:"Delta",               url:"https://www.delta.com" },
  UA:{ name:"United Airlines",     url:"https://www.united.com" },
  AA:{ name:"American Airlines",   url:"https://www.aa.com" },
  WN:{ name:"Southwest",           url:"https://www.southwest.com" },
  B6:{ name:"JetBlue",             url:"https://www.jetblue.com" },
  NK:{ name:"Spirit Airlines",     url:"https://www.spirit.com" },
  F9:{ name:"Frontier Airlines",   url:"https://www.flyfrontier.com" },
  AC:{ name:"Air Canada",          url:"https://www.aircanada.com" },
  QF:{ name:"Qantas",              url:"https://www.qantas.com" },
  IB:{ name:"Iberia",              url:"https://www.iberia.com" },
  AY:{ name:"Finnair",             url:"https://www.finnair.com" },
  SK:{ name:"SAS",                 url:"https://www.flysas.com" },
  OS:{ name:"Austrian Airlines",   url:"https://www.austrian.com" },
  LX:{ name:"SWISS",               url:"https://www.swiss.com" },
  SN:{ name:"Brussels Airlines",   url:"https://www.brusselsairlines.com" },
  A3:{ name:"Aegean Airlines",     url:"https://en.aegeanair.com" },
  LO:{ name:"LOT Polish Airlines", url:"https://www.lot.com" },
  W6:{ name:"Wizz Air",            url:"https://wizzair.com" },
  DY:{ name:"Norwegian",           url:"https://www.norwegian.com" },
  EW:{ name:"Eurowings",           url:"https://www.eurowings.com" },
  HV:{ name:"Transavia",           url:"https://www.transavia.com" },
  TP:{ name:"TAP Air Portugal",    url:"https://www.flytap.com" },
  VY:{ name:"Vueling",             url:"https://www.vueling.com" },
  AZ:{ name:"ITA Airways",         url:"https://www.itaairways.com" },
  MH:{ name:"Malaysia Airlines",   url:"https://www.malaysiaairlines.com" },
  NH:{ name:"ANA",                 url:"https://www.ana.co.jp/en/us" },
  JL:{ name:"Japan Airlines",      url:"https://www.jal.com" },
  OZ:{ name:"Asiana Airlines",     url:"https://flyasiana.com" },
  CI:{ name:"China Airlines",      url:"https://www.china-airlines.com" },
  CA:{ name:"Air China",           url:"https://www.airchina.com" },
  MU:{ name:"China Eastern",       url:"https://www.ceair.com" },
  CZ:{ name:"China Southern",      url:"https://www.csair.com" },
  ET:{ name:"Ethiopian Airlines",  url:"https://www.ethiopianairlines.com" },
  KQ:{ name:"Kenya Airways",       url:"https://www.kenya-airways.com" },
  MS:{ name:"Egyptair",            url:"https://www.egyptair.com" },
  AI:{ name:"Air India",           url:"https://www.airindia.in" },
  G3:{ name:"Gol Airlines",        url:"https://www.voegol.com.br" },
  LA:{ name:"LATAM Airlines",      url:"https://www.latam.com" },
  CM:{ name:"Copa Airlines",       url:"https://www.copaair.com" },
  AV:{ name:"Avianca",             url:"https://www.avianca.com" },
};

const TRAIN_PROVIDERS = [
  { keys:["eurostar"],                  name:"Eurostar",         url:"https://www.eurostar.com" },
  { keys:["thalys"],                    name:"Thalys/Eurostar",  url:"https://www.eurostar.com" },
  { keys:["tgv","sncf","intercités","inoui","ouigo"], name:"SNCF", url:"https://www.oui.sncf" },
  { keys:["ice","db ","deutsche bahn"], name:"Deutsche Bahn",    url:"https://www.bahn.com" },
  { keys:["trenitalia","frecciarossa","frecciargento","italo"], name:"Trenitalia", url:"https://www.trenitalia.com" },
  { keys:["renfe","ave ","alvia","avant"], name:"Renfe",          url:"https://www.renfe.com" },
  { keys:["lner"],                      name:"LNER",             url:"https://www.lner.co.uk" },
  { keys:["avanti"],                    name:"Avanti West Coast",url:"https://www.avantiwestcoast.co.uk" },
  { keys:["gwr","great western"],       name:"Great Western Railway", url:"https://www.gwr.com" },
  { keys:["thameslink","gtrmid"],       name:"Thameslink",       url:"https://www.thameslinkrailway.com" },
  { keys:["southeastern"],              name:"Southeastern",     url:"https://www.southeasternrailway.co.uk" },
  { keys:["crosscountry"],              name:"CrossCountry",     url:"https://www.crosscountrytrains.co.uk" },
  { keys:["öbb","oebb","railjet"],      name:"ÖBB",             url:"https://www.oebb.at" },
  { keys:["infrabel","thalys","ic ","sncb"], name:"SNCB/Infrabel", url:"https://www.belgiantrain.be" },
  { keys:["ns ","sprinter","intercity"], name:"NS (Dutch Rail)", url:"https://www.ns.nl/en" },
  { keys:["cp ","comboios"],            name:"CP Portugal",      url:"https://www.cp.pt" },
  { keys:["vy ","nsb ","vy tog"],       name:"Vy (Norwegian Rail)", url:"https://www.vy.no/en" },
];

/* ─────────────────────────────────────────────────────────────
   STATIC RIGHTS ENGINE
   ───────────────────────────────────────────────────────────── */
function _getStaticRights(spot) {
  const sub     = (spot.transportSubtype || "").toLowerCase();
  const carrier = (spot.carrier || "").toLowerCase();
  const isEUCarrier = [...EU_CARRIERS].some(c => carrier.includes(c));

  if (sub === "plane" && isEUCarrier) {
    return {
      html: `<ul>
        <li><strong>EU Regulation 261/2004 applies.</strong> As the airline cancelled your flight you are entitled to choose between a full refund or re-routing at the earliest opportunity.</li>
        <li><strong>Right to care:</strong> Meals &amp; refreshments proportionate to waiting time. Hotel accommodation &amp; transport if overnight stay required.</li>
        <li><strong>Compensation:</strong> €250 (≤ 1,500 km) · €400 (1,500–3,500 km) · €600 (> 3,500 km). Only waived if the airline proves extraordinary circumstances beyond its control.</li>
        <li><strong>How to claim:</strong> Submit in writing to the airline within 6 years (UK) or 3 years (EU). Keep boarding-pass and cancellation notice as evidence.</li>
      </ul>`,
      source: "EU Regulation 261/2004",
    };
  }

  if (sub === "plane") {
    return {
      html: `<ul>
        <li><strong>US DOT rules apply</strong> if you're travelling on a US carrier or to/from the US. The airline must offer a prompt refund if you choose not to travel on the alternative offered.</li>
        <li>No federal compensation mandate exists for cancellations caused by events outside the airline's control, but most US carriers offer vouchers or rebooking.</li>
        <li><strong>How to claim:</strong> Contact the airline's customer relations department in writing. Reference <em>14 CFR Part 259</em> and <em>260</em> if the airline resists your refund.</li>
      </ul>`,
      source: "US DOT 14 CFR 259/260",
    };
  }

  if (sub === "train") {
    if (carrier.includes("eurostar") || carrier.includes("thalys")) {
      return {
        html: `<ul>
          <li><strong>Eurostar Delay Repay:</strong> 25% refund for 1–2 h delay, 50% for > 2 h. Full refund if you choose not to travel.</li>
          <li>Submit via Eurostar's Delay Repay form within 28 days of travel.</li>
        </ul>`,
        source: "Eurostar Passenger Charter",
      };
    }
    if (carrier.includes("sncf") || carrier.includes("tgv") || carrier.includes("intercités")) {
      return {
        html: `<ul>
          <li><strong>SNCF G30 guarantee:</strong> 25% refund for 30–60 min delay, 50% for 60–120 min, 75% for > 2 h.</li>
          <li>For cancellations, you're entitled to a full refund or the next available train at no extra cost.</li>
          <li>File via <em>oui.sncf</em> Passenger Rights section within 60 days.</li>
        </ul>`,
        source: "SNCF G30 Guarantee / EU Rail Passenger Rights Reg. 1371/2007",
      };
    }
    if (carrier.includes("deutsche bahn") || carrier.includes("db ")) {
      return {
        html: `<ul>
          <li><strong>DB Fahrgastrechte:</strong> 25% refund for 60–119 min delay, 50% for ≥ 120 min. Full refund for cancellations.</li>
          <li>Claim via the DB Fahrgastrechte form (online or at any DB Service Point) within 1 year.</li>
        </ul>`,
        source: "EU Regulation 1371/2007 / DB Passenger Rights",
      };
    }
    return {
      html: `<ul>
        <li><strong>EU Regulation 1371/2007</strong> covers most European trains. You're entitled to a full refund or re-routing if your departure is cancelled.</li>
        <li>For delays > 60 min: 25% refund. For delays > 120 min: 50% refund.</li>
        <li>Contact the operating rail company's customer service in writing within the statutory period (varies by operator).</li>
      </ul>`,
      source: "EU Rail Passenger Rights Regulation 1371/2007",
    };
  }

  return {
    html: `<ul>
      <li>Check the provider's cancellation and refund policy — most include a full refund for cancellations initiated by the provider.</li>
      <li>If you paid by credit card, check whether your card issuer offers travel protection (chargeback rights may apply).</li>
      <li>Keep all correspondence, booking confirmations, and the cancellation notice as evidence.</li>
    </ul>`,
    source: "General consumer rights guidance",
  };
}

/* ─────────────────────────────────────────────────────────────
   GEMINI RIGHTS FETCH
   ───────────────────────────────────────────────────────────── */
const _rightsCache = {};

async function _fetchGeminiRights(spot) {
  if (!GEMINI_CONFIG.apiKey) return null;
  if (_rightsCache[spot.id]) return _rightsCache[spot.id];

  const sub     = spot.transportSubtype || "transport";
  const carrier = spot.carrier || "unknown carrier";
  const origin  = spot.customOrigin || spot.transportFrom || "";
  const dest    = spot.customDestination || spot.transportTo || "";
  const date    = spot.scheduledDate || "";

  const prompt = `You are a concise travel rights expert. A traveller's ${sub} from "${origin}" to "${dest}" operated by "${carrier}" on ${date} was cancelled.

Provide the most relevant consumer rights in 4 bullet points covering: (1) the specific regulation that applies (e.g. EU 261/2004 for EU flights, US DOT for US flights, EU 1371/2007 for European trains), (2) compensation or refund amount, (3) right to care or hotel if applicable, (4) how to submit the claim and the deadline.

Format your response ONLY as an HTML <ul> list with <li> items. Use <strong> for regulation names and key figures. Be specific and practical. No preamble, no legal disclaimers.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${GEMINI_CONFIG.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) return null;
    const result = { html: text, source: "Gemini AI · " + GEMINI_CONFIG.model };
    _rightsCache[spot.id] = result;
    return result;
  } catch { return null; }
}

/* ─────────────────────────────────────────────────────────────
   CARRIER / PROVIDER RESOLUTION
   ───────────────────────────────────────────────────────────── */
function _resolveProviderFromCarrier(spot) {
  const raw = (spot.carrier || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (spot.transportSubtype === "train" || spot.transportSubtype === "bus") {
    for (const op of TRAIN_PROVIDERS) {
      if (op.keys.some(k => lower.includes(k))) return { name: op.name, url: op.url };
    }
  }

  const iataMatch = raw.match(/^([A-Z]{2,3})\s*\d/);
  if (iataMatch) {
    const code = iataMatch[1];
    if (IATA_PROVIDERS[code]) return IATA_PROVIDERS[code];
  }

  for (const [key] of Object.entries(AIRLINE_CLAIM_LINKS)) {
    if (lower.includes(key)) {
      const match = Object.values(IATA_PROVIDERS).find(p => p.name.toLowerCase().includes(key));
      if (match) return match;
    }
  }

  return null;
}

function _getClaimLinks(spot) {
  const carrier = (spot.carrier || "").toLowerCase();
  const links = [];

  const provider = _resolveProviderFromCarrier(spot);
  if (provider) {
    links.push({ label: `${provider.name} website`, url: provider.url, isProvider: true });
  }

  for (const [key, url] of Object.entries(AIRLINE_CLAIM_LINKS)) {
    if (carrier.includes(key)) {
      links.push({ label: `${spot.carrier || key} — claims page`, url });
      break;
    }
  }

  if (spot.transportSubtype === "plane") {
    links.push({ label: "AirHelp (EU261 claims)", url: "https://www.airhelp.com/en/flight-delays/" });
  }

  const q = encodeURIComponent(`${spot.carrier || spot.transportSubtype || "airline"} flight cancellation claim compensation`);
  links.push({ label: "Search online", url: `https://www.google.com/search?q=${q}` });

  links.push({ label: "EU Consumer Centre", url: "https://ec.europa.eu/info/live-work-travel-eu/consumer-rights-and-complaints/resolve-your-consumer-complaint_en" });

  return links;
}

/* ─────────────────────────────────────────────────────────────
   NAV BADGE
   ───────────────────────────────────────────────────────────── */
export function updateDisruptionBadge() {
  const count = state.spots.filter(s => s.type === "transport" && s.isCancelled).length;
  const btn = document.getElementById("nav-disruption-btn");
  if (!btn) return;
  btn.querySelector(".dis-nav-badge")?.remove();
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "dis-nav-badge";
    badge.textContent = count;
    badge.style.cssText = "margin-left:auto;font-size:0.6875rem;font-weight:700;background:var(--danger);color:#fff;border-radius:100px;padding:1px 6px;";
    btn.appendChild(badge);
  }
}

/* ─────────────────────────────────────────────────────────────
   FIRESTORE CLAIM SAVE
   ───────────────────────────────────────────────────────────── */
async function _saveClaimData(spotId, data) {
  await updateDoc(cb.spotDocRef(spotId), {
    claimRef:    data.claimRef    || null,
    claimNotes:  data.claimNotes  || null,
    claimStatus: data.claimStatus || { refundRequested: false, compensationFiled: false, resolved: false },
  });
}

/* ─────────────────────────────────────────────────────────────
   CARD HTML BUILDER
   ───────────────────────────────────────────────────────────── */
function _buildDisruptionCardHTML(spot) {
  const subtype   = spot.transportSubtype ? spot.transportSubtype.charAt(0).toUpperCase() + spot.transportSubtype.slice(1) : "Transport";
  const origin    = spot.customOrigin    || spot.transportFrom || "—";
  const dest      = spot.customDestination || spot.transportTo || "—";
  const dateStr   = spot.scheduledDate
    ? new Date(spot.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : "";
  const carrierMeta = spot.carrier ? ` · ${escapeHtml(spot.carrier)}` : "";
  const cs          = spot.claimStatus || {};

  const claimLinks = _getClaimLinks(spot);
  const linksHTML  = claimLinks.map(l =>
    `<a class="dis-link${l.isProvider ? " provider" : ""}" href="${l.url}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      ${escapeHtml(l.label)}
    </a>`
  ).join("");

  const rebookedByAll   = state.spots.filter(s => s.rebookedFromId === spot.id);
  const availableToLink = state.spots.filter(
    s => s.type === "transport" && !s.isCancelled && s.id !== spot.id && !s.rebookedFromId
  );

  const taggedHTML = rebookedByAll.length
    ? `<div class="dis-rebook-tagged">
        ${rebookedByAll.map(t => `
          <div class="dis-rebooked-tag">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
            ${escapeHtml(t.name || t.transportSubtype || "Transport")}
            <button class="dis-unlink-btn" data-unlink="${escapeHtml(t.id)}">Unlink</button>
          </div>`).join("")}
      </div>` : "";

  const addMoreHTML = availableToLink.length
    ? `<div>
        <div class="dis-field-label" style="margin-bottom:8px">${rebookedByAll.length ? "Link additional replacements:" : "Select replacement transports:"}</div>
        <div class="dis-rebook-cb-list">
          ${availableToLink.map(t => `
            <label class="dis-rebook-cb-item">
              <input type="checkbox" data-rebook-cb="${escapeHtml(spot.id)}" value="${escapeHtml(t.id)}">
              <span>${escapeHtml(t.name || t.transportSubtype || "Transport")}${t.carrier ? ` · ${escapeHtml(t.carrier)}` : ""}${t.scheduledDate ? ` · ${t.scheduledDate}` : ""}</span>
            </label>`).join("")}
        </div>
        <button class="dis-rebook-btn" data-rebook-confirm="${escapeHtml(spot.id)}">Link selected as rebooking</button>
      </div>`
    : rebookedByAll.length === 0
      ? `<p style="font-size:0.8125rem;color:var(--text-3);margin:0">No other transports available. Add a replacement in the Itinerary tab first.</p>`
      : "";

  const rebookSection = taggedHTML + addMoreHTML;

  return `
  <div class="disruption-card" data-dis-id="${escapeHtml(spot.id)}">
    <div class="disruption-card-header">
      <div class="dis-header-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="dis-header-text">
        <div class="dis-route">${escapeHtml(origin)} → ${escapeHtml(dest)}</div>
        <div class="dis-meta">${escapeHtml(subtype)}${carrierMeta}${dateStr ? " · " + escapeHtml(dateStr) : ""}</div>
      </div>
      <svg class="dis-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="disruption-card-body">

      <div class="disruption-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="disruption-section-label" style="margin-bottom:0">Your Rights &amp; Entitlements</div>
          <button class="dis-regen-btn" data-regen-rights="${escapeHtml(spot.id)}" title="Regenerate using Gemini AI">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            Regenerate
          </button>
        </div>
        <div data-rights-for="${escapeHtml(spot.id)}">
          <div class="dis-rights-loading"><span class="spin">⟳</span> Loading rights…</div>
        </div>
      </div>

      <div class="disruption-section">
        <div class="disruption-section-label">Where to Claim</div>
        <div class="dis-links">${linksHTML}</div>
      </div>

      <div class="disruption-section">
        <div class="disruption-section-label">Claims Tracker</div>
        <div class="dis-tracker">
          <div>
            <div class="dis-field-label">Claim reference number</div>
            <input class="form-input" style="width:100%;box-sizing:border-box" placeholder="e.g. AF-2024-XXXXX"
              data-claim-ref="${escapeHtml(spot.id)}" value="${escapeHtml(spot.claimRef || "")}">
          </div>
          <div>
            <div class="dis-field-label">Status</div>
            <div class="dis-checkboxes">
              <label class="dis-check-item">
                <input type="checkbox" data-claim-check="refundRequested" data-for="${escapeHtml(spot.id)}" ${cs.refundRequested ? "checked" : ""}> Refund requested
              </label>
              <label class="dis-check-item">
                <input type="checkbox" data-claim-check="compensationFiled" data-for="${escapeHtml(spot.id)}" ${cs.compensationFiled ? "checked" : ""}> Compensation filed
              </label>
              <label class="dis-check-item">
                <input type="checkbox" data-claim-check="resolved" data-for="${escapeHtml(spot.id)}" ${cs.resolved ? "checked" : ""}> Resolved ✓
              </label>
            </div>
          </div>
          <div>
            <div class="dis-field-label">Notes</div>
            <textarea class="form-input" rows="3" style="width:100%;box-sizing:border-box;resize:vertical"
              placeholder="e.g. Spoke to gate agent John, voucher offered"
              data-claim-notes="${escapeHtml(spot.id)}">${escapeHtml(spot.claimNotes || "")}</textarea>
          </div>
          <div class="dis-tracker-actions">
            <button class="dis-save-btn" data-claim-save="${escapeHtml(spot.id)}">Save</button>
            <span class="dis-saved-toast" data-save-toast="${escapeHtml(spot.id)}">Saved ✓</span>
          </div>
        </div>
      </div>

      <div class="disruption-section">
        <div class="disruption-section-label">Rebooking</div>
        <div data-rebook-section="${escapeHtml(spot.id)}">${rebookSection}</div>
      </div>

    </div>
  </div>`;
}

/* ─────────────────────────────────────────────────────────────
   MAIN RENDER
   ───────────────────────────────────────────────────────────── */
export function renderDisruption() {
  const container = document.getElementById("disruption-content");
  if (!container) return;

  updateDisruptionBadge();

  const cancelled = state.spots
    .filter(s => s.type === "transport" && s.isCancelled)
    .sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));

  if (cancelled.length === 0) {
    container.innerHTML = `
      <div class="disruption-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="52" height="52">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <div class="disruption-empty-title">No cancelled transports</div>
        <div class="disruption-empty-sub">When a flight or train is cancelled, open its card in the Itinerary and tap <strong>Mark as Cancelled</strong>. Recovery options will appear here.</div>
      </div>`;
    return;
  }

  const summary = `
    <div class="disruption-summary-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span><strong>${cancelled.length}</strong> cancelled transport${cancelled.length > 1 ? "s" : ""} — expand each card to manage your claim.</span>
    </div>`;

  container.innerHTML = summary + cancelled.map(s => _buildDisruptionCardHTML(s)).join("");

  async function _loadRights(card, spotId, force = false) {
    const rightsEl = card.querySelector(`[data-rights-for="${spotId}"]`);
    const spot     = state.spots.find(s => s.id === spotId);
    if (!rightsEl || !spot) return;
    if (!force && rightsEl.dataset.loaded) return;
    rightsEl.dataset.loaded = "1";
    rightsEl.innerHTML = `<div class="dis-rights-loading"><span class="spin">⟳</span> Loading rights…</div>`;

    let rights = null;
    if (GEMINI_CONFIG.apiKey) rights = await _fetchGeminiRights(spot);
    if (!rights) rights = _getStaticRights(spot);

    rightsEl.innerHTML = `
      <div class="dis-rights-body">${rights.html}</div>
      <div class="dis-rights-source">Source: ${escapeHtml(rights.source)}</div>`;
  }

  container.querySelectorAll(".disruption-card-header").forEach(header => {
    header.addEventListener("click", async (e) => {
      if (e.target.closest(".dis-regen-btn")) return;
      const card   = header.closest(".disruption-card");
      const isOpen = card.classList.toggle("open");
      if (!isOpen) return;
      await _loadRights(card, card.dataset.disId);
    });
  });

  container.querySelectorAll("[data-regen-rights]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const spotId = btn.dataset.regenRights;
      const card   = container.querySelector(`[data-dis-id="${spotId}"]`);
      if (!card) return;
      delete _rightsCache[spotId];
      btn.classList.add("spinning");
      btn.disabled = true;
      await _loadRights(card, spotId, true);
      btn.classList.remove("spinning");
      btn.disabled = false;
    });
  });

  container.querySelectorAll("[data-claim-save]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const spotId = btn.dataset.claimSave;
      const card   = container.querySelector(`[data-dis-id="${spotId}"]`);
      if (!card) return;
      const refInput   = card.querySelector(`[data-claim-ref="${spotId}"]`);
      const notesInput = card.querySelector(`[data-claim-notes="${spotId}"]`);
      const claimStatus = {};
      card.querySelectorAll(`[data-claim-check][data-for="${spotId}"]`).forEach(cb => {
        claimStatus[cb.dataset.claimCheck] = cb.checked;
      });
      try {
        await _saveClaimData(spotId, {
          claimRef:    refInput?.value.trim()   || null,
          claimNotes:  notesInput?.value.trim() || null,
          claimStatus,
        });
        const toast = card.querySelector(`[data-save-toast="${spotId}"]`);
        if (toast) { toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2000); }
      } catch (e) { console.error("Save claim failed:", e); }
    });
  });

  container.querySelectorAll("[data-rebook-confirm]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cancelledId = btn.dataset.rebookConfirm;
      const section     = container.querySelector(`[data-rebook-section="${cancelledId}"]`);
      const checked     = [...(section?.querySelectorAll(`[data-rebook-cb="${cancelledId}"]:checked`) || [])];
      if (!checked.length) return;
      try {
        await Promise.all(checked.map(checkbox => updateDoc(cb.spotDocRef(checkbox.value), { rebookedFromId: cancelledId })));
      } catch (e) { console.error("Rebook link failed:", e); }
    });
  });

  container.querySelectorAll("[data-unlink]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await updateDoc(cb.spotDocRef(btn.dataset.unlink), { rebookedFromId: null });
      } catch (e) { console.error("Unlink failed:", e); }
    });
  });
}
