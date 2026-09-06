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
