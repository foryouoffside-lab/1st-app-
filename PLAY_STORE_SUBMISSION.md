# Play Store Submission — Reference Content

> Companion docs: **`LAUNCH_COMPLIANCE.md`** (legal + Play policy blockers,
> global release) and **`PLAY_STORE_ASO.md`** (how ranking actually works).

Everything below is content to paste directly into Play Console when you submit.
Nothing here is code — this file isn't read by the app or the build, it's just
your copy-paste reference for the day you deploy.

---

## 0. Order of operations (recap)

1. Create Play Developer account (play.google.com/console/signup) — $25 one-time,
   plus identity verification (can take days — start this first).
2. Create the app in Play Console.
3. Fill in App content (Data Safety, content rating, target audience — all below).
4. Fill in Store listing (description, screenshots, icon, feature graphic — below).
5. Set the OAuth consent screen App name in Google Cloud Console (section 1) —
   independent of Play, but do it before testers sign in on the web.
6. Build the signed `.aab` and upload it to a **Closed testing** track first.
7. Recruit 12 opt-in testers, wait 14 continuous active days (new-account requirement).
8. Once that's satisfied, promote to Production.

---

## 1. App identity

- **App name (on-device label):** SkillDrills — set in
  `android/app/src/main/res/values/strings.xml` and `capacitor.config.ts`.
  This is what shows under the launcher icon and in the Google account picker.
  The "Pro" was dropped on 2026-08-23 to match the legal pages, the login
  screen, and the OAuth consent screen.
- **Store listing title:** `SkillDrills: Focus & Reaction` (see §2) — the Play
  title is a separate, keyword-weighted field and does not have to match the
  on-device label.
- **Package name:** com.skilldrills.pro
- **Category:** Education (or Puzzle/Trivia — "Education" fits best given the
  cognitive-training framing; pick whichever Play Console suggests as closest match)
- **Contains ads:** No
- **In-app purchases:** No
- **Price:** Free

### Google sign-in consent screen — needs a Console visit

The Google sign-in consent screen currently reads **"Sign in to
skilldrills-42ddc.firebaseapp.com"**, because Firebase auto-created the OAuth
consent screen and no App name was ever set, so Google falls back to showing
the raw auth domain.

This does **not** affect the Play Store build: on native, sign-in goes through
`FirebaseAuthentication.signInWithGoogle()` (see `contexts/AuthContext.js`,
the `Capacitor.isNativePlatform()` branch), which shows Android's own account
picker with the app name and no domain. Only the website's `signInWithPopup`
path shows this screen.

**To fix (Console only — there is no CLI or API for this, so it cannot be
scripted):** Google Cloud Console -> project `skilldrills-42ddc` -> **Google
Auth Platform -> Branding** (older UI: APIs & Services -> OAuth consent
screen). Set App name to `SkillDrills`, add the app logo, and fill in the
support email and developer contact. The screen then reads "Sign in to
SkillDrills".

Worth doing before opening sign-ups to the public regardless: Google requires
OAuth consent screen verification for published apps, and this same Branding
page is where that process starts.

**Optional, larger:** the popup's URL bar still shows `firebaseapp.com` even
once the name is set. Removing that needs a custom auth domain — attach a
domain to Firebase Hosting (only the default `skilldrills-42ddc.web.app`
exists today), add the DNS records, then change `authDomain` in
`lib/firebase.js` to match. Website-only polish; not needed for the app.

---

## 2. Store listing text

> Rewritten 2026-08-22 to remove efficacy claims — see `LAUNCH_COMPLIANCE.md` §4.
> The previous copy said "science-based" and "sharpen the mental skills that
> matter every day"; both are real-world-improvement claims of the kind the FTC
> fined Lumosity $2M over. This version keeps the appeal and drops the claim.

**Short description** (max 80 characters):
```
24 free reaction, memory and focus drills. Train daily, duel players worldwide.
```
(79 characters)

**Full description** (max 4000 characters):
```
SkillDrills is a free training-game app with 24 drills across five categories - Attention, Focus, Memory, Problem Solving, and Processing Speed.

TRAIN AND COMPETE
Practise the skills each drill measures: holding attention under distraction, keeping information in working memory, reacting quickly under time pressure, and working through problems against the clock. Every drill adapts its difficulty as you improve, so you are always playing at the edge of your ability.

DAILY CHALLENGES
A new set of challenges rotates in every day, keeping your training varied and building a streak - miss a day and your streak resets, so there is a reason to come back.

ARENA - HEAD-TO-HEAD DUELS
Challenge other players to real-time 1v1 duels across a rotating set of drills. Win to climb the EIQ ladder - a competitive ranking built from both your score and the difficulty of the drill. EIQ is a leaderboard ranking inside SkillDrills, not an IQ score or a measure of intelligence.

TRACK YOUR PROGRESS
See your best scores, streaks, and XP level over time, all saved to your account so your progress follows you across sessions.

WHY SKILLDRILLS
- 24 free drills, no paywall, no ads
- Sign in with Google - no separate password to remember
- Your solo drill scores and progress stay on your device
- Built for quick, focused sessions - most drills run 30-45 seconds
- Play solo, or duel players from anywhere in the world

SkillDrills is a set of training games made for practice and entertainment. It is not a medical device or a diagnostic tool, and we make no claim that playing it improves your performance outside the app.
```
(1620 characters)

