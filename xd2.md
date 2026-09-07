# Prompt: xd2 — make it feel like a game, not an app (animation pass)

Paste this to Claude Code and say **"use prompt xd2 and do step N"** (steps are numbered
below; do ONE step per session, get it approved, then move on).

---

## What this is

The drills work but they read like a settings screen: numbers snap into place, the
result screen is dead static, a correct hit is just a sound. This pass adds the
**earned** animation — score feedback, a result screen that celebrates, haptics,
level-up moments — so the app feels like a polished mobile game.

This is a *polish* pass. **Do not** change game logic, scoring, difficulty, timers,
or drill mechanics. Presentation only.

## The hard rules (these are scars — do not relearn them)

1. **NO screen shake.** The WebView resizes under a centred overlay and it reads as
   a bug, not juice. `fx-shake` / `hide-drill-controls` are dead no-ops in
   `globals.css` — leave them dead, do not revive or add anything like them.
2. **NO full-screen positive/success flash.** `.fx-flash-gold` / `.fx-flash-cyan`
   are deliberately blanked (`background:none`) because burst-scoring drills
   strobed several times a second. Keep them blank. Only a **mistake or timeout**
   flashes the screen, and only red (`.fx-flash-red` / `.fx-flash-red-hard`).
3. **Compositor only.** Animate `transform` and `opacity` (and `box-shadow` /
   `background-color` sparingly). **Never** animate `width`, `height`, `top`,
   `left`, `margin`, `padding` — that's layout and it jank­s. The motion drills
   run their game loop on a ~14ms JS budget; **add zero per-frame JS** to any
   `requestAnimationFrame` step. New animations are CSS keyframes or one-shot
   `setTimeout`s, never loop work.
4. **Tailwind `animate-in` / `fade-in` / `zoom-in-*` utilities are silent no-ops**
   here — no plugin is installed. Write real `@keyframes` in `styles/globals.css`.
5. **`opacity:0` + `animation-fill-mode:both` can strand an element permanently
   invisible** in Android's WebView if a frame is dropped (this is the historic
   "empty countdown ring" bug). For anything load-bearing — a digit, a score, the
   result card — the keyframe must animate **transform only** and start from a
   visible state, or the element's resting state must be guaranteed by React, not
   by `fill-mode`.
6. **`prefers-reduced-motion: reduce`** — the global rule in `globals.css` freezes
   animations at keyframe `0%`. Every `0%` must be a clean, legible resting state.
7. **Two repos.** Push to the `backup` remote only (`git push backup main`) — that
   is the app repo (`1st-app-`). The website repo (`global-drill-system`) has been
   removed as a remote from this checkout; **do not re-add it or merge anything
   between them.**

## What already exists — reuse, don't reinvent

`styles/globals.css`:
- `.fx-pop-in` — scale .5→1.08→1 with overshoot, 180ms. Entrance.
- `.fx-count-pop` — transform-only scale punch, 180ms (WebView-safe, see rule 5).
- `.fx-fade-up` — opacity 0→1 + translateY 8px→0, 180ms.
- `.fx-pop` — expanding fading ring, 500ms. Burst on a hit point.
- `.fx-flash` / `.fx-flash-red` / `.fx-flash-red-hard` — mistake washes.
- `.fx-vignette` — pulsing red edge, danger state.

`lib/canvasFx.js`: `drawPulseRing`, layered-sprite cache — for canvas drills.

Audio: every drill file has an inline synth class (`playHit()`, `playPenalty()`,
`playWrongBoom()`, …). Mute pref: `sd_settings` → `{ soundEnabled }`, read via
`getSettings()` in `lib/progressStore.js`.

Level / XP data is REAL: `lib/progressStore.js` — 1000 XP per level.
`saveDrillResult()` returns `{ isNewBest, firstPlay, xpEarned, xpBreakdown,
streakMilestone, leveledUp }` where `leveledUp` is the new level number or `null`.
`getProgressSummary()` (progressStore ~L216) returns `{ level, xp, xpInLevel,
xpToNext }`.

---

## Step 1 — Shared animated result screen  (biggest single win, all 11 drills)

**Problem:** every drill client has its own copy-pasted `ResultScreen` +
`ResultStat` function. They're near-identical and 100% static.

