# Arena — "something looks fishy" checklist

Keep this. If the leaderboard ever looks wrong, work through this and send me the
answers — that's everything I need to confirm it and fix it.

Background on *why* this is possible: see `ARENA_ANTICHEAT_OPTIONS.md`.
Short version: the phone reports who won, so a technical person could write a
script that fakes a match. Decided on 2026-08-02 to accept this risk and revisit
only if the app grows or something below actually shows up.

---

## 1. What "fishy" actually looks like

You'll notice these just by using your own app — no monitoring needed.

- A player's **wins or EIQ jumps a lot in a short time**, more than they could
  have played in that window. A real duel takes ~30 seconds plus lobby time, so
  roughly 1–2 matches a minute is the honest ceiling.
- **A name you don't recognise** sitting at the top of a small tester group.
- Someone's **win count doesn't match their Results tab** — Arena → Results lists
  the actual matches. If they show 50 wins and 3 match records, something is wrong.
- A player's **EIQ went down for no reason** (they may have been targeted by
  someone else's fake matches, not cheating themselves).

**If none of this ever happens, nothing is happening.** No need to go looking.

---

## 2. Where to look — Firebase Console

Firebase Console → your project → **Firestore Database** → Data.

Two collections matter:

- **`users`** — one document per player. The stats live here: `wins`, `losses`,
  `eiq`, `streak`, and `lastMatchId` (the last match that moved their stats).
- **`challenges`** — one document per duel, including every completed one. This is
  the evidence. **Every fake match leaves a permanent record here.**

Find the suspicious player in `users` (search by `displayName`), then look in
`challenges` for documents where `fromUid` or `toUid` is their uid.

---

## 3. How to tell a real match from a fake one

A genuine completed duel has **all** of these fields. A script that fakes a match
usually won't bother setting them all — missing ones are the tell:

| Field | Set by | Missing = suspicious |
|---|---|---|
| `fromReady` **and** `toReady` | both players' apps loading the duel | Yes — both must be `true` |
| `matchStartAt` | the host, during the 3-2-1 countdown | **Yes — strongest single tell** |
| `startTime` | set when the invite was accepted | Yes |
| `fromEiqGained`, `toEiqGained` | the match-completion step | Yes |
| `fromEiqAfter`, `toEiqAfter` | the match-completion step | Yes |
| `fromScore`, `toScore` | real gameplay | Both `0`, or identical, or absurdly high |

Other things that don't add up in a real match:

- **`createdAt` and the completion are seconds apart.** A real duel is an invite,
  an accept, a lobby, a 3-second countdown, then 30 seconds of play. Under ~40
  seconds start-to-finish is not physically possible.
- **Many completed matches between the same two players in a row**, back to back,
  with no gaps.
- **`abandoned: true` / `forfeitedBy` on every single match** — someone farming
  forfeits rather than playing. (Note: a forfeit win is capped at +8 EIQ by design,
  so this is a slow, weak exploit — but it's a signal.)
- The two accounts were **created at almost the same time** (check `createdAt` in
  `users`) — a sign of one person running two accounts against each other.

---

## 4. What to send me

Copy these out of the Console and paste them to me. Don't worry about tidying it up:

1. **The suspicious player's `users` document** — the whole thing (it contains no
   private data; this doc is publicly readable by design, and email is never stored
   in it).
2. **Two or three of their `challenges` documents** where `status` is `completed`.
3. **Roughly when you noticed**, and what looked wrong ("this account went from 2
   wins to 40 overnight").
4. Whether the **other** account in those matches is someone you recognise.

That's enough for me to confirm whether it's fabricated, work out how many matches
are affected, and give you exact corrected numbers.

---

## 5. Fixing it

Both of these are things you can do yourself in the Console — **Console edits
bypass the security rules**, so you always have the final say over your own data.

**Correct the stats:** open the player's document in `users` and edit `wins`,
`losses`, `eiq`, `streak` back to the right values. Send me the match records first
and I'll tell you what those values should be.

**Delete the fake matches:** delete those documents from `challenges` so they stop
showing in anyone's Results tab.

**If it's persistent or more than a one-off**, that's the trigger to actually add
App Check (`ARENA_ANTICHEAT_OPTIONS.md`, Option A) — free, and it blocks the script
outright rather than cleaning up after it. Tell me and I'll do it.

---

## 6. What is NOT a problem

Don't raise the alarm for these — they're all working as designed:

- **Wins appearing without you remembering the match.** Leaving a live duel is a
  loss for the leaver and a win for whoever stayed. Test sessions generate these.
- **Losing EIQ on a forfeit.** Deliberate — quitting costs the full swing, while the
  winner only gets up to +8, so forfeits can't be used to boost a friend.
- **A player locked out of Arena for 30–60 minutes.** That's the anti-abuse lockout
  after repeated quitting. It clears itself.
- **EIQ moving by different amounts each match.** Expected — the swing scales with
  drill difficulty, score margin, and how expected the result was.
- **A player sitting at 0 EIQ.** It's floored at 0; it can't go negative.
