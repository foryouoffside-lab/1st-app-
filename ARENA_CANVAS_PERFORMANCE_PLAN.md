# Arena Drills — Canvas Rendering Performance Rewrite Plan

## Context

SkillDrills' Arena (1v1 duel) drills were making laptops and phones run hot — CPU spiking to 27-40% for a single browser tab during a match, compared to 7-8% for drills built the "cheap" way. Investigation (measured with Chrome Task Manager, DevTools closed, on the same machine) traced this to two categories of problem:

1. **Real bugs — already fixed** (see "Already Completed" below): a duplicate Firestore real-time listener, an over-broad global re-render trigger, and unnecessary `backdrop-blur` compositing running for the entire match.
2. **A fundamental rendering-architecture difference between drills — this plan.** Two of the six duel-eligible drills (`Batch Processing`, `Quick Dodge`) already draw their moving game pieces on a single `<canvas>` element, the same technique real games use. The other three convert-worthy drills (`Divided Attention`, `Multi-Tasking`, `Selective Attention`) instead render every moving target as a real, individually-animated HTML element (glowing circles with CSS `animate-ping`, `box-shadow`, mount/unmount every 1-2 seconds). That's why they burn far more CPU for visually simpler games — the browser has to run its full page-layout engine (layout → style → paint → composite) for every glowing dot, every frame, instead of just repainting pixels into one flat canvas image.

**Goal:** bring `Divided Attention`, `Multi-Tasking`, and `Selective Attention` to the same rendering approach already proven in `Batch Processing` / `Quick Dodge`, without changing any gameplay behavior — scoring, timers, difficulty curves, and Arena/duel sync must come out byte-for-byte identical. This is a rendering-layer swap, not a gameplay rewrite.

**Honest ceiling on the CPU target:** on this same hardware, the already-canvas-based drills measured ~7-8% CPU (clean, DevTools closed). That's the realistic floor for this app as it exists today — a browser/Capacitor WebView document engine has baseline overhead (JS execution, React, the page shell, Arena's Firestore sync) that a canvas swap alone cannot fully erase, the same way a website will never be as lean as a natively-compiled game (see below). Getting close to 1-2% would require leaving the browser/DOM stack entirely (a native game engine), which is out of scope for a Next.js/Capacitor app. What this plan *can* deliver is parity with `Batch Processing`/`Quick Dodge` — i.e. cut these three drills' CPU by roughly 3-5x, the same win already proven on this codebase.

---

## Already Completed (do not revert)

These changes are already live in the codebase and this plan builds on top of them:

