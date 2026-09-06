# Play Launch Gate — pre-submission audit, 2026-09-02

Goal: **approved on the first review.** Everything below came from an actual
audit of this working tree, not a generic checklist. Companion docs:
`LAUNCH_COMPLIANCE.md` (legal), `PLAY_STORE_SUBMISSION.md` (copy-paste content).

Every change below was verified by rebuilding the signed release bundle:
TypeScript clean, static export clean, `app-release.aab` at 6.4 MB targeting
API 36.

---

## 0. Status

| | Count |
|---|---|
| Would have been rejected on upload | **2** — both fixed |
| Fixed in code this pass | 9 |
| Only you can do (browser-only) | 4 |
| Signed AAB | builds clean, 6.4 MB |

---

## 1. The two that would have been rejected automatically

Play blocks these at upload — a human reviewer never sees the app.

### 1a. Target API level was 35; Play requires 36 — FIXED

Since **2026-08-31**, every new app must target Android 16 (API 36). This app
targeted Android 15, so the upload would have been refused outright.

- `android/variables.gradle` — `compileSdkVersion` and `targetSdkVersion`
  35 → **36**
- `android/build.gradle` — Android Gradle Plugin 8.9.1 → **8.13.0**, which is
  what Capacitor 8 builds against for compileSdk 36
- AndroidX bumped to Capacitor 8's expected versions (activity 1.11.0,
  core 1.17.0, fragment 1.8.9)

Verified: the merged release manifest reads `targetSdkVersion="36"`.

### 1b. WebView remote debugging was left switched on — FIXED

`capacitor.config.ts` still had `webContentsDebuggingEnabled: true` from the
2026-09-02 Arena debugging session, with a comment saying it must go back to
false before any release build. In a shipped app this exposes the WebView to
`chrome://inspect` from any machine that can reach the phone over adb — a
signed-in player's session can be read straight out of localStorage.

It is no longer a flag anyone has to remember:

```ts
webContentsDebuggingEnabled: !!devUrl,
```

On during `npm run mobile:live`, structurally impossible to leave on in a
release build (`mobile:release` sets no `CAP_DEV_URL`).

---

## 2. Checked against the built bundle — already passing

- **16 KB memory page support.** Required for all new apps. The one native
  library (`libdatastore_shared_counter.so`, from Firebase) was read straight
  out of the AAB — all four architectures align at 16384 bytes.
- **Permissions are minimal and justified.** Six remain: INTERNET,
  ACCESS_NETWORK_STATE, VIBRATE, POST_NOTIFICATIONS, WAKE_LOCK,
  RECEIVE_BOOT_COMPLETED. No location, camera, storage or contacts. No
  `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` (those need a separate Play
  declaration and are a common rejection). Notifications are requested at
  runtime correctly in `lib/dailyReminder.js`.
- **Legal URLs live.** `/privacy`, `/terms` and `/delete-account` all return
  200 on skilldrills.online, reachable without an account.
- **No secrets in the shipped bundle.** The only key present is the Firebase
  Web API key, which is a public client identifier by design. The release
  keystore and `keystore.properties` are correctly gitignored and have never
  been committed (checked the full history).
- **Store listing makes no efficacy claims.** The §2 copy is the rewritten
  claim-free version.

### Advertising ID permission removed — FIXED

Firebase Analytics was merging in `com.google.android.gms.permission.AD_ID`
plus the two `ACCESS_ADSERVICES_*` permissions. Left alone you would have had
to answer *"yes, this app uses an advertising ID"* in Play Console and carry a
matching Data Safety declaration for data the app never touches — the kind of
mismatch reviewers flag.

The app has no ads and no ad attribution, so they are now stripped in
`android/app/src/main/AndroidManifest.xml` with `tools:node="remove"`.
Analytics still works (it runs off the Firebase app-instance ID).

> **Answer "No" to the advertising ID question in Play Console.**
> If an ad SDK is ever added, delete that manifest block and update the
> declarations in the same change.

