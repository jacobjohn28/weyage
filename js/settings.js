import { state, activeTripId, _tripSettingsId, setTripSettingsId } from "./state.js";
import { db, doc, updateDoc, deleteDoc, arrayRemove, arrayUnion } from "./firebase.js";
import { escapeHtml, emailToName } from "./utils.js";
import { CURRENCY_LIST } from "./budget.js";

/* ─────────────────────────────────────────────────────────────
   CALLBACK REGISTRATION
   ───────────────────────────────────────────────────────────── */
const cb = {};
export function registerSettingsCallbacks({ exitToTripList }) {
  Object.assign(cb, { exitToTripList });
}

/* ─────────────────────────────────────────────────────────────
   TRIP SETTINGS DRAWER
   ───────────────────────────────────────────────────────────── */
let _tsExtraCurrencies = [];
let _tsMembers = [];

export const MEMBER_COLORS = [
  "#4E8774","#5B8CCC","#C86B4B","#8E6BBE",
  "#B8874E","#4DA6A8","#CC6B8E","#7A9E3E",
];

export function membersWithCollaborators(trip) {
  const allEmails   = [...new Set([trip.createdBy, ...(trip.allowedUsers || [])].filter(Boolean))];
  const storedNames = trip.collaboratorNames || {};
  const current     = (trip.members || []).map(m => ({ ...m }));
  allEmails.forEach((email, i) => {
    if (!current.some(m => m.email === email)) {
      const name = storedNames[email]
        || (email === state.user?.email?.toLowerCase() ? state.user?.displayName : null)
        || emailToName(email);
      current.push({
        id:    "mbr-" + Date.now().toString(36) + i,
        name,
        color: MEMBER_COLORS[current.length % MEMBER_COLORS.length],
        email,
      });
    }
  });
  return current;
}

function renderTripSettingsMembers() {
  const container = document.getElementById("ts-members-list");
  if (!container) return;
  const countEl = document.getElementById("ts-members-count");
  if (countEl) countEl.textContent = _tsMembers.length || "";
  if (!_tsMembers.length) {
    container.innerHTML = `<div style="font-size:0.8125rem;color:var(--text-3);font-style:italic;padding:4px 0">No participants yet.</div>`;
    return;
  }
  container.innerHTML = _tsMembers.map(m => `
    <div class="ts-member-item">
      <div class="ts-member-avatar" style="background:${escapeHtml(m.color || "#888")}">${escapeHtml(m.name.charAt(0).toUpperCase())}</div>
      <span class="ts-member-name">${escapeHtml(m.name)}</span>
      <button class="ts-member-remove" data-remove-id="${escapeHtml(m.id)}" title="Remove" type="button">×</button>
    </div>`).join("");
  container.querySelectorAll(".ts-member-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      _tsMembers = _tsMembers.filter(m => m.id !== btn.dataset.removeId);
      renderTripSettingsMembers();
    });
  });
}

function renderExtraCurrencyChips() {
  const container = document.getElementById("ts-extra-currencies");
  if (!container) return;
  container.innerHTML = _tsExtraCurrencies.length
    ? _tsExtraCurrencies.map(code => `
        <span class="currency-chip">
          ${escapeHtml(code)}
          <button class="currency-chip-remove" data-code="${escapeHtml(code)}" aria-label="Remove ${escapeHtml(code)}" type="button">×</button>
        </span>`).join("")
    : `<span style="font-size:0.8125rem;color:var(--text-3);font-style:italic">None added yet</span>`;
  container.querySelectorAll(".currency-chip-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      _tsExtraCurrencies = _tsExtraCurrencies.filter(c => c !== btn.dataset.code);
      renderExtraCurrencyChips();
    });
  });
}

