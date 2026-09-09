'use client';

// components/LevelBadge.js
// The XP-level rank pill ("the batch"). Icon + rank name + level number.
// Used on the Arena profile sheet and the Progress page. See lib/levelBadge.js
// for the rank ladder.

import { badgeForLevel } from '../lib/levelBadge';

export default function LevelBadge({ level, showName = true, size = 'sm', className = '' }) {
  const lv = Math.floor(Number(level) || 0);
  if (lv < 1) return null;

  const badge = badgeForLevel(lv);
  const Icon = badge.icon;
  const xs = size === 'xs';

  return (
    <span
      className={`inline-flex items-center rounded-full border font-black uppercase tracking-wider ${badge.cls} ${
        xs ? 'gap-1 px-1.5 py-0.5 text-[8px]' : 'gap-1.5 px-2 py-0.5 text-[9px]'
      } ${className}`}
      title={`${badge.name} — Level ${lv}`}
    >
      <Icon className={xs ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      {showName ? `${badge.name} · Lv ${lv}` : `Lv ${lv}`}
    </span>
  );
}