**Suggested title** (max 30 chars — see `PLAY_STORE_ASO.md` §2):
```
SkillDrills: Focus & Reaction
```
(29 characters. Current "SkillDrills Pro" uses 15 and spends 3 of them on a
word nobody searches for.)

**Contact email:** skilldrills.contact@gmail.com

**Privacy policy URL:** https://skilldrills.online/privacy

**Data deletion URL:** https://skilldrills.online/delete-account
(Play Console -> Data safety -> Data deletion. Required because the app has
accounts. The page is `app/delete-account/page.js`.)

> The warning that used to sit here ("do not submit the description above as
> written") applied to the PRE-2026-08-22 copy, which is gone. Everything in
> §2 is the rewritten, claim-free version and is safe to paste as-is. Leaving
> the old warning under the new copy read as "do not submit this", which is
> the opposite of what it meant.

---

## 3. Graphic assets

- **App icon (512x512):** already have it — `public/icons/icon-512x512.png`
- **Feature graphic (1024x500):** use **`store-assets/feature-graphic-v2.png`**
  (1024x500 exact, RGB/no alpha, 237 KB). Source: `feature-graphic-v2.html`;
  re-render with `node store-assets/render-feature.js <src.html> <out.png>`
  (Playwright + Edge, opaque background — Play rejects alpha here).

  Replaced and DELETED `feature-graphic-1024x500.png` on 2026-09-02 — having
  both in one folder meant the wrong one got uploaded to Play Console once
  already. Two things were wrong with it, and both would be wrong again if
  anyone re-renders the old source: it carried a **"PRO" badge** months after
  the app was renamed to plain "SkillDrills" (contradicting the launcher label,
  capacitor.config.ts, the legal pages and the store title), and it advertised
  "brain training drills" — the efficacy framing that LAUNCH_COMPLIANCE.md §4
  deliberately stripped out of the description. A graphic making a claim the
  description carefully avoids is the version a reviewer reads.
- **Screenshots:** already captured, in `store-assets/screenshots/`
  (Processing Speed hub, Grid Memorization gameplay, etc.) — upload those
  directly. Play requires at least 2; more (4-8) is better for the listing.

---

## 4. Content rating questionnaire — expected answers

Play's rating questionnaire is dynamic, but based on what this app actually is
(no violence, no user-generated content shown publicly beyond a display name,
no gambling, no real-money elements):

- Violence: None
- Sexual content: None
- Profanity: None
- Controlled substances: None
- Gambling/contests with real money: None
- User-generated content shared with others: displayName and photo are visible
  to other players (leaderboard/opponent cards) — declare this honestly if asked
- Shares location: No
- Digitally purchases: No

This should land the app at the lowest rating tier (e.g., "Everyone" / PEGI 3),
but let the actual questionnaire's specific wording decide — answer honestly
question-by-question rather than assuming the tier.

---

## 5. Target audience & content

- **Target age group:** Since sign-in requires a Google account (implicitly
  13+ per Google's own account policy) and there's competitive online
  interaction (Arena duels, public display name/photo) — do NOT mark this as
  primarily targeting children. Select an adult/general audience age range
  (13+ or 18+, whichever Play Console offers as the "not designed for children"
  option) — this must be accurate, since misdeclaring this triggers Play's
  stricter Families policy requirements unnecessarily.

---

## 6. Data Safety form — exact answers

**Does your app collect or share any user data?** → Yes

**Personal info**
| Data type | Collected? | Shared with 3rd parties? | Purpose |
|---|---|---|---|
| Name | Yes | No | App functionality (leaderboard identity) |
| Email address | Yes | No | Account management (Google Sign-In; not stored in the app's database) |

**Photos**
| Data type | Collected? | Shared? | Purpose |
|---|---|---|---|
| Photos | Yes (Google profile photo, or user-uploaded) | No | App functionality (leaderboard/duel cards) |

**App activity**
| Data type | Collected? | Purpose |
|---|---|---|
| App interactions (screen views) | Yes | Analytics |
| Other user-generated content (drill/category/score events) | Yes | Analytics |

**App info and performance**
| Data type | Collected? | Purpose |
|---|---|---|
| Crash logs | Yes (Crashlytics) | App functionality |
| Diagnostics (device model, OS, app version) | Yes | Analytics |

**Device or other IDs**
| Data type | Collected? | Purpose |
|---|---|---|
| Device or other IDs | Yes (Firebase install ID) | Analytics |

**Other standard questions:**
- Is data encrypted in transit? → Yes
- Can users request data deletion? → Yes — in-app: Progress → Delete Account & Wipe Data
- Required or optional? → Name + email: required. Photo: optional (falls back to a generated avatar).

---

## 7. App access (for the reviewer)

Play asks how a reviewer can access full app functionality if login is required.

**Answer:** "All features are accessible immediately after signing in with any
Google account via Google Sign-In (OAuth) — no special test credentials or
restricted access exist. The reviewer can sign in with any Google account
they choose."

---

## 8. Closed testing — what you'll need

- At least **12 testers** who explicitly opt in via the private testing link
  Play Console generates for your closed test.
- They need to remain active for **14 continuous days** before Play unlocks
  Production release for a new developer account.
- Start recruiting testers the moment your first testing build is uploaded —
  this 14-day clock is likely the longest single wait in the whole launch,
  so get it running early rather than leaving it for last.