---

## 3. Only you can do these — browser only

### 3a. Add Play's app-signing SHA-1 to Firebase — WILL FAIL THE REVIEW IF SKIPPED

This is the single most common reason a Capacitor + Firebase app fails its
first review.

When you upload the AAB, **Play re-signs it with its own certificate.** Google
Sign-In is keyed to a certificate fingerprint. Right now `google-services.json`
knows exactly two:

- `e9e140f8…` — your upload keystore
- `1fbf3f72…` — this laptop's debug keystore

Play's app-signing certificate is not among them, because it does not exist
yet. The result: sign-in works perfectly for you, and fails with error `12500`
for **everyone who installs from Play** — including the reviewer, who will
report that the app cannot be used, and reject it.

**After your first upload:**

1. Play Console → Test and release → App integrity → App signing → copy the
   **SHA-1**
2. Firebase Console → Project settings → Your apps → **Add fingerprint**
3. Re-download `google-services.json` into `android/app/` (not strictly
   required, but keeps the repo honest)
4. Install from the Play test link yourself and confirm sign-in works

Do this **before** sending the build to testers or to review.

### 3b. Take the OAuth consent screen out of Testing mode

If it is still in "Testing", only email addresses on the test-user list can
sign in — the reviewer is locked out exactly like 3a.

Google Cloud Console → project `skilldrills-42ddc` → **Google Auth Platform →
Audience**. Publishing status must read **In production**. While there, set the
App name to `SkillDrills` under **Branding**, so the consent screen stops
reading "Sign in to skilldrills-42ddc.firebaseapp.com".

### 3c. Publish the tightened Firestore rules

`firestore.rules` had `allow read: if true` on both `users/{uid}` and
`usernames/{name}` — readable by anyone on the internet, signed in or not.
Since the whole app sits behind `AuthGate` and every read happens after
`onAuthStateChanged` returns a real user, that was strictly wider than anything
the app has ever needed. It let a stranger scrape every player's display name
and inline base64 profile photo, and burn the project's daily read quota at
will.

Both are now `allow read: if request.auth != null`.

```
firebase deploy --only firestore:rules
```

> **Before you deploy:** confirm the *website* project does not read Firestore
> unauthenticated. If it shows a public leaderboard, say so and the rule can be
> scoped instead of tightened.

### 3d. Restrict the Firebase API key

The key in the bundle is public by design and cannot be hidden — but an
unrestricted key can be lifted and used against other Google APIs billed to
your project.

Cloud Console → APIs & Services → Credentials. Restrict it to the Android app
(package name + SHA-1) and to only the APIs this app calls: Identity Toolkit,
Cloud Firestore, Firebase Installations.

### 3e. Declare 13+, never a children's age band

Privacy policy and Terms both say 13+. The moment any band under 13 is ticked,
Play's Families policy applies and brings a separate, stricter review. A
mismatch between the policy text and the Play declaration is a routine
rejection.

---

## 4. Bugs found and fixed

Not policy items — real defects. The first two a reviewer could plausibly hit.

### Privacy and Terms were behind the sign-in wall — FIXED

`components/AuthGate.js` kept a list of paths that stay public, with a comment
saying reviewers need to reach them without an account. But `next.config.js`
sets `trailingSlash: true`, so those routes load at `/privacy/` — and the list
held `/privacy`. `PUBLIC_PATHS.includes(pathname)` therefore never matched, and
**every legal page was gated.** Now normalised through `isPublicPath()`, with
`/delete-account` added.

### The error and 404 screens rendered invisible text — FIXED

`app/error.js` and `app/not-found.js` still wore the website's light palette
(`text-gray-900`, `text-gray-600`, `bg-white`) on the app's `#050508`
background — near-black text on a near-black ground. A reviewer hitting either
screen would have seen a blank page. Repainted for the dark theme.

### Five drills re-rendered themselves mid-play for nothing — FIXED

