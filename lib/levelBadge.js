// lib/levelBadge.js
// SkillDrills — XP-level rank badge ("the batch").
//
// The player's training level (progressStore.getPlayerLevel = floor(xp/1000)+1)
// maps to one of these named ranks. It is a SEPARATE ladder from the Arena EIQ
// tiers (Bronze/Silver/Gold/Diamond) — that one measures duel skill, this one
// measures how much you have trained overall — so the names deliberately don't
// overlap.
//
// The badge is shown on the Arena profile sheet and the Progress page, and is
// visible to other players: AuthContext pushes `level` onto the public
// users/{uid} doc whenever it changes (see the level-sync effect there).

import { Shield, Star, Award, Gem, Crown } from 'lucide-react';

// Ordered low → high. `min` is the first level that earns the rank. Colours
// escalate cool → warm → gold, matching the app's existing tier-pill palette
// (see tierClsFor / badgesFor). No glow — the colour ramp and the level number
// are the "premium at high level" signal, in keeping with the flat theme.
export const LEVEL_BADGES = [
  { id: 'recruit',    name: 'Recruit',    min: 1,  icon: Shield, cls: 'text-neutral-300 border-[#33344a] bg-[#1a1b26]' },
  { id: 'cadet',      name: 'Cadet',      min: 3,  icon: Shield, cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  { id: 'operative',  name: 'Operative',  min: 6,  icon: Star,   cls: 'text-cyan-300 border-cyan-400/30 bg-cyan-400/10' },
  { id: 'specialist', name: 'Specialist', min: 11, icon: Star,   cls: 'text-blue-300 border-blue-400/30 bg-blue-400/10' },
  { id: 'veteran',    name: 'Veteran',    min: 18, icon: Award,  cls: 'text-violet-300 border-violet-400/30 bg-violet-400/10' },
  { id: 'elite',      name: 'Elite',      min: 28, icon: Gem,    cls: 'text-amber-300 border-amber-400/40 bg-amber-400/10' },
  { id: 'legend',     name: 'Legend',     min: 41, icon: Crown,  cls: 'text-yellow-300 border-yellow-400/50 bg-yellow-400/10' },
];

/** The badge rank for a given training level. Never null — level 1 is Recruit. */
export function badgeForLevel(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  let badge = LEVEL_BADGES[0];
  for (const b of LEVEL_BADGES) {
    if (lv >= b.min) badge = b;
  }
  return badge;
}