- `ConcentrationGridClient.js` L1063 / L1101
- `DualTargetFlowClient.js` L1444
- `DistractionFighterClient.js` L1058
- `KineticInterceptClient.js` L1181
- `ShadeFinderClient.js` L978
- `CardMatchingClient.js` L1168
- `GridMemorizationClient.js` L1128
- `TowerOfHanoiClient.js` L1100
- `FingerSequencingClient.js` L1700
- `QuickDodgeClient.js` L2500
- (check each — line numbers drift)

**Do:**
1. Read 3–4 of them. They differ slightly (accent colour, whether there's a grade
   letter, extra stats). Build ONE `components/drill/ResultScreen.js` that takes
   props covering every variant (`accent`, `grade`, `score`, `bestScore`,
   `accuracy`, `xpEarned`, `leveledUp`, `isNewBest`, `progressSummary`,
   `onPlayAgain`, `onShare`, `backHref`, plus an optional `extraStats` array).
   Match the current visual design exactly — same layout, same colours, same
   copy, same buttons, same share hookup. Only the *motion* is new.
2. `lib/useCountUp.js` — `useCountUp(target, ms = 600)` → returns a number that
   eases from 0 to `target` once on mount via `requestAnimationFrame`, cancels on
   unmount. Use it for score, accuracy, XP. (This rAF is fine — it's the result
   screen, not a game loop.)
3. Motion:
   - Card root: `.fx-fade-up` + a 160ms scale-in (0.96→1) entrance.
   - Grade block: `.fx-pop-in`.
   - Stat tiles: `.fx-fade-up` staggered 70ms apart (`animation-delay`).
   - Numbers: count up (step 2).
   - **NEW BEST**: replace the static pill with a stamp — scale 1.35→1 with a
     small rotate wobble (transform only), plus a one-shot diagonal shine sweep
     (a skewed white-gradient bar translating across an `overflow:hidden` pill).
     Fire one dedicated fanfare tone (add `playFanfare()` to the synth, or reuse
     `playHit` twice) — gated on `soundEnabled`.
   - Grade **S / S+**: slow shimmer loop — pick the WebView-safe option (animate a
     `box-shadow` colour pulse, NOT `background-clip:text` position, which fails
     to paint under a scale animation in this WebView).
   - **XP bar**: a thin track under the XP tile, fill = `transform:scaleX` from
     `xpInLevel/1000` (before) → new fraction, 700ms ease-out. If `leveledUp` is
     set: fill to 100%, brief white flash, snap to 0, fill to the remainder, and
     play the fanfare + a `LevelUpToast` (step 4 component — if step 4 isn't done
     yet, just a simple centred "LEVEL {n}" `.fx-pop-in` for now).
4. Swap all 11 drills to `<ResultScreen .../>`, delete their local copies. The
   drill must pass `progressSummary` — get it from `getProgressSummary()` (already
   imported in most, or add it) captured *before* `saveDrillResult` so the bar can
   animate from the old value.
5. `DrillWrapper.js` has a **separate** duel result screen (~L1232). Apply the same
   count-up + stagger there too, but keep it a small follow-up commit — solo first.

