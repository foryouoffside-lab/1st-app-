'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2, Play, Flame, Swords, Award, Lock, ChevronRight,
  Layers, Grid3x3, Shield, Crosshair, Contrast, Copy, Brain, Puzzle, Fingerprint, Zap,
} from 'lucide-react';
import { getSessionState, markSessionStarted } from '../../lib/sessionFlow';
import { getWeeklyGoal, WEEKLY_TARGET } from '../../lib/weeklyGoal';
import { getArenaChallenge } from '../../lib/arenaChallenge';
import { getStreak } from '../../lib/progressStore';
import { logEvent } from '../../lib/analytics';

// One small original mark per drill, not a shared category icon — a wall of
// identical icons said nothing about which game was which.
const DRILL_LOGO = {
  'multi-tasking': Layers,
  'concentration-grid': Grid3x3,
  'distraction-fighter': Shield,
  'moving-target': Crosshair,
  'shade-finder': Contrast,
  'card-matching': Copy,
  'grid-memorization': Brain,
  'tower-of-hanoi': Puzzle,
  'finger-sequencing': Fingerprint,
  'quick-dodge': Zap,
};

// One row for a session drill: number, mark, name + meta, play/done end-cap.
// The "next" drill is emphasised (violet border, filled play button), but ALL
// three are tappable — the session is guided, not gated. Tapping any drill
// starts the session and jumps straight into that one.
function SessionRow({ n, drill, isNext, onPick }) {
  const DrillLogo = DRILL_LOGO[drill.id] || Zap;
  const done = drill.completed;

  const body = (
    <div
      className="flex items-center gap-3.5 rounded-2xl border p-4 transition-colors"
      style={{
        background: 'var(--card)',
        borderColor: done
          ? 'color-mix(in srgb, #22c55e 32%, var(--line))'
          : isNext ? 'color-mix(in srgb, var(--brand-2) 45%, var(--line))' : 'var(--line)',
      }}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-black tabular-nums"
        style={{ borderColor: 'var(--line)', color: done ? '#22c55e' : isNext ? 'var(--brand-3)' : 'var(--text-faint)' }}>
        {done ? <CheckCircle2 className="h-4 w-4" /> : n}
      </span>

      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
        style={{ background: 'var(--card-raised)', borderColor: 'var(--line)', color: done ? '#22c55e' : 'var(--brand-3)' }}>
        <DrillLogo className="h-5 w-5" />
      </span>

      <div className="min-w-0 flex-1">
        <h3 className="truncate font-display text-lg leading-none text-white">{drill.name}</h3>
        {/* Short enough to always fit — the category is already named in the
            "why these three" line above, so the row just carries pace + bonus. */}
        <p className="mt-1.5 text-[10px] font-semibold text-white/55">
          {drill.timeHint || 'Endurance'} &nbsp;&bull;&nbsp; 2&times; XP
        </p>
      </div>

      {done ? (
        <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400">Done</span>
      ) : (
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors"
          style={isNext
            ? { background: 'var(--brand-2)', borderColor: 'var(--brand-2)', color: '#fff' }
            : { background: 'var(--card-raised)', borderColor: 'var(--line)', color: 'var(--brand-3)' }}
        >
          <Play className="ml-0.5 h-[18px] w-[18px]" fill="currentColor" />
        </span>
      )}
    </div>
  );

  if (done) return body;
  return (
    <button type="button" onClick={() => onPick(drill)} className="block w-full text-left">
      {body}
    </button>
  );
}

