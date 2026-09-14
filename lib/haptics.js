// lib/haptics.js
// SkillDrills — the felt half of "you got that wrong".
//
// WHY THIS EXISTS
//
// A mistake used to register in the hand as well as the ear, but by accident:
// the penalty sound sat at 220/165Hz, below what a phone speaker can radiate,
// so instead of becoming sound that energy went into vibrating the case. The
// player felt a thud. That turned out to be worth keeping — a mistake landing
// in the body is faster feedback than a mistake landing only in the ear.
//
// Getting it from the speaker was the wrong way to get it:
//   - it is a chassis lottery, different on every phone and absent on a
//     well-damped one;
//   - it only works while the phone is being held, and reads as a cheap
//     rattle on a table;
//   - it cannot be tuned separately from volume, because it IS volume;
//   - it spends speaker headroom on frequencies the driver cannot reproduce,
//     muddying the note that is actually meant to be heard.
//
// So the sound was moved up out of the buzz band (see playPenalty in
// lib/gameAudio.js) and the felt part moved here, to the haptic motor, where
// it is consistent across devices, works on a table, and has its own setting.
//
// This is also what earns @capacitor/haptics its place: the dependency was
// already installed and already declaring the VIBRATE permission, while
// nothing in the app had ever called it.

import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

// Read on the hot path (inside a running drill), so it has to be synchronous.
// AppShellClient seeds it from stored settings at startup and the Progress
// toggle updates it; the default matches getSettings().
let enabled = true;

// Mistakes can arrive in bursts — a mistimed run of taps, a chain of misses as
// a round falls apart. Firing the motor on every one of those does not read as
// feedback, it reads as a rattle, and it is the one thing here that costs real
// battery. One tap per 90ms is enough to feel every distinct mistake while
// collapsing a burst into a single pulse.
const MIN_GAP_MS = 90;
let lastAt = 0;

export function setHapticsEnabled(value) {
  enabled = value !== false;
}

/**
 * A short tap for a wrong answer / miss.
 *
 * Deliberately ImpactStyle.Light. In SOLO a mistake costs no score — only time
 * — so this is a nudge, not a punishment, and it matches the gentle falling
 * chime it accompanies. Anything heavier turns the app into something that
 * tells you off.
 *
 * Correct hits get NOTHING on purpose. The contrast is the signal: if success
 * also buzzed, neither would mean anything, and the motor would run several
 * times a second for a whole session.
 *
 * Fire-and-forget and never throws — this is called from inside a game loop,
 * so a failure here must not interrupt a drill.
 */
export function missFeedback() {
  if (!enabled) return;
  try {
    if (!Capacitor.isNativePlatform()) return;
    const now = Date.now();
    if (now - lastAt < MIN_GAP_MS) return;
    lastAt = now;
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  } catch {
    // No motor, permission refused, plugin missing — the sound still plays.
  }
}
