// lib/immersive.js
// SkillDrills — edge-to-edge full screen while a drill route is open.
//
// The drills already hid the STATUS bar through @capacitor/status-bar, but
// nothing hid the NAVIGATION bar, so every board was drawn into the screen
// minus the gesture pill / button bar at the bottom. Two of the 24 drills
// (Concentration Grid, Distraction Fighter) never asked for full screen at
// all. Doing it here, from DrillWrapper, is what makes all 24 behave the same.
//
// Native path is a small in-repo plugin (ImmersiveModePlugin.java) because no
// Capacitor plugin exposes the navigation bar. Browser path is the standard
// Fullscreen API, which needs a user gesture — the drills' own enterDrill()
// already calls requestFullscreen() from inside the START handler, so this
// just tries and accepts a rejection.
//
// Best-effort throughout: a failure here must never stop a drill loading.

import { Capacitor, registerPlugin } from '@capacitor/core';

const ImmersiveNative = registerPlugin('ImmersiveMode');

let holders = 0;

export function enterImmersive() {
  holders += 1;
  if (holders > 1) return;

  if (Capacitor.isNativePlatform()) {
    ImmersiveNative.enable().catch(() => {});
    return;
  }
  // Browser only. Rejected without a gesture, which is fine — the drill's own
  // START handler makes the same request from inside a real click.
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch {}
}

export function exitImmersive() {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return;

  if (Capacitor.isNativePlatform()) {
    ImmersiveNative.disable().catch(() => {});
    return;
  }
  try {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch {}
}
