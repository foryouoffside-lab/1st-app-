'use client';

// components/MobileHeader.js
// SkillDrills Pro — Compact top header for mobile
// Shows: Avatar + Name | Streak flame | Level badge, per the approved
// design spec's .mh/.id-block/.chip pattern (see FULL_APP_VISUAL_DESIGN_SPEC.md §2).

import { useEffect, useState } from 'react';
import { Flame } from 'lucide-react';
import { getStreak, getPlayerLevel } from '../lib/progressStore';
import { useAuth } from '../contexts/AuthContext';

export default function MobileHeader() {
  const { user } = useAuth();
  const [streak, setStreak] = useState(0);
  const [level,  setLevel]  = useState(1);
  const [xpIn,   setXpIn]   = useState(0);
  const [xpTo,   setXpTo]   = useState(1000);

  useEffect(() => {
    async function load() {
      try {
        const [s, lv] = await Promise.all([getStreak(), getPlayerLevel()]);
        setStreak(s.current);
        setLevel(lv.level);
        setXpIn(lv.xpInLevel);
        setXpTo(lv.xpToNext);
      } catch {}
    }
    load();
  }, []);

  const displayName = user?.displayName?.split(' ')[0] || 'Player';
  const initials = (user?.displayName || 'Player').trim().slice(0, 2).toUpperCase();

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 md:hidden bg-[#050508]/95 backdrop-blur-xl border-b border-white/[0.04] flex flex-col"
      style={{ 
        paddingTop: 'calc(16px + env(safe-area-inset-top))',
        paddingBottom: '0px'
      }}
    >
      <div className="flex items-center justify-between px-4 pb-4.5">
        {/* Identity: avatar + name */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-pink-500 to-violet-400 flex items-center justify-center font-bold text-xs text-white shrink-0 overflow-hidden border border-white/[0.08]">
            {user?.photoURL ? (
              <img src={user.photoURL} alt={displayName} className="w-full h-full object-cover" />
            ) : (
              initials
            )}
          </div>
          <div className="text-sm font-black text-white tracking-tight">{displayName}</div>
        </div>

        {/* Right: Streak + Level */}
        <div className="flex items-center gap-2">
          {streak > 0 && (
            <div className="flex items-center gap-0.5 bg-orange-500/10 text-orange-400 text-[10px] px-2 py-1 rounded-full border border-orange-500/20 font-black">
              <Flame className="w-3 h-3 fill-orange-400" />
              <span>{streak}</span>
            </div>
          )}
          <div className="bg-neutral-900 border border-neutral-800 text-neutral-300 text-[10px] px-2 py-1 rounded-full font-black">
            LV {level}
          </div>
        </div>
      </div>

      {/* XP progress bar */}
      <div className="xp-track w-full">
        <div
          className="xp-fill transition-all duration-700 h-[2px] bg-gradient-to-r from-violet-500 to-cyan-400"
          style={{ width: `${Math.min(100, Math.round((xpIn / (xpIn + xpTo)) * 100))}%` }}
        />
      </div>
    </header>
  );
}
