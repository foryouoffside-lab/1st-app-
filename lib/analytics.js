// lib/analytics.js
// Thin wrapper around @capacitor-firebase/analytics (same Firebase project
// as auth/Crashlytics — no new account). Scoped to native only for now: the
// app's stated focus is the packaged Android app, not the website (which
// already has Vercel Analytics for pageviews — see app/layout.js). The web
// build of this plugin *would* work via the Firebase JS SDK, but that
// requires Analytics to be linked to the Firebase project in the console,
// which hasn't been confirmed, so it's left off to avoid surprises on the
// live site.
//
// ── The daily-session funnel ────────────────────────────────────────────────
// Four events, no extra personal data (Firebase already ties events to the
// pseudonymous app-instance id; we add the signed-in uid via setUserId in
// AppShellClient, and nothing here carries names, emails or scores beyond what
// drill_completed already did):
//
//   session_start          — the player tapped "Start / Continue today's
//                            session" on Home or Daily. param: source.
//   session_drill_complete — a daily-set drill was completed for the first
//                            time today (fired from progressStore, so retries
//                            and reloads don't re-count). param: drill_id.
//   daily_session_complete — all three of today's drills are done.
//   weekly_goal_complete   — five daily sessions finished in one local week.
//
// Session-completion rate = daily_session_complete / session_start over a day.
// In-session drop-off = session_drill_complete count vs 3× session_start.
//
// ── Retention (measure, don't claim) ────────────────────────────────────────
// Firebase Analytics logs `first_open` and `session_start` on its own. Day-1
// retention = users with a Firebase `session_start` on calendar day N+1 after
// their `first_open` on day N, divided by the day-N `first_open` cohort;
// day-7 is the same at N+7. Both read straight off the Firebase console's
// Retention report (or BigQuery export) with no new instrumentation. Do NOT
// report a retention delta from this work until at least two full weekly
// cohorts exist on each side of the release — before that there is no baseline
// to compare against.

import { Capacitor } from '@capacitor/core';
import { FirebaseAnalytics } from '@capacitor-firebase/analytics';

const isNative = () => Capacitor.isNativePlatform();

export function logScreenView(screenName) {
  if (!isNative()) return;
  FirebaseAnalytics.setCurrentScreen({ screenName }).catch(() => {});
}

export function logEvent(name, params) {
  if (!isNative()) return;
  FirebaseAnalytics.logEvent({ name, params }).catch(() => {});
}

export function identifyAnalyticsUser(uid) {
  if (!isNative() || !uid) return;
  FirebaseAnalytics.setUserId({ userId: uid }).catch(() => {});
}