**Verify:** `npm run build`. Screenshot the result screen of 2–3 drills (force it
via the headless loop — see xd.md's screenshot section and the dev-chunk trap).
One commit: "Shared animated result screen across all drills".

---

## Step 2 — Haptics  (cheap, every drill)

`@capacitor/haptics@^8` is **already a dependency**. No install — but it needs
`npx cap sync android` and an APK rebuild to take effect on device (note this in
the commit body).

1. `lib/haptics.js` — wrap `@capacitor/haptics`. Export `tapLight()`,
   `tapMedium()`, `tapSuccess()`, `tapError()`. Each: check a `hapticsEnabled`
   pref (add to `sd_settings`, default `true`; also respect `soundEnabled === false`
   as a global "quiet" signal — if unsure, gate on `hapticsEnabled` only). Wrap
   every call in try/catch and no-op on web / when the plugin is absent.
2. Add a **Haptics** toggle next to the sound toggle in the global settings UI
   (find it — `getSettings`/`setSettings` in `progressStore.js`, rendered
   somewhere off `DrillWrapper` / an app settings screen).
3. Wire one line next to each existing `audioSynth?.playX()` call site:
   - correct hit → `tapLight()`
   - level-up / new best / daily complete → `tapMedium()` or `tapSuccess()`
   - mistake / wrong tap / timeout / collision → `tapError()`
4. Do NOT add haptics inside a per-frame loop — only on discrete events.

**Verify:** `npm run build`. One commit: "Add haptic feedback to drill events
(needs cap sync + APK rebuild)".

---

## Step 3 — In-drill juice  (PILOT on concentration-grid only, then stop for approval)

Build all three on `concentration-grid` first. Get it approved on device before
touching any other drill.

1. **Floating `+N` on a hit.** At the tap/hit point, mount a small absolutely-
   positioned `<div>` that rises ~28px and fades over 600ms (transform + opacity
   keyframe), colour by combo tier (white → amber → orange → gold), removed on
   `animationend`. Cap at ~6 concurrent (pool or slice the array). No layout, no
   per-frame JS.
2. **Combo punch.** When the combo count increases, `.fx-count-pop` the HUD combo
   stat and shift its colour warmer as it climbs. The combo value already flows to
   `DrillWrapper`'s `HUDStat` — this may need a tiny `key={combo}` remount or a
   className toggle. Transform only.
3. **Hit-stop.** On a *milestone* hit only (every 5th combo, or a high-value
   target), freeze the game step for ~45ms — ONE guarded `setTimeout` on the loop,
   not a per-frame check. Only for fast/reflex drills; never for memory/puzzle
   drills (it reads as a stutter there).

**Verify + STOP.** Screenshot mid-play. One commit: "Concentration Grid: floating
points, combo punch, hit-stop (juice pilot)". Wait for the user to test on device
and approve before step 3b.

### Step 3b — roll the approved juice out

- Floating `+N` + combo punch → `quick-dodge`, `distraction-fighter`,
  `multi-tasking`, `finger-sequencing`, `moving-target`.
- Hit-stop → only the reflex ones (`quick-dodge`, `moving-target`,
  `finger-sequencing`) if it read well in the pilot.
- Memory/puzzle drills (`grid-memorization`, `card-matching`, `tower-of-hanoi`,
  `shade-finder`): result screen (step 1) + haptics (step 2) only — **no**
  floating points, no hit-stop.
- Extract the `+N` popup into a shared `components/drill/ScorePopupLayer.js` +
  a `lib/useScorePopups.js` hook so it's one implementation.
- One commit per 2–3 drills with screenshots.

---

## Step 4 — Level-up moment  (drills that ramp)

`components/drill/LevelUpToast.js` — a non-blocking centred banner: "LEVEL {n}"
scales/fades in (`.fx-pop-in`), holds ~700ms, fades out. **No pause, no input
block, no dim.** Mounts for ~1s then unmounts.

Hook it wherever each drill raises its level: grep `stepLevel` (concentration-grid,
tower-of-hanoi, finger-sequencing use it; others increment a `levelRef` / call
`setLevel` — check each). Pair with `tapMedium()` + a soft rising tone.

One commit: "Level-up toast across ramping drills".

---

## Step 5 — Phase transitions + home polish  (smallest, do last)

1. **Start card → play:** cross-fade the start card out (opacity 1→0 + scale
   1→0.97, 160ms) instead of an instant unmount. The countdown already animates.
2. **Play → result:** covered by step 1's card entrance — just confirm it reads.
3. **Home rail + hub cards:** consistent `active:scale-[0.97] transition-transform`
   press state on every drill card (some have it, make it uniform).
4. **Streak counter (home):** if it ticked up since the last visit, a one-shot
   flame bounce (`.fx-count-pop` + a small rotate).
5. **Daily banner:** a subtle progress shimmer when a challenge is partway done.

One commit: "Phase transitions and home-screen micro-animations".

---

## Canva note

The Canva MCP connection is for **static art only** — share-card imagery, store
assets. Every animation in this pass is CSS / canvas, authored in this repo. Do
**not** export anything from Canva into the game; it can't produce in-app motion
and the file-size / theming cost isn't worth it.

## Per-step checklist

- [ ] `npm run build` passes
- [ ] Screenshotted the change (headless loop from xd.md; mind the dev-chunk trap)
- [ ] No animated layout properties, no new per-frame JS
- [ ] `0%` keyframe is a legible still (reduced-motion)
- [ ] Reverted any debug/skip flag used to reach the screen
- [ ] `graphify update .`
- [ ] Commit footer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- [ ] `git push backup main` — never `origin`
