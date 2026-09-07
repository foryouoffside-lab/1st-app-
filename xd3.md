# Prompt: xd3 — make it read as a game, in OUR skin

Paste to Claude Code and say **"use prompt xd3 and do step N"**. One step per
session: build it, screenshot it, push to `backup`, wait for the user to test.

---

## What this is

We tore down Matiks (a mental-maths game) and pulled the ideas worth having into a
deck — artifact `f5008d0b`, "SkillDrills Redesign". This prompt is the build list
from that deck, **filtered to what actually helps us and rebuilt in our own
identity**. The deck is a reference, not a spec. Matiks is a competitor; anything
that would make us look like a reskin of it is called out below and must not ship.

`xd2.md` (result-screen motion, haptics, in-drill juice, level-up toast, phase
transitions) is a **separate track that still stands** — step 1 shipped, steps 2–5
pending. xd3 is the redesign track. They don't conflict.

## OUR identity — do not drift toward the deck's palette

Every value here already exists in `styles/globals.css`. Use these, not the deck's.

| role | ours | the deck's (do NOT use) |
|---|---|---|
| ground | `--ink #050508` | `#08070C` |
| surfaces | `--card #12131c` / `--card-raised #1a1b26` | `#14111C` |
| brand | `--brand-1 #6366f1` → `--brand-2 #8b5cf6` → `--brand-3 #a78bfa` (indigo→violet) | flat `#7C5CFF` |
| per-drill accent | the `--c-*` category vars (`--c-cognitive #8e61f6`, `--c-memory #3b82f6`, `--c-motor #22c55e`, `--c-visual #06b6d4`, `--c-reaction #ec4899`, …) — each drill already themes to its own | invented cyan/amber/magenta/lime |
| display face | `.font-display` (Anton, already loaded and in use) | — |
| body | Inter (`--font-inter`) | — |
| numbers | `tabular-nums` / `font-variant-numeric` — our existing treatment | — |

### Things that must NOT ship (they are the copy tells)
- **Ghost-echo / outlined offset headline** (`-webkit-text-stroke` echo behind a
  word) — this is Matiks' signature. Never.
- Their exact ground `#08070C`, their flat `#7C5CFF`, their four arcade accents.
- A round-blob mascot with a cat silhouette, or any mascot before the user signs
  off on a design (see xd2 — Canva is not the tool; do not generate one here).
- "One heavy condensed face at 80–110px on every screen" — we already use Anton
  for headers; scale it up **tastefully**, per screen, not as a blanket rule.

## The house rules (from xd2, still scars)
- Compositor only: animate `transform` / `opacity`. Never `width`/`height`/`top`/
  `left`/`margin`. No per-frame JS in a drill's game loop.
- No screen shake. No full-screen success flash.
- Tailwind `animate-in` utilities are no-ops — real `@keyframes` in `globals.css`.
- Load-bearing text animates transform only from a visible state (`opacity:0` +
  `fill-mode:both` strands it invisible in the WebView).
- `0%` keyframe is a legible still (reduced-motion).
- Push to `backup` only. `origin` (the website repo) is not a remote here anymore.

---

## Step 1 — Physical buttons (global, cheap, biggest feel-per-line)

Every primary CTA becomes a solid fill + a **hard offset shadow** (not blur) that
presses down on tap.

- New `.btn-press` class in `globals.css`: solid background, `box-shadow:0 5px 0
  <darker>`, `:active` → `transform:translateY(4px); box-shadow:0 1px 0 <darker>`,
  ~90ms transition on transform + box-shadow.
- **Our skin, not theirs:** fill = the drill's `--c-*` accent (or `--brand-2` for
  app chrome), shadow = a hand-darkened shade of that same colour, dark text on
  accent. No cyan-on-cyan.
- Apply to: Start (start card), Play Again (result), duel Rematch / New duel,
  the daily-banner CTA. Leave secondary/text buttons flat.
- Keep our existing `active:scale-[0.97]` where a full 3D button is too loud
  (icon buttons, back arrows).

Screenshot the start card + result screen. Commit "Physical press buttons".

## Step 2 — Result background tinted by outcome

The solo result card (`components/drill/ResultScreen.js`, already animated) gets a
background that reflects how the run went.

- `personal best` → a `--brand-2` violet wash + faint chevron texture
- `solid run` (top ~40% but not a best) → a cool `--c-visual`/category wash
- `weak run` → near-flat, dim
- Two CSS gradients on a `.res-bg` layer behind `.res-card`, `z-index` below the
  content, `opacity` ~0.4. Chevron = one `repeating-linear-gradient` at ~145°,
  very low alpha. **Angle and colours are ours — do not reuse the deck's
  `rgba(124,92,255,...)` literal.**
- Pick the tier from data already on `summary` (isNewBest, accuracy, score vs
  best). No new fields.

