'use client';

// lib/playerIdentity.js
// SkillDrills — the signed-in player's public name, readable synchronously.
//
// The shared score card needs a name at draw time, but it's produced by
// generateShareCard() — a plain function called from ~24 drill components, not
// a React component, so it can't call useAuth(). Rather than thread the user
// object through every one of those call sites, AuthContext publishes the name
// here whenever the profile resolves and everything else reads it from here.
//
// The name IS the unique username: AuthContext reserves it atomically at
// `usernames/{lowercased displayName}` and it's immutable afterwards, so
// `displayName` is safe to treat as a stable public handle.
//
// Mirrored into localStorage so a card drawn before the auth listener has
// resolved (cold start straight into a drill) still shows the right name
// instead of falling back to the generic placeholder.

const STORAGE_KEY = 'sd_player_name';

let cachedName = null;

/** Called by AuthContext on profile load/change, and with null on sign-out. */
export function setPlayerName(name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  cachedName = clean || null;
  try {
    if (cachedName) localStorage.setItem(STORAGE_KEY, cachedName);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / storage disabled — the in-memory copy still works for
    // this session, which is the case that matters.
  }
}

/**
 * The player's username, or null when signed out.
 * Callers decide their own placeholder; the share card omits the handle
 * entirely rather than printing something meaningless.
 */
export function getPlayerNameOrNull() {
  if (cachedName) return cachedName;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cachedName = stored;
      return cachedName;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Username format — the ONE place the rules live.
//
// 3-10 characters, ASCII letters and digits only. No spaces, no punctuation,
// no emoji. Three reasons this is tight rather than permissive:
//   1. The name is a handle other people TYPE — the Arena friend search and
//      the duel invite flow both look a player up by it. A name with spaces
//      or invisible characters in it is a name nobody can successfully
//      search for.
//   2. It is rendered in fixed-width furniture — leaderboard rows, the duel
//      head-to-head card, the share card — where a long name either clips or
//      forces everything else to shrink. 10 is what those layouts fit.
//   3. It blocks the whole family of impersonation tricks that depend on
//      whitespace and lookalike characters (trailing spaces, double spaces,
//      zero-width joiners) making two different names render identically.
//
// Names created BEFORE this rule are unaffected: display names are immutable
// (firestore.rules locks the field), so nobody is ever asked to re-pick, and
// existing longer names keep rendering and resolving exactly as they did.
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 10;

/**
 * Strip a raw string down to something that CAN be a username.
 * Used live on the sign-up input so a disallowed character simply never
 * appears, rather than being accepted and then rejected on submit.
 */
export function sanitizeUsername(raw) {
  return (typeof raw === 'string' ? raw : '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, USERNAME_MAX);
}

/**
 * Validate an already-sanitized name.
 * Returns null when it's fine, or a short human-readable reason when it
 * isn't — the same strings the sign-up form shows.
 */
export function validateUsername(raw) {
  const name = typeof raw === 'string' ? raw : '';
  if (name.length < USERNAME_MIN) return `Must be at least ${USERNAME_MIN} characters.`;
  if (name.length > USERNAME_MAX) return `Must be ${USERNAME_MAX} characters or fewer.`;
  if (!/^[A-Za-z0-9]+$/.test(name)) return 'Letters and numbers only — no spaces.';
  return null;
}
