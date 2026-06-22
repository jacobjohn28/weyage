/* ─────────────────────────────────────────────────────────────
   FIREBASE CONFIG
   ───────────────────────────────────────────────────────────── */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA5zjXweiXgFakCYMQCE0tEkUrhI4UqwiM",
  authDomain: "weyage-ed0cb.firebaseapp.com",
  projectId: "weyage-ed0cb",
  storageBucket: "weyage-ed0cb.firebasestorage.app",
  messagingSenderId: "1002189778782",
  appId: "1:1002189778782:web:81493906785a07658b69cf"
};

/* ─────────────────────────────────────────────────────────────
   GEMINI CONFIG
   ───────────────────────────────────────────────────────────── */
export const GEMINI_CONFIG = {
  apiKey: "",
  model: "gemini-3.1-flash-lite",
};

export const PEXELS_CONFIG = { apiKey: "" };

/* ─────────────────────────────────────────────────────────────
   CLOUDINARY CONFIG  (free tier — no auth required for uploads)
   1. Sign up at cloudinary.com (free)
   2. Dashboard → Settings → Upload → Upload presets → Add preset
      → set Signing Mode to "Unsigned" → save → copy the preset name
   3. Copy your Cloud name from the top-left of the Cloudinary dashboard
   ───────────────────────────────────────────────────────────── */
export const CLOUDINARY_CONFIG = {
  cloudName:    "dkzhgcons",   // e.g. "dxyz123abc"
  uploadPreset: "Weyage",   // e.g. "weyage_unsigned"
};

/* ─────────────────────────────────────────────────────────────
   PUSH NOTIFICATIONS  (free — native Web Push / VAPID, no FCM)
   Notifies signed-in shared-trip viewers + collaborators when new
   gallery photos are added. Sending is done by a small serverless
   function (see /notify-service) that holds the VAPID PRIVATE key.

   • vapidPublicKey  — safe to ship in the client (it's public).
   • notifyEndpoint  — the deployed Vercel function URL; fill in after
                       first deploy, e.g. "https://<proj>.vercel.app/api/notify".
   • enabled         — master feature flag. Keep false until the endpoint
                       is live and verified end-to-end, then flip to true.
   ───────────────────────────────────────────────────────────── */
export const PUSH_CONFIG = {
  enabled: true,
  vapidPublicKey: "BOzgKmhAH82w0D3KhBH44r8FrxE3knBUJ-Q2y7UOoWt7Iu514V-ghydXPAWLoXKR8OjCopjhAETGfrHXGUZvNak",
  notifyEndpoint: "https://weyage.vercel.app/api/notify",
};

/* ─────────────────────────────────────────────────────────────
   FIREBASE SDK
   ───────────────────────────────────────────────────────────── */
export const FIREBASE_VERSION = "10.13.2";
export const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

/* ─────────────────────────────────────────────────────────────
   APP VERSION — single source of truth, rendered in the sidebar,
   the mobile "more" sheet, and Site Settings. Keep CACHE_NAME in
   sw.js in sync on each release (documented bump step).
   ───────────────────────────────────────────────────────────── */
export const APP_VERSION = "1.4.1.30";
