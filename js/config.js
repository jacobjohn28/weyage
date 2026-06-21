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
   FIREBASE SDK
   ───────────────────────────────────────────────────────────── */
export const FIREBASE_VERSION = "10.13.2";
export const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

/* ─────────────────────────────────────────────────────────────
   APP VERSION — single source of truth, rendered in the sidebar,
   the mobile "more" sheet, and Site Settings. Keep CACHE_NAME in
   sw.js in sync on each release (documented bump step).
   ───────────────────────────────────────────────────────────── */
export const APP_VERSION = "1.4.1.16";
