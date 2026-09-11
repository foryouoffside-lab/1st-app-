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

**Then, 2026-08-24: the mid-duel score sync was deleted outright.** Nothing
displayed the running value (the snapshot listener swallowed playing→playing
updates and the result screen uses the separately-submitted final scores), and
both walk-out paths — `forfeitMatch` and `resolveAbandonedMatch` — force the
winner regardless of score, so it only ever decorated the history row of an
abandoned match. Those rows now read 0–0 and lead with "won/lost by forfeit".
This removed ~6 writes per player per duel, about a third of a duel's cost.
**Do not reintroduce a live opponent score without pricing the writes first** —
and note the design decision behind it: a blind 30s duel with a reveal at the
end was judged better than one where a player who sees they're far ahead coasts
and one who sees they're far behind gives up.

**Capacity after all that, on the free tier:** roughly 800 duel matches/day
(~550 before the score sync was deleted), ~400+ duelling players/day, ~500
Arena browsers/day. These are DAILY CUMULATIVE limits — concurrency is a
non-issue, Firestore allows a million simultaneous connections. "500 people at
once" is fine; "500 people duelling over 24 hours" is the ceiling.

**Correction, 2026-09-10 — "solo players are unlimited" is no longer true.**
PLAYING is still free and always will be: a drill run makes zero network calls,
online or offline. But three things added since this brief was written cost
writes for merely being signed in with the app open, whether the player duels
or not:

  - `lib/presence.js` (2026-09-08), an app-wide `online`/`lastSeen` heartbeat;
  - the level-badge sync in `AuthContext` (2026-09-07);
  - `lib/progressCloud.js` (2026-09-10), the cloud progress backup.

Counted properly, a signed-in solo player cost ~11 writes per session, of which
presence was ~6 — the biggest single line on the whole budget. Two fixes
shipped the same day:

  1. **The duplicate presence writer is gone.** `AuthContext` had its own
     visibilitychange/beforeunload pair writing the SAME two fields as
     `presence.js` on the SAME events, so every foreground/background was
     billed twice over — and each of those writes ALSO cost a read, because the
     profile `onSnapshot` listener watches the very doc being written.
  2. **Presence now only runs for players who have friends.** It is read by
     nothing but the Arena's Friends tab (green dot + Duel button gate), so for
     an empty friends list every one of those writes was read by nobody.
     `AppShellClient` gates `startPresence` on a friend count cached by the
     Arena's own friends listener (`setKnownFriendCount`).

Known trade-off of (2): a friendless player stops advertising presence 8
minutes after sign-in, so they drop out of OTHER players' global "Online"
opponent list unless they are actually sitting on the Arena screen — which has
its own heartbeat, and is exactly when they want a duel anyway.

**Solo-only capacity now: ~4,000-5,000 players/day at one session each**
(~4 writes per session), versus ~1,700 before these two fixes. Writes still
bind before reads.

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

## Firestore — what is actually live right now (checked & deployed 2026-09-01)

Plain-language state of the database, so nobody has to go digging in the console.

| Thing | State |
|---|---|
| Database | `(default)`, Firestore **Native** mode, STANDARD edition |
| Security rules | **Live and identical to `firestore.rules` in this repo** — the CLI reported "already up to date" and re-released them |
| Composite indexes | **None, and none are needed** (see the section below) |
| Field exemptions | One: `users.photoURL` is no longer indexed |
| Collections in use | `users`, `usernames`, `challenges`, `matchmaking_queue` |
| Data integrity | 2 user docs ↔ 2 username reservations, no orphans, **no doc carries a legacy `email` field** |
| Automated backups | **None configured** (Firestore backups need the Blaze plan) |

Deploy both halves any time with:

    firebase deploy --only firestore:rules
    firebase deploy --only firestore:indexes

`firebase firestore:indexes` prints what is live, so you can always compare it
against `firestore.indexes.json` without opening the console.

### Two levers left deliberately unpulled

- **Completed duels are never deleted.** The cleanup sweep in
  `challengeEngine.js` only removes stale `pending`/`accepted`/`declined`
  invites; a `completed` challenge is kept forever on purpose, because
  `firestore.rules` reads it back with `getAfter()` to prove a stat write came
  from a real match, and its immutability is what stops one match id being
  replayed. Each doc is small, so this is a storage question and not an urgent
  one — but it grows with every duel ever played. If storage ever becomes the
  pinch, the fix is a **TTL policy** on the challenge docs rather than a code
  change. Be aware that expiring them also removes that far back in a player's
  Arena match history, so it is a product decision, not just cleanup.
- **Backups.** Nothing is backed up. With a handful of test accounts that costs
  nothing to ignore; once real players have EIQ and win/loss records worth
  keeping, turn on a backup schedule (needs Blaze) before you need it.


## Firestore indexes — why `firestore.indexes.json` is (almost) empty

Checked every query in the app on 2026-09-01. **No composite index is needed,
and none is declared.** That is not an oversight:

- Firestore auto-creates a single-field index for every field, so a query with
  ONE `where` (or one `orderBy`, like the leaderboard's `orderBy('eiq','desc')`)
  is served with no configuration.
- A query with SEVERAL `where(... '==' ...)` filters and no `orderBy` is served
  by merging those single-field indexes. Every multi-filter query here is that
  shape — `fromUid` + `status`, `toUid` + `status`, `toUid` + `status` on the
  open-challenge feed. **A composite index is only required when you mix a
  filter with an `orderBy`/range on a DIFFERENT field.**
- So if you ever add an `orderBy` next to a `where` — say, ordering open
  challenges by `createdAt` in the query instead of sorting in JS the way
  `HomePageClient.js` does today — that query WILL need a composite index and
  will fail until one exists. Add it here and redeploy rather than clicking the
  link in the console error, so the repo stays the source of truth.

### The one entry that IS here: `users.photoURL` is exempt from indexing

Profile photos are stored inline on the user document as a base64 `data:` URL
(no Firebase Storage, no Blaze plan needed) and `firestore.rules` caps them just
under 300 KB. Firestore would otherwise index that whole string twice, ascending
and descending, on a field nothing ever queries or sorts by — roughly doubling
the storage each user document costs and slowing every profile write. The
exemption turns that off. It is safe precisely because `photoURL` is only ever
read back as a value, never filtered or ordered on; if that ever changes, this
override has to go first or the new query will not work.

Deploy with:

    firebase deploy --only firestore:indexes


## Quick reference for future me

| Question | Answer |
|---|---|
| Can it crash from too many users? | No. Static app, solo play is offline. |
| What breaks then? | Firestore refuses requests when the daily free quota is gone. |
| Will Crashlytics tell me? | **No.** Check Firestore → Usage instead. |
| How many can it handle free? | ~800 duels/day, or ~4,000-5,000 solo players/day. PLAYING is free; being signed in with the app open is what costs. |
| Concurrent user limit? | Effectively none. The limits are daily totals. |
| First thing to do when it breaks? | Switch to Blaze + set a budget alert. |
| Could I get a surprise bill? | Very unlikely — no Cloud Functions, no Storage. |
