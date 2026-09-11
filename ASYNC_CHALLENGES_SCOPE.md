# Asynchronous friend challenges — scope (deferred)

Status: **not built.** This documents what it would take, so the decision is on
record rather than rushed.

## What exists today (synchronous only)

Arena duels are real-time. Both players must be online at the same moment:

- `lib/challengeEngine.js` — `sendChallenge` writes a `challenges/{id}` doc, the
  recipient's `ChallengeContext` listener shows a banner, both clients count
  down against a shared `matchStartAt`, play a fixed 45s, and `submitScore`
  settles it once **both** scores are in.
- Presence (`lib/presence.js`) gates who you can even invite — a `lastSeen`
  heartbeat, ~3 writes/session, consumed only by the Friends list.
- The "push a duel to an offline friend" idea was already rejected on cost — see
  the memory note *Offline duel gate 2026-09-08*: it needs a server (Blaze plan
  or Vercel function) to send the FCM push, and the app is a static export with
  no backend.

## What "async friend challenge" would require

A player sets a score on drill X and challenges a friend to beat it within N
hours; the friend plays whenever they like; the result resolves later.

1. **Data model** — a new `asyncChallenges/{id}` collection: `fromUid`, `toUid`,
   `drillSlug`, `fromScore`, `fromRunAt`, `expiresAt`, `toScore`, `status`,
   `winner`. Distinct from `challenges/` because the lifecycle is days, not
   seconds, and there is no lobby / countdown / shared clock.
2. **firestore.rules** — a new ruleset for that collection: creator sets their
   own score once, recipient sets theirs once, neither can edit the other's, a
   `getAfter` check that `winner` is computed correctly, TTL cleanup. This is
   the bulk of the risk — the current Arena rules took several passes to get
   right (see `ARENA_ANTICHEAT_OPTIONS.md`, `firestore.rules`).
3. **Anti-cheat** — the async score is submitted from an unobserved solo run, so
   it inherits the existing "fake match" hole (`ARENA_CHEAT_WATCHLIST.md`) with
   no live opponent to bound it. Acceptable at current scale, same as today.
4. **Notification** — the recipient needs to know a challenge is waiting. In-app
   is easy (a listener + a card on Home / Arena). A *push* when the app is
   closed is the same server dependency that blocked the offline-duel feature,
   so v1 would be in-app only: "3 challenges waiting" shows next time they open
   the app, and the existing local daily reminder is the only push.
5. **UI** — a "Challenge a friend" action on the solo result screen, an
   "Incoming / Outgoing" list (the Arena `Invites` tab could host it), and a
   result card when one resolves.
6. **Expiry** — client-side sweep like `cleanupStaleChallenges`, plus a rules
   TTL, so abandoned challenges don't accumulate.

## Rough size

~1 new lib file (~200 lines), a firestore.rules block + deploy (the risky bit),
2–3 UI surfaces, and a new `ChallengeContext` subscription. Small-to-medium, but
the rules work needs the same care the sync Arena rules got, and shipping it
half-done (no expiry, loose rules) would be worse than not shipping it.

## Recommendation

Defer until the daily-session loop has retention data behind it. If async
challenges are added, do the rules first and in isolation, the way the sync
Arena rules were hardened.