export default function DailyClient() {
  const router = useRouter();
  const [session, setSession] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [arena, setArena] = useState(null);
  const [streak, setStreak] = useState(0);

  const load = useCallback(async () => {
    try {
      const [sess, wk, a, s] = await Promise.all([
        getSessionState(),
        getWeeklyGoal().catch(() => null),
        getArenaChallenge(),
        getStreak(),
      ]);
      setSession(sess);
      setWeekly(wk);
      setArena(a);
      setStreak(s.current);
    } catch (error) {
      console.error('Failed to load daily session:', error);
    }
  }, []);

  useEffect(() => {
    load();
    // A duel finished elsewhere updates the Arena set; a drill finished
    // elsewhere updates the session. Refresh both on return to this page.
    const refresh = () => load();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  function startSession() {
    if (!session?.nextDrill) return;
    pickDrill(session.nextDrill);
  }

  // Tapping ANY of the three (not just "next") starts the session and jumps
  // straight into that drill — guided, not gated.
  function pickDrill(drill) {
    if (!drill?.href) return;
    markSessionStarted().catch(() => {});
    logEvent('session_start', { source: 'daily' });
    router.push(drill.href);
  }

  const drills = session?.drills || [];
  const done = session?.completedCount || 0;
  const total = session?.total || 3;
  const allDone = !!session?.allComplete;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#050508] pb-28 text-slate-100" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
      <div className="relative mx-auto max-w-lg space-y-6 px-4 pt-0">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="font-display text-[28px] text-white">Today&apos;s Session</h1>
          {streak > 0 && (
            <div className="flex items-center gap-1 rounded-xl border px-3 py-1.5"
              style={{ background: 'var(--card)', borderColor: 'var(--line)' }}>
              <Flame className="h-3.5 w-3.5 text-orange-400" />
              <span className="text-xs font-black text-orange-300">{streak}d</span>
            </div>
          )}
        </div>

        {/* Session progress + why-these-three */}
        <div className="rounded-2xl border p-4" style={{ background: 'var(--card)', borderColor: 'var(--line)' }}>
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-white">
              {allDone ? 'Complete' : done > 0 ? `${done} of ${total} done` : `${total} drills`}
            </span>
            {!allDone && session?.nextDrill && (
              <span className="text-slate-400">Next: <span className="text-slate-200">{session.nextDrill.name}</span></span>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[.06]">
            <div className="h-full rounded-full bg-violet-500 transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
          {session?.explanation && (
            <p className="mt-2.5 text-[11.5px] leading-snug text-slate-400">
              {session.personalized ? null : <span className="text-slate-500">New player · </span>}
              {session.explanation}
            </p>
          )}
        </div>

        {/* The three drills — ordered, "next" emphasised, all tappable */}
        <div className="space-y-3">
          {drills.map((d, i) => (
            <SessionRow
              key={d.id}
              n={i + 1}
              drill={d}
              isNext={!!session.nextDrill && session.nextDrill.id === d.id}
              onPick={pickDrill}
            />
          ))}
        </div>

        {/* Primary CTA — mirrors Home, state-specific */}
        {!allDone ? (
          <button
            onClick={startSession}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-4 py-3.5 text-sm font-black text-white transition hover:bg-violet-500 active:scale-[.99]"
          >
            <Play className="h-4 w-4 fill-current" />
            {done > 0 ? `Continue — ${total - done} drill${total - done === 1 ? '' : 's'} left` : "Start today's session"}
          </button>
        ) : (
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 text-center">
            <div className="flex items-center justify-center gap-1.5 font-display text-lg text-emerald-400">
              <CheckCircle2 className="h-5 w-5" /> Session complete
            </div>
            <p className="mt-1 text-xs text-slate-300">A fresh set unlocks at midnight. Free practice stays open any time.</p>
            <Link href="/progress" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-violet-300 hover:text-violet-200">
              See your progress <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}

        {/* ── Weekly goal — compact. 5 days a week clears it; the streak
             already covers "come back", this just forgives a missed day. ── */}
        {weekly && (
          <div className="rounded-2xl border p-4" style={{ background: 'var(--card)', borderColor: 'var(--line)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-amber-400" />
                <h2 className="font-display text-[17px] text-white">This Week</h2>
              </div>
              <span className="text-[11px] font-black tabular-nums text-slate-300">
                {weekly.completed}<span className="text-slate-500"> / {WEEKLY_TARGET} days</span>
              </span>
            </div>

            <div className="mt-2.5 flex gap-1.5">
              {weekly.days.map((d) => (
                <span
                  key={d.date}
                  title={d.date}
                  className="h-2 flex-1 rounded-full"
                  style={{ background: d.done ? '#8b5cf6' : d.isToday ? 'rgba(139,92,246,0.3)' : 'rgba(255,255,255,0.08)' }}
                />
              ))}
            </div>

            {weekly.nextBadge && (
              <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                {weekly.allDone
                  ? <><Award className="h-3.5 w-3.5 text-amber-400" /> <span className="text-amber-300 font-bold">{weekly.nextBadge.name}</span> earned this week</>
                  : <><Lock className="h-3 w-3" /> <span className="text-slate-300">{weekly.nextBadge.name}</span> · {WEEKLY_TARGET - weekly.completed} more {WEEKLY_TARGET - weekly.completed === 1 ? 'day' : 'days'}</>}
              </p>
            )}

            {weekly.earnedBadges.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-slate-500">Earned</span>
                {weekly.earnedBadges.map((b) => (
                  <span key={b.id} className="rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                    {b.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Arena Challenges — an OPTIONAL extra, not part of the session ── */}
        {arena && arena.drills.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Swords className="h-4 w-4 text-violet-300" />
                <h2 className="font-display text-[20px] text-white">Arena Challenges</h2>
              </div>
              <span className="text-[11px] font-black tabular-nums text-white/50">{arena.completedCount}/{arena.total}</span>
            </div>
            <p className="-mt-1 text-[11px] text-slate-400">
              Optional bonus XP from duel play. Doesn&apos;t count toward your daily session or streak.
            </p>

            {arena.drills.map((d) => {
              const DrillLogo = DRILL_LOGO[d.id] || Swords;
              return (
                <Link
                  key={d.slug}
                  href={`/challenge?duel=${encodeURIComponent(d.slug)}`}
                  className="flex items-center gap-3.5 rounded-2xl border p-4 transition-colors"
                  style={{
                    background: 'var(--card)',
                    borderColor: d.completed ? 'color-mix(in srgb, #22c55e 32%, var(--line))' : 'var(--line)',
                  }}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                    style={{ background: 'var(--card-raised)', borderColor: 'var(--line)', color: d.completed ? '#22c55e' : 'var(--brand-3)' }}>
                    <DrillLogo className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-display text-lg leading-none text-white">{d.name}</h3>
                    <div className="mt-1.5 text-[10px] font-semibold text-white/55">Arena duel &bull; 2&times; XP</div>
                  </div>
                  {d.completed
                    ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                    : <Play className="ml-0.5 h-[18px] w-[18px] shrink-0 text-violet-300" fill="currentColor" />}
                </Link>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
