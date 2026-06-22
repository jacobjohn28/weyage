/* ============================================================
   Weyage — push notification sender  (Vercel serverless function)

   Native Web Push (VAPID). Triggered by the client AFTER a gallery
   upload batch: the browser POSTs { tripId, eventId } plus the user's
   Firebase ID token. This function:
     1. verifies the caller is a trip editor (owner/collaborator)
     2. loads the typed event + the trip's push subscribers
     3. builds a message from the event type
     4. sends Web Push to every subscriber except the uploader
     5. prunes expired/invalid subscriptions

   Secrets (set as Vercel env vars — NEVER committed):
     FIREBASE_SERVICE_ACCOUNT  full service-account JSON (string)
     VAPID_PUBLIC_KEY          base64url public key (same as client)
     VAPID_PRIVATE_KEY         base64url private key (secret)
     VAPID_SUBJECT             e.g. "mailto:you@example.com"
     ALLOWED_ORIGIN            e.g. "https://<you>.github.io" (CORS)
   ============================================================ */
const admin = require("firebase-admin");
const webpush = require("web-push");

// One-time init — module scope persists across warm invocations.
if (!admin.apps.length) {
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}
const db = admin.firestore();

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/* Message builder — switch on event type so new types can be added later
   without touching the subscription/send path. Returns null for unknown
   types (silently ignored). The url is relative; the service worker
   resolves it against its own origin when opening/focusing a window. */
function buildMessage(trip, ev) {
  const tripName = trip.name || "your trip";
  switch (ev.type) {
    case "gallery_add": {
      const n = ev.count || 1;
      return {
        title: "Weyage",
        body: `${ev.byName || "Someone"} added ${n} photo${n === 1 ? "" : "s"} to ${tripName}`,
        url: `/weyage/?share=${trip.shareToken || ""}#gallery`,
        tag: `gallery-${ev.cityId || "trip"}`,
      };
    }
    default:
      return null;
  }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1) Verify caller identity (Firebase ID token).
    const authz = req.headers.authorization || "";
    const idToken = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (!idToken) return res.status(401).json({ error: "Missing token" });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerEmail = (decoded.email || "").toLowerCase();

    // 2) Inputs.
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { tripId, eventId } = body;
    if (!tripId || !eventId) return res.status(400).json({ error: "Missing tripId/eventId" });

    // 3) Authorize — caller must be a trip editor.
    const tripSnap = await db.doc(`trips/${tripId}`).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "Trip not found" });
    const trip = tripSnap.data();
    const editors = (trip.allowedUsers || []).map(e => String(e).toLowerCase());
    const isEditor = editors.includes(callerEmail) ||
      (trip.createdBy || "").toLowerCase() === callerEmail;
    if (!isEditor) return res.status(403).json({ error: "Not authorized for this trip" });

    // 4) Load the typed event.
    const evSnap = await db.doc(`trips/${tripId}/events/${eventId}`).get();
    if (!evSnap.exists) return res.status(404).json({ error: "Event not found" });
    const ev = evSnap.data();

    const msg = buildMessage(trip, ev);
    if (!msg) return res.status(200).json({ sent: 0, skipped: "unknown event type" });

    // 5) Fan out — every subscriber except the uploader. Prune dead tokens.
    const subsSnap = await db.collection(`trips/${tripId}/pushSubscribers`).get();
    const shareUrl = `/weyage/?share=${trip.shareToken || ""}#gallery`;
    const mainUrl  = `/weyage/?notifyTrip=${tripId}&notifyView=gallery`;
    let sent = 0, removed = 0;
    await Promise.all(subsSnap.docs.map(async (d) => {
      const s = d.data();
      if (s.uid && ev.byUid && s.uid === ev.byUid) return; // skip uploader's own devices
      if (!s.subscription) return;
      // Share-page viewers get the share URL; main-app editors/owners get the main app URL.
      const url = s.shareView ? shareUrl : mainUrl;
      const payload = JSON.stringify({ ...msg, url });
      try {
        await webpush.sendNotification(s.subscription, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await d.ref.delete().catch(() => {});
          removed++;
        } else {
          console.error("push send error", err.statusCode, err.body || err.message);
        }
      }
    }));

    return res.status(200).json({ sent, removed });
  } catch (err) {
    console.error("notify error", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
