import { state, activeTripId, setState } from "./state.js";
import { db, doc, updateDoc, deleteDoc, addDoc, collection,
         serverTimestamp, writeBatch, arrayUnion, deleteField } from "./firebase.js";
import { escapeHtml, localDateStr } from "./utils.js";
import { openModal, openAccomModal } from "./itinerary.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerBudgetCallbacks({ pushModalHistory, popModalHistory, getDrawerBudgetMode, setDrawerBudgetMode, clearDrawerContext }) {
  Object.assign(cb, { pushModalHistory, popModalHistory, getDrawerBudgetMode, setDrawerBudgetMode, clearDrawerContext });
}

/* Refresh the budget drawer after external data change (e.g. Firestore snapshot) */
export function refreshBudgetDrawer() {
  _bdEntries = aggregateBudget().filter(e => e.currency === _bdCurrency);
  _renderBudgetDrawer();
}


/* ── Setters for split state vars used from outside this module ── */
export function setSpotSplit(payerId, splitMode, splitsArray) {
  _spotPayerId = payerId;
  _spotSplitMode = splitMode || "equal";
  _spotCustomSplits = {};
  if (splitsArray) splitsArray.forEach(s => { _spotCustomSplits[s.memberId] = s.owed; });
}
export function setSpotMemberIds(ids) { _spotMemberIds = ids; }
export function setAccomSplit(payerId, splitMode, splitsArray) {
  _accomPayerId = payerId;
  _accomSplitMode = splitMode || "equal";
  _accomCustomSplits = {};
  if (splitsArray) splitsArray.forEach(s => { _accomCustomSplits[s.memberId] = s.owed; });
}
export function setAccomMemberIds(ids) { _accomMemberIds = ids; }

/* ─────────────────────────────────────────────────────────────
   BUDGET (4b)
   ───────────────────────────────────────────────────────────── */
const CATEGORY_COLORS = {
  "Accommodation": "#6B7DB3",
  "Transport":     "#8999C9",
  "Transit":       "#7BB3A8",
  "Food":          "#B36B6B",
  "Experiences":   "#6BAA8D",
  "Sights & Other":"#B39E6B",
};

const CITY_PALETTE = ["#6B7DB3","#6BAA8D","#B36B6B","#B39E6B","#8999C9","#9B8DB3","#6BB3B3","#B3836B"];

/* ─────────────────────────────────────────────────────────────
   CITY TRANSIT EXPENSES
   ───────────────────────────────────────────────────────────── */
const TRANSIT_TYPES = { taxi: "🚕 Taxi", metro: "🚇 Metro", bus: "🚌 Bus", tram: "🚋 Tram", other: "✦ Other" };

export function addTransitExpense(townId, entry) {
  return updateDoc(doc(db, "trips", activeTripId, "towns", townId), { transitExpenses: arrayUnion(entry) });
}

export function deleteTransitExpense(townId, entryId) {
  const town = state.towns.find(t => t.id === townId);
  if (!town) return Promise.resolve();
  const updated = (town.transitExpenses || []).filter(e => e.id !== entryId);
  return updateDoc(doc(db, "trips", activeTripId, "towns", townId), { transitExpenses: updated });
}

export function updateTransitExpense(townId, updatedEntry) {
  const town = state.towns.find(t => t.id === townId);
  if (!town) return Promise.resolve();
  const updated = (town.transitExpenses || []).map(e => e.id === updatedEntry.id ? updatedEntry : e);
  return updateDoc(doc(db, "trips", activeTripId, "towns", townId), { transitExpenses: updated });
}

