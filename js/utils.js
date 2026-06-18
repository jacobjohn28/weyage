/* ─────────────────────────────────────────────────────────────
   DATE / TIME HELPERS
   ───────────────────────────────────────────────────────────── */
export function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtDateRange(startISO, endISO) {
  const start = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  const sm = start.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  const em = end.toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" });
  return `${sm} — ${em}`;
}

export function fmtSpreadDates(startISO, endISO) {
  // Compact form for spread: "28 May → 1 Jun"
  const start = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  const opts = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString("en-GB", opts)}<span class="spread-dates-sep">→</span>${end.toLocaleDateString("en-GB", opts)}`;
}

export function nightsBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

export function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

export function fmtTime12(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${period}` : `${hour}:${String(m).padStart(2, "0")}${period}`;
}

export function fmtDayHeader(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return {
    dow: d.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase(),
    full: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
  };
}

/* ─────────────────────────────────────────────────────────────
   STRING / HTML HELPERS
   ───────────────────────────────────────────────────────────── */
export function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

export function emailToName(email) {
  return email.split("@")[0]
    .replace(/[._+-]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Returns an anchor that opens an exact address in Google Maps
export function mapsLink(address) {
  const url = "https://maps.google.com/?q=" + encodeURIComponent(address);
  return `<a class="address-map-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
    ${escapeHtml(address)}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="12" height="12" style="flex-shrink:0;margin-left:3px;vertical-align:middle;opacity:0.7"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
  </a>`;
}

// Returns a "Find on Maps" search button using spot name + city as the query
export function mapsSearchBtn(spotName, townName) {
  const query = spotName + (townName ? ", " + townName : "");
  const url = "https://maps.google.com/?q=" + encodeURIComponent(query);
  return `<a class="maps-search-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="12" height="12"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
    Find on Maps
  </a>`;
}

// Phone number detection patterns:
// 1. International: +countrycode followed by digits/spaces/dashes (e.g. +33 1 23 45 67 89)
// 2. French-style local: 5 pairs of 2 digits (e.g. 01 23 45 67 89 or 0123456789)
const PHONE_RE = /(\+[\d][\d\s\-().]{6,18}[\d]|\b0[\d][\s\-.]?\d{2}[\s\-.]?\d{2}[\s\-.]?\d{2}[\s\-.]?\d{2}\b)/g;

export function linkifyNotes(raw) {
  if (!raw) return "";
  // First escape the whole string, then re-linkify phone numbers.
  // We work on the raw string to detect phones, then escape each part separately.
  const parts = [];
  let last = 0;
  let m;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(raw)) !== null) {
    // Push text before this match (escaped)
    if (m.index > last) parts.push(escapeHtml(raw.slice(last, m.index)));
    const phone = m[0];
    const dialable = phone.replace(/[\s\-().]/g, "");
    parts.push(
      `<a class="phone-link" href="tel:${escapeHtml(dialable)}">${escapeHtml(phone)}</a>` +
      `<button class="phone-copy-btn" data-phone="${escapeHtml(phone)}" title="Copy number">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
      `Copy</button>`
    );
    last = m.index + phone.length;
  }
  if (last < raw.length) parts.push(escapeHtml(raw.slice(last)));
  // Replace newlines with <br> for display (raw text is pre-wrap in CSS, but we're using innerHTML now)
  return parts.join("").replace(/\n/g, "<br>");
}

export function wirePhoneCopyBtns(container) {
  container.querySelectorAll(".phone-copy-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const phone = btn.dataset.phone;
      try {
        await navigator.clipboard.writeText(phone);
        btn.classList.add("copied");
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy`;
        }, 2000);
      } catch {
        // Fallback: select text in a temp input
        const inp = document.createElement("input");
        inp.value = phone; inp.style.position = "fixed"; inp.style.opacity = "0";
        document.body.appendChild(inp); inp.select(); document.execCommand("copy");
        document.body.removeChild(inp);
        btn.classList.add("copied"); btn.textContent = "Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy`;
        }, 2000);
      }
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   BUTTON LOADING STATE
   ───────────────────────────────────────────────────────────── */
export function btnLoading(btn, label = "") {
  if (!btn) return;
  btn.disabled = true;
  btn._savedHTML = btn.innerHTML;
  btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${label ? escapeHtml(label) : ""}`;
}

export function btnReset(btn) {
  if (!btn) return;
  btn.disabled = false;
  if (btn._savedHTML !== undefined) {
    btn.innerHTML = btn._savedHTML;
    delete btn._savedHTML;
  }
}

/* ─────────────────────────────────────────────────────────────
   UI ICON HELPERS
   ───────────────────────────────────────────────────────────── */
export function typeIconSVG(type) {
  const icons = {
    sight:      `<svg class="spot-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="3"/><path d="M20.188 10.934C20.72 11.5 21 12.03 21 12.5c0 2.485-4.03 4.5-9 4.5s-9-2.015-9-4.5c0-.47.28-1 .812-1.566"/></svg>`,
    restaurant: `<svg class="spot-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>`,
    cafe:       `<svg class="spot-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/></svg>`,
    experience: `<svg class="spot-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    transport:  `<svg class="spot-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  };
  return icons[type] || icons.sight;
}
