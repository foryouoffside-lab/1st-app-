# SCALING PLAYBOOK — paste this into Claude Code when the app gets busy

**How to use this file:** when players start complaining the Arena is broken, or
you see Firestore usage climbing, open a new Claude Code chat in this repo and
paste the prompt below. Everything it needs to know is in it.

---

## THE PROMPT (copy from here down)

My app SkillDrills is live on the Play Store and getting busier. I need you to
work out whether I'm hitting Firebase limits and fix whatever is needed. Read
this whole brief before touching anything.

### Architecture — don't re-derive this

- Next.js with `output: 'export'` — fully static, bundled into the APK via
  Capacitor. **There is no server of mine to overload.** Hosting can't be the
  problem.
- Solo drills persist through `lib/progressStore.js` → `lib/storage.js`
  (Capacitor Preferences / localStorage). **Solo play never touches the network.
  Solo players cannot cost me anything or break anything.**
- The ONLY metered service is **Firestore**. Firebase Auth, Analytics and
  Crashlytics are free and unlimited. Firebase **Storage is not enabled** and
  there are **no Cloud Functions** — so there is no runaway-billing path.
- All backend logic is client-side. Match completion happens in a Firestore
  transaction in `lib/challengeEngine.js` (`completeMatchInTx`).
- `firestore.rules` has no CLI configured — it must be published by hand via the
  Firebase Console. Check it's current before blaming code.

### What failure actually looks like

Firestore does not crash and does not slow down. When the daily free quota is
gone it **refuses every request until midnight UTC**. The app keeps running,
solo drills keep working, and the Arena / leaderboard / profile sync silently
stop. **Crashlytics will report nothing.** So:

- Do NOT look for crash reports.
- DO ask me for a screenshot of Firebase Console → Firestore → Usage, and check
  daily **writes against 20,000** and **reads against 50,000** (free tier).
- Writes are almost always the binding limit, not reads.

### Work already done (2026-08-03) — do not redo any of this

A full load audit was already carried out. These are fixed and shipped:

1. Arena lobby listener was reading every pending challenge app-wide with no
   limit — now `toUid == 'global'` + `status == 'pending'` + `limit(30)`, with
   direct invites merged in from `ChallengeContext`.
2. `getServerClockOffset` was prewarmed for every user on every app open — now
   only runs on entering the Arena. Samples cut 5 → 3.
3. `cleanupStaleChallenges` read a slice of the whole collection — now scoped
   `fromUid == uid` + `limit(20)`.
4. Two Arena effects keyed on the whole `user` object (which AuthContext
   replaces on every profile write) were re-running constantly — now keyed on a
   stable `uid`.
5. Profile avatars are base64 stored inline in the user doc; upload now steps
   JPEG quality down until it fits a 14KB budget.
6. Matchmaking poll 4s → 8s (`MATCHMAKING_POLL_MS`).
7. Live duel score sync 800ms → 5s (`SCORE_SYNC_INTERVAL_MS` in
   `components/DrillWrapper.js`). This was the single biggest cost.

**Capacity after all that, on the free tier:** ~550 duel matches/day, ~400
duelling players/day, ~500 Arena browsers/day, solo-only players effectively
unlimited. These are DAILY CUMULATIVE limits — concurrency is a non-issue,
Firestore allows a million simultaneous connections. "500 people at once" is
fine; "500 people duelling over 24 hours" is the ceiling.

### What to do, in this order

**Step 1 — measure before changing anything.** Get the usage numbers from me.
If daily writes are under ~15,000, the quota is NOT the problem and you should
look for an actual bug instead. Don't optimise on a hunch.

**Step 2 — if I'm near or over the limit, tell me to switch to the Blaze plan
first.** This is almost always the right answer and it is nearly free:

- Blaze keeps the exact same free daily allowance and only bills the excess.
- Reads are $0.06 per 100,000. At 2-3x my current ceiling this is single-digit
  dollars a month.
- There is no hard spend cap in Firebase, so tell me to set a budget alert. The
  usual runaway-bill causes (recursive Cloud Functions, Storage egress) do not
  exist in this project.
- Blaze also unlocks Firebase Storage, which several fixes below need.

**Step 3 — free code-level wins, roughly best-first.** Only if still needed:

- **Cache the leaderboard.** `ChallengeArenaClient` refetches 50 user docs every
  time the Ranks tab is opened. A 60-second in-memory cache removes nearly all
  of it.
- **Avatars off the user doc.** This is the biggest remaining item and it is
  bandwidth, not document count. Every avatar is an inline base64 blob that
  rides along with the online-players read (40 docs), the leaderboard (50), and
  a COPY is stamped into every challenge doc as `fromPhoto`/`toPhoto` by
  `sendChallenge`. Moving avatars to Firebase Storage and storing a URL instead
  would cut Arena bandwidth by roughly 90%. Needs Blaze.
- **Make the online-players list a one-shot fetch** with a manual refresh button
  instead of a live `onSnapshot`. It currently re-delivers documents on every
  presence flip, and presence churn scales with playercount.
- **Move presence to Realtime Database.** RTDB has native `onDisconnect` and is
  dramatically cheaper than Firestore for high-churn presence writes. This is
  the standard fix and worth doing before anything exotic.
- **Trim Arena duel history** — two `limit(40)` queries on tab open.

**Step 4 — real scale (thousands of daily duellers).** In rough priority:

- **Move match completion into a Cloud Function.** This kills two birds: it caps
  the per-match write cost, and it closes the known cheat hole where two
  cooperating accounts can fabricate completed matches to grind EIQ. See
  `ARENA_CHEAT_WATCHLIST.md` and `ARENA_ANTICHEAT_OPTIONS.md` in this repo — I
  knowingly shipped with that hole open, so only raise it if I'm at this scale.
- **Enable App Check** to stop scripted clients hammering the database.
- **Rethink matchmaking.** `scanForMatch` reads `limit(25)` queue docs; with
  thousands queued that's an arbitrary slice and match quality degrades. Would
  need bucketing by EIQ band or a server-side matcher.

### Rules of engagement

- Verify claims against the actual code before acting. Past agent audits in this
  project have made confidently wrong claims about dead code.
- Don't change `firestore.rules` unless genuinely required — I have to publish
  rules by hand, and a forgotten publish silently breaks match recording.
- Ask before anything that costs money or is hard to undo.
- Plain language please. I'm semi-technical and cost-conscious.

## (end of prompt)

---

## Quick reference for future me

| Question | Answer |
|---|---|
| Can it crash from too many users? | No. Static app, solo play is offline. |
| What breaks then? | Firestore refuses requests when the daily free quota is gone. |
| Will Crashlytics tell me? | **No.** Check Firestore → Usage instead. |
| How many can it handle free? | ~550 duels/day. Solo players: unlimited. |
| Concurrent user limit? | Effectively none. The limits are daily totals. |
| First thing to do when it breaks? | Switch to Blaze + set a budget alert. |
| Could I get a surprise bill? | Very unlikely — no Cloud Functions, no Storage. |