export function showTransitSheet(townId, date, existingEntry = null) {
  return new Promise(resolve => {
    const overlay   = document.getElementById("transit-overlay");
    const cityEl    = document.getElementById("transit-sheet-city");
    const amtInput  = document.getElementById("transit-amount");
    const noteInput = document.getElementById("transit-note");
    const currSel   = document.getElementById("transit-currency");
    const titleEl   = document.getElementById("transit-sheet-title");

    const town = state.towns.find(t => t.id === townId);
    cityEl.textContent = town?.name || "";
    titleEl.textContent = existingEntry ? "Edit transit expense" : "Add transit expense";

    // Pre-fill for edit, or reset for add
    amtInput.value  = existingEntry ? existingEntry.amount.toFixed(2) : "";
    noteInput.value = existingEntry?.note || "";
    populateCurrencySelect(currSel, existingEntry?.currency || town?.accommodation?.priceCurrency);

    // Reset save button
    const saveBtn = document.getElementById("transit-save");
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ${existingEntry ? "Save changes" : "Add expense"}`;

    // Split section
    const transitMembers = state.trip?.members || [];
    const transitSplitSection = document.getElementById("transit-split-section");
    if (transitMembers.length >= 2) {
      transitSplitSection.style.display = "block";
      _transitPayerId = existingEntry?.paidBy || currentUserMemberId() || null;
      _transitSplitMode = existingEntry?.splitType || "equal";
      _transitCustomSplits = {};
      if (existingEntry?.splits) existingEntry.splits.forEach(s => { _transitCustomSplits[s.memberId] = s.owed; });
      renderTransitPayerChips(transitMembers);
      overlay.querySelectorAll("#transit-split-mode-row .split-mode-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === _transitSplitMode);
      });
      const transitCustomDiv = document.getElementById("transit-custom-splits");
      transitCustomDiv.style.display = _transitSplitMode === "custom" ? "block" : "none";
      if (_transitSplitMode === "custom") renderTransitCustomSplits(transitMembers);
      overlay.querySelectorAll("#transit-split-mode-row .split-mode-btn").forEach(btn => {
        btn.onclick = () => {
          _transitSplitMode = btn.dataset.mode;
          overlay.querySelectorAll("#transit-split-mode-row .split-mode-btn").forEach(b => b.classList.toggle("active", b === btn));
          transitCustomDiv.style.display = _transitSplitMode === "custom" ? "block" : "none";
          if (_transitSplitMode === "custom") renderTransitCustomSplits(transitMembers);
        };
      });
    } else {
      transitSplitSection.style.display = "none";
    }

    // Who's travelling? (member picker)
    const transitMemberSection = document.getElementById("transit-member-section");
    if (transitMembers.length >= 2) {
      transitMemberSection.style.display = "block";
      _transitMemberIds = existingEntry?.memberIds
        ? new Set(existingEntry.memberIds)
        : new Set(transitMembers.map(m => m.id));
      renderMemberPicker("transit-member-chips", _transitMemberIds, transitMembers);
    } else {
      transitMemberSection.style.display = "none";
    }

    // Set type selection
    let selectedType = existingEntry?.type || "metro";
    overlay.querySelectorAll(".transit-type-btn").forEach(btn => {
      btn.classList.toggle("selected", btn.dataset.type === selectedType);
    });

    overlay.classList.add("open");
    cb.pushModalHistory();
    setTimeout(() => amtInput.focus(), 300);

    function close(result) {
      overlay.classList.remove("open");
      document.getElementById("transit-save").onclick   = null;
      document.getElementById("transit-cancel").onclick = null;
      overlay.onclick = null;
      overlay.querySelectorAll(".transit-type-btn").forEach(b => { b.onclick = null; });
      cb.popModalHistory();
      resolve(result);
    }

    overlay.querySelectorAll(".transit-type-btn").forEach(btn => {
      btn.onclick = () => {
        selectedType = btn.dataset.type;
        overlay.querySelectorAll(".transit-type-btn").forEach(b => b.classList.toggle("selected", b === btn));
      };
    });

    document.getElementById("transit-save").onclick = async () => {
      const amount = parseFloat(amtInput.value);
      if (!(amount > 0)) { amtInput.focus(); return; }
      const entry = {
        id: existingEntry?.id || crypto.randomUUID(),
        type: selectedType,
        amount,
        currency: currSel.value,
        note: noteInput.value.trim() || null,
        date: existingEntry?.date || date || localDateStr(new Date()),
      };
      // Attach split data
      const tMembers = state.trip?.members || [];
      if (tMembers.length >= 2 && _transitPayerId) {
        entry.paidBy = _transitPayerId;
        if (_transitSplitMode === "solo") {
          entry.splitType = "solo";
          entry.splits = tMembers.map(m => ({ memberId: m.id, owed: m.id === _transitPayerId ? amount : 0 }));
        } else if (_transitSplitMode === "custom") {
          entry.splitType = "custom";
          entry.splits = tMembers.map(m => ({ memberId: m.id, owed: _transitCustomSplits[m.id] || 0 }));
        } else {
          entry.splitType = "equal";
          entry.splits = tMembers.map(m => ({ memberId: m.id, owed: amount / tMembers.length }));
        }
      }
      // Attach memberIds (who's travelling)
      entry.memberIds = (tMembers.length >= 2 && _transitMemberIds.size > 0 && _transitMemberIds.size < tMembers.length)
        ? [..._transitMemberIds]
        : null;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      if (existingEntry) {
        await updateTransitExpense(townId, entry);
      } else {
        await addTransitExpense(townId, entry);
      }
      close(entry);
    };

    document.getElementById("transit-cancel").onclick = () => close(null);
    overlay.onclick = e => { if (e.target === overlay) close(null); };
  });
}

export function getBudgetCategory(spot) {
  const validCats = ["Accommodation","Transport","Food","Experiences","Sights & Other"];
  if (spot.category && validCats.includes(spot.category)) return spot.category;
  if (spot.type === "transport") return "Transport";
  if (spot.type === "restaurant" || spot.type === "cafe") return "Food";
  if (spot.type === "experience") return "Experiences";
  return "Sights & Other";
}

// Full list of supported currencies — used to build selects and chips
export const CURRENCY_LIST = [
  { code: "AED", symbol: "د.إ", label: "AED — UAE Dirham" },
  { code: "AUD", symbol: "A$",  label: "AUD — Australian Dollar" },
  { code: "BRL", symbol: "R$",  label: "BRL — Brazilian Real" },
  { code: "CAD", symbol: "CA$", label: "CAD — Canadian Dollar" },
  { code: "CHF", symbol: "CHF", label: "CHF — Swiss Franc" },
  { code: "CNY", symbol: "¥",   label: "CNY — Chinese Yuan" },
  { code: "CZK", symbol: "Kč",  label: "CZK — Czech Koruna" },
  { code: "DKK", symbol: "kr",  label: "DKK — Danish Krone" },
  { code: "EUR", symbol: "€",   label: "EUR — Euro" },
  { code: "GBP", symbol: "£",   label: "GBP — British Pound" },
  { code: "HKD", symbol: "HK$", label: "HKD — Hong Kong Dollar" },
  { code: "HUF", symbol: "Ft",  label: "HUF — Hungarian Forint" },
  { code: "IDR", symbol: "Rp",  label: "IDR — Indonesian Rupiah" },
  { code: "INR", symbol: "₹",   label: "INR — Indian Rupee" },
  { code: "JPY", symbol: "¥",   label: "JPY — Japanese Yen" },
  { code: "KRW", symbol: "₩",   label: "KRW — South Korean Won" },
  { code: "MXN", symbol: "$",   label: "MXN — Mexican Peso" },
  { code: "MYR", symbol: "RM",  label: "MYR — Malaysian Ringgit" },
  { code: "NOK", symbol: "kr",  label: "NOK — Norwegian Krone" },
  { code: "NZD", symbol: "NZ$", label: "NZD — New Zealand Dollar" },
  { code: "PHP", symbol: "₱",   label: "PHP — Philippine Peso" },
  { code: "PLN", symbol: "zł",  label: "PLN — Polish Złoty" },
  { code: "SAR", symbol: "ر.س", label: "SAR — Saudi Riyal" },
  { code: "SEK", symbol: "kr",  label: "SEK — Swedish Krona" },
  { code: "SGD", symbol: "S$",  label: "SGD — Singapore Dollar" },
  { code: "THB", symbol: "฿",   label: "THB — Thai Baht" },
  { code: "TRY", symbol: "₺",   label: "TRY — Turkish Lira" },
  { code: "TWD", symbol: "NT$", label: "TWD — Taiwan Dollar" },
  { code: "USD", symbol: "$",   label: "USD — US Dollar" },
  { code: "VND", symbol: "₫",   label: "VND — Vietnamese Dong" },
  { code: "ZAR", symbol: "R",   label: "ZAR — South African Rand" },
];

export function currencySymbol(code) {
  return CURRENCY_LIST.find(c => c.code === code)?.symbol || code;
}

/** All currencies configured for the active trip: home + destination */
export function getTripCurrencies() {
  const home  = state.trip?.currency || "EUR";
  const extra = state.trip?.extraCurrencies || [];
  return [home, ...extra.filter(c => c !== home)];
}

/**
 * Populate a <select> element with the trip's currencies.
 * Preserves selectedValue; falls back to the home currency.
 */
export function populateCurrencySelect(el, selectedValue) {
  if (!el) return;
  const currencies = getTripCurrencies();
  const current    = selectedValue || currencies[0];
  el.innerHTML = currencies.map(code => {
    const sym = currencySymbol(code);
    return `<option value="${code}"${code === current ? " selected" : ""}>${sym} ${code}</option>`;
  }).join("");
  // Keep pre-existing value if it isn't in the list (legacy data)
  if (current && !currencies.includes(current)) {
    el.innerHTML += `<option value="${current}" selected>${currencySymbol(current)} ${current}</option>`;
    el.value = current;
  }
}

/* ─────────────────────────────────────────────────────────────
   STANDALONE EXPENSE MODAL
   ───────────────────────────────────────────────────────────── */
let _editingExpenseId = null;
let _expEstimated     = false;
let _expPayerId       = null;
let _expSplitMode     = "equal"; // "equal" | "solo" | "custom"
let _expCustomSplits  = {};

export function renderPayerChips(members) {
  const container = document.getElementById("exp-payer-chips");
  if (!container) return;
  container.innerHTML = members.map(m => `
    <div class="payer-chip${m.id === _expPayerId ? " selected" : ""}" data-member-id="${escapeHtml(m.id)}">
      <div class="payer-chip-avatar" style="background:${escapeHtml(m.color || "#888")}">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
      ${escapeHtml(m.name)}
    </div>`).join("");
  container.querySelectorAll(".payer-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      _expPayerId = chip.dataset.memberId;
      renderPayerChips(members);
    });
  });
}

export function updateSplitTotalCheck() {
  const checkEl = document.getElementById("split-total-check");
  if (!checkEl) return;
  const totalAmount = parseFloat(document.getElementById("exp-amount").value) || 0;
  const splitTotal = Object.values(_expCustomSplits).reduce((s, v) => s + v, 0);
  const diff = Math.abs(totalAmount - splitTotal);
  if (totalAmount > 0 && diff < 0.01) {
    checkEl.textContent = "✓ Splits add up correctly";
    checkEl.style.color = "var(--accent)";
  } else if (totalAmount > 0) {
    checkEl.textContent = `Splits total ${splitTotal.toFixed(2)}, expected ${totalAmount.toFixed(2)}`;
    checkEl.style.color = "var(--danger)";
  } else {
    checkEl.textContent = "";
  }
}

export function renderCustomSplits(members) {
  const container = document.getElementById("exp-custom-splits");
  if (!container) return;
  const totalAmount = parseFloat(document.getElementById("exp-amount").value) || 0;
  const perPerson = members.length > 0 ? totalAmount / members.length : 0;
  container.innerHTML = `
    <div style="font-size:0.8125rem;color:var(--text-3);margin-bottom:8px">Custom amounts owed (${document.getElementById("exp-currency").value}):</div>
    ${members.map(m => {
      const owed = _expCustomSplits[m.id] !== undefined ? _expCustomSplits[m.id] : parseFloat(perPerson.toFixed(2));
      if (_expCustomSplits[m.id] === undefined) _expCustomSplits[m.id] = parseFloat(perPerson.toFixed(2));
      return `
        <div class="split-row">
          <div class="split-row-name">
            <div class="balance-avatar" style="background:${escapeHtml(m.color || "#888")};width:20px;height:20px;font-size:0.6rem">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
            ${escapeHtml(m.name)}
          </div>
          <input class="split-row-input" type="number" min="0" step="0.01"
            data-member-id="${escapeHtml(m.id)}" value="${owed.toFixed(2)}">
        </div>`;
    }).join("")}
    <div id="split-total-check" style="font-size:0.75rem;margin-top:8px;text-align:right"></div>`;
  container.querySelectorAll(".split-row-input").forEach(input => {
    input.addEventListener("input", () => {
      _expCustomSplits[input.dataset.memberId] = parseFloat(input.value) || 0;
      updateSplitTotalCheck();
    });
  });
  updateSplitTotalCheck();
}

/* ─────────────────────────────────────────────────────────────
   SPOT SPLIT STATE
   ───────────────────────────────────────────────────────────── */
export let _spotPayerId     = null;
export let _spotSplitMode   = "equal"; // "equal" | "solo" | "custom"
export let _spotCustomSplits = {};
export let _spotMemberIds   = new Set(); // which members are attending this spot

export let _accomPayerId     = null;
export let _accomSplitMode   = "equal";
export let _accomCustomSplits = {};
export let _accomMemberIds   = new Set(); // which members are staying

let _transitPayerId    = null;
let _transitSplitMode  = "equal";
let _transitCustomSplits = {};
let _transitMemberIds  = new Set(); // which members are travelling

export function renderSpotPayerChips(members) {
  const container = document.getElementById("spot-payer-chips");
  if (!container) return;
  container.innerHTML = members.map(m => `
    <div class="payer-chip${m.id === _spotPayerId ? " selected" : ""}" data-member-id="${escapeHtml(m.id)}">
      <div class="payer-chip-avatar" style="background:${escapeHtml(m.color || "#888")}">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
      ${escapeHtml(m.name)}
    </div>`).join("");
  container.querySelectorAll(".payer-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      _spotPayerId = chip.dataset.memberId;
      renderSpotPayerChips(members);
    });
  });
}

/* ── Shared member-picker (multi-select chips) ───────────────
   selectedIds  – live Set of selected member IDs (mutated in place)
   allMembers   – array of { id, name, color }
   All selected = normal; deselected = dimmed. At least 1 always stays selected.
   ─────────────────────────────────────────────────────────── */
export function renderMemberPicker(containerId, selectedIds, allMembers) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = allMembers.map(m => `
    <div class="payer-chip${selectedIds.has(m.id) ? " selected" : " deselected"}" data-member-id="${escapeHtml(m.id)}">
      <div class="payer-chip-avatar" style="background:${escapeHtml(m.color || "#888")}">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
      ${escapeHtml(m.name)}
    </div>`).join("");
  container.querySelectorAll(".payer-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.memberId;
      if (selectedIds.has(id)) {
        if (selectedIds.size > 1) selectedIds.delete(id); // keep at least one
      } else {
        selectedIds.add(id);
      }
      renderMemberPicker(containerId, selectedIds, allMembers);
    });
  });
}

/* ── Time-mode toggle helper (spot modal) ────────────────── */
export function applySpotTimeMode(spotTimeMode) {
  const isDur = spotTimeMode === "duration";
  document.getElementById("spot-duration").style.display  = isDur ? "" : "none";
  document.getElementById("spot-end-time").style.display  = isDur ? "none" : "";
  const lbl = document.getElementById("spot-time-mode-label");
  const btn = document.getElementById("spot-time-mode-toggle");
  if (lbl) { lbl.textContent = isDur ? "Duration (min)" : "End time"; lbl.setAttribute("for", isDur ? "spot-duration" : "spot-end-time"); }
  if (btn) btn.textContent = isDur ? "Switch to end time" : "Switch to duration";
}

export function updateSpotSplitTotalCheck() {
  const checkEl = document.getElementById("spot-split-total-check");
  if (!checkEl) return;
  const total = parseFloat(document.getElementById("spot-price").value) || 0;
  const splitTotal = Object.values(_spotCustomSplits).reduce((s, v) => s + v, 0);
  const diff = Math.abs(total - splitTotal);
  if (total > 0 && diff < 0.01) {
    checkEl.textContent = "✓ Splits add up correctly";
    checkEl.style.color = "var(--accent)";
  } else if (total > 0) {
    checkEl.textContent = `Splits total ${splitTotal.toFixed(2)}, expected ${total.toFixed(2)}`;
    checkEl.style.color = "var(--danger)";
  } else {
    checkEl.textContent = "";
  }
}

export function renderSpotCustomSplits(members) {
  const container = document.getElementById("spot-custom-splits");
  if (!container) return;
  const total     = parseFloat(document.getElementById("spot-price").value) || 0;
  const perPerson = members.length > 0 ? total / members.length : 0;
  container.innerHTML = `
    <div style="font-size:0.8125rem;color:var(--text-3);margin-bottom:8px">Custom amounts owed (${document.getElementById("spot-price-currency").value}):</div>
    ${members.map(m => {
      const owed = _spotCustomSplits[m.id] !== undefined ? _spotCustomSplits[m.id] : parseFloat(perPerson.toFixed(2));
      if (_spotCustomSplits[m.id] === undefined) _spotCustomSplits[m.id] = parseFloat(perPerson.toFixed(2));
      return `
        <div class="split-row">
          <div class="split-row-name">
            <div class="balance-avatar" style="background:${escapeHtml(m.color || "#888")};width:20px;height:20px;font-size:0.6rem">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
            ${escapeHtml(m.name)}
          </div>
          <input class="split-row-input" type="number" min="0" step="0.01"
            data-member-id="${escapeHtml(m.id)}" value="${owed.toFixed(2)}">
        </div>`;
    }).join("")}
    <div id="spot-split-total-check" style="font-size:0.75rem;margin-top:8px;text-align:right"></div>`;
  container.querySelectorAll(".split-row-input").forEach(input => {
    input.addEventListener("input", () => {
      _spotCustomSplits[input.dataset.memberId] = parseFloat(input.value) || 0;
      updateSpotSplitTotalCheck();
    });
  });
  updateSpotSplitTotalCheck();
}

export function currentUserMemberId() {
  const members = state.trip?.members || [];
  const email = state.user?.email?.toLowerCase();
  const name  = (state.user?.displayName || "").toLowerCase();
  return (
    members.find(m => m.email && m.email.toLowerCase() === email)?.id ||
    members.find(m => m.name.toLowerCase() === name)?.id ||
    members[0]?.id ||
    null
  );
}

/* ── Accom split render helpers ─────────────────────────── */
export function renderAccomPayerChips(members) {
  const container = document.getElementById("accom-payer-chips");
  if (!container) return;
  container.innerHTML = members.map(m => `
    <div class="payer-chip${m.id === _accomPayerId ? " selected" : ""}" data-member-id="${escapeHtml(m.id)}">
      <div class="payer-chip-avatar" style="background:${escapeHtml(m.color || "#888")}">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
      ${escapeHtml(m.name)}
    </div>`).join("");
  container.querySelectorAll(".payer-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      _accomPayerId = chip.dataset.memberId;
      renderAccomPayerChips(members);
    });
  });
}

export function updateAccomSplitTotalCheck() {
  const checkEl = document.getElementById("accom-split-total-check");
  if (!checkEl) return;
  const members = state.trip?.members || [];
  const total = parseFloat(document.getElementById("accom-price").value) || 0;
  const splitTotal = Object.values(_accomCustomSplits).reduce((s, v) => s + v, 0);
  const diff = Math.abs(total - splitTotal);
  if (total > 0 && diff < 0.01) {
    checkEl.textContent = "✓ Splits add up correctly";
    checkEl.style.color = "var(--accent)";
  } else if (total > 0) {
    checkEl.textContent = `Splits total ${splitTotal.toFixed(2)}, expected ${total.toFixed(2)}`;
    checkEl.style.color = "var(--danger)";
  } else {
    checkEl.textContent = "";
  }
}

export function renderAccomCustomSplits(members) {
  const container = document.getElementById("accom-custom-splits");
  if (!container) return;
  const total = parseFloat(document.getElementById("accom-price").value) || 0;
  const perPerson = members.length > 0 ? total / members.length : 0;
  const currency = document.getElementById("accom-price-currency").value;
  container.innerHTML = `
    <div style="font-size:0.8125rem;color:var(--text-3);margin-bottom:8px">Custom amounts owed (${currency}):</div>
    ${members.map(m => {
      const owed = _accomCustomSplits[m.id] !== undefined ? _accomCustomSplits[m.id] : parseFloat(perPerson.toFixed(2));
      if (_accomCustomSplits[m.id] === undefined) _accomCustomSplits[m.id] = parseFloat(perPerson.toFixed(2));
      return `
        <div class="split-row">
          <div class="split-row-name">
            <div class="balance-avatar" style="background:${escapeHtml(m.color || "#888")};width:20px;height:20px;font-size:0.6rem">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
            ${escapeHtml(m.name)}
          </div>
          <input class="split-row-input" type="number" min="0" step="0.01"
            data-member-id="${escapeHtml(m.id)}" value="${owed.toFixed(2)}">
        </div>`;
    }).join("")}
    <div id="accom-split-total-check" style="font-size:0.75rem;margin-top:8px;text-align:right"></div>`;
  container.querySelectorAll(".split-row-input").forEach(input => {
    input.addEventListener("input", () => {
      _accomCustomSplits[input.dataset.memberId] = parseFloat(input.value) || 0;
      updateAccomSplitTotalCheck();
    });
  });
  updateAccomSplitTotalCheck();
}

/* ── Transit split render helpers ───────────────────────── */
export function renderTransitPayerChips(members) {
  const container = document.getElementById("transit-payer-chips");
  if (!container) return;
  container.innerHTML = members.map(m => `
    <div class="payer-chip${m.id === _transitPayerId ? " selected" : ""}" data-member-id="${escapeHtml(m.id)}">
      <div class="payer-chip-avatar" style="background:${escapeHtml(m.color || "#888")}">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
      ${escapeHtml(m.name)}
    </div>`).join("");
  container.querySelectorAll(".payer-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      _transitPayerId = chip.dataset.memberId;
      renderTransitPayerChips(members);
    });
  });
}

export function updateTransitSplitTotalCheck() {
  const checkEl = document.getElementById("transit-split-total-check");
  if (!checkEl) return;
  const total = parseFloat(document.getElementById("transit-amount").value) || 0;
  const splitTotal = Object.values(_transitCustomSplits).reduce((s, v) => s + v, 0);
  const diff = Math.abs(total - splitTotal);
  if (total > 0 && diff < 0.01) {
    checkEl.textContent = "✓ Splits add up correctly";
    checkEl.style.color = "var(--accent)";
  } else if (total > 0) {
    checkEl.textContent = `Splits total ${splitTotal.toFixed(2)}, expected ${total.toFixed(2)}`;
    checkEl.style.color = "var(--danger)";
  } else {
    checkEl.textContent = "";
  }
}

export function renderTransitCustomSplits(members) {
  const container = document.getElementById("transit-custom-splits");
  if (!container) return;
  const total = parseFloat(document.getElementById("transit-amount").value) || 0;
  const perPerson = members.length > 0 ? total / members.length : 0;
  const currency = document.getElementById("transit-currency").value;
  container.innerHTML = `
    <div style="font-size:0.8125rem;color:var(--text-3);margin-bottom:8px">Custom amounts owed (${currency}):</div>
    ${members.map(m => {
      const owed = _transitCustomSplits[m.id] !== undefined ? _transitCustomSplits[m.id] : parseFloat(perPerson.toFixed(2));
      if (_transitCustomSplits[m.id] === undefined) _transitCustomSplits[m.id] = parseFloat(perPerson.toFixed(2));
      return `
        <div class="split-row">
          <div class="split-row-name">
            <div class="balance-avatar" style="background:${escapeHtml(m.color || "#888")};width:20px;height:20px;font-size:0.6rem">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
            ${escapeHtml(m.name)}
          </div>
          <input class="split-row-input" type="number" min="0" step="0.01"
            data-member-id="${escapeHtml(m.id)}" value="${owed.toFixed(2)}">
        </div>`;
    }).join("")}
    <div id="transit-split-total-check" style="font-size:0.75rem;margin-top:8px;text-align:right"></div>`;
  container.querySelectorAll(".split-row-input").forEach(input => {
    input.addEventListener("input", () => {
      _transitCustomSplits[input.dataset.memberId] = parseFloat(input.value) || 0;
      updateTransitSplitTotalCheck();
    });
  });
  updateTransitSplitTotalCheck();
}

export function openExpenseModal(expenseId = null) {
  _editingExpenseId = expenseId;
  _expEstimated = false;

  const existing = expenseId ? (state.expenses || []).find(e => e.id === expenseId) : null;
  const trip = state.trip;

  document.getElementById("expense-modal-title").textContent = existing ? "Edit expense" : "Add expense";
  document.getElementById("exp-save-btn").innerHTML = existing
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add expense`;
  document.getElementById("exp-delete-btn").style.display = existing ? "inline-flex" : "none";

  // Populate currency dropdown
  populateCurrencySelect(document.getElementById("exp-currency"), existing?.currency);

  // Populate category dropdown from trip
  const cats = trip?.categories || ["Food","Sights","Transport","Lodging","Shopping","Other"];
  const catSel = document.getElementById("exp-category");
  catSel.innerHTML = cats.map(c =>
    `<option value="${escapeHtml(c)}"${c === (existing?.category || "Other") ? " selected" : ""}>${escapeHtml(c)}</option>`
  ).join("");

  // Populate payment method dropdown
  const methods = trip?.paymentMethods || ["Card","Cash"];
  const paySel = document.getElementById("exp-payment");
  paySel.innerHTML = methods.map(m =>
    `<option value="${escapeHtml(m)}"${m === (existing?.paymentMethod || methods[0]) ? " selected" : ""}>${escapeHtml(m)}</option>`
  ).join("");

  // Populate city dropdown
  const townSel = document.getElementById("exp-town");
  townSel.innerHTML = `<option value="">No specific city</option>` +
    (state.towns || []).map(t =>
      `<option value="${escapeHtml(t.id)}"${t.id === existing?.townId ? " selected" : ""}>${escapeHtml(t.name)}</option>`
    ).join("");

  // Pre-fill fields
  document.getElementById("exp-description").value = existing?.description || "";
  document.getElementById("exp-amount").value = existing?.amount || "";
  document.getElementById("exp-date").value = existing?.date || new Date().toISOString().slice(0, 10);
  document.getElementById("exp-note").value = existing?.note || "";

  // Estimated toggle
  _expEstimated = existing?.isEstimated ?? false;
  document.getElementById("exp-estimated-switch").classList.toggle("on", _expEstimated);

  // Split section — only shown when trip has 2+ participants
  const members = state.trip?.members || [];
  const splitSection = document.getElementById("exp-split-section");
  if (members.length >= 2) {
    splitSection.style.display = "block";
    _expPayerId = existing?.paidBy || currentUserMemberId() || null;
    _expSplitMode = existing?.splitType || "equal";
    _expCustomSplits = {};
    if (existing?.splits) existing.splits.forEach(s => { _expCustomSplits[s.memberId] = s.owed; });
    renderPayerChips(members);
    document.querySelectorAll("#exp-split-mode-row .split-mode-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === _expSplitMode);
    });
    const customDiv = document.getElementById("exp-custom-splits");
    customDiv.style.display = _expSplitMode === "custom" ? "block" : "none";
    if (_expSplitMode === "custom") renderCustomSplits(members);
  } else {
    splitSection.style.display = "none";
  }

  document.getElementById("exp-error").style.display = "none";
  document.getElementById("expense-modal-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
  setTimeout(() => document.getElementById("exp-description").focus(), 80);
}

export function closeExpenseModal() {
  document.getElementById("expense-modal-overlay").classList.remove("visible");
  document.body.style.overflow = "";
  _editingExpenseId = null;
}

export async function saveExpense() {
  const description = document.getElementById("exp-description").value.trim();
  const amount = parseFloat(document.getElementById("exp-amount").value);
  const currency = document.getElementById("exp-currency").value;
  const category = document.getElementById("exp-category").value;
  const date = document.getElementById("exp-date").value;
  const townId = document.getElementById("exp-town").value || null;
  const paymentMethod = document.getElementById("exp-payment").value;
  const note = document.getElementById("exp-note").value.trim();
  const errEl = document.getElementById("exp-error");

  if (!description) { errEl.textContent = "Description is required."; errEl.style.display = "block"; return; }
  if (!amount || amount <= 0) { errEl.textContent = "Enter a valid amount."; errEl.style.display = "block"; return; }
  errEl.style.display = "none";

  const saveBtn = document.getElementById("exp-save-btn");
  saveBtn.disabled = true;

  const data = { description, amount, currency, category, date, townId, paymentMethod, note, isEstimated: _expEstimated };

  // Attach split data when trip has participants
  const members = state.trip?.members || [];
  if (members.length >= 2 && _expPayerId) {
    data.paidBy = _expPayerId;
    if (_expSplitMode === "solo") {
      data.splitType = "solo";
      data.splits = members.map(m => ({ memberId: m.id, owed: m.id === _expPayerId ? amount : 0 }));
    } else if (_expSplitMode === "custom") {
      data.splitType = "custom";
      data.splits = members.map(m => ({ memberId: m.id, owed: _expCustomSplits[m.id] || 0 }));
      const splitTotal = data.splits.reduce((s, x) => s + x.owed, 0);
      if (Math.abs(splitTotal - amount) > 0.05) {
        errEl.textContent = `Custom splits total ${splitTotal.toFixed(2)} but expense is ${amount.toFixed(2)} — please adjust.`;
        errEl.style.display = "block";
        saveBtn.disabled = false;
        return;
      }
    } else {
      data.splitType = "equal";
      const perPerson = amount / members.length;
      data.splits = members.map(m => ({ memberId: m.id, owed: perPerson }));
    }
  }

  try {
    if (_editingExpenseId) {
      await updateDoc(doc(db, "trips", activeTripId, "expenses", _editingExpenseId), data);
    } else {
      await addDoc(collection(db, "trips", activeTripId, "expenses"), { ...data, createdAt: serverTimestamp() });
    }
    closeExpenseModal();
  } catch (err) {
    errEl.textContent = "Failed to save — " + err.message;
    errEl.style.display = "block";
  } finally {
    saveBtn.disabled = false;
  }
}

export async function settleUp(fromMemberId, toMemberId, amount, currency) {
  const members = state.trip?.members || [];
  const fromMember = members.find(m => m.id === fromMemberId);
  const toMember   = members.find(m => m.id === toMemberId);
  if (!fromMember || !toMember || !activeTripId) return;
  currency = currency || state.trip?.currency || "EUR";
  const sym = currencySymbol(currency);
  if (!confirm(`Record that ${fromMember.name} pays ${toMember.name} ${sym}${amount.toFixed(2)}?`)) return;
  try {
    await addDoc(collection(db, "trips", activeTripId, "expenses"), {
      description: `${fromMember.name} → ${toMember.name} (settle up)`,
      amount,
      currency,
      category: "Settlement",
      date: new Date().toISOString().slice(0, 10),
      townId: null,
      paymentMethod: "",
      note: "",
      isEstimated: false,
      isSettlement: true,
      paidBy: fromMemberId,
      splitType: "custom",
      splits: [{ memberId: toMemberId, owed: amount }],
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    alert("Failed to record settlement: " + err.message);
  }
}

export async function deleteExpense(expenseId) {
  if (!expenseId || !activeTripId) return;
  // Optimistic removal so the drawer refreshes immediately
  setState({ expenses: (state.expenses || []).filter(e => e.id !== expenseId) });
  _bdEntries = _bdEntries.filter(e => !(e.source === "expense" && e.id === expenseId));
  if (document.getElementById("spot-drawer-overlay")?.classList.contains("visible") && cb.getDrawerBudgetMode()) {
    _renderBudgetDrawer();
  }
  try {
    await deleteDoc(doc(db, "trips", activeTripId, "expenses", expenseId));
  } catch (err) {
    alert("Could not delete expense: " + err.message);
  }
}

export function aggregateBudget() {
  const entries = [];
  state.spots.forEach(s => {
    if (s.price) entries.push({
      source: "spot", id: s.id, townId: s.townId,
      name: s.name, category: getBudgetCategory(s),
      amount: s.price,
      currency: s.priceCurrency || "EUR",
      isEstimated: s.priceEstimated ?? true,
      isBooked: s.booked ?? false,
      scheduledDate: s.scheduledDate || null,
      scheduledTime: s.scheduledTime || null,
      order: s.order ?? 9999,
      paidBy: s.paidBy || null,
      splitType: s.splitType || null,
      splits: s.splits || null,
    });
  });
  state.towns.forEach(t => {
    if (t.accommodation?.price) entries.push({
      source: "accommodation", id: `accom-${t.id}`, townId: t.id,
      name: t.accommodation.name || "Accommodation",
      category: "Accommodation",
      amount: t.accommodation.price,
      currency: t.accommodation.priceCurrency || "EUR",
      isEstimated: t.accommodation.priceEstimated ?? false,
      isBooked: t.accommodation.booked ?? false,
      scheduledDate: t.accommodation.checkinDate || null,
      scheduledTime: null,
      order: 9999,
      paidBy: t.accommodation.paidBy || null,
      splitType: t.accommodation.splitType || null,
      splits: t.accommodation.splits || null,
    });
    (t.transitExpenses || []).forEach(e => {
      entries.push({
        source: "transit", id: e.id, townId: t.id,
        name: (TRANSIT_TYPES[e.type] || e.type) + (e.note ? ` · ${e.note}` : ""),
        category: "Transit",
        amount: e.amount,
        currency: e.currency || "EUR",
        isEstimated: false,
        isBooked: false,
        scheduledDate: e.date || null,
        scheduledTime: null,
        order: 99998,
        paidBy: e.paidBy || null,
        splitType: e.splitType || null,
        splits: e.splits || null,
      });
    });
  });
  // Standalone expenses (manually logged, not tied to a spot)
  (state.expenses || []).forEach(e => {
    if (!e.amount) return;
    entries.push({
      source: "expense", id: e.id, townId: e.townId || null,
      name: e.description || "Expense",
      category: e.category || "Other",
      amount: e.amount,
      currency: e.currency || (state.trip?.currency || "EUR"),
      isEstimated: e.isEstimated ?? false,
      isBooked: !e.isEstimated,
      scheduledDate: e.date || null,
      scheduledTime: null,
      paymentMethod: e.paymentMethod || "",
      note: e.note || "",
      order: 99999,
      paidBy: e.paidBy || null,
      splitType: e.splitType || null,
      splits: e.splits || null,
    });
  });
  return entries;
}

/* ── Home-currency conversion helpers ───────────────────── */

// rates are stored as "X units of foreign per 1 home-currency unit"
// (fetched from open.er-api.com/v6/latest/{homeCurrency})
export function tripHomeCurrency() {
  return state.trip?.currency || "SGD";
}

export function toHomeCurrency(amount, currency) {
  const home = tripHomeCurrency();
  if (!currency || currency === home) return amount;
  const rates = state.trip?.exchangeRates;
  if (!rates) return null;
  const rate = rates[currency]; // how many units of `currency` per 1 home-currency unit
  if (!rate) return null;
  return amount / rate;
}

export async function fetchAndSaveRates(btn) {
  const home = tripHomeCurrency();
  if (btn) { btn.disabled = true; btn.textContent = "Fetching…"; }
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${home}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.result !== "success") throw new Error("API error");
    // Store rates + timestamp
    await updateDoc(doc(db, "trips", activeTripId), {
      exchangeRates: data.rates,
      exchangeRatesUpdatedAt: serverTimestamp(),
    });
    if (btn) { btn.textContent = "Updated ✓"; setTimeout(() => { if (btn) btn.textContent = "Refresh rates"; btn.disabled = false; }, 2000); }
  } catch (err) {
    console.error("Rate fetch failed:", err);
    if (btn) { btn.textContent = "Failed — retry"; btn.disabled = false; }
  }
}

export function buildTabBarHTML(entries, budgetTargets, fmt, currencyList) {
  const home    = tripHomeCurrency();
  const homeSym = currencySymbol(home);
  const rates   = state.trip?.exchangeRates || null;

  const compact = n => {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 10000)   return Math.round(n / 1000) + "k";
    if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return fmt(Math.round(n));
  };

  // Home-currency total across all entries (for "All" tab label)
  let allTotal = 0; let allConverted = true;
  entries.forEach(e => {
    if (e.currency === home) { allTotal += e.amount; }
    else if (rates && rates[e.currency]) { allTotal += e.amount / rates[e.currency]; }
    else { allConverted = false; }
  });

  const allLabel = allConverted && (rates || entries.every(e => e.currency === home))
    ? `All · ${homeSym}${compact(Math.round(allTotal))}`
    : "All";

  const tabs = [`<button class="budget-tab${_budgetTab === "all" ? " active" : ""}" data-budgettab="all">${allLabel}</button>`];
  currencyList.forEach(cur => {
    const sym   = currencySymbol(cur);
    const total = entries.filter(e => e.currency === cur).reduce((s, e) => s + e.amount, 0);
    tabs.push(`<button class="budget-tab${_budgetTab === cur ? " active" : ""}" data-budgettab="${escapeHtml(cur)}" draggable="true" data-dragcur="${escapeHtml(cur)}">${escapeHtml(cur)} · ${sym}${compact(Math.round(total))}</button>`);
  });
  return `<div class="budget-tab-bar">${tabs.join("")}</div>`;
}

export function buildAllTabHTML(entries, budgetTargets, fmt, myMemberId, myExpFilter, groupMemberFilter) {
  const home       = tripHomeCurrency();
  const homeSym    = currencySymbol(home);
  const rates      = state.trip?.exchangeRates || null;
  const homeBudget  = budgetTargets[home] || 0;
  const myHomeBudget = myMemberId ? (state.trip?.memberBudgetTargets?.[myMemberId]?.[home] || 0) : 0;
  const grpFiltered = groupMemberFilter && groupMemberFilter.size > 0;
  const hasRates    = !!(rates) || entries.every(e => e.currency === home);

  const conv = (amt, cur) => cur === home ? amt : (rates && rates[cur] ? amt / rates[cur] : null);
  const mkPct = (v, d) => d > 0 ? Math.min(Math.round(v / d * 100), 100) : 0;

  // Group totals
  let totalPaidGroup = 0, totalPlannedGroup = 0;
  entries.forEach(e => {
    const amt = getParticipantAmount(e, groupMemberFilter || new Set());
    const c   = conv(amt, e.currency);
    if (c === null) return;
    totalPlannedGroup += c;
    if (!e.isEstimated) totalPaidGroup += c;
  });

  // My portion totals
  let totalPaidMine = 0, totalPlannedMine = 0;
  if (myMemberId) {
    filterMyEntries(entries, myMemberId, myExpFilter || "all").forEach(e => {
      const amt = getMyPortionAmount(e, myMemberId);
      const c   = conv(amt, e.currency);
      if (c === null) return;
      totalPlannedMine += c;
      if (!e.isEstimated) totalPaidMine += c;
    });
  }

  const grpDenom  = homeBudget || totalPlannedGroup;
  const grpPlan   = mkPct(totalPlannedGroup, grpDenom);
  const grpPaid   = mkPct(totalPaidGroup,    grpDenom);
  const grpOver   = homeBudget > 0 && totalPlannedGroup > homeBudget;
  const grpLeft   = homeBudget ? Math.round(homeBudget - totalPlannedGroup) : null;

  const myDenom   = myHomeBudget || totalPlannedMine;
  const myPlan    = mkPct(totalPlannedMine, myDenom);
  const myPaid    = mkPct(totalPaidMine,    myDenom);
  const myOver    = myHomeBudget > 0 && totalPlannedMine > myHomeBudget;
  const myLeft    = myHomeBudget ? Math.round(myHomeBudget - totalPlannedMine) : null;

  let tsLabel = "No rates set";
  if (state.trip?.exchangeRatesUpdatedAt) {
    const d = state.trip.exchangeRatesUpdatedAt;
    const date = new Date(d.toDate ? d.toDate() : d);
    tsLabel = `Rates: ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  }

  const noRates = `<p style="font-size:0.8125rem;color:var(--text-3);margin:6px 0 0">Set exchange rates to calculate totals.</p>`;

  const myColHTML = myMemberId ? `
    <div class="budget-all-col budget-col-mine">
      <div class="budget-col-label">My Portion</div>
      ${hasRates ? `
        <div class="budget-all-total">${homeSym}${fmt(Math.round(totalPaidMine))}</div>
        <div class="budget-all-subtext">paid · ${homeSym}${fmt(Math.round(totalPlannedMine))} planned${myLeft !== null ? ` · <span style="color:${myOver?"var(--danger)":"var(--text-3)"}">${myOver ? homeSym+fmt(-myLeft)+" over" : homeSym+fmt(myLeft)+" left"}</span>` : ""}</div>
        ${myDenom > 0 ? `
          <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${myPlan}%;opacity:0.4;background:var(--accent)"></div></div>
          <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${myPaid}%;background:${myOver?"var(--danger)":"var(--success)"}"></div></div>` : ""}
        <div class="budget-inline-target">
          <span class="budget-inline-target-label">My budget</span>
          <input class="form-input" id="my-budget-target-${home}" type="number" min="0" step="500"
            placeholder="e.g. 3000" value="${myHomeBudget || ""}">
          <button class="btn-ghost" data-my-budget-save="${home}">Set</button>
        </div>` : noRates}
    </div>` : "";

  const grpColHTML = `
    <div class="budget-all-col">
      <div class="budget-col-label">Group${grpFiltered ? `<span style="font-size:0.6875rem;font-weight:400;color:var(--accent);margin-left:4px;text-transform:none;letter-spacing:0">· filtered</span>` : ""}</div>
      ${hasRates ? `
        <div class="budget-all-total">${homeSym}${fmt(Math.round(totalPaidGroup))}</div>
        <div class="budget-all-subtext">paid · ${homeSym}${fmt(Math.round(totalPlannedGroup))} planned${!grpFiltered && grpLeft !== null ? ` · <span style="color:${grpOver?"var(--danger)":"var(--text-3)"}">${grpOver ? homeSym+fmt(-grpLeft)+" over" : homeSym+fmt(grpLeft)+" left"}</span>` : ""}</div>
        ${!grpFiltered && grpDenom > 0 ? `
          <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${grpPlan}%;opacity:0.4;background:var(--accent)"></div></div>
          <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${grpPaid}%;background:${grpOver?"var(--danger)":"var(--success)"}"></div></div>` : ""}
        <div class="budget-inline-target">
          <span class="budget-inline-target-label">Group budget</span>
          <input class="form-input" id="budget-target-${home}" type="number" min="0" step="500"
            placeholder="e.g. 12000" value="${homeBudget || ""}">
          <button class="btn-ghost" data-budget-save="${home}">Set</button>
        </div>` : noRates}
    </div>`;

  return `
    <div class="budget-all-panel">
      ${myMemberId ? myColHTML : ""}
      ${grpColHTML}
      <div class="budget-timeline-section">
        <div class="budget-timeline-label">Spending over time · ${home}</div>
        <div class="budget-timeline-block" id="budget-timeline-block">
          <canvas id="budget-timeline-chart"></canvas>
        </div>
      </div>
      <div class="budget-rates-footer" style="grid-column:1/-1">
        <span>${tsLabel}</span>
        <button class="budget-sgd-refresh" id="budget-refresh-rates-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="10" height="10"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          Refresh rates
        </button>
      </div>
    </div>`;
}

export function buildCurrencyTabHTML(cur, ces, budgetTargets, fmt, myMemberId) {
  const sym        = currencySymbol(cur);
  const grpFiltered = _groupMemberFilter.size > 0;
  const getGrpAmt  = e => getParticipantAmount(e, _groupMemberFilter);
  const mkPct      = (v, d) => d > 0 ? Math.min(Math.round(v / d * 100), 100) : 0;

  const totalActual  = ces.filter(e => !e.isEstimated).reduce((s, e) => s + e.amount, 0);
  const totalPlanned = ces.reduce((s, e) => s + e.amount, 0);
  const grpBudget    = budgetTargets[cur] || 0;
  const grpDenom     = grpBudget || totalPlanned;
  const dispActual   = grpFiltered ? ces.filter(e => !e.isEstimated).reduce((s, e) => s + getGrpAmt(e), 0) : totalActual;
  const dispPlanned  = grpFiltered ? ces.reduce((s, e) => s + getGrpAmt(e), 0) : totalPlanned;
  const grpPctActual  = mkPct(dispActual,  grpDenom);
  const grpPctPlan    = mkPct(dispPlanned, grpDenom);
  const grpOver       = grpBudget > 0 && totalPlanned > grpBudget;
  const grpLeft       = grpBudget ? Math.round(grpBudget - totalPlanned) : null;

  let myColHTML = "";
  if (myMemberId) {
    const myCes          = filterMyEntries(ces, myMemberId, _myExpFilter);
    const myTotalActual  = myCes.filter(e => !e.isEstimated).reduce((s, e) => s + getMyPortionAmount(e, myMemberId), 0);
    const myTotalPlanned = myCes.reduce((s, e) => s + getMyPortionAmount(e, myMemberId), 0);
    const myBudget       = state.trip?.memberBudgetTargets?.[myMemberId]?.[cur] || 0;
    const myDenom        = myBudget || myTotalPlanned;
    const myPctActual    = mkPct(myTotalActual,  myDenom);
    const myPctPlan      = mkPct(myTotalPlanned, myDenom);
    const myOver         = myBudget > 0 && myTotalPlanned > myBudget;
    const myLeft         = myBudget ? Math.round(myBudget - myTotalPlanned) : null;

    myColHTML = `
      <div class="budget-currency-col budget-col-mine">
        <div class="budget-col-label">My Portion</div>
        <div class="budget-all-total">${sym}${fmt(myTotalActual)}</div>
        <div class="budget-all-subtext">paid · ${sym}${fmt(myTotalPlanned)} planned${myLeft !== null ? ` · <span style="color:${myOver?"var(--danger)":"var(--text-3)"}">${myOver ? sym+fmt(-myLeft)+" over" : sym+fmt(myLeft)+" left"}</span>` : ""}</div>
        ${myDenom > 0 ? `
          <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${myPctPlan}%;opacity:0.4;background:var(--accent)"></div></div>
          <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${myPctActual}%;background:${myOver?"var(--danger)":"var(--success)"}"></div></div>` : ""}
        <div class="budget-inline-target">
          <span class="budget-inline-target-label">My budget</span>
          <input class="form-input" id="my-budget-target-${escapeHtml(cur)}" type="number" min="0" step="100"
            placeholder="e.g. 1500" value="${myBudget || ""}">
          <button class="btn-ghost" data-my-budget-save="${escapeHtml(cur)}">Set</button>
        </div>
        <div class="budget-charts-row" style="margin-top:14px">
          <div class="budget-chart-block">
            <div class="budget-chart-label">By city</div>
            <canvas id="budget-chart-${escapeHtml(cur)}-city-mine"></canvas>
          </div>
          <div class="budget-chart-block">
            <div class="budget-chart-label">By category</div>
            <canvas id="budget-chart-${escapeHtml(cur)}-cat-mine"></canvas>
          </div>
        </div>
      </div>`;
  }

  const grpColHTML = `
    <div class="budget-currency-col">
      <div class="budget-col-label">Group${grpFiltered ? `<span style="font-size:0.6875rem;font-weight:400;color:var(--accent);margin-left:4px;text-transform:none;letter-spacing:0">· filtered</span>` : ""}</div>
      <div class="budget-all-total">${sym}${fmt(dispActual)}</div>
      <div class="budget-all-subtext">paid · ${sym}${fmt(dispPlanned)} planned${!grpFiltered && grpLeft !== null ? ` · <span style="color:${grpOver?"var(--danger)":"var(--text-3)"}">${grpOver ? sym+fmt(-grpLeft)+" over" : sym+fmt(grpLeft)+" left"}</span>` : ""}</div>
      ${!grpFiltered && grpDenom > 0 ? `
        <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${grpPctPlan}%;opacity:0.4;background:var(--accent)"></div></div>
        <div class="budget-compact-progress"><div class="budget-compact-progress-fill" style="width:${grpPctActual}%;background:${grpOver?"var(--danger)":"var(--success)"}"></div></div>` : ""}
      <div class="budget-inline-target">
        <span class="budget-inline-target-label">Group budget</span>
        <input class="form-input" id="budget-target-${escapeHtml(cur)}" type="number" min="0" step="100"
          placeholder="e.g. 3000" value="${grpBudget || ""}">
        <button class="btn-ghost" data-budget-save="${escapeHtml(cur)}">Set</button>
      </div>
      <div class="budget-charts-row" style="margin-top:14px">
        <div class="budget-chart-block">
          <div class="budget-chart-label">By city</div>
          <canvas id="budget-chart-${escapeHtml(cur)}-city"></canvas>
        </div>
        <div class="budget-chart-block">
          <div class="budget-chart-label">By category</div>
          <canvas id="budget-chart-${escapeHtml(cur)}-cat"></canvas>
        </div>
      </div>
    </div>`;

  return `
    <div class="budget-currency-panel">
      ${myMemberId ? myColHTML : ""}
      ${grpColHTML}
    </div>`;
}

function calculateGroupBalances() {
  const members = state.trip?.members;
  if (!members || members.length < 2) return {};

  const splitItems = [
    ...(state.expenses || [])
      .filter(e => e.paidBy && e.splits?.length)
      .map(e => ({ currency: e.currency || state.trip?.currency || "EUR", amount: e.amount || 0, paidBy: e.paidBy, splits: e.splits })),
    ...(state.spots || [])
      .filter(s => s.paidBy && s.splits?.length && s.price)
      .map(s => ({ currency: s.priceCurrency || state.trip?.currency || "EUR", amount: s.price || 0, paidBy: s.paidBy, splits: s.splits })),
    ...(state.towns || [])
      .filter(t => t.accommodation?.paidBy && t.accommodation?.splits?.length && t.accommodation?.price)
      .map(t => ({ currency: t.accommodation.priceCurrency || state.trip?.currency || "EUR", amount: t.accommodation.price || 0, paidBy: t.accommodation.paidBy, splits: t.accommodation.splits })),
    ...(state.towns || []).flatMap(t =>
      (t.transitExpenses || [])
        .filter(e => e.paidBy && e.splits?.length)
        .map(e => ({ currency: e.currency || state.trip?.currency || "EUR", amount: e.amount || 0, paidBy: e.paidBy, splits: e.splits }))
    ),
  ];

  const netByCurrency = {};
  splitItems.forEach(exp => {
    const cur = exp.currency;
    if (!netByCurrency[cur]) {
      const obj = {};
      members.forEach(m => { obj[m.id] = 0; });
      netByCurrency[cur] = obj;
    }
    const net = netByCurrency[cur];
    if (!(exp.paidBy in net)) return;
    net[exp.paidBy] += exp.amount || 0;
    (exp.splits || []).forEach(s => { if (s.memberId in net) net[s.memberId] -= s.owed; });
  });
  const result = {};
  Object.entries(netByCurrency).forEach(([cur, net]) => {
    const creditors = members
      .filter(m => net[m.id] > 0.005)
      .map(m => ({ ...m, bal: net[m.id] }))
      .sort((a, b) => b.bal - a.bal);
    const debtors = members
      .filter(m => net[m.id] < -0.005)
      .map(m => ({ ...m, bal: -net[m.id] }))
      .sort((a, b) => b.bal - a.bal);
    const txns = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const c = creditors[ci], d = debtors[di];
      const transfer = Math.min(c.bal, d.bal);
      txns.push({ from: d, to: c, amount: transfer, currency: cur });
      c.bal -= transfer; d.bal -= transfer;
      if (c.bal < 0.005) ci++;
      if (d.bal < 0.005) di++;
    }
    if (txns.length) result[cur] = txns;
  });
  return result;
}

function renderGroupBalances() {
  const members = state.trip?.members;
  if (!members || members.length < 2) return "";
  const hasSplitItems =
    (state.expenses || []).some(e => e.paidBy && e.splits?.length) ||
    (state.spots   || []).some(s => s.paidBy && s.splits?.length && s.price) ||
    (state.towns   || []).some(t => t.accommodation?.paidBy && t.accommodation?.splits?.length) ||
    (state.towns   || []).some(t => (t.transitExpenses || []).some(e => e.paidBy && e.splits?.length));
  if (!hasSplitItems) return `
    <div class="group-balances-card">
      <div class="group-balances-heading">Group Balances</div>
      <p style="font-size:0.875rem;color:var(--text-3);margin:0">No split expenses yet — add an expense and assign a payer.</p>
    </div>`;
  const balances = calculateGroupBalances();
  const homeCurrency = state.trip?.currency || "EUR";
  const currencies = Object.keys(balances).sort((a, b) => {
    if (a === homeCurrency) return -1; if (b === homeCurrency) return 1;
    return a.localeCompare(b);
  });
  if (!currencies.length) return `
    <div class="group-balances-card">
      <div class="group-balances-heading">Group Balances</div>
      <p style="font-size:0.875rem;color:var(--text-3);margin:0">All settled up! ✓</p>
    </div>`;
  const fmt = n => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let rowsHTML = "";
  currencies.forEach(cur => {
    const sym = currencySymbol(cur);
    (balances[cur] || []).forEach(t => {
      rowsHTML += `
        <div class="balance-row">
          <div class="balance-from">
            <div class="balance-avatar" style="background:${escapeHtml(t.from.color || "#888")}">${escapeHtml(t.from.name.charAt(0).toUpperCase())}</div>
            <span>${escapeHtml(t.from.name)}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="color:var(--text-3);flex-shrink:0"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <div class="balance-avatar" style="background:${escapeHtml(t.to.color || "#888")}">${escapeHtml(t.to.name.charAt(0).toUpperCase())}</div>
            <span>${escapeHtml(t.to.name)}</span>
          </div>
          <span class="balance-amount">${sym}${fmt(t.amount)}</span>
          <button class="balance-settle-btn"
            data-from="${escapeHtml(t.from.id)}"
            data-to="${escapeHtml(t.to.id)}"
            data-amount="${t.amount}"
            data-currency="${escapeHtml(cur)}">Settle up</button>
        </div>`;
    });
  });
  return `
    <div class="group-balances-card" id="group-balances-card">
      <div class="group-balances-heading">Group Balances</div>
      ${rowsHTML}
    </div>`;
}

export function buildSettleUpHTML() {
  const members = state.trip?.members;
  if (!members || members.length < 2) return "";
  const hasSplitItems =
    (state.expenses || []).some(e => e.paidBy && e.splits?.length) ||
    (state.spots   || []).some(s => s.paidBy && s.splits?.length && s.price) ||
    (state.towns   || []).some(t => t.accommodation?.paidBy && t.accommodation?.splits?.length) ||
    (state.towns   || []).some(t => (t.transitExpenses || []).some(e => e.paidBy && e.splits?.length));
  if (!hasSplitItems) return "";

  const balances  = calculateGroupBalances();
  const homeCur   = state.trip?.currency || "EUR";
  const currencies = Object.keys(balances).sort((a, b) => {
    if (a === homeCur) return -1; if (b === homeCur) return 1;
    return a.localeCompare(b);
  });
  const fmtB = n => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let totalTxns = 0;
  let rowsHTML = "";
  if (!currencies.length) {
    rowsHTML = `<p style="font-size:0.875rem;color:var(--text-3);margin:0">All settled up ✓</p>`;
  } else {
    currencies.forEach(cur => {
      const sym = currencySymbol(cur);
      (balances[cur] || []).forEach(t => {
        totalTxns++;
        rowsHTML += `
          <div class="balance-row">
            <div class="balance-from">
              <div class="balance-avatar" style="background:${escapeHtml(t.from.color||"#888")}">${escapeHtml(t.from.name.charAt(0).toUpperCase())}</div>
              <span>${escapeHtml(t.from.name)}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="color:var(--text-3);flex-shrink:0"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              <div class="balance-avatar" style="background:${escapeHtml(t.to.color||"#888")}">${escapeHtml(t.to.name.charAt(0).toUpperCase())}</div>
              <span>${escapeHtml(t.to.name)}</span>
            </div>
            <span class="balance-amount">${sym}${fmtB(t.amount)}</span>
            <button class="balance-settle-btn"
              data-from="${escapeHtml(t.from.id)}" data-to="${escapeHtml(t.to.id)}"
              data-amount="${t.amount}" data-currency="${escapeHtml(cur)}">Settle up</button>
          </div>`;
      });
    });
  }

  const countLabel = totalTxns > 0
    ? `${totalTxns} transfer${totalTxns !== 1 ? "s" : ""}`
    : "All settled up ✓";

  return `
    <div class="budget-settleup-section" id="budget-settleup-section">
      <div class="budget-settleup-header">
        <span class="budget-settleup-title">Settle up</span>
        <span class="budget-settleup-count">${countLabel}</span>
        <svg class="budget-settleup-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="18 15 12 9 6 15"/></svg>
      </div>
      <div class="budget-settleup-body">${rowsHTML}</div>
    </div>`;
}



let budgetChartInstances = {};

let _chartJsPromise = null;
export function loadChartJs() {
  if (typeof Chart !== "undefined") return Promise.resolve();
  if (_chartJsPromise) return _chartJsPromise;
  _chartJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _chartJsPromise;
}

/* ─────────────────────────────────────────────────────────────
   EXPENSES TAB
   ───────────────────────────────────────────────────────────── */
let _expTabSort    = "date";
let _expTabDir     = "desc";
let _expTabCatFilter  = new Set();
let _expTabCityFilter = new Set();
let _expTabPersonFilter = null; // null | "paid" | "owe"
let _expFiltersOpen    = false; // is filter panel expanded?
let _expSelectionMode  = false; // are rows in multi-select mode?
let _expSelectedIds    = new Set(); // ids of selected expense entries
let _bulkStatusValue   = "keep"; // "keep" | "paid" | "estimated"

const SOURCE_COLORS = {
  spot:          "#6BAA8D",
  accommodation: "#6B7DB3",
  transit:       "#7BB3A8",
  expense:       "#B39E6B",
};
const SOURCE_LABELS = {
  spot:          "Spot",
  accommodation: "Accom",
  transit:       "Transit",
  expense:       "Expense",
};

export function renderExpenses() {
  const content = document.getElementById("expenses-content");
  if (!content) return;

  const fmt2 = n => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const myMemberId = currentUserMemberId();

  // Full unfiltered list for building pill options
  const allEntries = aggregateBudget();
  const categories = [...new Set(allEntries.map(e => e.category))].sort();
  const cities = [...new Set(
    allEntries.map(e => state.towns.find(t => t.id === e.townId)?.name || "Other")
  )].sort();

  // Build filtered + sorted entries
  let entries = allEntries.slice();

  if (_expTabPersonFilter === "paid" && myMemberId) {
    entries = entries.filter(e => e.paidBy === myMemberId);
  } else if (_expTabPersonFilter === "owe" && myMemberId) {
    entries = entries.filter(e =>
      e.paidBy && e.paidBy !== myMemberId &&
      (e.splits || []).some(s => s.memberId === myMemberId && s.owed > 0.005)
    );
  }
  if (_expTabCatFilter.size > 0) {
    entries = entries.filter(e => _expTabCatFilter.has(e.category));
  }
  if (_expTabCityFilter.size > 0) {
    entries = entries.filter(e => {
      const city = state.towns.find(t => t.id === e.townId)?.name || "Other";
      return _expTabCityFilter.has(city);
    });
  }

  // Sort
  entries.sort((a, b) => {
    if (_expTabSort === "value") {
      return _expTabDir === "desc" ? b.amount - a.amount : a.amount - b.amount;
    }
    // date sort: undated goes to bottom
    const aKey = (a.scheduledDate || "0000-00-00") + "T" + (a.scheduledTime || "00:00") + String(a.order ?? 9999).padStart(6, "0");
    const bKey = (b.scheduledDate || "0000-00-00") + "T" + (b.scheduledTime || "00:00") + String(b.order ?? 9999).padStart(6, "0");
    return _expTabDir === "desc" ? bKey.localeCompare(aKey) : aKey.localeCompare(bKey);
  });

  const hasActiveFilter = _expTabCatFilter.size + _expTabCityFilter.size > 0 || _expTabPersonFilter;
  const filterCount = _expTabCatFilter.size + _expTabCityFilter.size + (_expTabPersonFilter ? 1 : 0);

  // Totals
  const totalByCur = {};
  entries.forEach(e => { totalByCur[e.currency] = (totalByCur[e.currency] || 0) + e.amount; });
  const totalStr = Object.entries(totalByCur)
    .map(([c, a]) => `${currencySymbol(c)}${fmt2(a)}`).join(" · ");

  const controlsHTML = `
    <div class="exp-controls">
      <div class="exp-toolbar">
        <div class="exp-toolbar-sort">
          <span class="exp-sort-label">Sort</span>
          <button class="exp-sort-btn${_expTabSort === "date"  ? " active" : ""}" data-expsort="date">Date${_expTabSort === "date"  ? (_expTabDir === "desc" ? " ↓" : " ↑") : ""}</button>
          <button class="exp-sort-btn${_expTabSort === "value" ? " active" : ""}" data-expsort="value">Amount${_expTabSort === "value" ? (_expTabDir === "desc" ? " ↓" : " ↑") : ""}</button>
        </div>
        <button class="exp-filter-toggle${_expFiltersOpen || filterCount > 0 ? " active" : ""}" id="exp-filter-toggle-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          Filters${filterCount > 0 ? ` <span class="exp-filter-badge">${filterCount}</span>` : ""}
        </button>
        <button class="exp-select-toggle${_expSelectionMode ? " active" : ""}" id="exp-select-toggle-btn" title="Select multiple expenses to edit together">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><rect x="3" y="5" width="4" height="4" rx="1"/><line x1="10" y1="7" x2="21" y2="7"/><rect x="3" y="11" width="4" height="4" rx="1"/><line x1="10" y1="13" x2="21" y2="13"/><rect x="3" y="17" width="4" height="4" rx="1"/><line x1="10" y1="19" x2="21" y2="19"/></svg>
          Select
        </button>
      </div>
      ${_expFiltersOpen ? `
      <div class="exp-filter-panel">
        ${myMemberId ? `
        <div class="exp-filter-section">
          <div class="exp-filter-section-label">Mine</div>
          <div class="exp-filter-pills">
            <button class="exp-filter-pill${!_expTabPersonFilter ? " active" : ""}" data-expperson="">All</button>
            <button class="exp-filter-pill${_expTabPersonFilter === "paid" ? " active" : ""}" data-expperson="paid">I paid</button>
            <button class="exp-filter-pill${_expTabPersonFilter === "owe"  ? " active" : ""}" data-expperson="owe">I owe</button>
          </div>
        </div>` : ""}
        ${categories.length > 0 ? `
        <div class="exp-filter-section">
          <div class="exp-filter-section-label">Category</div>
          <div class="exp-filter-pills">
            ${categories.map(c => `<button class="exp-filter-pill${_expTabCatFilter.has(c) ? " active" : ""}" data-expcat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
          </div>
        </div>` : ""}
        ${cities.length > 1 ? `
        <div class="exp-filter-section">
          <div class="exp-filter-section-label">City</div>
          <div class="exp-filter-pills">
            ${cities.map(c => `<button class="exp-filter-pill${_expTabCityFilter.has(c) ? " active" : ""}" data-expcity="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
          </div>
        </div>` : ""}
        ${hasActiveFilter ? `<button class="exp-clear-btn" id="exp-clear-filters-btn">Clear all</button>` : ""}
      </div>` : ""}
    </div>`;

  const summaryHTML = entries.length > 0 ? `
    <div class="exp-summary">${entries.length} expense${entries.length !== 1 ? "s" : ""}${totalStr ? " · " + totalStr : ""}</div>` : "";

  const listHTML = entries.length === 0
    ? `<p class="exp-empty">No expenses match the current filters.</p>`
    : entries.map(e => {
        const town   = state.towns.find(t => t.id === e.townId);
        const members = state.trip?.members || [];
        const payer  = e.paidBy ? members.find(m => m.id === e.paidBy) : null;
        const myOwed = myMemberId
          ? (e.splits || []).find(s => s.memberId === myMemberId)?.owed
          : undefined;
        const dateStr = e.scheduledDate
          ? new Date(e.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
          : "";
        const estBadge = e.isEstimated ? `<span class="exp-est-badge">est.</span>` : "";
        const payerLine = payer
          ? `<div class="exp-row-payer">Paid by ${escapeHtml(payer.name)}${myOwed != null && myOwed > 0 ? ` · My share: ${currencySymbol(e.currency)}${fmt2(myOwed)}` : ""}</div>`
          : "";
        const cityName = town ? escapeHtml(town.name) : "";
        const catColor = CATEGORY_COLORS[e.category] || "#888";
        const srcLabel = SOURCE_LABELS[e.source] || e.source;
        const isSelectable = e.source === "expense"; // only manual expenses support bulk-edit
        const isSelected   = _expSelectionMode && isSelectable && _expSelectedIds.has(e.id);
        const cbCell = _expSelectionMode
          ? `<div class="exp-col-cb">${isSelectable
              ? `<input type="checkbox" class="exp-row-cb"${isSelected ? " checked" : ""}>`
              : ""}</div>`
          : "";

        return `
          <div class="exp-row${_expSelectionMode ? " selecting" : ""}${isSelected ? " exp-selected" : ""}"${isSelectable && _expSelectionMode ? ` data-selid="${escapeHtml(e.id)}"` : ""}>
            ${cbCell}
            <div class="exp-col-date">${dateStr || "—"}</div>
            <div class="exp-col-name">
              <div class="exp-row-name">${escapeHtml(e.name)}${estBadge}</div>
              ${payerLine}
              <div class="exp-row-meta-mobile">
                ${dateStr ? `<span class="exp-meta-chip">${dateStr}</span>` : ""}
                <span class="exp-cat-badge" style="background:${catColor}">${escapeHtml(e.category)}</span>
                ${cityName ? `<span class="exp-meta-chip">${cityName}</span>` : ""}
                <span class="exp-source-badge">${srcLabel}</span>
              </div>
            </div>
            <div class="exp-col-chip"><span class="exp-cat-badge" style="background:${catColor}">${escapeHtml(e.category)}</span></div>
            <div class="exp-col-chip">${cityName || "—"}</div>
            <div class="exp-col-source">
              <span class="exp-source-badge">${srcLabel}</span>
            </div>
            <div class="exp-col-right">
              <div class="exp-row-amount">${currencySymbol(e.currency)}${fmt2(e.amount)}</div>
              ${!_expSelectionMode ? `<button class="exp-edit-btn"
                data-expsource="${escapeHtml(e.source)}"
                data-expid="${escapeHtml(e.id)}"
                data-exptownid="${escapeHtml(e.townId || "")}"
                aria-label="Edit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>` : ""}
            </div>
          </div>`;
      }).join("");

  content.innerHTML = controlsHTML + summaryHTML + listHTML;

  // Filter panel toggle
  content.querySelector("#exp-filter-toggle-btn")?.addEventListener("click", () => {
    _expFiltersOpen = !_expFiltersOpen;
    renderExpenses();
  });

  // Select-mode toggle
  content.querySelector("#exp-select-toggle-btn")?.addEventListener("click", () => {
    _expSelectionMode = !_expSelectionMode;
    if (!_expSelectionMode) _expSelectedIds.clear();
    renderExpenses();
  });

  // Row click in selection mode → toggle selection
  content.querySelectorAll(".exp-row[data-selid]").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.dataset.selid;
      if (_expSelectedIds.has(id)) _expSelectedIds.delete(id);
      else _expSelectedIds.add(id);
      // Lightweight in-place update (avoid full re-render to keep scroll position)
      row.classList.toggle("exp-selected", _expSelectedIds.has(id));
      const cb = row.querySelector(".exp-row-cb");
      if (cb) cb.checked = _expSelectedIds.has(id);
      _updateExpSelectionBar();
    });
  });

  _updateExpSelectionBar();

  // Sort buttons
  content.querySelectorAll(".exp-sort-btn[data-expsort]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.expsort === _expTabSort) {
        _expTabDir = _expTabDir === "desc" ? "asc" : "desc";
      } else {
        _expTabSort = btn.dataset.expsort;
        _expTabDir  = "desc";
      }
      renderExpenses();
    });
  });

  // Mine pills (inside filter panel)
  content.querySelectorAll(".exp-filter-pill[data-expperson]").forEach(btn => {
    btn.addEventListener("click", () => {
      _expTabPersonFilter = btn.dataset.expperson || null;
      renderExpenses();
    });
  });

  // Category filter pills
  content.querySelectorAll(".exp-filter-pill[data-expcat]").forEach(pill => {
    pill.addEventListener("click", () => {
      const c = pill.dataset.expcat;
      if (_expTabCatFilter.has(c)) _expTabCatFilter.delete(c);
      else _expTabCatFilter.add(c);
      renderExpenses();
    });
  });

  // City filter pills
  content.querySelectorAll(".exp-filter-pill[data-expcity]").forEach(pill => {
    pill.addEventListener("click", () => {
      const c = pill.dataset.expcity;
      if (_expTabCityFilter.has(c)) _expTabCityFilter.delete(c);
      else _expTabCityFilter.add(c);
      renderExpenses();
    });
  });

  // Clear all filters
  content.querySelector("#exp-clear-filters-btn")?.addEventListener("click", () => {
    _expTabCatFilter.clear();
    _expTabCityFilter.clear();
    _expTabPersonFilter = null;
    renderExpenses();
  });

  // Edit buttons
  content.querySelectorAll(".exp-edit-btn[data-expsource]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { expsource: source, expid: id, exptownid: townId } = btn.dataset;
      if (source === "expense") {
        openExpenseModal(id);
      } else if (source === "spot") {
        const spot = state.spots.find(s => s.id === id);
        if (spot) openModal(spot);
      } else if (source === "accommodation") {
        const town = state.towns.find(t => t.id === townId);
        if (town) openAccomModal(town);
      } else if (source === "transit") {
        const town = state.towns.find(t => t.id === townId);
        const entry = (town?.transitExpenses || []).find(e => e.id === id);
        if (entry) await showTransitSheet(townId, entry.date, entry);
      }
    });
  });
}

/* ── Bulk expense selection helpers ────────────────────────── */

function _updateExpSelectionBar() {
  const bar = document.getElementById("exp-selection-bar");
  if (!bar) return;
  const n = _expSelectedIds.size;
  bar.style.display = _expSelectionMode ? "flex" : "none";
  const numEl = document.getElementById("exp-sel-count-num");
  if (numEl) numEl.textContent = n;
  const editBtn = document.getElementById("exp-sel-edit-btn");
  if (editBtn) {
    editBtn.textContent = n > 0 ? `Edit ${n} expense${n !== 1 ? "s" : ""}` : "Edit selected";
    editBtn.disabled = n === 0;
  }
}

export function openBulkExpenseModal() {
  const trip = state.trip;
  const cats    = trip?.categories    || ["Food","Sights","Transport","Lodging","Shopping","Other"];
  const methods = trip?.paymentMethods || ["Card","Cash"];
  const towns   = state.towns || [];

  document.getElementById("bulk-exp-category").innerHTML =
    `<option value="">— keep —</option>` +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  document.getElementById("bulk-exp-town").innerHTML =
    `<option value="__keep__">— keep —</option>` +
    `<option value="">No specific city</option>` +
    towns.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");

  document.getElementById("bulk-exp-payment").innerHTML =
    `<option value="">— keep —</option>` +
    methods.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  document.getElementById("bulk-exp-date").value = "";

  _bulkStatusValue = "keep";
  document.querySelectorAll(".bulk-status-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.bulkStatus === "keep")
  );

  const n = _expSelectedIds.size;
  document.getElementById("bulk-modal-title").textContent =
    `Edit ${n} expense${n !== 1 ? "s" : ""}`;

  const errEl = document.getElementById("bulk-exp-error");
  if (errEl) errEl.style.display = "none";

  document.getElementById("bulk-expense-overlay").classList.add("visible");
}

export function closeBulkExpenseModal() {
  document.getElementById("bulk-expense-overlay")?.classList.remove("visible");
}

export async function saveBulkExpenses() {
  const ids = [..._expSelectedIds];
  if (!ids.length || !activeTripId) return;

  const category  = document.getElementById("bulk-exp-category").value;
  const townRaw   = document.getElementById("bulk-exp-town").value;
  const date      = document.getElementById("bulk-exp-date").value;
  const payMethod = document.getElementById("bulk-exp-payment").value;

  // Build updates — only include fields the user actually changed
  const updates = {};
  if (category)               updates.category      = category;
  if (townRaw !== "__keep__")  updates.townId        = townRaw; // "" = no city
  if (date)                   updates.date          = date;
  if (payMethod)              updates.paymentMethod = payMethod;
  if (_bulkStatusValue !== "keep") updates.isEstimated = _bulkStatusValue === "estimated";

  const errEl   = document.getElementById("bulk-exp-error");
  const saveBtn = document.getElementById("bulk-exp-save");

  if (!Object.keys(updates).length) {
    if (errEl) { errEl.textContent = "No changes selected — adjust at least one field."; errEl.style.display = "block"; }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  try {
    const batch = writeBatch(db);
    ids.forEach(id => {
      batch.update(doc(db, "trips", activeTripId, "expenses", id), updates);
    });
    await batch.commit();
    closeBulkExpenseModal();
    _expSelectedIds.clear();
    _expSelectionMode = false;
    renderExpenses();
  } catch (err) {
    console.error("Bulk save failed:", err);
    if (errEl) { errEl.textContent = "Save failed — please try again."; errEl.style.display = "block"; }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export function renderBudget() {
  const entries = aggregateBudget();
  const fmt = n => n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const content = document.getElementById("budget-content");
  if (!content) return;

  if (entries.length === 0) {
    Object.values(budgetChartInstances).forEach(c => c.destroy());
    budgetChartInstances = {};
    content.innerHTML = `<p style="color:var(--text-3);font-size:0.9375rem;padding:8px 0">No prices added yet — edit any spot and enter a price to start tracking your budget.</p>`
      + buildSettleUpHTML();
    _wireSettleUp(content);
    return;
  }

  // Group by currency; home currency first then alphabetical
  const byCurrency = {};
  entries.forEach(e => {
    if (!byCurrency[e.currency]) byCurrency[e.currency] = [];
    byCurrency[e.currency].push(e);
  });
  const home = tripHomeCurrency();
  let currencyList = Object.keys(byCurrency).sort((a, b) => {
    if (a === home) return -1; if (b === home) return 1;
    return a.localeCompare(b);
  });
  // Restore persisted currency order when the trip changes (handles refresh and trip switching)
  const _tripId = state.trip?.id || null;
  if (_currencyOrderTripId !== _tripId) {
    _currencyOrder      = _loadCurrencyOrder(_tripId);
    _currencyOrderTripId = _tripId;
  }

  // Apply manual drag order (only reorders currencies that still exist)
  if (_currencyOrder) {
    const known = new Set(currencyList);
    const ordered = _currencyOrder.filter(c => known.has(c));
    const rest    = currencyList.filter(c => !_currencyOrder.includes(c));
    currencyList  = [...ordered, ...rest];
  }

  // Legacy budget merge
  const budgetTargets = { ...(state.trip?.budgetTargets || {}) };
  if (state.trip?.totalBudget && !budgetTargets.EUR) budgetTargets.EUR = state.trip.totalBudget;

  // Destroy stale chart instances before rebuilding DOM
  Object.values(budgetChartInstances).forEach(c => c.destroy());
  budgetChartInstances = {};

  const myMemberId = currentUserMemberId();

  // Reset tab if currency no longer exists
  if (_budgetTab !== "all" && !currencyList.includes(_budgetTab)) _budgetTab = "all";

  // ── Column headers (desktop) ────────────────────────────────
  const dashGrpMembers = (state.trip?.members || []).filter(m =>
    entries.some(e => e.paidBy === m.id || (e.splits || []).some(s => s.memberId === m.id))
  );
  const grpFiltered = _groupMemberFilter.size > 0;
  const colHeadersHTML = myMemberId ? `
    <div class="budget-dash-col-headers">
      <div class="budget-dash-col-header budget-col-mine">
        <div class="budget-dash-col-title">My Portion</div>
        <div class="budget-dash-col-filters">
          <button class="budget-person-pill${_myExpFilter === "all"  ? " active" : ""}" data-myfilter="all">All</button>
          <button class="budget-person-pill${_myExpFilter === "paid" ? " active" : ""}" data-myfilter="paid">I paid</button>
          <button class="budget-person-pill${_myExpFilter === "owe"  ? " active" : ""}" data-myfilter="owe">I owe</button>
        </div>
      </div>
      <div class="budget-dash-col-header">
        <div class="budget-dash-col-title">Group${grpFiltered ? `<span style="font-size:0.75rem;font-weight:400;color:var(--accent);margin-left:5px">· filtered</span>` : ""}</div>
        ${dashGrpMembers.length > 1 ? `
        <div class="budget-dash-col-filters">
          <button class="grp-member-pill${!grpFiltered ? " active" : ""}" data-grpmember="">All</button>
          ${dashGrpMembers.map(m => `<button class="grp-member-pill${_groupMemberFilter.has(m.id) ? " active" : ""}" data-grpmember="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button>`).join("")}
        </div>` : ""}
      </div>
    </div>` : "";

  // ── Tab bar ─────────────────────────────────────────────────
  const tabBarHTML = buildTabBarHTML(entries, budgetTargets, fmt, currencyList);

  // ── Tab content ─────────────────────────────────────────────
  const tabContentHTML = _budgetTab === "all"
    ? buildAllTabHTML(entries, budgetTargets, fmt, myMemberId, _myExpFilter, _groupMemberFilter)
    : buildCurrencyTabHTML(_budgetTab, byCurrency[_budgetTab], budgetTargets, fmt, myMemberId);

  // ── Unbooked / estimated ────────────────────────────────────
  const unbooked = entries.filter(e => e.isEstimated);
  const unbookedHTML = unbooked.length > 0 ? `
    <div class="budget-section-title" style="margin-top:16px">Estimated / not yet booked</div>
    ${unbooked.map(e => `
      <div class="budget-unbooked-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="14" height="14" style="flex-shrink:0;color:var(--text-3)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span class="budget-unbooked-name">${escapeHtml(e.name)}</span>
        <span class="budget-unbooked-amount">~${currencySymbol(e.currency)}${fmt(e.amount)}</span>
      </div>`).join("")}` : "";

  // ── Settle-up at bottom ─────────────────────────────────────
  const settleupHTML = buildSettleUpHTML();

  content.innerHTML = colHeadersHTML + tabBarHTML + tabContentHTML + unbookedHTML + settleupHTML;

  // ── Wire: tab switching ─────────────────────────────────────
  content.querySelectorAll(".budget-tab[data-budgettab]").forEach(tab => {
    tab.addEventListener("click", () => {
      _budgetTab = tab.dataset.budgettab;
      renderBudget();
    });
  });

  // ── Wire: currency tab drag-to-reorder ──────────────────────
  let _dragSrc = null;
  content.querySelectorAll(".budget-tab[data-dragcur]").forEach(tab => {
    tab.addEventListener("dragstart", e => {
      _dragSrc = tab.dataset.dragcur;
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => tab.classList.add("tab-dragging"));
    });
    tab.addEventListener("dragend", () => {
      tab.classList.remove("tab-dragging");
      content.querySelectorAll(".budget-tab").forEach(t => t.classList.remove("tab-drag-over"));
    });
    tab.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      content.querySelectorAll(".budget-tab").forEach(t => t.classList.remove("tab-drag-over"));
      if (tab.dataset.dragcur !== _dragSrc) tab.classList.add("tab-drag-over");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("tab-drag-over"));
    tab.addEventListener("drop", e => {
      e.preventDefault();
      tab.classList.remove("tab-drag-over");
      const src = _dragSrc, tgt = tab.dataset.dragcur;
      if (!src || !tgt || src === tgt) return;
      const base = _currencyOrder || currencyList;
      const next = [...base];
      const si = next.indexOf(src), ti = next.indexOf(tgt);
      if (si < 0 || ti < 0) return;
      next.splice(si, 1);
      next.splice(ti, 0, src);
      _currencyOrder      = next;
      _currencyOrderTripId = state.trip?.id || null;
      _saveCurrencyOrder(_currencyOrderTripId, _currencyOrder);
      renderBudget();
    });
  });

  // ── Wire: My Portion filter pills ──────────────────────────
  content.querySelectorAll(".budget-person-pill[data-myfilter]").forEach(pill => {
    pill.addEventListener("click", () => { _myExpFilter = pill.dataset.myfilter; renderBudget(); });
  });

  // ── Wire: Group participant pills ───────────────────────────
  content.querySelectorAll(".grp-member-pill[data-grpmember]").forEach(pill => {
    pill.addEventListener("click", () => {
      const id = pill.dataset.grpmember;
      if (id === "") {
        _groupMemberFilter.clear();
      } else {
        if (_groupMemberFilter.has(id)) _groupMemberFilter.delete(id);
        else _groupMemberFilter.add(id);
        if (_groupMemberFilter.size === dashGrpMembers.length) _groupMemberFilter.clear();
      }
      renderBudget();
    });
  });

  // ── Wire: budget target saves ───────────────────────────────
  content.querySelectorAll("[data-budget-save]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cur = btn.dataset.budgetSave;
      const val = parseFloat(document.getElementById(`budget-target-${cur}`)?.value) || null;
      const targets = { ...(state.trip?.budgetTargets || {}) };
      if (val) targets[cur] = val; else delete targets[cur];
      await updateDoc(doc(db, "trips", activeTripId), { budgetTargets: targets });
    });
  });

  content.querySelectorAll("[data-my-budget-save]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cur = btn.dataset.myBudgetSave;
      const mid = currentUserMemberId();
      if (!mid) return;
      const val = parseFloat(document.getElementById(`my-budget-target-${cur}`)?.value) || null;
      const fieldPath = `memberBudgetTargets.${mid}.${cur}`;
      await updateDoc(doc(db, "trips", activeTripId), { [fieldPath]: val ?? deleteField() });
    });
  });

  // ── Wire: rates refresh ─────────────────────────────────────
  document.getElementById("budget-refresh-rates-btn")?.addEventListener("click", e => {
    fetchAndSaveRates(e.currentTarget);
  });

  // ── Wire: settle-up ─────────────────────────────────────────
  _wireSettleUp(content);

  // ── Charts ──────────────────────────────────────────────────
  // Stamp a generation token on content so the rAF callback can detect stale renders.
  // If renderBudget() fires again before the rAF runs, the token changes and the old
  // callback exits early — preventing double Chart.js instantiation on the same canvas.
  const renderGen = Symbol();
  content._renderGen = renderGen;
  loadChartJs().then(() => requestAnimationFrame(() => {
    if (content._renderGen !== renderGen) return; // stale; a newer render already ran
    if (_budgetTab === "all") {
      renderBudgetTimelineChart(entries, fmt);
    } else {
      renderBudgetCharts({ [_budgetTab]: byCurrency[_budgetTab] }, fmt, entries);
    }
  }));
}

