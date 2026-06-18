import { FIREBASE_CONFIG, FIREBASE_BASE } from "./config.js";

/* ─────────────────────────────────────────────────────────────
   FIREBASE SDK — populated by initFirebase(), exported as live bindings
   so all importers see the updated values after init resolves.
   ───────────────────────────────────────────────────────────── */
export let app = null;
export let auth = null;
export let db = null;

// Auth SDK functions
export let getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, signInAnonymously;

// Firestore SDK functions
export let initializeFirestore, persistentLocalCache;
export let doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs;
export let onSnapshot, writeBatch, serverTimestamp, arrayUnion, addDoc;
export let query, where, arrayRemove, deleteField;

// Storage SDK functions
export let storage = null;
export let storageRef, uploadBytes, getDownloadURL, deleteObject;

export function isConfigured() {
  return FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("REPLACE_ME");
}

export async function initFirebase() {
  // Load all Firebase modules in parallel
  const [appMod, authMod, fsMod, storageMod] = await Promise.all([
    import(`${FIREBASE_BASE}/firebase-app.js`),
    import(`${FIREBASE_BASE}/firebase-auth.js`),
    import(`${FIREBASE_BASE}/firebase-firestore.js`),
    import(`${FIREBASE_BASE}/firebase-storage.js`),
  ]);

  const { initializeApp } = appMod;
  ({ getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, signInAnonymously } = authMod);
  ({ initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, updateDoc, deleteDoc,
     collection, getDocs, onSnapshot, writeBatch, serverTimestamp, arrayUnion, addDoc,
     query, where, arrayRemove, deleteField } = fsMod);
  ({ getStorage: _getStorage, ref: storageRef, uploadBytes, getDownloadURL, deleteObject } = storageMod);

  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  storage = _getStorage(app);
}

let _getStorage;
