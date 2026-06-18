import { db, collection, addDoc, deleteDoc, updateDoc, doc, serverTimestamp } from "./firebase.js";
import { state, setState } from "./state.js";
import { escapeHtml, btnLoading, btnReset } from "./utils.js";

/* ─────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────── */
function _contactsPath() {
  const email = state.user?.email?.toLowerCase();
  if (!email) throw new Error("Not signed in");
  return collection(db, "contacts", email, "people");
}

export function contactNameForEmail(email) {
  if (!email) return null;
  const c = state.contacts.find(c => c.email.toLowerCase() === email.toLowerCase());
  return c ? c.name : null;
}

/* ─────────────────────────────────────────────────────────────
   RENDER
   ───────────────────────────────────────────────────────────── */
export function renderContactsPanel() {
  const list = document.getElementById("ff-contacts-list");
  const empty = document.getElementById("ff-empty");
  if (!list) return;

  const contacts = state.contacts;
  if (!contacts.length) {
    list.innerHTML = "";
    if (empty) empty.style.display = "";
    return;
  }
  if (empty) empty.style.display = "none";

  const groups = [
    { key: "family",  label: "Family" },
    { key: "friends", label: "Friends" },
    { key: null,      label: "Other" },
  ];

  let html = "";
  groups.forEach(({ key, label }) => {
    const members = contacts.filter(c => (c.group ?? null) === key);
    if (!members.length) return;
    html += `<div class="ff-group-label">${label}</div>`;
    members.forEach(c => {
      html += `
        <div class="ff-contact-row" data-id="${escapeHtml(c.id)}">
          <div class="ff-contact-avatar">${escapeHtml((c.name || "?").charAt(0).toUpperCase())}</div>
          <div class="ff-contact-info">
            <div class="ff-contact-name">${escapeHtml(c.name)}</div>
            <div class="ff-contact-email">${escapeHtml(c.email)}</div>
          </div>
          <button class="ff-contact-delete icon-btn" data-id="${escapeHtml(c.id)}" title="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
    });
  });

  list.innerHTML = html;

  list.querySelectorAll(".ff-contact-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteContact(btn.dataset.id));
  });
}

/* ─────────────────────────────────────────────────────────────
   CRUD
   ───────────────────────────────────────────────────────────── */
export async function addContact() {
  const nameEl  = document.getElementById("ff-add-name");
  const emailEl = document.getElementById("ff-add-email");
  const groupEl = document.getElementById("ff-add-group");
  const errEl   = document.getElementById("ff-add-error");
  const btn     = document.getElementById("ff-add-btn");

  const name  = nameEl.value.trim();
  const email = emailEl.value.trim().toLowerCase();
  const group = groupEl.value || null;

  if (!name) { errEl.textContent = "Name is required."; errEl.style.display = ""; return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = "Enter a valid email address."; errEl.style.display = ""; return;
  }
  if (state.contacts.some(c => c.email.toLowerCase() === email)) {
    errEl.textContent = "This email is already in your contacts."; errEl.style.display = ""; return;
  }

  errEl.style.display = "none";
  btnLoading(btn, "Adding…");
  try {
    await addDoc(_contactsPath(), { name, email, group, addedAt: serverTimestamp() });
    nameEl.value = "";
    emailEl.value = "";
    groupEl.value = "friends";
  } catch (err) {
    errEl.textContent = "Failed to add: " + err.message;
    errEl.style.display = "";
  } finally {
    btnReset(btn);
  }
}

async function deleteContact(contactId) {
  if (!confirm("Remove this contact?")) return;
  try {
    const email = state.user?.email?.toLowerCase();
    await deleteDoc(doc(db, "contacts", email, "people", contactId));
  } catch (err) {
    console.error("Delete contact:", err);
  }
}

/* ─────────────────────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────────────────────── */
export function initContactsPanel() {
  document.getElementById("ff-add-btn")?.addEventListener("click", addContact);
  document.getElementById("ff-add-email")?.addEventListener("keydown", e => {
    if (e.key === "Enter") addContact();
  });
}
