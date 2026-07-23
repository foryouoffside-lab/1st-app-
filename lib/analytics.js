// lib/analytics.js
// Thin wrapper around @capacitor-firebase/analytics (same Firebase project
// as auth/Crashlytics — no new account). Scoped to native only for now: the
// app's stated focus is the packaged Android app, not the website (which
// already has Vercel Analytics for pageviews — see app/layout.js). The web
// build of this plugin *would* work via the Firebase JS SDK, but that
// requires Analytics to be linked to the Firebase project in the console,
// which hasn't been confirmed, so it's left off to avoid surprises on the
// live site.

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
