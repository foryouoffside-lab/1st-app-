# Arena Integration Guide — how to turn a solo drill into an Arena duel

This is the **switchboard** for Arena mode. When you say *"add this drill to Arena,"*
this file is the checklist that makes it a plug‑in job that never touches other drills.

Arena mode = real‑time 1v1 duels. Both players play the **same drill for a fixed 30s**,
the higher score wins, and every match moves your **EIQ** rank. All the shared plumbing
(matchmaking, the countdown, the live opponent, the result screen, the notifications,
the leaderboard) already lives in `components/DrillWrapper.js`, `lib/challengeEngine.js`,
`contexts/ChallengeContext.js`, and `app/challenge/ChallengeArenaClient.js`. A drill only
has to opt in and follow the rules below — **the UI/feel is identical for every drill; only
the drill's own game logic differs.**

---

## The one switchboard entry (start here)

`lib/challengeEngine.js` → `DUEL_DRILLS`. Add one line and the drill appears in
matchmaking, the picker, and the roster. **This is the only shared file you edit.**

```js
export const DUEL_DRILLS = [
  { slug: 'cognitive/processing-speed/quick-dodge', name: 'Quick Dodge', hardness: 1.1 },
  // ... add your drill here:
  { slug: 'cognitive/<cat>/<your-drill>', name: 'Your Drill', hardness: 1.2 },
];
```

- `slug` — the drill's route under `/drills/` (no leading slash).
- `name` — what shows in the picker / result screen.
- `hardness` — 1.0 (easy) … 1.5 (hard). Sets how much **EIQ** is at stake per match
  (harder drill = bigger swing). See "How EIQ works" below.

The **first entry** is the auto‑matchmaking default drill — keep a simple, universally
understandable drill there.

---

## The 10 rules every Arena drill must follow

These are what make a drill "blend into Arena" with the same look, feel, and fairness.
Copy them from any existing Arena drill (Quick Dodge / Shade Finder / Concentration Grid /
Multi‑Tasking are the reference implementations).

1. **Detect duel mode.** Read the challenge id from the URL and derive `isChallenge`:
   ```js
   const searchParams = useSearchParams();
   const challengeId = searchParams ? searchParams.get('challengeId') : null;
   const isChallenge = !!challengeId;
   const totalTime = isChallenge ? 30 : TOTAL_TIME;   // duels are ALWAYS 30s
   ```

   **The duel clock is fixed and untouchable — never add time to it.** Lots of
   solo drills refill or extend the timer as a reward (a full reset on
   round-clear, `+1.5s` per chain, a time penalty on a mistake). Every one of
   those must be gated behind `!isChallenge`. The two duelists run *independent*
   local clocks that agree only because both start at the same `matchStartAt`
   and both count down exactly 30s — so any drill-side change to the clock
   desyncs them: the player earning time plays a longer match, while their
   opponent's 30s expires and strands them on "Waiting for opponent to
   finish...". This bit `Concentration Grid`, `Tower of Hanoi`, and
   `Sequence Aim Trainer` simultaneously (fixed 2026-07-25); it is the single
   easiest way to break Arena, because each drill looks correct on its own.
   ```js
   if (!isChallenge) { timeLeftRef.current = totalTime; }   // solo-only refill
   ```

2. **Synced auto‑start.** Both clients begin at the exact same wall‑clock instant using
   `useDuelMatchStart` (a direct Firestore subscription — do NOT use React context here):
   ```js
   import { useDuelMatchStart } from '.../lib/challengeEngine';
   const matchStartAt = useDuelMatchStart(challengeId);
   const duelAutoStartedRef = useRef(false);

   useEffect(() => {
     if (!isChallenge || !matchStartAt || phase !== 'start' || duelAutoStartedRef.current) return;
     const delay = Math.max(0, matchStartAt - Date.now());
     const t = setTimeout(() => { duelAutoStartedRef.current = true; enterDrill(); }, delay);
     return () => clearTimeout(t);
   }, [isChallenge, matchStartAt, phase, enterDrill]);
   ```
   Skip the visible 3‑2‑1 in duels — DrillWrapper renders the shared countdown:
   `runCountdown(isChallenge ? 0 : 3)`.

3. **No lives in a duel.** A duel always runs the full 30s — a bad start must not end your
   side early while the opponent keeps playing. Gate life loss behind `!isChallenge`.

4. **Mistakes cost score in a duel (the penalty).** Because there are no lives, a wrong
   tap / miss / timeout deducts **−5 score, floored at 0** — this is the only "fear" and it
   flows into EIQ. Solo takes a life instead, never score. See `feedback_no_score_penalties`
   in memory.
   ```js
   if (isChallenge) { scoreRef.current = Math.max(0, scoreRef.current - 5); }
   else             { livesRef.current = Math.max(0, livesRef.current - 1); }
   ```

