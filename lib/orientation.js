// lib/orientation.js
// SkillDrills Pro — Dynamic Orientation Controller
// Handles locking/unlocking device screen orientation programmatically.
//
// Android's WebView has never reliably implemented the web Screen
// Orientation API (screen.orientation.lock() silently fails as
// "NotSupportedError" on many real devices) — so on native platforms this
// goes through @capacitor/screen-orientation instead, which calls Android's
// native orientation lock directly and always works. The web API is kept as
// the path for the actual browser site (skilldrills.online).

import { Capacitor } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

export async function lockLandscape() {
  try {
    if (Capacitor.isNativePlatform()) {
      await ScreenOrientation.lock({ orientation: 'landscape' });
      return true;
    }
    if (typeof window !== 'undefined' && window.screen && window.screen.orientation) {
      await window.screen.orientation.lock('landscape');
      return true;
    }
  } catch (e) {
    console.warn("Screen orientation lock failed: ", e);
  }
  return false;
}

export async function lockPortrait() {
  try {
    if (Capacitor.isNativePlatform()) {
      await ScreenOrientation.lock({ orientation: 'portrait' });
      return true;
    }
    if (typeof window !== 'undefined' && window.screen && window.screen.orientation) {
      await window.screen.orientation.lock('portrait');
      return true;
    }
  } catch (e) {
    console.warn("Screen orientation lock failed: ", e);
  }
  return false;
}

export async function unlockOrientation() {
  try {
    if (Capacitor.isNativePlatform()) {
      await ScreenOrientation.unlock();
      return true;
    }
    if (typeof window !== 'undefined' && window.screen && window.screen.orientation) {
      window.screen.orientation.unlock();
      return true;
    }
  } catch (e) {
    console.warn("Screen orientation unlock failed: ", e);
  }
  return false;
}
