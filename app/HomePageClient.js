'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import {
  ArrowRight, BarChart3, Brain, CheckCircle2, ChevronRight, Crown,
  Flame, Play, Sparkles, Swords, Target, Timer, Trophy, Zap,
  Database, Eye, Activity, BookOpen, Dumbbell, Hand
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { acceptChallenge } from '../lib/challengeEngine';
import { ARENA_ENABLED } from '../lib/featureFlags';
import { getDailyChallenge } from '../lib/dailyChallenge';
import {
  getAllDrillProgress, getDrillsPlayed, getPlayerLevel, getStreak,
  getTotalSessions,
} from '../lib/progressStore';
import { getDailyMission, getTrainingFocus, setTrainingFocus, TRAINING_FOCUSES } from '../lib/playerJourney';
import { Storage } from '../lib/storage';
import { DRILL_INDEX } from '../lib/drillIndex';
import { DRILL_GROUPS, getDrillGroup, getGroupIcon } from '../lib/drillGroups';

const HOMEPAGE_CATEGORIES = DRILL_GROUPS.map(g => ({
  slug: g.id,
  name: g.name,
  icon: g.icon,
  emoji: g.emoji,
  accent: g.accent,
  href: `/drills/cognitive?group=${g.id}`,
}));

function useMidnightCountdown() {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      const seconds = Math.max(0, Math.floor((midnight - now) / 1000));
      const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      setCountdown(`${hours}:${minutes}`);
    };
    update();
    const interval = window.setInterval(update, 30000);
    return () => window.clearInterval(interval);
  }, []);

  return countdown;
}

