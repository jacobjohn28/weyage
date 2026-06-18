# Setup Guide — Trip Companion

This is a one-time setup. Plan for about 15–20 minutes. Once done, you and your wife both visit the same URL on any device, sign in with Google, and see the same live-syncing trip.

You'll do three things:
1. **Firebase** — free backend for auth, database, and file storage
2. **Configure the HTML file** — paste your Firebase keys and the two allowed emails
3. **GitHub Pages** — host the file on a private repo with a stable HTTPS URL

---

## Part 1 — Firebase (10 minutes)

Firebase is Google's free backend. The free tier is far more than this app will ever need (1 GB database, 5 GB file storage, unlimited Google sign-ins).

### 1.1 Create the project

1. Go to **https://console.firebase.google.com**
2. Click **Add project**
3. Name it anything memorable — e.g. `trip-france-2026`
4. **Disable Google Analytics** when prompted (not needed, just adds noise)
5. Wait ~30 seconds for the project to be created, then **Continue**

### 1.2 Enable Authentication

1. In the left sidebar, click **Build → Authentication**
2. Click **Get started**
3. Under "Sign-in providers", click **Google**
4. Toggle **Enable**
5. Pick a **Project public-facing name** (e.g. "Trip Companion") and a **Project support email** (your email)
6. Click **Save**

### 1.3 Enable Firestore Database

1. In the left sidebar, click **Build → Firestore Database**
2. Click **Create database**
3. Choose a **location** close to you (e.g. `eur3 (europe-west)` for Europe). **This can't be changed later.**
4. Choose **Start in production mode** — we'll add custom security rules in a moment
5. Click **Create**

### 1.4 Enable Storage

1. In the left sidebar, click **Build → Storage**
2. Click **Get started**
3. Choose **Start in production mode**
4. Pick the **same location** as your Firestore
5. Click **Done**

### 1.5 Register a web app and get your config

1. Click the **gear icon** (top left, next to "Project Overview") → **Project settings**
2. Scroll to **Your apps**
3. Click the **`</>` icon** (web app)
4. Give it a nickname (e.g. "Trip Web")
5. **Do not check** "Also set up Firebase Hosting"
6. Click **Register app**
7. You'll see a `firebaseConfig` object. **Keep this tab open** — you'll copy these values in Part 2.

It will look like:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "trip-france-2026.firebaseapp.com",
  projectId: "trip-france-2026",
  storageBucket: "trip-france-2026.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123..."
};
```

> **Security note:** It's normal and safe for this config to be embedded in the HTML. These keys identify your project but don't grant access on their own — the security rules below are what protect your data.

### 1.6 Add Firestore security rules

1. In the left sidebar, click **Build → Firestore Database → Rules** tab
2. Replace the entire contents with this, **then change the two emails** to yours and your wife's Google account emails:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isApproved() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/appUsers/$(request.auth.token.email));
    }

    // App users allowlist — read-only for the user themselves, managed via Firebase Console
    match /appUsers/{email} {
      allow read: if request.auth != null && request.auth.token.email == email;
      allow write: if false;
    }

    // Site-wide config (Pexels/Gemini API keys etc.) — admin write only
    match /config/site {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
        request.auth.token.email == "your.email@gmail.com";
    }

    // Trips
    match /trips/{tripId} {
      allow create: if isApproved() &&
        request.auth.token.email in request.resource.data.allowedUsers;

      allow read: if request.auth != null && (
        resource.data.shareToken != null ||
        request.auth.token.email in resource.data.allowedUsers ||
        request.auth.token.email in resource.data.get('shareViewers', [])
      );

      allow update, delete: if isApproved() &&
        request.auth.token.email in resource.data.allowedUsers;

      // Allow share viewers to record themselves in shareViewers
      allow update: if request.auth != null
        && request.auth.firebase.sign_in_provider != 'anonymous'
        && resource.data.shareToken != null
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['shareViewers']);

      // Catch-all for any other subcollections — approved users only
      match /{subcollection=**} {
        allow read, write: if isApproved() &&
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers;
      }

      // Towns — approved users can read/write; share-link viewers can read
      match /towns/{townId} {
        allow read: if request.auth != null && (
          get(/databases/$(database)/documents/trips/$(tripId)).data.shareToken != null ||
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers
        );
        allow write: if isApproved() &&
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers;
      }

      // Spots — same as towns
      match /spots/{spotId} {
        allow read: if request.auth != null && (
          get(/databases/$(database)/documents/trips/$(tripId)).data.shareToken != null ||
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers
        );
        allow write: if isApproved() &&
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers;
      }

      // City Gallery — same read access as towns/spots
      match /cityGallery/{photoId} {
        allow read: if request.auth != null && (
          get(/databases/$(database)/documents/trips/$(tripId)).data.shareToken != null ||
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers
        );
        allow write: if isApproved() &&
          request.auth.token.email in
            get(/databases/$(database)/documents/trips/$(tripId)).data.allowedUsers;
      }
    }

    // Friends & Family contacts — each user owns their own contact book
    match /contacts/{ownerEmail}/people/{contactId} {
      allow read, write: if request.auth != null &&
        request.auth.token.email.lower() == ownerEmail.lower();
    }
  }
}
```

3. Click **Publish**

### 1.7 Add Storage security rules

