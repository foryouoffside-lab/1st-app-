// lib/crashReporting.js
// Thin wrapper around @capacitor-firebase/crashlytics. Every method on that
// plugin throws "Not implemented on web" (it's Android/iOS only), and this
// app also runs as a plain website — so every call here is gated behind
// Capacitor.isNativePlatform() in one place instead of repeating that check
// (and risking someone forgetting it) at every call site.

import { Capacitor } from '@capacitor/core';
import { FirebaseCrashlytics } from '@capacitor-firebase/crashlytics';

const isNative = () => Capacitor.isNativePlatform();

export function reportError(error, context) {
  const message = error?.message || String(error);
  if (!isNative()) {
    console.error('[crashReporting]', context || '(uncaught)', error);
    return;
  }
  FirebaseCrashlytics.recordException({
    message: context ? `${context}: ${message}` : message,
  }).catch(() => {});
}

export function identifyUser(uid) {
  if (!isNative() || !uid) return;
  FirebaseCrashlytics.setUserId({ userId: uid }).catch(() => {});
}
