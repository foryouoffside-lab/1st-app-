'use client';

// components/CelebrationToast.js
// SkillDrills Pro — reward-system celebration surface.
//
// lib/progressStore.js dispatches a `sd:celebration` window event whenever a
// drill result triggers a streak milestone, level-up, daily mission
// completion, or daily challenge completion. Listening globally here (rather
// than plumbing return values through every one of the ~24 drill call sites,
// most of which fire the result off fire-and-forget) means this works for
// every drill with zero changes to the drills themselves.
//
// Visual language is reused from GameEndScreen.js's "New Personal Best"
// treatment (sparkle dots + Crown/violet accents) so it reads as part of the
// same reward system rather than a new one-off style.

import { useEffect, useState } from 'react';
import { Crown, Zap, Sparkles, Flame } from 'lucide-react';

const AUTO_DISMISS_MS = 4500;

function buildLines(detail) {
  const lines = [];
  if (detail.streakMilestone) {
    lines.push({ icon: Flame, color: 'text-orange-400', text: `${detail.streakMilestone}-day streak!` });
  }
  if (detail.leveledUp) {
    lines.push({ icon: Crown, color: 'text-yellow-400', text: `Level ${detail.leveledUp} reached!` });
  }
  if (detail.dailyChallengeSetComplete) {
    lines.push({ icon: Sparkles, color: 'text-cyan-400', text: "All 3 of today's drills complete!" });
  } else if (detail.dailyChallengeCompleted) {
    lines.push({ icon: Sparkles, color: 'text-cyan-400', text: 'Daily challenge complete!' });
  }
  return lines;
}

export default function CelebrationToast() {
  const [queue, setQueue] = useState([]);

  useEffect(() => {
    function handleCelebration(e) {
      const detail = e.detail || {};
      const lines = buildLines(detail);
      if (lines.length === 0) return;
      setQueue(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, lines, xpEarned: detail.xpEarned || 0 }]);
    }
    window.addEventListener('sd:celebration', handleCelebration);
    return () => window.removeEventListener('sd:celebration', handleCelebration);
  }, []);

  const active = queue[0] || null;

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      setQueue(prev => prev.slice(1));
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [active]);

  if (!active) return null;

  return (
    <div className="fixed top-44 left-1/2 -translate-x-1/2 z-[9999] w-full max-w-md px-4 pointer-events-none">
      <div
        className="relative overflow-hidden rounded-2xl p-4 pointer-events-auto shadow-[0_0_30px_rgba(139,92,246,0.25)]"
        style={{ background: 'linear-gradient(180deg, #17122b 0%, #0d0d18 100%)', border: '1px solid rgba(139,92,246,0.25)' }}
      >
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {[...Array(8)].map((_, i) => (
            <div
              key={i}
              className="absolute w-1 h-1 rounded-full animate-ping"
              style={{
                background: '#fbbf24',
                left: `${10 + i * 11}%`,
                top: `${20 + (i % 3) * 25}%`,
                animationDelay: `${i * 0.15}s`,
                animationDuration: '1.5s',
                opacity: 0.5,
              }}
            />
          ))}
        </div>

        <div className="relative space-y-1.5">
          {active.lines.map((line, i) => {
            const Icon = line.icon;
            return (
              <div key={i} className="flex items-center gap-2">
                <Icon className={`w-4 h-4 ${line.color} shrink-0`} />
                <span className="text-sm font-black text-white">{line.text}</span>
              </div>
            );
          })}
          {active.xpEarned > 0 && (
            <div className="flex items-center gap-2 pt-1.5 mt-1.5 border-t border-white/10">
              <Zap className="w-3.5 h-3.5 text-violet-400 shrink-0" />
              <span className="text-xs font-bold text-violet-300">+{active.xpEarned} XP</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