1. In the left sidebar, click **Build → Storage → Rules** tab
2. Replace the contents with this, **using the same two emails**:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {

    function isAllowed() {
      return request.auth != null && request.auth.token.email in [
        'your.email@gmail.com',
        'wife.email@gmail.com'
      ];
    }

    match /{allPaths=**} {
      allow read, write: if isAllowed();
    }
  }
}
```

3. Click **Publish**

### 1.8 Authorize your domain (do this after Part 3)

You'll do this step after you've set up GitHub Pages and have your URL.

---

## Part 2 — Configure the HTML file (2 minutes)

Open `index.html` in any text editor (VS Code, Notepad, the GitHub web editor — anything works).

### 2.1 Paste your Firebase config

Find this block near the top of the `<script>` section:

```javascript
const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME_API_KEY",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME_PROJECT_ID",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME_SENDER_ID",
  appId: "REPLACE_ME_APP_ID"
};
```

Replace each `REPLACE_ME_*` value with the value from your Firebase config (step 1.5).

### 2.2 Add the two allowed emails

A few lines below, find:

```javascript
const ALLOWED_EMAILS = [
  // "your.email@gmail.com",
  // "wife.email@gmail.com",
];
```

Uncomment both lines and replace with your two Google account emails. **Use the same emails as in your Firestore and Storage rules** — they must match exactly.

```javascript
const ALLOWED_EMAILS = [
  "your.email@gmail.com",
  "wife.email@gmail.com",
];
```

Save the file.

---

## Part 3 — GitHub Pages (5 minutes)

This gives you a stable HTTPS URL that works on your phone and supports "Add to Home Screen".

### 3.1 Create a private repository

1. Go to **https://github.com/new**
2. Repository name: anything (e.g. `trip-2026`)
3. **Set it to Private**
4. **Check** "Add a README file"
5. Click **Create repository**

### 3.2 Upload the files

1. On the repo page, click **Add file → Upload files**
2. Drag in both `index.html` and `SETUP.md`
3. Scroll down, write a commit message like "initial setup", click **Commit changes**

### 3.3 Enable GitHub Pages

1. In the repo, click **Settings** (top tab)
2. In the left sidebar, click **Pages**
3. Under **Source**, choose **Deploy from a branch**
4. Branch: **main**, folder: **/ (root)**
5. Click **Save**
6. Wait ~1 minute. Refresh the Pages settings page — you'll see a green box with your URL, like:

   `https://yourusername.github.io/trip-2026/`

### 3.4 Authorize the domain in Firebase

Now go back to Firebase to finish step 1.8:

1. **https://console.firebase.google.com** → your project → **Authentication → Settings → Authorized domains** tab
2. Click **Add domain**
3. Paste the domain part only (no `https://`, no path) — e.g. `yourusername.github.io`
4. Click **Add**

---

## Part 4 — Try it (1 minute)

1. Visit your GitHub Pages URL on your laptop
2. Click **Continue with Google**, sign in with one of your allowed emails
3. You should land on the dashboard with the 5 towns of the trip displayed

If you see an error like "this trip is private", check that the email you signed in with matches one of the `ALLOWED_EMAILS` in the HTML.

### Add to your phone home screen

1. Open your GitHub Pages URL on your phone
2. **iOS Safari:** Share button → **Add to Home Screen**
3. **Android Chrome:** menu (⋮) → **Add to Home screen**

The app now opens fullscreen like a native app, with offline support after the first visit.

### Share with your wife

Send her the URL. She signs in with her Google account (must match the second email in your `ALLOWED_EMAILS`), and from that moment she sees the same trip you do, live-syncing.

---

## Troubleshooting

**"Sign-in failed: auth/unauthorized-domain"**
You missed step 3.4. Add your GitHub Pages domain to Firebase Authorized domains.

**"This trip is private. xxx is not on the guest list."**
The email you signed in with isn't in `ALLOWED_EMAILS`. Edit the HTML, push the change, wait ~1 min for GitHub Pages to redeploy.

**"Missing or insufficient permissions" in console**
Your Firestore/Storage security rules don't include the email you're signed in with. Update both rules files in the Firebase console and click Publish.

**Sign-in popup gets blocked**
Some browsers block popups. Allow popups for your GitHub Pages domain.

**Changes to index.html don't appear**
GitHub Pages takes ~1 minute to redeploy after a commit. Hard-refresh your browser (Cmd/Ctrl + Shift + R).

---

## What's next

Phase 1 is the foundation: auth, allowlist, theme, layout, and the seeded trip data. Coming in later phases:

- **Phase 2:** Add and edit spots (restaurants, sights, experiences), draggable itinerary cards, the detail drawer
- **Phase 3:** Interactive map (Leaflet), food view, dashboard widgets
- **Phase 4:** Attachments (QR codes, ticket photos), the budget tracker with charts
- **Phase 5:** Service worker for offline use, map tile pre-caching, sync polish

Each phase will be a drop-in replacement for `index.html` that preserves the data already in Firestore.

---

## Quick reference — emails

You need to update **three places** with the same two emails:

| Location | Where |
|---|---|
| `index.html` | The `ALLOWED_EMAILS` array near the top of the script |
| Firestore rules | The `isAllowed()` function in the Rules tab |
| Storage rules | The `isAllowed()` function in the Rules tab |

If sign-in works but data won't load, mismatched emails between these three places is the most common cause.