The four `.tsx` reaction drills each kept a `level` value in React state that
nothing on screen ever read; `StrobeLatencyClient.js` did the same with
`flashDuration`. Every level-up (and, for the strobe, every hit) re-rendered
the entire drill component during gameplay with no visible effect. Removed —
the live values already live in refs the game loop reads directly, so
difficulty behaviour is unchanged (`levelRef` writes intact in all four).

### Dead code removed

- `lib/drillRules.js` — `levelForScore` and `stepLevel`. Their own docblocks
  claimed Arena and Quick Dodge still used them; neither did.
- `styles/globals.css` — 8 unreferenced rules, ~2.5 KB, including `.xp-track` /
  `.xp-fill` which styled the deleted `components/MobileHeader.js`, and
  `.drill-row` / `.drill-list` which the hub's preview-card grid replaced.
  Zero unreferenced custom classes remain.
- Discarded per-frame locals in three drill render loops, one dead import
  (`rampUp`), one dead destructure (`regions`), one dead assignment
  (`startLvl`).
- `.gitignore` — added `*.log`; firebase-tools drops `firebase-debug.log` into
  the repo root on every deploy.
- `PLAY_STORE_SUBMISSION.md` §2 — a stale warning box under the *new* listing
  copy said "do not submit the description above as written". It referred to
  the pre-2026-08-22 copy. Reading it in order told you the opposite of what it
  meant.

### Scans that came back clean

- Repo-wide ESLint correctness pass (no-undef, dupe keys, unreachable code,
  const reassignment, unsafe optional chaining, and ~20 more): **no real
  errors**. The only hits are four TypeScript DOM lib types the JS parser
  cannot see.
- `tsc --noEmit`: clean.
- Unused-export scan across all 108 source files: nothing dead left.

---

## 5. Do it in this order

Steps 3 and 4 must happen after the first upload but before anyone signs in.

1. Publish the Firestore rules (after the website check in 3c)
2. Fix the OAuth consent screen (3b) and restrict the API key (3d)
3. Upload `android/app/build/outputs/bundle/release/app-release.aab` to a
   **Closed testing** track
4. **Add Play's app-signing SHA-1 to Firebase (3a), then install from the test
   link and confirm sign-in works**
5. Complete App content — Data Safety, content rating, target audience 13+,
   ads = No, **advertising ID = No**, deletion URL
6. Fill Store listing from `PLAY_STORE_SUBMISSION.md` §2; assets are in
   `store-assets/`
7. Run the 12-tester / 14-day closed test, then promote to Production

---

## 6. One thing to expect

The **review** genuinely can pass first time, and everything above is aimed at
exactly that.

But there is a separate gate that is not a review and cannot be shortened: a
new *personal* developer account must run a closed test with **at least 12
testers who stay opted in for 14 continuous days** before Production unlocks.
It is a waiting period, not a judgement — nothing about the app affects it.
Start recruiting testers the day you upload the first build, or that clock
becomes the longest part of the launch.

---

## 7. Still open — not touched by this pass

- The **LAWYER** items in `LAUNCH_COMPLIANCE.md` §5, chiefly the GDPR
  Article 27 EU/UK representative.
- The debug keystore fingerprint (`1fbf3f72…`) is registered in Firebase. Normal
  for development, low risk, but it does mean a debug-signed build from this
  machine can authenticate as the app. Remove it from Firebase once you no
  longer need debug sign-in.
- `resolveProfile()` in `contexts/AuthContext.js` queries `users` by email for
  legacy pre-Google-auth accounts. The rules forbid `email` in user documents,
  so this query can never match — it costs one wasted Firestore read on every
  new sign-in. Left in place because it is a documented migration path; delete
  it once you are sure no legacy accounts remain.
- On-device verification of Android 16 edge-to-edge. Apps targeting API 36
  cannot opt out of edge-to-edge; Capacitor 8 handles it, but it has not been
  seen running on a real Android 16 device.
