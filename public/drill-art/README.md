# Drill art — Home screen drill rail

Drop one image per drill here, then **add its id to the `DRILL_ART` set** near
the top of `app/HomePageClient.js`. Any drill not in that set keeps showing its
auto-captured gameplay frame from `/previews/cards/<id>.webp`.

(Why the manual list: the app is a static export, and a broken-`<img>` error
can fire before React attaches an `onError` handler, so the source is chosen up
front instead of on failure.)

## Filenames (exact)

| File | Drill | Category accent |
|------|-------|-----------------|
| `quick-dodge.webp`        | Quick Dodge        | pink `#ec4899` |
| `distraction-fighter.webp`| Distraction Fighter | cyan `#06b6d4` |
| `card-matching.webp`      | Card Matching      | blue `#3b82f6` |
| `multi-tasking.webp`      | Multi-Tasking      | violet `#8e61f6` |
| `moving-target.webp`      | Moving Target      | cyan `#06b6d4` |
| `grid-memorization.webp`  | Grid Memorization  | blue `#3b82f6` |
| `shade-finder.webp`       | Shade Finder       | cyan `#06b6d4` |
| `tower-of-hanoi.webp`     | Tower of Hanoi     | amber `#f59e0b` |
| `concentration-grid.webp` | Concentration Grid | cyan `#06b6d4` |
| `finger-sequencing.webp`  | Finger Sequencing  | pink `#ec4899` |

## Specs

- **Aspect ratio: 4 : 3** (the card crops to this; anything outside is clipped).
- Export **1024 × 768** or larger. `.webp` preferred (`.png` also works — then
  change the extension in `HomePageClient.js`, or just convert to `.webp`).
- Keep the subject centred and away from the **top-left corner** (difficulty
  pill) and **bottom-left / bottom-right corners** (duration + play button sit
  there).
- No text, no logos, no UI chrome — the card adds its own.