function _wireSettleUp(content) {
  content.querySelector(".budget-settleup-header")?.addEventListener("click", () => {
    content.querySelector(".budget-settleup-section")?.classList.toggle("open");
  });
  content.querySelectorAll(".balance-settle-btn").forEach(btn => {
    btn.addEventListener("click", () =>
      settleUp(btn.dataset.from, btn.dataset.to, parseFloat(btn.dataset.amount), btn.dataset.currency)
    );
  });
}


export function renderBudgetCharts(byCurrency, fmt, allEntries) {
  if (typeof Chart === "undefined") return;
  const myMemberId = currentUserMemberId();

  Object.entries(byCurrency).forEach(([cur, ces]) => {
    const sym = currencySymbol(cur);

    // Options factory — shared x-axis max enforced per chart pair so City and
    // Category always use the same scale range within a column.
    const makeOpts = (xMax) => ({
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${sym}${fmt(ctx.raw)}` } },
      },
      scales: {
        x: {
          ...(xMax > 0 ? { max: xMax } : {}),
          grid: { color: "rgba(128,128,128,0.1)" },
          ticks: { callback: v => `${sym}${fmt(v)}`, color: "#888", font: { size: 11 } },
        },
        y: { grid: { display: false }, ticks: { color: "#888", font: { size: 11 }, autoSkip: false } },
      },
    });

    // Height helper: each bar gets 32px + 24px padding; min 80px
    const chartH = (n) => `${Math.max(80, n * 32 + 24)}px`;

    // ── Pre-compute group data ─────────────────────────────────
    // Uses getParticipantAmount so top-level participant filter is reflected in bars

    const byCityGroup = {};
    ces.forEach(e => {
      const name = state.towns.find(t => t.id === e.townId)?.name || "Other";
      byCityGroup[name] = (byCityGroup[name] || 0) + getParticipantAmount(e, _groupMemberFilter);
    });
    const cityLabelsGroup = Object.keys(byCityGroup).sort((a, b) => byCityGroup[b] - byCityGroup[a]);
    const cityDataGroup   = cityLabelsGroup.map(k => byCityGroup[k]);
    const cityColorsGroup = cityLabelsGroup.map((_, i) => CITY_PALETTE[i % CITY_PALETTE.length]);

    const byCatGroup = {};
    ces.forEach(e => { byCatGroup[e.category] = (byCatGroup[e.category] || 0) + getParticipantAmount(e, _groupMemberFilter); });
    const catLabelsGroup = Object.keys(byCatGroup).sort((a, b) => byCatGroup[b] - byCatGroup[a]);
    const catDataGroup   = catLabelsGroup.map(k => byCatGroup[k]);
    const catColorsGroup = catLabelsGroup.map(c => CATEGORY_COLORS[c] || "#888");

    const groupXMax = Math.max(0, ...cityDataGroup, ...catDataGroup);

    // ── Pre-compute mine data ──────────────────────────────────

    const myCes    = myMemberId ? filterMyEntries(ces, myMemberId, _myExpFilter) : [];
    // myCesAll: all entries involving me, ignoring top-level filter — passed to drawer
    // so the drawer's own Mine filter can work across the full set
    const myCesAll = myMemberId ? filterMyEntries(ces, myMemberId, "all") : [];
    let cityLabelsMine = [], cityDataMine = [], cityColorsMine = [];
    let catLabelsMine  = [], catDataMine  = [], catColorsMine  = [];
    let mineXMax = 0;

    if (myMemberId) {
      const byCityMine = {};
      myCes.forEach(e => {
        const name = state.towns.find(t => t.id === e.townId)?.name || "Other";
        byCityMine[name] = (byCityMine[name] || 0) + getMyPortionAmount(e, myMemberId);
      });
      cityLabelsMine = Object.keys(byCityMine).sort((a, b) => byCityMine[b] - byCityMine[a]);
      cityDataMine   = cityLabelsMine.map(k => byCityMine[k]);
      cityColorsMine = cityLabelsMine.map((_, i) => CITY_PALETTE[i % CITY_PALETTE.length]);

      const byCatMine = {};
      myCes.forEach(e => { byCatMine[e.category] = (byCatMine[e.category] || 0) + getMyPortionAmount(e, myMemberId); });
      catLabelsMine = Object.keys(byCatMine).sort((a, b) => byCatMine[b] - byCatMine[a]);
      catDataMine   = catLabelsMine.map(k => byCatMine[k]);
      catColorsMine = catLabelsMine.map(c => CATEGORY_COLORS[c] || "#888");

      mineXMax = Math.max(0, ...cityDataMine, ...catDataMine);
    }

    // ── Create group charts ────────────────────────────────────

    // Helper: resolve clicked row index from Chart.js event (bar click OR label/row click)
    const rowIdx = (event, chart, labels) => {
      if (!chart || !labels.length) return -1;
      const els = chart.getElementsAtEventForMode(event.native, 'y', { intersect: false }, false);
      if (els.length) return els[0].index;
      // Fallback: map y-pixel to scale index directly (catches clicks outside bars)
      try {
        const v = chart.scales.y.getValueForPixel(event.native.offsetY);
        const i = Math.round(v);
        return (i >= 0 && i < labels.length) ? i : -1;
      } catch { return -1; }
    };
    const rowHover = (event, elements, chart, labels) => {
      try {
        const v = chart.scales?.y?.getValueForPixel(event.native?.offsetY);
        const onRow = Number.isFinite(v) && v >= -0.5 && v < labels.length - 0.5;
        return elements.length > 0 || onRow;
      } catch { return elements.length > 0; }
    };

    const cityCtx = document.getElementById(`budget-chart-${cur}-city`);
    if (cityCtx) {
      cityCtx.parentElement.style.height = chartH(cityLabelsGroup.length);
      budgetChartInstances[`${cur}-city`] = new Chart(cityCtx, {
        type: "bar",
        data: { labels: cityLabelsGroup, datasets: [{ data: cityDataGroup, backgroundColor: cityColorsGroup, borderRadius: 4, borderSkipped: false }] },
        options: {
          ...makeOpts(groupXMax),
          onHover: (event, elements, chart) => { cityCtx.style.cursor = rowHover(event, elements, chart, cityLabelsGroup) ? "pointer" : "default"; },
          onClick: (event, elements, chart) => {
            const i = rowIdx(event, chart, cityLabelsGroup);
            if (i < 0) return;
            const cityName = cityLabelsGroup[i];
            const cityEntries = (allEntries || ces).filter(e => {
              const town = state.towns.find(t => t.id === e.townId);
              return (town?.name || "Other") === cityName && e.currency === cur;
            });
            openBudgetDrawer(cityName, cur, cityEntries, "city", "group");
          },
        },
      });
    }

    const catCtx = document.getElementById(`budget-chart-${cur}-cat`);
    if (catCtx) {
      catCtx.parentElement.style.height = chartH(catLabelsGroup.length);
      budgetChartInstances[`${cur}-cat`] = new Chart(catCtx, {
        type: "bar",
        data: { labels: catLabelsGroup, datasets: [{ data: catDataGroup, backgroundColor: catColorsGroup, borderRadius: 4, borderSkipped: false }] },
        options: {
          ...makeOpts(groupXMax),
          onHover: (event, elements, chart) => { catCtx.style.cursor = rowHover(event, elements, chart, catLabelsGroup) ? "pointer" : "default"; },
          onClick: (event, elements, chart) => {
            const i = rowIdx(event, chart, catLabelsGroup);
            if (i < 0) return;
            const category = catLabelsGroup[i];
            const catEntries = (allEntries || ces).filter(e => e.category === category && e.currency === cur);
            openBudgetDrawer(category, cur, catEntries, "category", "group");
          },
        },
      });
    }

    // Sync group y-axis widths so grid lines stay perfectly aligned
    const gc = budgetChartInstances[`${cur}-city`];
    const gcat = budgetChartInstances[`${cur}-cat`];
    if (gc && gcat) {
      const w = Math.max(gc.scales.y.width, gcat.scales.y.width);
      gc.options.scales.y.afterFit   = s => { s.width = w; };
      gcat.options.scales.y.afterFit = s => { s.width = w; };
      gc.update('none');
      gcat.update('none');
    }

    // ── Create mine charts ─────────────────────────────────────

    if (!myMemberId) return;

    const cityCMine = document.getElementById(`budget-chart-${cur}-city-mine`);
    if (cityCMine) {
      cityCMine.parentElement.style.height = chartH(cityLabelsMine.length);
      budgetChartInstances[`${cur}-city-mine`] = new Chart(cityCMine, {
        type: "bar",
        data: { labels: cityLabelsMine, datasets: [{ data: cityDataMine, backgroundColor: cityColorsMine, borderRadius: 4, borderSkipped: false }] },
        options: {
          ...makeOpts(mineXMax),
          onHover: (event, elements, chart) => { cityCMine.style.cursor = rowHover(event, elements, chart, cityLabelsMine) ? "pointer" : "default"; },
          onClick: (event, elements, chart) => {
            const i = rowIdx(event, chart, cityLabelsMine);
            if (i < 0) return;
            const cityName = cityLabelsMine[i];
            const cityEntries = myCesAll.filter(e => (state.towns.find(t => t.id === e.townId)?.name || "Other") === cityName);
            openBudgetDrawer(cityName, cur, cityEntries, "city", "mine");
          },
        },
      });
    }

    const catCMine = document.getElementById(`budget-chart-${cur}-cat-mine`);
    if (catCMine) {
      catCMine.parentElement.style.height = chartH(catLabelsMine.length);
      budgetChartInstances[`${cur}-cat-mine`] = new Chart(catCMine, {
        type: "bar",
        data: { labels: catLabelsMine, datasets: [{ data: catDataMine, backgroundColor: catColorsMine, borderRadius: 4, borderSkipped: false }] },
        options: {
          ...makeOpts(mineXMax),
          onHover: (event, elements, chart) => { catCMine.style.cursor = rowHover(event, elements, chart, catLabelsMine) ? "pointer" : "default"; },
          onClick: (event, elements, chart) => {
            const i = rowIdx(event, chart, catLabelsMine);
            if (i < 0) return;
            const category = catLabelsMine[i];
            const catEntries = myCesAll.filter(e => e.category === category);
            openBudgetDrawer(category, cur, catEntries, "category", "mine");
          },
        },
      });
    }

    // Sync mine y-axis widths
    const mc = budgetChartInstances[`${cur}-city-mine`];
    const mcat = budgetChartInstances[`${cur}-cat-mine`];
    if (mc && mcat) {
      const w = Math.max(mc.scales.y.width, mcat.scales.y.width);
      mc.options.scales.y.afterFit   = s => { s.width = w; };
      mcat.options.scales.y.afterFit = s => { s.width = w; };
      mc.update('none');
      mcat.update('none');
    }
  });
}

/* ── Budget timeline (All tab) line chart ───────────────── */
export function renderBudgetTimelineChart(entries, fmt) {
  if (typeof Chart === "undefined") return;
  const canvas = document.getElementById("budget-timeline-chart");
  if (!canvas) return;

  const home     = tripHomeCurrency();
  const homeSym  = currencySymbol(home);
  const rates    = state.trip?.exchangeRates || null;
  const conv     = (amt, cur) => cur === home ? amt : (rates && rates[cur] ? amt / rates[cur] : amt);
  const myMemberId = currentUserMemberId();

  // Compute cumulative and per-day amounts
  const byDate = {};
  entries.forEach(e => {
    if (!e.scheduledDate) return;
    const d = e.scheduledDate;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(e);
  });

  const sortedDates = Object.keys(byDate).sort();
  if (!sortedDates.length) return;

  // Friendly axis labels  "12 Jun"
  const dateLabels = sortedDates.map(d => {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  });

  // Daily group totals (converted to home currency)
  const groupData = sortedDates.map(d =>
    byDate[d].reduce((s, e) => s + conv(e.amount, e.currency), 0)
  );

  // Daily mine totals
  const mineData = myMemberId
    ? sortedDates.map(d =>
        byDate[d].reduce((s, e) => s + conv(getMyPortionAmount(e, myMemberId), e.currency), 0)
      )
    : null;

  // Destroy any previous timeline chart instance
  if (budgetChartInstances.__timeline) {
    budgetChartInstances.__timeline.destroy();
    delete budgetChartInstances.__timeline;
  }

  const accentColor  = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()  || "#4E8774";
  const successColor = getComputedStyle(document.documentElement).getPropertyValue("--success").trim() || "#6F8B68";
  // Build a 10%-opacity fill from the border color using a hidden canvas alpha trick
  const _hexToRgba = (hex, alpha) => {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };
  const mineFill = _hexToRgba(successColor.startsWith("#") ? successColor : "#6F8B68", 0.10);
  const compact = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

  const datasets = [{
    label: "Group",
    data: groupData,
    borderColor: successColor,
    backgroundColor: "transparent",
    fill: false,
    pointRadius: 4,
    pointHoverRadius: 6,
    tension: 0.3,
    borderWidth: 2,
    borderDash: [5, 3],
  }];

  if (mineData) {
    datasets.push({
      label: "My Portion",
      data: mineData,
      borderColor: accentColor,
      backgroundColor: mineFill,
      fill: true,
      pointRadius: 5,
      pointHoverRadius: 7,
      tension: 0.3,
      borderWidth: 2,
    });
  }

  budgetChartInstances.__timeline = new Chart(canvas, {
    type: "line",
    data: { labels: dateLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: !!myMemberId,
          position: "top",
          labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 }, color: "#888" },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${homeSym}${fmt(Math.round(ctx.raw))}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(128,128,128,0.1)" },
          ticks: { color: "#888", font: { size: 11 }, maxRotation: 45 },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(128,128,128,0.1)" },
          ticks: { color: "#888", font: { size: 11 }, callback: v => `${homeSym}${compact(v)}` },
        },
      },
      onClick: (event, elements, chart) => {
        // Use index mode so click anywhere on the vertical is captured
        const pts = chart.getElementsAtEventForMode(event.native || event, "index", { intersect: false }, false);
        if (!pts.length) return;
        const idx = pts[0].index;
        const dateKey = sortedDates[idx];
        const dayEntries = byDate[dateKey] || [];
        const dateLabel = new Date(dateKey + "T00:00:00").toLocaleDateString("en-GB", {
          weekday: "short", day: "numeric", month: "long",
        });
        openBudgetDrawer(dateLabel, home, dayEntries, "date", "group");
      },
      onHover: (event, elements) => {
        canvas.style.cursor = elements.length ? "pointer" : "default";
      },
    },
  });
}

/* ── Budget expense drawer ───────────────────────────────── */
// Budget drawer state
let _bdEntries       = [];
let _bdCurrency      = "";
let _bdSort          = "date";      // "date" | "value"
let _bdDir           = "desc";      // "desc" | "asc"
let _bdMode          = "";          // "city" | "category"
let _bdActiveFilters = new Set();   // cross-dimension filter (category/city)
let _bdColumn        = "group";     // "mine" | "group" — which column opened the drawer
let _bdMineFilter    = "all";       // "all" | "paid" | "owe"  (left column drawer)
let _bdGroupFilter   = new Set();   // participant IDs  (right column drawer, empty = all)
let _bdFiltersOpen   = false;       // filter panel expanded?

let _myExpFilter        = "all";      // left column top-level: "all" | "paid" | "owe"
let _groupMemberFilter  = new Set();  // right column top-level: participant IDs (empty = all)
let _budgetTab          = "all";      // active budget tab: "all" | currency code
let _currencyOrder      = null;       // null = default sort | string[] = manual drag order
let _currencyOrderTripId = null;      // tracks which trip _currencyOrder belongs to (for cross-trip safety)

function _loadCurrencyOrder(tripId) {
  try { const s = localStorage.getItem(`currency-order-${tripId}`); return s ? JSON.parse(s) : null; }
  catch { return null; }
}
function _saveCurrencyOrder(tripId, order) {
  try { localStorage.setItem(`currency-order-${tripId}`, JSON.stringify(order)); } catch {}
}

export function getMyPortionAmount(e, myMemberId) {
  if (!myMemberId) return 0;
  if (e.splits?.length) return (e.splits || []).find(s => s.memberId === myMemberId)?.owed || 0;
  return e.paidBy === myMemberId ? e.amount : 0;
}

// Returns the combined spend for a set of members on a single entry.
// memberIds empty → full e.amount (whole group).
export function getParticipantAmount(e, memberIds) {
  if (!memberIds || memberIds.size === 0) return e.amount;
  if (e.splits?.length) {
    return e.splits.filter(s => memberIds.has(s.memberId)).reduce((sum, s) => sum + s.owed, 0);
  }
  return memberIds.has(e.paidBy) ? e.amount : 0;
}

export function filterMyEntries(entries, myMemberId, filter) {
  if (!myMemberId) return [];
  if (filter === "paid") return entries.filter(e => e.paidBy === myMemberId);
  if (filter === "owe")  return entries.filter(e =>
    e.paidBy && e.paidBy !== myMemberId &&
    (e.splits || []).some(s => s.memberId === myMemberId && s.owed > 0.005)
  );
  // "all": paid or in splits
  return entries.filter(e =>
    e.paidBy === myMemberId ||
    (e.splits || []).some(s => s.memberId === myMemberId && s.owed > 0.005)
  );
}

function _sortBudgetEntries(entries) {
  return [...entries].sort((a, b) => {
    if (_bdSort === "value") {
      return _bdDir === "desc" ? b.amount - a.amount : a.amount - b.amount;
    }
    // date + time sort: combine date + time + itinerary order for stable, meaningful ordering
    const aKey = (a.scheduledDate || "9999-99-99") + "T" + (a.scheduledTime || "99:99") + String(a.order ?? 9999).padStart(6, "0");
    const bKey = (b.scheduledDate || "9999-99-99") + "T" + (b.scheduledTime || "99:99") + String(b.order ?? 9999).padStart(6, "0");
    return _bdDir === "desc" ? bKey.localeCompare(aKey) : aKey.localeCompare(bKey);
  });
}

function _renderBudgetDrawer() {
  const body = document.getElementById("drawer-body");
  if (!body) return;

  const myMemberId = currentUserMemberId();
  const sym = currencySymbol(_bdCurrency);
  const fmt = n => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const members = state.trip?.members || [];

  // 1. Cross-dimension filter (category when in city view, or city when in category view)
  const afterCrossFilter = _bdActiveFilters.size === 0
    ? _bdEntries
    : _bdEntries.filter(e => {
        if (_bdMode === "city") return _bdActiveFilters.has(e.category);
        const cityName = state.towns.find(t => t.id === e.townId)?.name || "Other";
        return _bdActiveFilters.has(cityName);
      });

  // 2. Column-specific filter
  let filtered;
  if (_bdColumn === "mine" && myMemberId) {
    filtered = filterMyEntries(afterCrossFilter, myMemberId, _bdMineFilter);
  } else if (_bdColumn === "group" && _bdGroupFilter.size > 0) {
    filtered = afterCrossFilter.filter(e =>
      (e.paidBy && _bdGroupFilter.has(e.paidBy)) ||
      (e.splits || []).some(s => _bdGroupFilter.has(s.memberId) && s.owed > 0.005)
    );
  } else {
    filtered = afterCrossFilter;
  }

  // 3. Compute display amount per entry
  // In "date" mode the drawer shows all entries for a single day converted to home currency.
  const _bdRates = state.trip?.exchangeRates || null;
  const _bdHome  = tripHomeCurrency();
  const _bdConv  = (amt, cur) => cur === _bdHome ? amt : (_bdRates && _bdRates[cur] ? amt / _bdRates[cur] : amt);
  const getDisplayAmt = e => {
    if (_bdMode === "date") return _bdConv(e.amount, e.currency);
    if (_bdColumn === "mine" && myMemberId) return getMyPortionAmount(e, myMemberId);
    if (_bdColumn === "group" && _bdGroupFilter.size > 0) return getParticipantAmount(e, _bdGroupFilter);
    return e.amount;
  };

  const fTotal    = filtered.reduce((s, e) => s + getDisplayAmt(e), 0);
  const fPaid     = filtered.filter(e => !e.isEstimated).reduce((s, e) => s + getDisplayAmt(e), 0);
  const fEstCount = filtered.filter(e => e.isEstimated).length;

  // 4. Filter count / badge
  const bdFilterCount = _bdActiveFilters.size +
    (_bdColumn === "mine" ? (_bdMineFilter !== "all" ? 1 : 0) : _bdGroupFilter.size);
  const hasActiveFilter = bdFilterCount > 0;

  // 5. Cross-dimension pills
  const crossPillValues = _bdMode === "city"
    ? [...new Set(_bdEntries.map(e => e.category))].sort()
    : [...new Set(_bdEntries.map(e => state.towns.find(t => t.id === e.townId)?.name || "Other"))].sort();
  const crossLabel = _bdMode === "city" ? "Category" : "City";

  // 6. Participant pills (right column)
  const relevantMembers = members.filter(m =>
    _bdEntries.some(e => e.paidBy === m.id || (e.splits || []).some(s => s.memberId === m.id))
  );

  const sorted = _sortBudgetEntries(filtered);

  body.innerHTML = `
    <div id="bd-header" style="padding-bottom:14px;margin-bottom:4px;border-bottom:1px solid var(--border)">
      <div id="bd-total-amount" style="font-family:var(--font-display);font-size:1.75rem;font-weight:500;letter-spacing:-0.03em;line-height:1;font-variant-numeric:tabular-nums">${sym}${fmt(fTotal)}</div>
      <div id="bd-total-sub" style="font-size:0.8125rem;color:var(--text-3);margin-top:4px">${sym}${fmt(fPaid)} paid${fEstCount ? ` · ${sym}${fmt(fTotal - fPaid)} estimated` : ""} · ${filtered.length} expense${filtered.length !== 1 ? "s" : ""}</div>

      <div class="bd-drawer-toolbar">
        <div class="bd-drawer-toolbar-sort">
          <span class="budget-sort-label">Sort</span>
          <button class="budget-sort-btn${_bdSort === "date"  ? " active" : ""}" data-sort="date">Date / time<span class="sort-arrow">${_bdSort === "date"  ? (_bdDir === "desc" ? " ↓" : " ↑") : ""}</span></button>
          <button class="budget-sort-btn${_bdSort === "value" ? " active" : ""}" data-sort="value">Value<span class="sort-arrow">${_bdSort === "value" ? (_bdDir === "desc" ? " ↓" : " ↑") : ""}</span></button>
        </div>
        <button class="bd-filter-toggle${_bdFiltersOpen || bdFilterCount > 0 ? " active" : ""}" id="bd-filter-toggle-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          Filters${bdFilterCount > 0 ? ` <span class="bd-filter-badge">${bdFilterCount}</span>` : ""}
        </button>
      </div>

      ${_bdFiltersOpen ? `
      <div class="bd-drawer-filter-panel">
        ${_bdColumn === "mine" ? `
        <div class="bd-filter-section">
          <div class="bd-filter-section-label">Mine</div>
          <div class="bd-filter-pills">
            <button class="bd-filter-pill${_bdMineFilter === "all"  ? " active" : ""}" data-bdmine="all">All</button>
            <button class="bd-filter-pill${_bdMineFilter === "paid" ? " active" : ""}" data-bdmine="paid">I paid</button>
            <button class="bd-filter-pill${_bdMineFilter === "owe"  ? " active" : ""}" data-bdmine="owe">I owe</button>
          </div>
        </div>` : ""}
        ${_bdColumn === "group" && relevantMembers.length > 1 ? `
        <div class="bd-filter-section">
          <div class="bd-filter-section-label">Participants</div>
          <div class="bd-filter-pills">
            ${relevantMembers.map(m => `<button class="bd-filter-pill${_bdGroupFilter.has(m.id) ? " active" : ""}" data-bdmember="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button>`).join("")}
          </div>
        </div>` : ""}
        ${crossPillValues.length > 1 ? `
        <div class="bd-filter-section">
          <div class="bd-filter-section-label">${crossLabel}</div>
          <div class="bd-filter-pills">
            ${crossPillValues.map(v => `<button class="bd-filter-pill${_bdActiveFilters.has(v) ? " active" : ""}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join("")}
          </div>
        </div>` : ""}
        ${hasActiveFilter ? `<button class="bd-clear-btn" id="bd-drawer-clear-btn">Clear all</button>` : ""}
      </div>` : ""}
    </div>

    <div id="budget-drawer-list">
      ${sorted.map(e => {
        const town = state.towns.find(t => t.id === e.townId);
        const dateStr = e.scheduledDate
          ? new Date(e.scheduledDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
          : "";
        const timeStr = e.scheduledTime ? ` · ${e.scheduledTime}` : "";
        const subLabel = _bdMode === "city"
          ? `<span style="font-size:0.75rem;color:var(--text-3)">${escapeHtml(e.category)}</span>`
          : (town ? `<span style="font-size:0.75rem;color:var(--text-3)">${escapeHtml(town.name)}</span>` : "");
        const displayAmt = getDisplayAmt(e);
        const isManualEntry = e.source === "expense";
        const expenseActions = isManualEntry ? `
          <div class="bd-expense-actions">
            <button class="bd-expense-btn" data-expense-edit="${escapeHtml(e.id)}" title="Edit expense">✏</button>
            <button class="bd-expense-btn del" data-expense-del="${escapeHtml(e.id)}" title="Delete">✕</button>
          </div>`
          : (_bdMode === "date" ? `
          <div class="bd-expense-actions">
            <button class="bd-expense-btn"
              data-bd-open-source="${escapeHtml(e.source)}"
              data-bd-open-id="${escapeHtml(e.id)}"
              data-bd-open-townid="${escapeHtml(e.townId || "")}"
              title="Open">✏</button>
          </div>` : "");
        return `
          <div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:0.9375rem;color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.name)}</div>
                <div style="display:flex;gap:8px;margin-top:3px;flex-wrap:wrap">
                  ${subLabel}
                  ${dateStr ? `<span style="font-size:0.75rem;color:var(--text-3)">${dateStr}${timeStr}</span>` : ""}
                  ${e.isEstimated ? `<span style="font-size:0.6875rem;color:var(--text-3);background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:1px 5px">est.</span>` : ""}
                  ${e.source === "expense" ? `<span style="font-size:0.6875rem;color:var(--accent);background:rgba(var(--accent-rgb,78,135,116),0.08);border:1px solid rgba(var(--accent-rgb,78,135,116),0.2);border-radius:4px;padding:1px 5px">manual</span>` : ""}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                <div style="font-size:0.9375rem;font-weight:600;color:${e.isEstimated ? "var(--text-2)" : "var(--text)"};font-variant-numeric:tabular-nums">${sym}${fmt(displayAmt)}</div>
                ${expenseActions}
              </div>
            </div>
          </div>`;
      }).join("")}
    </div>`;

  // ── Wire event listeners ───────────────────────────────────

  body.querySelector("#bd-filter-toggle-btn")?.addEventListener("click", () => {
    _bdFiltersOpen = !_bdFiltersOpen;
    _renderBudgetDrawer();
  });

  body.querySelectorAll(".budget-sort-btn[data-sort]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.sort === _bdSort) {
        _bdDir = _bdDir === "desc" ? "asc" : "desc";
      } else {
        _bdSort = btn.dataset.sort;
        _bdDir  = "desc";
      }
      _renderBudgetDrawer();
    });
  });

  // Mine filter pills (left column drawer)
  body.querySelectorAll(".bd-filter-pill[data-bdmine]").forEach(pill => {
    pill.addEventListener("click", () => {
      _bdMineFilter = pill.dataset.bdmine;
      _renderBudgetDrawer();
    });
  });

  // Participant filter pills (right column drawer)
  body.querySelectorAll(".bd-filter-pill[data-bdmember]").forEach(pill => {
    pill.addEventListener("click", () => {
      const id = pill.dataset.bdmember;
      if (_bdGroupFilter.has(id)) _bdGroupFilter.delete(id);
      else _bdGroupFilter.add(id);
      _renderBudgetDrawer();
    });
  });

  // Cross-dimension filter pills
  body.querySelectorAll(".bd-filter-pill[data-value]").forEach(pill => {
    pill.addEventListener("click", () => {
      const val = pill.dataset.value;
      if (_bdActiveFilters.has(val)) _bdActiveFilters.delete(val);
      else _bdActiveFilters.add(val);
      _renderBudgetDrawer();
    });
  });

  // Clear all
  body.querySelector("#bd-drawer-clear-btn")?.addEventListener("click", () => {
    _bdActiveFilters.clear();
    _bdMineFilter = "all";
    _bdGroupFilter.clear();
    _renderBudgetDrawer();
  });

  // Edit/delete manual expenses
  body.querySelectorAll("[data-expense-edit]").forEach(btn => {
    btn.addEventListener("click", ev => { ev.stopPropagation(); openExpenseModal(btn.dataset.expenseEdit); });
  });
  body.querySelectorAll("[data-expense-del]").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (confirm("Delete this expense?")) deleteExpense(btn.dataset.expenseDel);
    });
  });

  // Open spot / accommodation / transit entries from the date-mode drawer
  body.querySelectorAll("[data-bd-open-source]").forEach(btn => {
    btn.addEventListener("click", async ev => {
      ev.stopPropagation();
      const source = btn.dataset.bdOpenSource;
      const id     = btn.dataset.bdOpenId;
      const townId = btn.dataset.bdOpenTownid;
      if (source === "spot") {
        const spot = state.spots.find(s => s.id === id);
        if (spot) openModal(spot);
      } else if (source === "accommodation") {
        const town = state.towns.find(t => t.id === townId);
        if (town) openAccomModal(town);
      } else if (source === "transit") {
        const town = state.towns.find(t => t.id === townId);
        const entry = (town?.transitExpenses || []).find(e => e.id === id);
        if (entry) await showTransitSheet(townId, entry.date, entry);
      }
    });
  });
}

