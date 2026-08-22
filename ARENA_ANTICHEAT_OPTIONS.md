# Arena anti-cheat — the remaining problem and the two ways to fix it

Written 2026-08-02, the night before launch. Nothing here is urgent for launch day.
This is the reference for the post-launch discussion.

---

## The problem in one paragraph

When a duel ends, **one of the two phones** decides who won and writes the result
(wins, losses, EIQ) into the database. There is no server checking that a game
actually happened — the phone is both the player and the scorekeeper.

Firestore security rules can check whether a write *looks* correct. They cannot
check whether a real match *happened*, because from the database's point of view a
real match and a fabricated one are the same thing: a phone saying "this happened."

### What is already fixed (published 2026-08-02)

Stats can no longer be written out of thin air. Every wins/losses/EIQ change must
now carry a `lastMatchId` that points at a challenge document which is finishing in
that same instant, between exactly those two players. Challenges must be created as
`pending`, can only reach `completed` from `playing`, and are frozen once completed
so the same match can never be counted twice.

### What is still possible

Someone technical can fabricate the *match* instead of the stats: write a script
that creates a challenge document and walks it through the normal steps
(pending → accepted → playing → completed), then claims the win.

**Limits on the damage:**

- Each fake match moves at most ±100 EIQ and one win/loss. No jackpot.
- Each one needs a brand-new challenge document — the same one can't be reused.
- Climbing the leaderboard means creating hundreds of fake match records, all of
  which sit permanently in the database where they can be seen and undone.
- It is not doable by tapping the screen. It requires extracting the Firebase
  config from the app and writing custom code against it.

**Risk verdict:** acceptable for a closed test with known testers. Matters once the
app is public and the leaderboard is worth cheating for.

---

## Option A — App Check

**What it is:** a gate in front of the database. Firebase App Check verifies that a
request came from your genuine, unmodified app, installed from the Play Store, on a
real device. Anything else — a script, a desktop browser, a repackaged APK — is
rejected before it reaches a single security rule.

**Why it fits this problem:** the attack *requires* running custom code against
Firestore. App Check refuses that code outright. It doesn't make the phone
trustworthy; it makes sure only your real app can talk to the database at all.

**Cost:** free. No Blaze plan, no card on file.

**Roughly what's involved:**

1. Enable App Check in the Firebase Console, using the **Play Integrity** provider.
2. Register the app's signing certificate (SHA-256) — the same keystore used for the
   Play Store build.
3. Add `@capacitor-firebase/app-check` (matches the v8 `@capacitor-firebase/*`
   packages already in `package.json`).
4. Bridge the token into the JavaScript Firestore SDK. This is the fiddly part —
   see the caveat below.
5. Run in **monitoring mode** first, watch the Console metrics until real traffic
   shows as verified, and only then turn on **enforcement**.

**The real caveat:** this app is Capacitor, so the game talks to Firestore through
the *JavaScript* SDK, while App Check's Play Integrity attestation happens on the
*native* side. The native token has to be handed to the JS SDK through a
`CustomProvider`. This works, but it's the step to test carefully — if enforcement
is switched on while that bridge is misconfigured, **your own app gets locked out of
its own database.** That is exactly why step 5 exists: monitoring mode first, always.

**What it does not fix:** the phone is still the scorekeeper. Someone running a
rooted device or a modified build could in principle still get through. The bar goes
from "anyone who can write a script" to "someone willing to defeat Play Integrity" —
a large jump, but not infinity.

---

## Option B — Cloud Functions

**What it is:** the root-cause fix. Move the "who won" decision off the phone and
onto Google's servers. Phones just report their own score; a small program on the
server reads both scores, decides the winner, and writes the stats itself.

Once that's in place, the security rules can forbid phones from writing
wins/losses/EIQ **entirely** — not "bounded," not "must show a match," but flatly
impossible. Fabricating a match stops working because a fabricated match has no real
scores behind it and the server, not the phone, does the deciding.

**Cost:** requires the **Blaze (pay-as-you-go) plan**, which means a card on file.
Blaze includes a monthly free allowance that an app this size would very likely stay
inside — but that is a likelihood, not a promise, and it's worth setting a budget
alert in the Console.

**Roughly what's involved:**

1. Upgrade the Firebase project to Blaze and set a budget alert.
2. `firebase init functions` — this project currently has no `functions/` directory
   and no `firebase.json`, so this is new setup.
3. Port the match-result logic (`completeMatchInTx` in `lib/challengeEngine.js` —
   winner selection, EIQ swing, forfeit rules, the lockout logic) into a function
   that triggers when a challenge document updates.
4. Simplify the three client paths that currently complete matches — `submitScore`,
   `forfeitMatch`, `resolveAbandonedMatch` — so they only report a score or a
   forfeit, and never write stats.
5. Delete the whole bounded stat-write branch from `firestore.rules`.
6. Deploy and test a real duel end to end.

**The real risk:** this rewrites match completion — the single most important path in
Arena, and the one that has *never* been tested with two real devices. A bug here
doesn't cause cheating; it causes duels to never finish at all, which is worse than
the problem being solved. This should be done deliberately, with two phones in hand
to test against, not in a rush.

---

## How they compare

| | App Check | Cloud Functions |
|---|---|---|
| Stops the practical attack | Yes | Yes |
| Fixes the root cause | No — phone still scorekeeper | Yes |
| Money | Free | Blaze plan, card on file |
| Size of job | Smaller | Larger |
| Worst case if botched | Own app locked out of database | Duels stop completing |
| Touches game logic | No | Yes — the critical path |

They are not either/or. **App Check first** is the better order: it's free, it
doesn't touch the game logic, and it blocks the realistic version of this attack.
Cloud Functions is the thing to do before going fully public, when the leaderboard
actually means something.

---

## Suggested sequence

1. **Launch.** Ship as-is. The current rules already block the easy version of this.
2. **Confirm a real 2-device duel works.** Still the biggest untested risk in Arena —
   bigger than cheating. Everything else waits behind this.
3. **Add App Check during the 14-day closed test.** Monitoring mode first, enforce
   only once the Console shows real traffic verifying.
4. **Add Cloud Functions before opening to the public**, if the leaderboard is going
   to be a real feature people care about.
