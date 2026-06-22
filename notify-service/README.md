# Weyage notify-service

Tiny serverless function that sends **native Web Push (VAPID)** notifications to
signed-in shared-trip viewers/collaborators when a trip event occurs (today:
gallery photo uploads). Free to run on Vercel's Hobby tier. No FCM, no Firebase
Blaze plan — Firestore stays on the free Spark plan.

## How it fits together

```
client (gallery upload) ──POST {tripId,eventId}+IDtoken──► /api/notify
                                                              │ verify caller is an editor
                                                              │ read event + pushSubscribers (Admin SDK)
                                                              │ web-push to each subscriber (not uploader)
                                                              ▼
                                          viewers' PWA service worker → showNotification
```

## One-time setup

1. **Create a Firebase service account**
   Firebase console → Project Settings → *Service accounts* → **Generate new private key**.
   Download the JSON. Keep it secret (never commit it).

2. **Get the VAPID keys**
   The pair was generated for this project. The **public** key already lives in
   `js/config.js` (`PUSH_CONFIG.vapidPublicKey`). The **private** key is set only
   here as an env var.
   (To regenerate: `npx web-push generate-vapid-keys` — then update both places.)

3. **Deploy on Vercel**
   - New Project → import this GitHub repo.
   - **Root Directory:** `notify-service`
   - Framework preset: *Other*. Build command: none. Output dir: none.
   - Add the environment variables below, then **Deploy**.
   - Your endpoint will be `https://<project>.vercel.app/api/notify`.

4. **Wire the client**
   Put that endpoint into `js/config.js` → `PUSH_CONFIG.notifyEndpoint`, and flip
   `PUSH_CONFIG.enabled` to `true` once verified.

## Environment variables (Vercel → Settings → Environment Variables)

| Name                       | Value                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `FIREBASE_SERVICE_ACCOUNT` | The entire service-account JSON, pasted as a single string  |
| `VAPID_PUBLIC_KEY`         | Same base64url public key as in `config.js`                 |
| `VAPID_PRIVATE_KEY`        | The base64url **private** key (secret)                      |
| `VAPID_SUBJECT`            | `mailto:you@example.com`                                     |
| `ALLOWED_ORIGIN`           | Your site origin, e.g. `https://<you>.github.io` (for CORS) |

## Local test (optional)

```bash
cd notify-service
npm install
# set the env vars in your shell, then use `vercel dev`
```

## Extending later

Add a new event `type` where you emit it in the client, then add a `case` in
`buildMessage()` in `api/notify.js`. The subscription, auth, and send paths stay
the same.