export function openTripSettings(tripId) {
  const trip = state.allTrips.find(t => t.id === tripId);
  if (!trip) return;
  setTripSettingsId(tripId);

  document.getElementById("ts-name").value = trip.name || "";
  document.getElementById("ts-start").value = trip.startDate || "";
  document.getElementById("ts-end").value = trip.endDate || "";

  const tsCurrSel = document.getElementById("ts-currency");
  tsCurrSel.innerHTML = CURRENCY_LIST.map(c =>
    `<option value="${c.code}"${c.code === (trip.currency || "EUR") ? " selected" : ""}>${c.label}</option>`
  ).join("");

  function refreshAddCurrencySel() {
    const home   = document.getElementById("ts-currency").value;
    const taken  = new Set([home, ..._tsExtraCurrencies]);
    const addSel = document.getElementById("ts-add-currency-sel");
    addSel.innerHTML = `<option value="">Add a currency…</option>` +
      CURRENCY_LIST.filter(c => !taken.has(c.code)).map(c =>
        `<option value="${c.code}">${c.label}</option>`
      ).join("");
  }
  _tsExtraCurrencies = [...(trip.extraCurrencies || [])];
  renderExtraCurrencyChips();
  refreshAddCurrencySel();

  tsCurrSel.onchange = () => { refreshAddCurrencySel(); renderExtraCurrencyChips(); };

  const addBtn = document.getElementById("ts-add-currency-btn");
  addBtn.onclick = () => {
    const sel  = document.getElementById("ts-add-currency-sel");
    const code = sel.value;
    if (!code || _tsExtraCurrencies.includes(code)) return;
    _tsExtraCurrencies.push(code);
    renderExtraCurrencyChips();
    refreshAddCurrencySel();
  };

  document.getElementById("ts-save-error").style.display = "none";
  const saveBtn = document.getElementById("ts-save-btn");
  saveBtn.textContent = "Save changes"; saveBtn.disabled = false;

  ["ts-collab-section", "ts-members-section"].forEach(id => {
    const section = document.getElementById(id);
    if (!section) return;
    section.classList.remove("open");
    const toggle = section.querySelector(".ts-section-toggle");
    toggle.onclick = () => section.classList.toggle("open");
  });

  renderTripSettingsCollaborators(trip);
  document.getElementById("ts-collab-name").value = "";
  document.getElementById("ts-email").value = "";
  document.getElementById("ts-add-error").style.display = "none";

  _tsMembers = membersWithCollaborators(trip);
  renderTripSettingsMembers();
  document.getElementById("ts-member-name").value = "";
  document.getElementById("ts-member-error").style.display = "none";
  document.getElementById("ts-add-member-btn").onclick = () => {
    const nameInput = document.getElementById("ts-member-name");
    const errEl = document.getElementById("ts-member-error");
    const name = nameInput.value.trim();
    if (!name) { errEl.textContent = "Enter a name."; errEl.style.display = "block"; return; }
    if (_tsMembers.some(m => m.name.toLowerCase() === name.toLowerCase())) {
      errEl.textContent = "A participant with this name already exists."; errEl.style.display = "block"; return;
    }
    errEl.style.display = "none";
    const color = MEMBER_COLORS[_tsMembers.length % MEMBER_COLORS.length];
    _tsMembers.push({ id: "mbr-" + Date.now().toString(36), name, color });
    nameInput.value = "";
    renderTripSettingsMembers();
  };

  const isCreator = trip.createdBy === state.user?.email?.toLowerCase();
  document.getElementById("ts-danger-section").style.display = isCreator ? "block" : "none";

  document.getElementById("trip-settings-overlay").classList.add("visible");
  history.pushState({ weyageTripSettings: true }, "");
}

export function closeTripSettings() {
  document.getElementById("trip-settings-overlay").classList.remove("visible");
  setTripSettingsId(null);
}

