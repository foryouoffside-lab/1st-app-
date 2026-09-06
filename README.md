# SkillDrills

A cognitive training app: 24 timed drills for attention, focus, memory,
problem-solving and processing speed, plus a 1v1 Arena.

Two products share this one repo — see `LAUNCH_COMPLIANCE.md` before editing
anything user-facing:

- **The Android app** (`com.skilldrills.pro`) — the real product, built with
  Capacitor from the static Next.js export.
- **The website** — the same build, deployed for the store's required legal
  pages (privacy, terms, account deletion).

## What's in it

- **24 drills**, all in the Cognitive category: attention (6), focus (4),
  memory (3), problem-solving (2), processing speed (9).
- **Solo endurance runs** — the clock is the only fail state. Every clean hit
  buys back a little time, and the payout decays as the level climbs, which is
  what makes a run eventually end. All of that lives in `lib/drillRules.js`.
- **Arena** — real-time 1v1 duels on a shared absolute deadline, over Firestore.
  6 of the 24 drills are duel-eligible (`DUEL_DRILLS` in `lib/challengeEngine.js`).
- **Daily challenge**, XP/levels, streaks and a leaderboard.
- Google sign-in is required for the Arena and the leaderboard.

## Tech

- Next.js 15 (App Router, `output: 'export'` — fully static, no server)
- React 18, Tailwind CSS
- Capacitor 8 for the Android build
- Firebase Auth + Firestore (Arena, leaderboard, profiles)
- Solo play is entirely local — progress lives in device storage, not Firestore

## Local development

```bash
npm install
npm run dev
```

## Android

```bash
npm run mobile:live      # fastest loop: live-reload onto a connected device
npm run mobile:build     # next build + cap sync android
npm run mobile:release   # release bundle
```

## Security rules

`firestore.rules` is the real security boundary (the Firebase web config in
`lib/firebase.js` is public by design). It is **not** deployed automatically —
publish it from the Firebase Console, or matches silently fail to record.

## License

All rights reserved.