5. **Difficulty ramps with SCORE and only ratchets UP.** The better you play, the harder
   it gets — identically on every device. **A −5 penalty must never lower the difficulty.**
   Track a high‑water `levelRef` / `e.level` / grid size and only ever raise it; derive
   speed/spawn/contrast from that ratcheted value, NEVER from the raw current score.

6. **Device‑independent timing.** Never advance movement by a raw per‑frame delta with a
   30fps clamp (that makes slow phones play in slow motion = easier). Use a **fixed‑timestep
   accumulator** for physics (see Quick Dodge `runGameLoop`) or wall‑clock durations /
   `setInterval` timers (see Multi‑Tasking / Shade Finder). Same score ⇒ same difficulty ⇒
   same real‑time speed on any device.

7. **Clean play area in a duel.** Only penalty/timeout pop‑ups show. Suppress combo, level‑up,
   overdrive, "close call", "+points" toasts by gating your feedback helper:
   ```js
   const triggerFeedback = useCallback((text, type = 'good') => {
     if (isChallenge && type !== 'bad') return;   // Arena shows only 'bad' (penalty/timeout)
     // ...
   }, [isChallenge]);
   ```

8. **The canonical miss/timeout sound.** Every Arena drill uses the **same** two‑note chime
   for a wrong tap AND a timeout, so the Arena feels like one game. Params (triangle wave):
   ```
   note 1: 587.33 Hz, start t0,       dur 0.11
   note 2: 392.00 Hz, start t0+0.09,  dur 0.18
   gain ramps 0.0001 → 0.2 → 0.001
   ```
   Reference copies: Shade Finder `playFalseAlarm`, Concentration Grid `playBuzz`,
   Quick Dodge `playWrong`, Multi‑Tasking `playPenalty`. No harsh sawtooth/square "buzz" or
   low "boom" sounds anywhere.

9. **Minimal chrome + own HUD.** Pass `minimalChrome` to `<DrillWrapper>` and render your
   own score/level/timer HUD. DrillWrapper hides its header for the whole duel (this is what
   keeps the play area a constant size — the header used to reappear on the result screen and
   cause a shake/resize).

10. **Submit the final score once.** DrillWrapper handles submission and the result screen —
    you just report your final score to it (via the `score` prop / its submit path). Do NOT
    render your own end screen in a duel (gate it behind `!isChallenge`); DrillWrapper's
    result overlay takes over.

---

## How EIQ works (so you can pick `hardness`)

EIQ is the Arena rank (like a chess rating). Each match:

```
swing = drill hardness × how decisively you won (score margin)
winner: +swing     loser: −swing (floored at 0, never negative)     draw: no change
```

- `hardness` scales the whole swing — a harder drill is worth more EIQ.
- The score margin (winner vs loser) scales it too — a blowout swings more than a squeaker.
- Arena scores feed EIQ only; they never mix with solo/personal‑best scores.

Defined in `lib/challengeEngine.js`: `eiqSwing()`, `EIQ_TIERS`, `tierForEiq()`.

---

## Server side (one‑time, only if the security rule changes)

`firestore.rules` already allows a match to write each player's `eiq` (±100/write, floored
at 0) and `wins/losses/streak`. **If you change how much EIQ a match can move, bump that cap
and re‑publish the rules in the Firebase Console** — otherwise match resolution gets denied.
Adding a new drill does NOT require a rules change.

---

## Where the shared Arena UI lives (don't rebuild it per drill)

| Piece | File |
|---|---|
| Roster / matchmaking / EIQ / tiers | `lib/challengeEngine.js` |
| Duel shell, countdown, live opponent, **result screen**, rematch | `components/DrillWrapper.js` |
| Incoming/outgoing challenge notifications | `contexts/ChallengeContext.js` + `components/ChallengeStatusToast.js` |
| Arena hub, picker, **leaderboard** (sorted by EIQ) | `app/challenge/ChallengeArenaClient.js` |
| Enable/disable Arena globally | `lib/featureFlags.js` → `ARENA_ENABLED` |

---

## Quick checklist when you tell me "add <drill> to Arena"

- [ ] Add the `{ slug, name, hardness }` line to `DUEL_DRILLS`.
- [ ] Wire rules 1–10 into the drill's client (copy from a reference drill).
- [ ] **Nothing adds to or subtracts from the clock in duel mode** (rule 1) —
      grep the drill for every assignment to its time ref and confirm each one
      is either the initial `= totalTime` or gated behind `!isChallenge`.
- [ ] **Duel starts at the lowest difficulty for both players** — no
      personal-best seeding (`const startLevel = isChallenge ? 1 : ...`).
- [ ] Difficulty ratchets up by score; verify a −5 penalty can't lower it.
- [ ] Timing is device‑independent (fixed‑timestep or wall‑clock).
- [ ] Uses the canonical miss/timeout chime; suppresses non‑penalty toasts in duels.
- [ ] `minimalChrome` + own HUD; no own end screen in duels.
- [ ] Build (`npm run build`) + `npx cap sync android`; test a real 2‑device duel.