function prettyDrillName(drillId) {
  return drillId.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export default function HomePageClient() {
  const { user, db } = useAuth();
  const router = useRouter();
  const [daily, setDaily] = useState(null);
  const [level, setLevel] = useState({ level: 1, xpInLevel: 0, xpToNext: 1000 });
  const [streak, setStreak] = useState({ current: 0, longest: 0 });
  const [stats, setStats] = useState({ sessions: 0, drills: 0 });
  const [recent, setRecent] = useState([]);
  const [arenaChallenges, setArenaChallenges] = useState([]);
  const [bestCombo, setBestCombo] = useState(0);
  const [trainingFocus, setTrainingFocusState] = useState(null);
  const [mission, setMission] = useState(null);
  const [progress, setProgress] = useState({});
  const countdown = useMidnightCountdown();

  useEffect(() => {
    async function loadDashboard() {
      try {
        const [today, playerLevel, playerStreak, sessions, drills, allProgress, history] = await Promise.all([
          getDailyChallenge(), getPlayerLevel(), getStreak(), getTotalSessions(), getDrillsPlayed(), getAllDrillProgress(),
          Storage.getJSON('sd_history', {}),
        ]);
        setDaily(today);
        setLevel(playerLevel);
        setStreak(playerStreak);
        setStats({ sessions, drills });
        setProgress(allProgress);
        const savedFocus = getTrainingFocus();
        setTrainingFocusState(savedFocus);
        if (savedFocus) setMission(getDailyMission(allProgress, savedFocus));
        
        // Calculate best combo from history
        const maxCombo = Object.values(history || {}).reduce((max, list) => {
          const listMax = list.reduce((m, item) => Math.max(m, item.combo || 0), 0);
          return Math.max(max, listMax);
        }, 0);
        setBestCombo(maxCombo);

        setRecent(
          Object.entries(allProgress)
            .map(([id, value]) => ({ id, ...value }))
            .filter(item => item.lastPlayed)
            .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed))
            .slice(0, 4), // Spec asks for up to 4 in continue training
        );
      } catch (error) {
        console.error('Unable to load home dashboard', error);
      }
    }
    loadDashboard();
  }, []);

  useEffect(() => {
    if (!ARENA_ENABLED || !db || !user) return;

    // limit(10) caps how much this always-on home-screen listener can pull
    // down; the id/status bail-out below keeps the whole home page from
    // re-rendering when a snapshot fires without the visible list actually
    // changing.
    const arenaQuery = query(
      collection(db, 'challenges'),
      where('status', '==', 'pending'),
      where('toUid', '==', 'global'),
      limit(10),
    );
    const unsubscribeArena = onSnapshot(arenaQuery, snapshot => {
      const challenges = snapshot.docs
        .map(challenge => ({ id: challenge.id, ...challenge.data() }))
        .filter(challenge => challenge.fromUid !== user.uid)
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setArenaChallenges(prev => {
        if (prev.length === challenges.length && prev.every((c, i) => c.id === challenges[i].id)) return prev;
        return challenges;
      });
    }, error => console.error('Unable to load arena challenges', error));

    return () => {
      unsubscribeArena();
    };
  }, [db, user]);

  const xpProgress = useMemo(() => {
    const total = level.xpInLevel + level.xpToNext;
    return total ? Math.round((level.xpInLevel / total) * 100) : 0;
  }, [level]);

  // Themes the Daily Challenge card off whichever category today's drill
  // belongs to, so it reads as a premium category-branded card (matching
  // the Cognitive hub's .cat-hero) instead of a fixed purple/pink gradient.
  const dailyTheme = useMemo(() => {
    if (!daily?.drill) return null;
    return HOMEPAGE_CATEGORIES.find(c => c.slug === getDrillGroup(daily.drill)) || null;
  }, [daily]);
  const DailyIcon = dailyTheme?.icon || Sparkles;

  async function joinArenaChallenge(challenge) {
    if (!user) {
      router.push('/challenge');
      return;
    }
    try {
      await acceptChallenge(challenge.id, user);
      router.push(`/drills/${challenge.drillSlug}?challengeId=${challenge.id}`);
    } catch (error) {
      console.error('Unable to join arena challenge', error);
      alert(error?.code === 'arena/locked-out' ? error.message : 'This challenge is no longer available. Please choose another one.');
    }
  }

  function chooseTrainingFocus(id) {
    const selectedFocus = setTrainingFocus(id);
    if (!selectedFocus) return;
    setTrainingFocusState(selectedFocus);
    setMission(getDailyMission(progress, selectedFocus));
  }

  const displayName = user?.displayName?.split(' ')[0] || 'Player';
  const isNewUser = stats.drills === 0;

  const getDrillCount = (groupSlug) => {
    return DRILL_INDEX.filter(d => getDrillGroup(d) === groupSlug).length;
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#050508] pb-28 text-slate-100">
      <style dangerouslySetInnerHTML={{ __html: `
        .home-scroll::-webkit-scrollbar { display: none; }
        .home-scroll { -ms-overflow-style: none; scrollbar-width: none; }
      ` }} />

      <main className="relative mx-auto max-w-lg px-4 sm:px-6" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
        <header className="mb-7 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">SkillDrills</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-white">Ready to improve, {displayName}?</h1>
          </div>
          <Link href="/challenge?tab=leaderboard" aria-label="Open leaderboard" className="flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-300 transition hover:bg-amber-300/20">
            <Crown className="h-5 w-5" />
          </Link>
        </header>

        {/* Incoming duel invites are now handled by the global ChallengeNotificationBanner
            (mounted once in AppShellClient) so there's a single notification surface
            instead of a duplicate inline card competing with it here. */}

        {/* 2. Daily Challenge — full width. Level/XP detail lives on /progress only. */}
        <div className="daily-card mb-6" style={dailyTheme ? { '--a': dailyTheme.accent } : undefined}>
          <div className="glowspot" />
          <div className="top">
            <div className="ic">
              <DailyIcon className="w-5 h-5" />
            </div>
            <span className="k">
              <Sparkles className="w-3 h-3 animate-pulse" />
              {isNewUser ? 'Your First Daily Challenge' : 'Daily Challenge'}
            </span>
          </div>
          <h2 className="t">{daily?.drill?.name || 'Loading Daily...'}</h2>
          <p className="d">
            {isNewUser
              ? 'Two minutes to your first score — every streak starts with drill one.'
              : 'Complete it today for double XP.'}
          </p>
          {daily?.completed ? (
            <div className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-emerald-400/10 py-3 text-sm font-bold text-emerald-300">
              <CheckCircle2 className="h-4 w-4" /> Challenge complete
            </div>
          ) : (
            <Link
              href={daily?.drill?.path || '/drills'}
              className="go cursor-pointer"
            >
              {isNewUser ? 'Start now' : 'Play daily challenge'}
              <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>

        {/* 3. Daily mission row (if configured) */}
        {trainingFocus && mission && (
          <section className="mb-8 rounded-3xl border border-violet-300/20 bg-[#101526] p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-300">Today’s mission</span>
                <h2 className="mt-1 text-lg font-black text-white">{mission.focus.label}</h2>
              </div>
              <button onClick={() => setTrainingFocusState(null)} className="text-xs font-bold text-slate-400 transition hover:text-white">Change</button>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[.06]">
              <div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-300 transition-all" style={{ width: `${Math.round((mission.completeCount / mission.total) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-slate-400">{mission.completeCount} of {mission.total} focused drills complete today.</p>
            <div className="mt-3 space-y-2">
              {mission.drills.map((drill, index) => (
                <Link key={drill.id} href={drill.path} className="flex items-center gap-3 rounded-2xl border border-white/[.06] bg-white/[.025] px-3 py-2.5 transition hover:bg-white/[.06]">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${drill.complete ? 'bg-emerald-400/15 text-emerald-300' : 'bg-violet-400/10 text-violet-300'}`}>
                    {drill.complete ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{drill.name}</span>
                  <ArrowRight className="h-4 w-4 text-slate-500" />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* 4. Category Grid */}
        <div className="section-label">Categories</div>
        <div className="cat-grid m md:!grid-cols-3 mb-6">
          {HOMEPAGE_CATEGORIES.map(cat => {
            const Icon = cat.icon;
            const count = getDrillCount(cat.slug);
            return (
              <Link
                key={cat.slug}
                href={cat.href}
                className="cat-tile"
                style={{ '--a': cat.accent }}
              >
                <div className="glow" />
                <div className="ic">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="nm">{cat.name}</div>
                <div className="cnt">{count} drills</div>
              </Link>
            );
          })}
        </div>

        {/* 5. Quiet Wayfinding Link */}
        <Link href="/drills" className="quiet-link mb-6">
          <Target className="icon w-4 h-4" />
          <span>All Drills — browse all <b className="tabular">{DRILL_INDEX.length}</b> across every category</span>
          <ChevronRight className="chev icon w-4 h-4" />
        </Link>

        {/* 6. Continue Training / Onboarding Empty State */}
        <div className="section-label">Continue training</div>
        {isNewUser ? (
          <div className="empty-block mb-8">
            <div className="ic">
              <Target className="icon w-5 h-5" />
            </div>
            <b>No drills played yet</b>
            <span>Finish your first drill to start tracking progress here.</span>
          </div>
        ) : (
          <div className="cont-row home-scroll mb-8">
            {recent.map(item => {
              const drill = DRILL_INDEX.find(d => d.id === item.id) || { name: prettyDrillName(item.id), path: '/drills' };
              const theme = HOMEPAGE_CATEGORIES.find(c => c.slug === getDrillGroup(drill)) || { accent: 'var(--c-cognitive)' };
              const DrillIcon = getGroupIcon(getDrillGroup(drill));
              const attempts = item.attempts || 0;
              const pct = Math.min(100, Math.round((attempts / 10) * 100));
              return (
                <Link
                  key={item.id}
                  href={drill.path || '/drills'}
                  className="cont-card viewfinder-box"
                  style={{ '--a': theme.accent }}
                >
                  <div className="viewfinder-corner tl" />
                  <div className="viewfinder-corner tr" />
                  <div className="lab-ic mb-2"><DrillIcon className="w-5 h-5" /></div>
                  <b>{drill.name}</b>
                  <div className="bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <div className="pct">{attempts} attempts · Best: {item.best?.toLocaleString() || 0}</div>
                </Link>
              );
            })}
          </div>
        )}

        {/* 7. Live Arena Matches — full-width flat cards (spans the same width as a
             2-column category row), stacked when there's more than one challenge.
             Arena is off for now (see lib/featureFlags.js) — shows a Coming Soon
             card instead of the live-duel list/join flow. */}
        <section className="mt-8">
          <SectionHeading icon={Swords} title="Arena challenges" action={ARENA_ENABLED ? 'Open arena' : 'Coming soon'} href="/challenge" />
          {ARENA_ENABLED ? (
            <>
              <p className="-mt-2 mb-3 text-xs text-slate-400">Join a live duel or create your own.</p>
              <div className="flex flex-col gap-3">
                {arenaChallenges.map(challenge => (
                  <article key={challenge.id} className="rounded-2xl border border-fuchsia-300/20 bg-gradient-to-br from-fuchsia-500/15 to-[#111526] p-4 flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-fuchsia-200">
                        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Live duel
                      </span>
                      <h3 className="mt-2 truncate text-base font-black text-white">{challenge.drillName || 'Arena Challenge'}</h3>
                      <p className="mt-0.5 truncate text-xs text-slate-300">Posted by {challenge.fromName || 'a player'}</p>
                    </div>
                    <button
                      onClick={() => joinArenaChallenge(challenge)}
                      className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-fuchsia-400 px-4 py-2.5 text-xs font-black text-slate-950 transition hover:bg-fuchsia-300 active:scale-[.98]"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" /> Join
                    </button>
                  </article>
                ))}
                {arenaChallenges.length === 0 && (
                  <div className="rounded-2xl border border-white/[0.08] bg-neutral-900/40 p-5 flex flex-col justify-center items-center text-center">
                    <Swords className="h-6 w-6 text-neutral-600 mb-2" />
                    <span className="text-xs font-bold text-neutral-300">No active duels</span>
                    <span className="text-[10px] text-neutral-500 mt-1">Visit the Arena tab to publish a challenge.</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-neutral-900/40 p-5 flex flex-col justify-center items-center text-center">
              <Swords className="h-6 w-6 text-neutral-600 mb-2" />
              <span className="text-xs font-bold text-neutral-300">Coming soon</span>
              <span className="text-[10px] text-neutral-500 mt-1">Live 1v1 duels are being tuned up for mobile.</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function SectionHeading({ icon: Icon, title, action, href }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-black text-white">
        <Icon className="h-4 w-4 text-violet-300" /> {title}
      </h2>
      <Link href={href} className="inline-flex items-center gap-1 text-xs font-bold text-violet-300 transition hover:text-violet-200">
        {action}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