Screenshot all three states. Commit "Outcome-tinted result background".

## Step 3 — Honest personal-best line on the result card

Replace the bare "Best Score" tile value with an explicit comparison so the number
can't lie (this is also the fix for PREV. BEST once printing the new score).

- Line reads: `Previous best 1,276  ▲ +566` when beaten, `Best 1,842` when not,
  nothing when there's no prior best (first play — no zeros).
- Delta in `--c-motor` green, tabular figures, `.font-display` for the numbers.
- Lives in the left panel under Points, or as its own strip — whichever reads
  cleaner at 900×423 landscape and in portrait.

Commit "Explicit previous-best delta on result card".

## Step 4 — Start card: kill the first-play zeros, grow the name

Reconcile with the **recent 290px start-card redesign the user approved** (accent =
target colour, rules ≤34 chars) — change only what's clearly better, keep that work.

- **Personal-best strip renders only when a best exists.** First ever play: no
  "Best 0 / Combo 0x / Lv.1" — the title takes that space instead.
- Drill title one size up, `.font-display`, left-aligned, two lines max. Test it
  doesn't collide with the rules block or the 290px frame.
- Start button → the `.btn-press` from step 1.
- Leave the rules rows for now (step 5 decides their fate).

Screenshot a played drill and a never-played drill. Commit "Start card: hide
first-play zeros, enlarge title".

## Step 5 — "How to play" as one practice round (per drill, real work)

Replaces the rule list with a played example. High value, do it carefully.

- Start card gets a `How to play?` pill (top area). Tapping it enters the drill's
  normal loop with: **timer disabled, scoring off, one coach tooltip** anchored to
  the first spawn/target. After one successful action → a small "You're ready"
  card → back to the start card.
- **First ever open of a drill auto-runs this** (store one flag per drill id in
  `sd_settings` or a dedicated key). After that it lives behind the pill.
- "Skip" always visible, top corner, dim.
- Build it for **one drill first** (suggest `shade-finder` — simplest loop),
  get it approved, then roll out.
- Our "You're ready" card is a plain flat card in our theme — NOT a mascot
  break-out (no character yet).

Commit per drill. Wait for approval after the first.

## Step 6 — Inline countdown HUD (retires the shake-bug class)

The 3·2·1 overlay has caused viewport-resize shake we've fixed 3+ times. Replace
the pattern, don't patch it again.

- The drill's HUD, timer bar and controls **mount at final size during the
  countdown**. The countdown is inline text in the play area — `Starting in 3` →
  `2` → `1` → `Go`, the digit in the drill accent, `.font-count-pop` on change.
- Nothing changes size or position when the round goes live → zero layout shift.
- Solo and Arena share one HUD component (Arena adds the opponent side).
- Delete the full-screen countdown overlay and its `fx-shake` / `afterViewport
  Settled` scaffolding once nothing references them.

Screenshot the countdown → live transition. Commit "Inline countdown, pre-mounted
HUD".

## Step 7 — Arena result: head-to-head breakdown

Duel result screen (in `DrillWrapper.js`) gains a stats comparison behind a
swipe-up / expand.

- Rows: `your value — metric — their value`, a marker (▸/◂ or a bar) pointing at
  whoever won each row, winner's cell gets a thin accent outline. Metrics:
  correct, avg time, fastest, slowest, accuracy, peak level.
- All values already written by the duel — presentation only, no data change.
- Collapsed by default; a `Swipe up for breakdown` affordance opens it.
- Our theme: green = `--c-motor`, loss marker = `--c-fps` red, outline =
  `--brand-2`.

Commit "Arena head-to-head breakdown".

## Step 8 — Matchmaking radar

Replace the Arena "searching for opponent" spinner with a radar sweep.

- A rotating conic wedge + 2–3 staggered ripple rings + a faint grid, `SD` or the
  logo mark in the centre. All `transform`/`opacity` keyframes, no JS.
- **Our colours:** `--brand-2` wedge, `--line` rings — not the deck's violet
  literal.
- Self-contained component, drops into the existing search state.

Commit "Matchmaking radar".

---

## Not yet — product bets, need the user's call first (do NOT build under xd3)
- "You beat X% of players" line on results (needs enough real score data)
- Streak-gated content / monthly season
- A character / mascot (the real de-copy move — but a deliberate design pass)
- 4-tab nav (Home / Drills / Arena / You), merging Ranks + Progress

## Per-step checklist
- [ ] `npm run build` passes
- [ ] Screenshotted (headless loop from xd.md; mind the dev-chunk trap)
- [ ] Used OUR tokens — no deck colour literals, no ghost-echo, no mascot
- [ ] Compositor-only animation, `0%` keyframe legible
- [ ] `graphify update .`
- [ ] Commit footer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- [ ] `git push backup main`
