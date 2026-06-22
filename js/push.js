import { PUSH_CONFIG } from "./config.js";
import { db, auth, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "./firebase.js";

/* ─────────────────────────────────────────────────────────────
   WEB PUSH — client opt-in (native VAPID, no FCM)

   Lets a signed-in shared-trip viewer (or collaborator) subscribe
   their installed PWA to notifications. The actual sending is done
   by the /notify-service serverless function; this module only:
     • checks capability + feature flag
     • subscribes/unsubscribes via the existing service worker
     • stores the PushSubscription under the trip so the sender can
       reach this device.

   Subscription docs live at  trips/{tripId}/pushSubscribers/{id}
   where {id} is a stable hash of the push endpoint (one per device),
   so re-enabling is idempotent and never creates duplicates.
   ───────────────────────────────────────────────────────────── */

function _configured() {
  return !!(PUSH_CONFIG.enabled && PUSH_CONFIG.vapidPublicKey && PUSH_CONFIG.notifyEndpoint);
}

export function pushSupported() {
  return typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
}

/** Only offer push to signed-in, non-anonymous users (per product decision). */
export function pushEligible() {
  const u = auth?.currentUser;
  return _configured() && pushSupported() && !!u && !u.isAnonymous;
}

/* VAPID public key (base64url) → Uint8Array for applicationServerKey. */
function _urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* Stable, filesystem-safe doc id derived from the subscription endpoint. */
async function _subId(endpoint) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

/**
 * Per-trip state for UI. Subscription state is per (trip × device): a
 * browser has at most ONE push subscription, but we keep a subscriber doc
 * per trip, so "subscribed" means a doc exists for THIS trip on THIS device.
 *   "unavailable" — flag off / endpoint not set / not eligible
 *   "unsupported" — browser/PWA can't do web push
 *   "denied"      — user blocked notifications at the OS/browser level
 *   "subscribed"  — this device is opted in for this trip
 *   "idle"        — eligible but not opted in to this trip
 */
export async function getPushState(tripId) {
  if (!_configured() || !pushEligible()) return "unavailable";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || !tripId) return "idle";
    const id = await _subId(sub.endpoint);
    const snap = await getDoc(doc(db, "trips", tripId, "pushSubscribers", id));
    return snap.exists() ? "subscribed" : "idle";
  } catch {
    return "idle";
  }
}

export async function enablePush(tripId) {
  if (!pushEligible()) throw new Error("Notifications aren't available here.");
  const reg = await navigator.serviceWorker.ready;

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was not granted.");

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlB64ToUint8Array(PUSH_CONFIG.vapidPublicKey),
    });
  }

  const u = auth.currentUser;
  const json = sub.toJSON();
  const id = await _subId(sub.endpoint);
  await setDoc(doc(db, "trips", tripId, "pushSubscribers", id), {
    uid: u.uid,
    name: u.displayName || u.email || "Someone",
    email: (u.email || "").toLowerCase(),
    subscription: json,        // { endpoint, keys:{p256dh,auth} } — used by the sender
    endpoint: sub.endpoint,
    userAgent: navigator.userAgent || "",
    createdAt: serverTimestamp(),
  });
  return "subscribed";
}

export async function disablePush(tripId) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try {
      const id = await _subId(sub.endpoint);
      await deleteDoc(doc(db, "trips", tripId, "pushSubscribers", id));
    } catch (e) { console.error("Failed removing push subscriber doc:", e); }
    // NOTE: we intentionally do NOT call sub.unsubscribe(). A browser has a
    // single push subscription shared across all trips, so unsubscribing would
    // silence every other trip too. Removing this trip's doc is enough — the
    // sender only pushes to trips that still reference the device.
  }
  return "idle";
}
