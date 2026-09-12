# App reliability review — 2026-09-11

## Changes

- Arena searches now serialize scans, invalidate late responses after cancellation or navigation, and stop polling when a match is found. A late-created invite is withdrawn. Queue cleanup no longer blocks the found state, and a failed withdrawal is not treated as proof that an opponent accepted.
- Queue heartbeats update existing entries instead of recreating deleted entries. Repeated final-score submissions are guarded while a submission is in flight. Arena subscriptions follow user identity rather than restarting after every profile update.
- Four drill configurations now use the shared 45-second duel duration. Quick Dodge, Shade Finder, and Moving Target derive arena time from the shared deadline instead of accumulating local timer drift.
- Landscape fallback prompts remain visible in arena mode. Quick Dodge resets stale touch coordinates on resize. Quick Dodge and Sequence Aim invalidate interrupted launches and countdown work after leaving or changing matches.
- Offscreen and hidden-tab drill previews pause their CSS animations. Presence correctly returns online after a brief background/resume cycle and cleans up late native listener registration.
- Daily Arena Challenge selection uses an unsigned hash shift, preventing invalid negative drill indexes on some dates.
- Fixed lint errors throughout app/components/lib/contexts. Removed unused Sequence Aim state. Set the Next.js tracing root to this project to prevent Windows builds scanning the parent user directory.

## Verification

- ESLint: 97 files checked, zero errors, 46 warnings remain (primarily hook dependencies and image guidance).
- `node --test scripts/arena-regression.test.cjs`: 11 passing tests covering asynchronous queue races, blocked cleanup, declined-match routing, presence lifecycle, 3,650 dates of arena selections, and an interrupted Sequence Aim launch.
- `node scripts/app-smoke.cjs`: all ten drill startup checks passed in headless Edge. Quick Dodge pixel dragging and resize input cancellation passed. Offscreen preview pausing passed. No uncaught page errors in that run.
- Production static build/export passed. Lint was run separately because the existing build configuration skips lint and type validation.

The browser test uses the existing development-only preview mode. To repeat it, start a separate development server on `127.0.0.1:3210` with `NEXT_PUBLIC_CAPTURE_PREVIEWS=1` and `NEXT_CAPTURE_DIST=.next-smoke`, then run the script. The browser blocks external requests; it does not create real accounts, matches, or score records.

## Remaining validation

These checks do not certify live two-device matchmaking, cross-device simultaneous acceptance, deployed Firestore rules/indexes, reconnect behavior against the real backend, or sustained Android CPU/GPU/thermal performance. No backend deployment or live match was performed. CPU and frame-rate improvements have not been quantified on a physical phone; zero lag on every device is not established. The 46 lint warnings were not suppressed globally.