function openBudgetDrawer(groupLabel, currency, entries, mode = "", column = "group") {
  cb.clearDrawerContext?.();
  cb.setDrawerBudgetMode?.(true);

  _bdEntries       = entries;
  _bdCurrency      = currency;
  _bdSort          = "date";
  _bdDir           = "desc";
  _bdMode          = mode;
  _bdActiveFilters = new Set();
  _bdColumn        = column;
  _bdMineFilter    = column === "mine" ? _myExpFilter : "all"; // seed from top-level filter
  _bdGroupFilter.clear();
  _bdFiltersOpen   = false;

  const badge = document.getElementById("drawer-type-badge");
  badge.textContent = currency;
  badge.dataset.type = "budget";
  document.getElementById("drawer-spot-name").textContent = groupLabel;
  document.getElementById("drawer-edit-btn").style.display = "none";
  document.getElementById("drawer-visited-btn").style.display = "none";

  _renderBudgetDrawer();

  cb.pushModalHistory();
  document.getElementById("spot-drawer-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
}

/* ─────────────────────────────────────────────────────────────
   TOWN EDIT
   ───────────────────────────────────────────────────────────── */
let editingTownId = null;
let townHidePhotoState = false;

export function openTownEditModal(town = null) {
  editingTownId = town ? town.id : null;
  townHidePhotoState = town?.hidePhoto ?? false;
  document.getElementById("town-edit-modal-title").textContent = town ? "Edit city" : "New city";
  document.getElementById("town-edit-name").value      = town?.name || "";
  document.getElementById("town-edit-arrival").value   = town?.arrivalDate || "";
  document.getElementById("town-edit-departure").value = town?.departureDate || "";
  document.getElementById("town-hide-photo-switch").classList.toggle("on", townHidePhotoState);
  document.getElementById("town-edit-delete-btn").style.display = town ? "" : "none";
  document.getElementById("town-edit-overlay").classList.add("visible");
  document.getElementById("town-edit-name").focus();
}

function closeTownEditModal() {
  editingTownId = null;
  document.getElementById("town-edit-overlay").classList.remove("visible");
}

async function reorderTownsByDate(extraTown = null) {
  // Build full list including a newly created town not yet in state
  const all = extraTown
    ? [...state.towns.filter(t => t.id !== extraTown.id), extraTown]
    : [...state.towns];
  all.sort((a, b) => {
    const arr = (a.arrivalDate || "").localeCompare(b.arrivalDate || "");
    if (arr !== 0) return arr;
    return (a.departureDate || "").localeCompare(b.departureDate || "");
  });
  const batch = writeBatch(db);
  all.forEach((t, i) => batch.update(doc(db, "trips", activeTripId, "towns", t.id), { order: i + 1 }));
  batch.update(doc(db, "trips", activeTripId), { cityNames: all.map(t => t.name) });
  await batch.commit();
}

async function saveTownEdit() {
  const name          = document.getElementById("town-edit-name").value.trim();
  const arrivalDate   = document.getElementById("town-edit-arrival").value;
  const departureDate = document.getElementById("town-edit-departure").value;
  if (!name || !arrivalDate || !departureDate) return;
  const saveBtn = document.getElementById("town-edit-save-btn");
  saveBtn.disabled = true;
  try {
    if (editingTownId) {
      await updateDoc(doc(db, "trips", activeTripId, "towns", editingTownId), { name, arrivalDate, departureDate, hidePhoto: townHidePhotoState });
      // Pass updated town explicitly — state.towns still has old dates at this point
      const updatedTown = { ...state.towns.find(t => t.id === editingTownId), name, arrivalDate, departureDate };
      await reorderTownsByDate(updatedTown);
    } else {
      // Generate a unique ID from name; avoid collisions with existing towns
      let newId = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
      if (state.towns.find(t => t.id === newId)) newId = `${newId}-${Date.now()}`;
      const derivedCountry = extractTripDestination(state.trip?.name || "");
      const newTown = { id: newId, name, arrivalDate, departureDate, country: derivedCountry || "", order: 999 };
      await setDoc(doc(db, "trips", activeTripId, "towns", newId), newTown);
      await reorderTownsByDate(newTown);
      closeTownEditModal();
      if (PEXELS_CONFIG.apiKey) {
        openPhotoPicker(newId, name);
      }
      return;
    }
    closeTownEditModal();
  } catch (err) {
    console.error("Town save error:", err);
  } finally {
    saveBtn.disabled = false;
  }
}

async function deleteTownEdit() {
  if (!editingTownId) return;
  const town = state.towns.find(t => t.id === editingTownId);
  const spotCount = state.spots.filter(s => s.townId === editingTownId).length;
  const msg = spotCount > 0
    ? `Delete ${town?.name || "this city"} and its ${spotCount} spot${spotCount > 1 ? "s" : ""}? This cannot be undone.`
    : `Delete ${town?.name || "this city"}? This cannot be undone.`;
  if (!confirm(msg)) return;

  const deleteBtn = document.getElementById("town-edit-delete-btn");
  deleteBtn.disabled = true;
  try {
    const batch = writeBatch(db);
    // Delete all spots belonging to this town
    state.spots.filter(s => s.townId === editingTownId)
      .forEach(s => batch.delete(doc(db, "trips", activeTripId, "spots", s.id)));
    // Delete the town doc
    batch.delete(doc(db, "trips", activeTripId, "towns", editingTownId));
    const remainingNames = state.towns.filter(t => t.id !== editingTownId).map(t => t.name);
    batch.update(doc(db, "trips", activeTripId), { cityNames: remainingNames });
    await batch.commit();
    closeTownEditModal();
  } catch (err) {
    console.error("Town delete error:", err);
    deleteBtn.disabled = false;
  }
}

document.getElementById("town-edit-close-btn").addEventListener("click", closeTownEditModal);
document.getElementById("town-edit-cancel-btn").addEventListener("click", closeTownEditModal);
document.getElementById("town-edit-save-btn").addEventListener("click", saveTownEdit);
document.getElementById("town-hide-photo-toggle").addEventListener("click", () => {
  townHidePhotoState = !townHidePhotoState;
  document.getElementById("town-hide-photo-switch").classList.toggle("on", townHidePhotoState);
});
document.getElementById("town-edit-delete-btn").addEventListener("click", deleteTownEdit);
document.getElementById("town-edit-overlay").addEventListener("click", e => {
  if (e.target === document.getElementById("town-edit-overlay")) closeTownEditModal();
});

/* ─────────────────────────────────────────────────────────────
   LINKED SPOTS (4c)
   ───────────────────────────────────────────────────────────── */
export async function linkSpots(spotIdA, spotIdB) {
  const a = state.spots.find(s => s.id === spotIdA);
  const b = state.spots.find(s => s.id === spotIdB);
  if (!a || !b) return;
  const groupId = a.groupId || b.groupId || crypto.randomUUID();
  // Propagate groupId to all spots currently in either group
  const affected = state.spots.filter(s =>
    s.id === spotIdA || s.id === spotIdB ||
    (a.groupId && s.groupId === a.groupId) ||
    (b.groupId && s.groupId === b.groupId)
  );
  const batch = writeBatch(db);
  affected.forEach(s => batch.update(doc(db, "trips", activeTripId, "spots", s.id), { groupId }));
  await batch.commit();
}

export async function unlinkSpot(spotId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot?.groupId) return;
  const groupMembers = state.spots.filter(s => s.groupId === spot.groupId);
  const batch = writeBatch(db);
  if (groupMembers.length <= 2) {
    // Last link — clear groupId on both so neither appears linked
    groupMembers.forEach(s => batch.update(doc(db, "trips", activeTripId, "spots", s.id), { groupId: null }));
  } else {
    batch.update(doc(db, "trips", activeTripId, "spots", spotId), { groupId: null });
  }
  await batch.commit();
}


