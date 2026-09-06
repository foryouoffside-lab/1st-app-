# Prompt: xd — finish the animated drill-card previews

Paste this to Claude Code and say **"use prompt xd and do the next drill"**.

---

## What this is

The app's drill cards (home rail + Cognitive hub) used static `.webp` images.
We're replacing them, one drill at a time, with **tiny looping CSS animations that
show the drill's actual mechanic** — so the app reads like a puzzle game, not a
list. 3 of 10 are done. This prompt is the spec for the remaining 7.

## The rule (do not break this)

1. **Look EXACTLY like the real drill.** Same objects, same colours, same flat
   style. Before writing anything, open that drill's client file and copy its
   real hex colours / shapes / sprite construction (some sprites are built in
   `lib/canvasFx.js`). No invented UI — no reticles, crosshairs, HUDs, score
   numbers, labels. Just the drill's own objects.
2. **Minimal.** The drill's object + its real movement + its real hit/clear
   feedback. Nothing else.
3. **Pure CSS, compositor only.** `transform` / `opacity` / `background-color` /
   `box-shadow` keyframes. No `requestAnimationFrame`, no JS per frame, no
   `<canvas>`. Many of these render at once on a scrolling list.
4. **Reduced motion:** the global `@media (prefers-reduced-motion: reduce)` rule
   in `globals.css` freezes all animation on keyframe 0 — so keyframe `0%` must
   be a clean, legible still.
5. **Never touch the drill itself.** Only the preview component + its CSS.

## Architecture

- `components/DrillPreview.js` — dispatcher. Add the new drill to the `ANIMATED`
  map: `'drill-id': DrillIdPreview`.
- `components/drill-previews/<Name>Preview.js` — one component, renders `<div>`s
  only (may import lucide icons if the drill uses them).
- `styles/globals.css` — keyframes + classes in the block that starts
  `/* Card Matching — ... */` area (search `gm-prev`, `mt-prev`, `cm-prev`).
  Prefix every class with the drill's short code (`qd-prev`, `df-prev`, ...).
- Both `app/HomePageClient.js` and `app/drills/cognitive/CognitiveHubClient.js`
  already call `hasAnimatedPreview(id) ? <DrillPreview/> : <img/>` — no wiring
  needed, just the map entry.

### Sizing (applies to every preview)

- Root `.<code>-prev`: `position:absolute; inset:0; display:flex; center;`
  background = near-black `#050508` + a faint radial wash in the drill's accent +
  the faint 14–15px grid-floor `::after` with a `mask-image` fade (copy from
  `.gm-prev`).
- Inner playfield: `aspect-ratio` to match the mechanic, `width` ~45–75%,
  `max-height` ~70–85%. The thumb is **4:3 on the home rail, 16:9 in the hub** —
  test both. A difficulty pill sits top-left and a play button + duration sit
  along the bottom; keep the action clear of those corners (a small
  `transform: translateY(5–9%)` on the playfield often does it).

## Done (use as reference for style/level of polish)

| drill | file | loop |
|---|---|---|
| grid-memorization | `GridMemorizationPreview.js` / `.gm-prev*` | 6 cells light indigo (memorise) → dark → cells pop cyan in a cascade → repeat |
| moving-target | `MovingTargetPreview.js` / `.mt-prev*` | drill's red layered-circle target flies a looping path, flashes solid white on hit (2×/lap) |
| card-matching | `CardMatchingPreview.js` / `.cm-prev*` | 2×2 of the drill's cards; top pair 3D-flips to matching stars → pulse cyan + vanish → bottom pair flips to heart+circle → no match → flip back |

## To do — 7 drills, one per session

For each: read the client file first, match its real look, then build. Suggested
loop is a starting point — the mechanic is what matters.

1. **quick-dodge** — `app/drills/cognitive/processing-speed/quick-dodge/QuickDodgeClient.js`
   - Mechanic: drag a player dot; dodge moving hot-pink hazards. Accent `#ec4899`.
   - Loop: player dot weaves a smooth path between 2–3 drifting hazard shapes;
     near-miss each time; no collision (or one brief pink flash then reset).

2. **distraction-fighter** — `app/drills/cognitive/focus/distraction-fighter/DistractionFighterClient.js`
   - Mechanic: Stroop — a colour word printed in a different ink colour; you pick
     the INK colour. Accent cyan.
   - Loop: a word (e.g. "RED") appears in cyan ink → the matching cyan swatch
     lights / gets a tick → next word in a new mismatched colour → repeat. Use
     the drill's real `STROOP_COLORS` and its font.

3. **multi-tasking** — `app/drills/cognitive/attention/multi-tasking/DualTargetFlowClient.js`
   - Mechanic: landscape; two streams/lanes, track two things at once. Accent `#8e61f6`.
   - Loop: two glyph streams drift outward from a centre seam; one glyph in each
     stream pulses violet as the tracked pair. Copy the drill's glyph set.

4. **shade-finder** — `app/drills/cognitive/focus/shade-finder/ShadeFinderClient.js`
   - Mechanic: grid of near-identical squares, one is a hair different; tap it.
     Accent teal/cyan (grid is purple in-game — check the file).
   - Loop: grid fades in → one square's shade drifts just off the others → a
     ring/tick lands on it → grid resets with a new odd-one-out.

5. **tower-of-hanoi** — `app/drills/cognitive/problem-solving/tower-of-hanoi/TowerOfHanoiClient.js`
   - Mechanic: 3 pegs, stacked disks, move the stack; one disk at a time, never
     larger on smaller. Accent amber `#f59e0b`, disks blue in-game — check.
   - Loop: top disk lifts, slides to another peg, drops; then the next; a short
     legal sequence, then reset. Match the drill's disk colours/order.

6. **concentration-grid** — `app/drills/cognitive/focus/concentration-grid/ConcentrationGridClient.js`
   - Mechanic: Schulte table, numbers 1–25 in a 5×5, tap in ascending order.
   - Loop: full grid of numbers → 1, 2, 3, 4… light up in sequence (the drill's
     "found" colour) → clear → reshuffle. Use the drill's cell + number styling.

7. **finger-sequencing** — `app/drills/cognitive/processing-speed/finger-sequencing/FingerSequencingClient.js`
   - Mechanic: numbered pads; a sequence flashes; tap it back. Accent magenta;
     pads show 1–9; highlight is green in-game — check.
   - Loop: 3×3 pad grid → pads flash in a short sequence (2·3·1…) → then the same
     pads light green one-by-one as "replayed" → reset.

## Verify each one

```bash
npm run build          # must pass

# screenshot loop — start ONE dev server, then shoot against it:
rm -rf .next-previews
NEXT_PUBLIC_CAPTURE_PREVIEWS=1 NEXT_CAPTURE_DIST=.next-previews npx next dev -p 4324 &
# wait for "Ready", then curl http://localhost:4324/drills/cognitive/ once to warm it,
# then a small Playwright/msedge script that waits for `.<code>-prev`, locates
# `.drill-card` containing it, and screenshots the card ~12× at ~300ms.
```

**Dev-chunk trap:** if the page 404s its chunks or throws "Invalid or unexpected
token" / "Loading chunk app/layout failed" — that's a stale `.next-previews`, not
your code. Kill every dev server, `rm -rf .next-previews`, run `next build` once,
restart one dev server, warm with curl, retry. Never run two dev servers on the
same `distDir`.

## When a drill is approved

`graphify update .`, then commit just that drill's files with:

```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

and push to the `backup` remote (`git push backup main`) — that's the app repo.
Do **not** push to `origin` (that's the website project).