function renderTripSettingsCollaborators(trip) {
  const container = document.getElementById("ts-access-list");
  if (!container || !trip) return;
  const users = trip.allowedUsers || [];
  const countEl = document.getElementById("ts-collab-count");
  if (countEl) countEl.textContent = users.length || "";
  const isCreator = trip.createdBy === state.user?.email?.toLowerCase();
  const currentEmail = state.user?.email?.toLowerCase();
  if (!users.length) {
    container.innerHTML = `<div style="font-size:0.875rem;color:var(--text-3);padding:8px 0">No collaborators yet.</div>`;
    return;
  }
  container.innerHTML = users.map(email => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;font-size:0.875rem">
        ${escapeHtml(email)}
        ${email === currentEmail ? ' <span style="color:var(--text-3);font-size:0.75rem">(you)</span>' : ""}
        ${email === trip.createdBy ? ' <span style="color:var(--accent);font-size:0.75rem">owner</span>' : ""}
      </div>
      ${isCreator && email !== currentEmail
        ? `<button class="icon-btn ts-remove-btn" data-email="${escapeHtml(email)}" title="Remove" style="color:var(--danger)">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           </button>`
        : ""}
    </div>
  `).join("");
  container.querySelectorAll(".ts-remove-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const email = btn.dataset.email;
      if (!confirm(`Remove ${email} from this trip?`)) return;
      try {
        await updateDoc(doc(db, "trips", _tripSettingsId), { allowedUsers: arrayRemove(email) });
        const updated = { ...trip, allowedUsers: (trip.allowedUsers || []).filter(e => e !== email) };
        renderTripSettingsCollaborators(updated);
      } catch (err) {
        alert("Failed to remove collaborator: " + (err.message || err.code));
      }
    });
  });
}

export async function saveTripSettings() {
  if (!_tripSettingsId) return;
  const name = document.getElementById("ts-name").value.trim();
  const errEl = document.getElementById("ts-save-error");
  if (!name) { errEl.textContent = "Trip name is required."; errEl.style.display = "block"; return; }
  errEl.style.display = "none";
  const btn = document.getElementById("ts-save-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const savedTripId = _tripSettingsId;
    await updateDoc(doc(db, "trips", savedTripId), {
      name,
      startDate: document.getElementById("ts-start").value || null,
      endDate: document.getElementById("ts-end").value || null,
      currency: document.getElementById("ts-currency").value,
      extraCurrencies: _tsExtraCurrencies,
      members: _tsMembers,
    });
    if (savedTripId === activeTripId) {
      const el = document.getElementById("sidebar-trip-name");
      if (el) el.textContent = name;
    }
    closeTripSettings();
  } catch (err) {
    errEl.textContent = "Failed to save: " + (err.message || err.code);
    errEl.style.display = "block";
    btn.textContent = "Save changes"; btn.disabled = false;
  }
}

export async function addTripCollaborator() {
  const email      = document.getElementById("ts-email").value.trim().toLowerCase();
  const collabName = document.getElementById("ts-collab-name").value.trim();
  const errEl      = document.getElementById("ts-add-error");
  const trip       = state.allTrips.find(t => t.id === _tripSettingsId);
  if (!trip) return;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; return;
  }
  if ((trip.allowedUsers || []).includes(email)) {
    errEl.textContent = "This person already has access."; errEl.style.display = "block"; return;
  }
  errEl.style.display = "none";
  try {
    const updatedNames = { ...(trip.collaboratorNames || {}), [email]: collabName || emailToName(email) };
    const updatedTrip  = { ...trip, allowedUsers: [...(trip.allowedUsers || []), email], collaboratorNames: updatedNames };
    const updatedMembers = membersWithCollaborators(updatedTrip);
    await updateDoc(doc(db, "trips", _tripSettingsId), {
      allowedUsers:      arrayUnion(email),
      collaboratorNames: updatedNames,
      members:           updatedMembers,
    });
    document.getElementById("ts-email").value = "";
    document.getElementById("ts-collab-name").value = "";
    renderTripSettingsCollaborators(updatedTrip);
    _tsMembers = updatedMembers.map(m => ({ ...m }));
    renderTripSettingsMembers();
  } catch (err) {
    errEl.textContent = "Failed to add collaborator: " + (err.message || err.code);
    errEl.style.display = "block";
  }
}

export async function deleteTripFromSettings() {
  const tripId = _tripSettingsId;
  const trip = state.allTrips.find(t => t.id === tripId);
  if (!trip) return;
  const isCreator = trip.createdBy === state.user?.email?.toLowerCase();
  if (!isCreator) return;
  if (!confirm(`Delete "${trip.name}" permanently? This cannot be undone.`)) return;
  try {
    closeTripSettings();
    if (tripId === activeTripId) cb.exitToTripList();
    await deleteDoc(doc(db, "trips", tripId));
  } catch (err) {
    alert("Failed to delete trip: " + (err.message || err.code));
  }
}

export function initSettings() {
  document.getElementById("trip-settings-close")?.addEventListener("click", closeTripSettings);
  document.getElementById("ts-save-btn")?.addEventListener("click", saveTripSettings);
  document.getElementById("ts-add-btn")?.addEventListener("click", addTripCollaborator);
  document.getElementById("ts-delete-btn")?.addEventListener("click", deleteTripFromSettings);
  document.getElementById("trip-settings-backdrop")?.addEventListener("click", closeTripSettings);
}