1. **`lib/challengeEngine.js`** — `useDuelMatchStart(challengeId)` used to keep its own Firestore listener open for the entire match (duplicating `DrillWrapper`'s listener on the same doc). It now unsubscribes itself the instant it captures `matchStartAt`, since that value never changes again.
2. **`contexts/ChallengeContext.js`** — the global "outgoing challenge" listener used to push a new object through Context (re-rendering `ChallengeStatusToast`, `DrillWrapper`, and the Arena lobby) on *every* score-sync write during any match the user is hosting, even though none of those consumers read score. It now only updates when `id`/`status` actually change.
3. **`components/DrillWrapper.js`** — the shared bottom Arena scoreboard bar (present in every duel, for the whole match) used `backdropFilter: blur(12px)` continuously. Replaced with a solid near-opaque fill (`rgba(5,5,8,0.98)`) — visually identical, zero compositing cost.
4. **Game clock tick rate** — `Batch Processing`, `Selective Attention`, `Divided Attention`, `Multi-Tasking`, `Symbol Matching` all halved their main countdown `setInterval` from 100ms to 200ms (5 ticks/sec instead of 10 — the displayed clock only ever shows whole seconds, so this is visually identical while halving one steady re-render source for the whole match).
5. **`app/drills/cognitive/processing-speed/symbol-matching/SymbolMatchingClient.js`** — the on-screen keypad buttons and the top legend bar used `backdrop-blur-md` continuously for the whole match. Replaced with solid fills.

**Symbol Matching is intentionally excluded from the canvas conversion below.** Research into its actual mechanics found it has *no* continuously-moving/animating elements — its keypad and legend only change once per round (every 0.9s-2.2s, difficulty-dependent), not every frame. The blur fix above was the real cost driver there; a canvas rewrite would add real risk for negligible additional gain. Leave it as-is unless a future measurement proves otherwise.

---

## Target Architecture (the pattern already proven in this codebase)

Reference implementation: `app/drills/cognitive/processing-speed/quick-dodge/QuickDodgeClient.js`. All three conversions below should follow this same shape:

1. **Mutable game state lives in a ref, not React state.** A single `engine = useRef({...})` object holds every per-frame value (target/item positions, spawn timers-as-data, current difficulty knobs). Positions are **never** synced to React state — only the canvas draw loop reads `engine.current` directly, every frame, with zero React re-render cost per position update.

2. **One `<canvas>` element, one `requestAnimationFrame` draw loop.** Sized via `ResizeObserver` + `devicePixelRatio`, exactly as `QuickDodgeClient.js:757-940` does (`resizeCanvas`, `canvasSizeRef`, the `draw()` function, `drawAnimRef`). All moving/animated visuals for that drill get drawn into this one canvas each frame — no more individual DOM nodes per target/item/shape.

3. **CSS effects become canvas-drawn equivalents:**
   - `animate-ping` rings → reuse `QuickDodgeClient.js`'s `drawPulseRing(ctx, x, y, baseR, color, time, seed, periodSec, maxScale, alphaStart)` helper (`QuickDodgeClient.js:794-806`) verbatim — it already reproduces this exact effect on canvas using a `(time+seed) % period` cycle.
   - `box-shadow` glow → `ctx.shadowBlur` / `ctx.shadowColor` (see `QuickDodgeClient.js:891` for the pattern, applied conditionally so it isn't paid for on every draw call unless actually glowing).
   - `bg-gradient-to-br` → `ctx.createLinearGradient(...)` (see `QuickDodgeClient.js:843-848` / `:885-887`).
   - Icons (lucide `AlertTriangle`, shape emoji, etc.) → either a simple hand-drawn vector shape (a triangle + exclamation mark is easy on canvas) or `ctx.fillText()` directly with an emoji string — canvas renders emoji glyphs fine, which is the simplest option for `Selective Attention`'s shape set and `Multi-Tasking`'s glyph set.

4. **What stays as plain DOM/CSS, unchanged, in all three drills** (these are cheap — short-lived, low-count, or low-frequency — porting them buys nothing and adds risk):
   - Score/level/lives/timer HUD text and the `Heart` icon row
   - `feedback` popup text, `flashes[]` full-screen overlay, `shakeCls` screen shake, the `dangerLevel` vignette pulse — all already low-frequency, short-duration (480-650ms), small-DOM-footprint effects
   - Combo badge, target/legend indicator boxes
   - Start screen, countdown screen, rotate-hint screen, result screen (only ever mounted outside the continuous 'playing' loop)
   - `Divided Attention`'s number-matching side panel (digit box + MATCH button + progress bar) — it only changes on a 0.8-1.9s cycle, not continuously; leave it as DOM.

5. **Hit-testing moves from per-element `onClick`/`onPointerDown` to one handler on the canvas/container.** On pointer-down, convert the tap's client coordinates to the same percentage coordinate space the engine uses (see `QuickDodgeClient.js`'s `handlePointerDown`/`handlePointerMove` for the `getBoundingClientRect()` → percentage conversion pattern), then check against the current target/item list's positions + radii — replacing DOM click dispatch with the same kind of math `QuickDodgeClient.js` already uses for its obstacle collision checks.

6. **React state is still updated, just throttled — not per-frame.** `QuickDodgeClient.js:601-609` syncs `score`/`combo`/`timeRemaining`/`level`/`lives` to React state only every 4th physics frame. Follow the same pattern in all three conversions: the canvas draw loop runs every frame from the ref, but `setScore`/`setLives`/etc. (which `DrillWrapper` needs for the Arena scoreboard and Firestore score-sync) fire on a throttle. **This is required for Arena to keep working** — `DrillWrapper`'s score-sync effect and bottom HUD read these props, not the canvas.

7. **Extract shared canvas helpers once, reuse three times.** Rather than copy-pasting `drawPulseRing` and the tap-hit-test math into three files, pull them into a small new module, e.g. `lib/canvasFx.js`, exporting:
   - `drawPulseRing(ctx, x, y, baseR, color, time, seed, periodSec, maxScale, alphaStart)` (moved verbatim from `QuickDodgeClient.js`)
   - `hitTestCircle(px, py, targetX, targetY, radius)` — the `Math.hypot(...) < radius` check used for tap detection
   - A `useCanvasSize(containerRef, canvasRef, phase)` hook wrapping the resize-observer boilerplate (`QuickDodgeClient.js:765-789`)

   Then have `QuickDodgeClient.js` itself adopt these too (small follow-up cleanup, not required for this plan to succeed, but keeps one source of truth going forward).

---

## Non-Negotiables — must come out identical

- **Scoring**: every call into `lib/scoringEngine.js`'s `scoreAction`, `calcEndBonuses`, `calcSessionXP` — same arguments, same call sites conceptually. Do not touch the scoring engine itself.
- **`DrillWrapper` prop contract**: `drillName`, `category`, `score`, `combo`, `timeLeft`, `lives`, `maxLives`, `soundEnabled`, `onSoundToggle`, `backHref`, `minimalChrome` — same props, same values, same cadence of updates as today.
- **Arena/`isChallenge` branching**, identical in all three (already documented per-drill below — do not change): no sudden-death-on-0-lives during a duel (clock always runs the full shared time), no `requestFullscreen()` during a duel, the visible 3-2-1 countdown is skipped in duel mode (`runCountdown(isChallenge ? 0 : 3)`), duel auto-start via `useDuelMatchStart(challengeId)` at the shared `matchStartAt` timestamp.
- **Firestore score-sync cadence** — `DrillWrapper`'s throttle (≥800ms between writes) depends on the `score` prop actually changing at a reasonable rate; keep the React-state throttle in step 6 above frequent enough (e.g. every 4-6 frames, matching `QuickDodgeClient.js`) that duel score sync doesn't visibly lag.
- **Difficulty formulas** — reproduce every constant and formula exactly as documented per-drill below. These are pure functions of score/level; get a single constant wrong and the game's pacing changes.
- **Keyboard input** where it currently exists (e.g. `Symbol Matching`'s digit-key handling — not in scope here, but `Divided Attention`'s MATCH button and any other non-target-tap controls must keep working unchanged since they stay DOM).

---

## Per-Drill Specs

### 1. `app/drills/cognitive/attention/divided-attention/DividedAttentionClient.js` — convert first

**What moves to canvas:** `primaryTarget` and `secondaryTarget` (currently the `InterceptOrb` component, `DividedAttentionClient.js:1100-1128`) — up to 2 simultaneous circles on screen.

**What stays DOM:** everything else — number-matching side panel, HUD, feedback/flash/shake/vignette, combo badge, start/countdown/result screens.

**Current mechanics to preserve exactly:**
- `spawnPrimary()` (`:533-553`): picks position via `pickPosition(avoid)` (`:166-173`, percentage coords, avoids overlapping the other target by >24 units, 6 attempts then gives up), rolls `isHazard = Math.random() < hazardChanceRef.current`, target lives `targetLifeRef.current` ms (a `setTimeout`, not a spawn-interval — the lifespan *is* the cadence), then **unconditionally respawns itself** on expiry regardless of outcome.
- `attemptSecondary()` (`:555-579`): polls every 1.1s (`Math.random() >= dualChanceRef.current` gate) until it wins the roll; secondary hazard chance has a **25% floor** (`Math.max(0.25, hazardChanceRef.current)`); secondary lifespan is 85% of primary's (`targetLifeRef.current * 0.85`); reschedules itself 0.7-1.8s later depending on whether it resolved via tap or expiry.
- Tap on `pulse` = correct; tap on `hazard` = wrong (flat -8 score + life loss); letting `pulse` expire = wrong (life loss, no score deduction); letting `hazard` expire = correct at a 55% score multiplier ("restraint" — rewarding *not* tapping a hazard). A tap on the primary target **immediately** respawns it; the secondary instead waits its 0.7-1.8s retry window either way.
- `updateDifficulty()` (`:333-348`, called after every correct action): `level = min(15, floor(score/40)+1)`; `progress = (level-1)/14`; `targetLifeRef = round(1500 - progress*850)` (1500ms→650ms); `hazardChanceRef = level<2 ? 0 : min(0.45, (level-2)*0.07)`; `dualChanceRef = level<4 ? 0 : min(0.5, (level-4)*0.08)`; `orbScaleRef = max(0.65, 1 - progress*0.35)` (shrinks orbs as level rises — apply as the canvas circle's radius multiplier).
- Visual spec for the canvas redraw: pulse target = cyan gradient circle (`from-cyan-400 to-blue-600`, `border-cyan-200`, glow `rgba(34,211,238,0.6)`), bullseye center (ring + dot, no icon); hazard target = red gradient circle (`from-red-500 to-rose-700`, `border-red-300`, glow `rgba(239,68,68,0.6)`), centered warning-triangle icon. Both get the expanding/fading ping ring (`drawPulseRing`) and scale by `orbScaleRef.current`. Entrance pop (currently CSS `fx-pop-in`, ~180ms bouncy scale-in) — reproduce as a short scale-up tween in the draw loop keyed off each target's spawn timestamp, or drop it if not worth the complexity (cosmetic only).
- `resolveCorrect`/`resolveWrong` full effect list (score deltas, combo, feedback text, burst spawn position) is documented in full in the earlier research pass — preserve every branch (`pulse`, `restraint`, `hazard_tap`, `pulse_miss`, `wrong_match`, `double_tap`, `missed_even`) exactly.
- `isChallenge`: `totalTime=30` vs `45`; no sudden-death; no fullscreen; countdown skipped; number-matching panel and target orbs render identically in both modes (only the surrounding chrome differs, already gated correctly).

### 2. `app/drills/cognitive/attention/multi-tasking/DualTargetFlowClient.js` — convert second (likely the biggest win)

**Why this one matters most:** it currently spawns each flying shape as its own DOM element *with its own individual `requestAnimationFrame` loop* (`createShape`/`animate()`, `DualTargetFlowClient.js:561-660`, tracked in a `Set` called `animationFramesRef`). That's N concurrent animation loops plus N DOM elements, each independently mutating inline styles every frame — almost certainly more expensive than any of the other three drills. Converting to one shared engine array + one shared draw loop (exactly the `QuickDodgeClient.js` obstacle-array pattern) should be the single largest CPU cut in this whole plan.

**What moves to canvas:** every flying shape glyph in both lanes.

**What stays DOM:** left/right target indicator boxes, HUD, feedback/flash/shake/vignette, combo badge.

**Current mechanics to preserve exactly:**
- Two lanes, each independently spawning via a self-rescheduling `setTimeout` (`scheduleLeftSpawn`/`scheduleRightSpawn`, `:662-672`; right lane's first spawn is offset 300ms so lanes don't sync). Left-lane shapes fly from the center divider outward to the left edge; right-lane shapes fly from the divider outward to the right edge.
- Each shape: 35% chance of being the lane's current target glyph (from `SHAPES`, `:28`, 8 unicode shapes), else a distractor; travel duration = `4000 / speedRef.current` ms, computed once at spawn and driven by simple linear interpolation of position over that duration (replace each shape's individual rAF with one shared loop that advances every live shape's `progress` each frame using elapsed time, exactly like `QuickDodgeClient.js` advances obstacle positions by `vx*dt`/`vy*dt`).
- Tap on a shape matching that lane's current target = correct; tap on a non-matching shape = wrong; a *target* shape reaching the far edge untapped = "missed" (wrong); non-target shapes flying off untapped = no penalty (silently removed).
- `updateDifficulty()` (`:330-354`): `level = min(15, floor(score/40)+1)`; `p=(level-1)/14`; `speedRef = 3.0 + p*4.0` (governs the `4000/speed` crossing duration, so 1333ms at L1 → 571ms at L15); `spawnRateRef = 1000 - p*600` (spawn-loop delay, 1000ms→400ms). At level ≥3, `isDifferentTargetsRef` flips on ("Target Divergence") — left and right targets become genuinely different glyphs instead of matching.
- `targetChangeIntervalRef`: every 25000ms, both lane targets force-scramble via `setRandomTargets()` regardless of level.
- Visual spec: normal shape = gray `#d1d5db` glyph with faint text-shadow; on correct tap → flashes blue `#60a5fa` with `0 0 20px #60a5fa` glow + `scale(1.2)` for ~150ms before removal; on wrong tap → flashes red `#ef4444` for ~150ms before removal. Reproduce as a short "hit flash" state per shape in the engine array (a timestamp + color to blend toward for ~150ms after being tapped), drawn via `ctx.fillText` for the glyph plus a glow via `ctx.shadowBlur`.
- `isChallenge`: `totalTime=30` vs `45`; no sudden-death; no fullscreen; countdown skipped; auto-start via `useDuelMatchStart`. Note: there's a small pre-existing dead-code branch in the result screen (`isChallenge ? 'waiting...' : <PlayAgain>` inside a block already gated `!isChallenge`, so it's unreachable) — harmless, not required to fix, but fine to clean up in passing since you'll be touching this file anyway.

### 3. `app/drills/cognitive/attention/selective-attention/SelectiveAttentionClient.js` — convert third

**What moves to canvas:** the `items[]` array — 5 to 8 simultaneous colored/shaped circles per round (one target + N distractors), currently each its own `GameItem` DOM element.

**What stays DOM:** target color/shape swatch indicator (top pill), HUD, feedback/flash/shake/vignette, combo badge.

**Current mechanics to preserve exactly:**
- This drill is **round-based**, not per-item independent: `spawnRound()` (`:478-512`) builds the whole batch (target + distractors) at once and they all live/die together on one `roundTimerRef` (a `setTimeout` for `roundWindowRef.current` ms — this *is* the item lifespan, not a separate spawn cadence).
- Target: random color (8 options) + random shape (6 options: circle/square/triangle/star/heart/diamond, currently rendered as emoji). Each distractor matches the target on **exactly one** of the two features (50/50 coin flip: same-shape-different-color or same-color-different-shape) — never zero matching features, never both — this is what makes it a genuine conjunction-search task; get this rule exactly right.
- Positions via `pickPositions(count+1)` (`:155-168`) — a lightweight max-min-distance placement (tries up to 8 random candidates per point within `x∈[12,88]%, y∈[18,84]%`, keeps whichever maximizes distance to already-placed points) — already percentage-based, portable to canvas as-is.
- Tapping the target = correct; tapping any distractor = wrong (`wrong_item`, flat -5 score penalty); the round's timer expiring with nothing tapped = wrong (`timeout`, no score penalty). Either way, **all items in the round disappear immediately** on any resolution (tap or timeout), then the next round spawns after a fixed 120ms gap.
- `updateDifficulty()` (`:294-307`): `level = min(15, floor(score/40)+1)`; `progress=(level-1)/14`; `roundWindowRef = round(1800 - progress*1100)` (item lifespan, 1800ms→700ms); `distractorCountRef = min(8, 5 + floor(progress*3))` (5 items at L1, stepping up to 8 by L15).
- Visual spec: each item = a 40-48px circle, solid Tailwind background color per `COLOR_CLASS`, centered shape glyph (emoji is fine — `ctx.fillText` renders emoji directly, simplest path); entrance pop (`fx-pop-in`) is cosmetic-optional as with Divided Attention above.
- `isChallenge`: `totalTime=30` vs `45`; no sudden-death; no fullscreen; countdown skipped; auto-start via `useDuelMatchStart`; the target swatch indicator is shown in **both** modes (essential info, not just chrome) — don't gate it behind `!isChallenge`.

---

## File List

New:
- `lib/canvasFx.js` — shared `drawPulseRing`, `hitTestCircle`, canvas-resize hook (see Architecture step 7)

Modified (rendering-layer only, gameplay logic preserved):
- `app/drills/cognitive/attention/divided-attention/DividedAttentionClient.js`
- `app/drills/cognitive/attention/multi-tasking/DualTargetFlowClient.js`
- `app/drills/cognitive/attention/selective-attention/SelectiveAttentionClient.js`

Not touched by this plan (already fixed, or intentionally excluded):
- `app/drills/cognitive/processing-speed/symbol-matching/SymbolMatchingClient.js` (blur fix only, already done — no canvas conversion)
- `components/DrillWrapper.js`, `contexts/ChallengeContext.js`, `lib/challengeEngine.js` (already fixed — do not revert)
- `app/drills/cognitive/attention/batch-processing/BatchProcessingClient.js`, `app/drills/cognitive/processing-speed/quick-dodge/QuickDodgeClient.js` (already canvas-based — reference implementations, optionally adopt the new `lib/canvasFx.js` helpers as a follow-up cleanup, not required)

---

## Verification Checklist (per drill, before moving to the next)

1. `npm run lint` on the changed file(s) — no new errors.
2. `npm run dev`, play the drill **solo** end-to-end: spawning, tapping, scoring, combo, difficulty ramp-up, life loss, and the end screen all behave exactly as before.
3. Play it in **Arena/duel mode** (two browser sessions, or one + a second test account): confirm the shared countdown, live opponent-score sync in `DrillWrapper`'s bottom bar, the 30s duel clock, no-sudden-death-on-0-lives, and the finished/winner screen all still work.
4. Chrome Task Manager (Shift+Esc via the ⋮ menu → More Tools, **DevTools fully closed**), same method used earlier in this project: compare CPU% for this drill in Arena mode before/after — expect it to land near `Batch Processing`'s ~7-8% baseline, not the 27-40% seen before this plan.
5. Confirm touch/pointer hit-testing feels right on an actual phone (percentage-coordinate math can be off by a few pixels in ways that only show up on real touch input, not mouse clicks) — check `Divided Attention`'s two simultaneous targets don't have a "dead zone" between them, `Multi-Tasking`'s two lanes register taps correctly near the center divider, `Selective Attention`'s items don't have overlapping hit areas when placed close together.