/* ─────────────────────────────────────────────────────────────
   INIT: wire DOM events for budget/expense modals
   ───────────────────────────────────────────────────────────── */
export function initBudget() {
  document.getElementById("budget-add-expense-btn")?.addEventListener("click", () => openExpenseModal());
  document.getElementById("expenses-add-btn")?.addEventListener("click", () => openExpenseModal());
  document.getElementById("expense-modal-close")?.addEventListener("click", closeExpenseModal);
  document.getElementById("exp-cancel-btn")?.addEventListener("click", closeExpenseModal);
  document.getElementById("exp-save-btn")?.addEventListener("click", saveExpense);
  document.getElementById("exp-delete-btn")?.addEventListener("click", async () => {
    if (!_editingExpenseId) return;
    if (!confirm("Delete this expense?")) return;
    const id = _editingExpenseId;
    closeExpenseModal();
    await deleteExpense(id);
  });
  document.getElementById("expense-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("expense-modal-overlay")) closeExpenseModal();
  });

  document.getElementById("exp-sel-clear-btn")?.addEventListener("click", () => {
    _expSelectedIds.clear();
    _expSelectionMode = false;
    renderExpenses();
  });
  document.getElementById("exp-sel-edit-btn")?.addEventListener("click", () => {
    if (_expSelectedIds.size > 0) openBulkExpenseModal();
  });

  document.getElementById("bulk-modal-close")?.addEventListener("click", closeBulkExpenseModal);
  document.getElementById("bulk-exp-cancel")?.addEventListener("click", closeBulkExpenseModal);
  document.getElementById("bulk-exp-save")?.addEventListener("click", saveBulkExpenses);
  document.getElementById("bulk-expense-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("bulk-expense-overlay")) closeBulkExpenseModal();
  });
  document.querySelectorAll(".bulk-status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _bulkStatusValue = btn.dataset.bulkStatus;
      document.querySelectorAll(".bulk-status-btn").forEach(b =>
        b.classList.toggle("active", b === btn)
      );
    });
  });

  document.getElementById("exp-estimated-toggle")?.addEventListener("click", () => {
    _expEstimated = !_expEstimated;
    document.getElementById("exp-estimated-switch").classList.toggle("on", _expEstimated);
  });

  document.querySelectorAll("#exp-split-mode-row .split-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _expSplitMode = btn.dataset.mode;
      document.querySelectorAll("#exp-split-mode-row .split-mode-btn").forEach(b => b.classList.toggle("active", b === btn));
      const customDiv = document.getElementById("exp-custom-splits");
      customDiv.style.display = _expSplitMode === "custom" ? "block" : "none";
      if (_expSplitMode === "custom") renderCustomSplits(state.trip?.members || []);
    });
  });

  document.querySelectorAll("#spot-split-mode-row .split-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _spotSplitMode = btn.dataset.mode;
      document.querySelectorAll("#spot-split-mode-row .split-mode-btn").forEach(b => b.classList.toggle("active", b === btn));
      const customDiv = document.getElementById("spot-custom-splits");
      customDiv.style.display = _spotSplitMode === "custom" ? "block" : "none";
      if (_spotSplitMode === "custom") renderSpotCustomSplits(state.trip?.members || []);
    });
  });

  document.querySelectorAll("#accom-split-mode-row .split-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _accomSplitMode = btn.dataset.mode;
      document.querySelectorAll("#accom-split-mode-row .split-mode-btn").forEach(b => b.classList.toggle("active", b === btn));
      const customDiv = document.getElementById("accom-custom-splits");
      customDiv.style.display = _accomSplitMode === "custom" ? "block" : "none";
      if (_accomSplitMode === "custom") renderAccomCustomSplits(state.trip?.members || []);
    });
  });
}
