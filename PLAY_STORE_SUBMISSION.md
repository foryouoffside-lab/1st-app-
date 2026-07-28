# Play Store Submission — Reference Content

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
5. Build the signed `.aab` and upload it to a **Closed testing** track first.
6. Recruit 12 opt-in testers, wait 14 continuous active days (new-account requirement).
7. Once that's satisfied, promote to Production.

---

## 1. App identity

- **App name:** SkillDrills Pro
- **Package name:** com.skilldrills.pro
- **Category:** Education (or Puzzle/Trivia — "Education" fits best given the
  cognitive-training framing; pick whichever Play Console suggests as closest match)
- **Contains ads:** No
- **In-app purchases:** No
- **Price:** Free

---

## 2. Store listing text

**Short description** (max 80 characters):
```
Train focus, memory & reaction time with 24 free brain training drills.
```
(72 characters)

**Full description** (max 4000 characters):
```
SkillDrills Pro is a free cognitive training app with 24 science-based drills across five categories — Attention, Focus, Memory, Problem Solving, and Processing Speed.

TRAIN YOUR MIND
Sharpen the mental skills that matter every day: staying focused under distraction, holding information in working memory, reacting faster, and thinking clearly under pressure. Every drill adapts its difficulty as you improve, so you're always training at the edge of your ability.

DAILY CHALLENGES
A new set of challenges rotates in every day, keeping your training varied and building a real streak — miss a day and your streak resets, so there's a reason to come back.

ARENA — HEAD-TO-HEAD DUELS
Challenge other players in real-time 1v1 duels across a rotating set of drills. Win to climb the EIQ ranking ladder — a competitive score built from both your performance and the difficulty of the drill.

TRACK YOUR PROGRESS
See your best scores, streaks, and XP level over time, all saved to your account so your progress follows you across sessions.

WHY SKILLDRILLS
- 24 free drills, no paywall, no ads
- Sign in with Google — no separate password to remember
- Your solo drill scores and progress stay on your device
- Built for quick, focused sessions — most drills run 30-45 seconds
```

**Contact email:** skilldrills.contact@gmail.com

**Privacy policy URL:** https://skilldrills.online/privacy

---

## 3. Graphic assets

- **App icon (512x512):** already have it — `public/icons/icon-512x512.png`
- **Feature graphic (1024x500):** done — `store-assets/feature-graphic-1024x500.png`
  (1024x500 exact, RGB/no alpha, matches Play's spec). Source is
  `store-assets/feature-graphic.html` if it ever needs edits — open it in a
  browser at 1024x500 or re-render with a headless browser screenshot.
- **Screenshots:** already captured, sitting in the `New folder` at the repo
  root (Processing Speed hub, Grid Memorization gameplay, etc.) — upload those
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
