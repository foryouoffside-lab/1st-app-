'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import {
  ArrowRight, CheckCircle2, Crown, Flag, Play, Swords,
  Target
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { acceptChallenge } from '../lib/challengeEngine';
import { ARENA_ENABLED } from '../lib/featureFlags';
import { getDailyChallenge } from '../lib/dailyChallenge';
import { DRILL_INDEX, byEngagement } from '../lib/drillIndex';
import { DRILL_GROUPS, getDrillGroup, getGroupIcon } from '../lib/drillGroups';

const HOMEPAGE_CATEGORIES = DRILL_GROUPS.map(g => ({
  slug: g.id,
  name: g.name,
  icon: g.icon,
  emoji: g.emoji,
  accent: g.accent,
  href: `/drills/cognitive?group=${g.id}`,
}));

// Category chips for the home-screen drill browser. "All" leads (it covers
// the whole catalogue, so the old "All Drills" wayfinding link is gone), then
// the five real categories. These chips filter the drill rail in place — they
// no longer navigate to the hub.
const CATEGORY_TABS = [
  { slug: 'all', name: 'All', icon: Target, accent: 'var(--c-cognitive)' },
  ...HOMEPAGE_CATEGORIES,
];

// Drill ids that have bespoke home-rail art at /public/drill-art/<id>.webp.
// ADD AN ID HERE when you drop its image in — anything not listed uses the
// auto-captured gameplay frame from /previews/cards/<id>.webp instead.
// (A static export can't reliably catch an <img> onError before hydration,
// so the choice is made up front rather than on load failure.)
const DRILL_ART = new Set([
  'quick-dodge',
]);

// Same mapping the /drills hub uses for its difficulty pill, so a drill's
// badge reads identically in both places.
const DIFFICULTY_CLASS = {
  easy: 'beginner', beginner: 'beginner',
  medium: 'intermediate', intermediate: 'intermediate',
  hard: 'advanced', advanced: 'advanced',
  impossible: 'impossible', elite: 'elite',
};

export default function HomePageClient() {
  const { user, db } = useAuth();
  const router = useRouter();
  const [daily, setDaily] = useState(null);
  const [arenaChallenges, setArenaChallenges] = useState([]);
  const [dashboardReady, setDashboardReady] = useState(false);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const today = await getDailyChallenge();
        setDaily(today);
      } catch (error) {
        console.error('Unable to load home dashboard', error);
      } finally {
        setDashboardReady(true);
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

  // `allComplete` is `0 === 0` for an empty set, so it reads true if the day's
  // picks ever fail to build. Only a set that actually has drills can be done.
  const dailyTotal = daily?.total || 3;
  const dailyDone = !!daily?.allComplete && (daily?.total || 0) > 0;
  const dailyStarted = (daily?.completedCount || 0) > 0 && !dailyDone;

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

  const displayName = user?.displayName?.split(' ')[0] || 'Player';

  // Which category the home-screen drill rail is showing. Chip taps set this;
  // nothing here navigates away.
  const [activeCategory, setActiveCategory] = useState('all');

  const railDrills = useMemo(() => {
    const list = activeCategory === 'all'
      ? DRILL_INDEX
      : DRILL_INDEX.filter(d => getDrillGroup(d) === activeCategory);
    return [...list].sort(byEngagement);
  }, [activeCategory]);

  const activeCategoryName = CATEGORY_TABS.find(c => c.slug === activeCategory)?.name || 'All';

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

        {/* 2. Daily Challenge — a compact entry banner, not a dashboard.
             The three-drill breakdown, streak detail and everything else
             now lives on /daily (see app/daily/DailyClient.js); this is
             only the doorway to it, and the whole card is the link. Its
             copy tracks the real daily state (not started / in progress /
             done) but never lists the individual drills. */}
        <Link href="/daily" className={`daily-banner group mb-6 ${dailyDone ? 'is-done' : ''}`}>
          <svg className="daily-banner-bg" viewBox="0 0 170 80" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
            {/* A rising ridgeline to a small planted flag — "finish the
                day's set, move forward". Kept faint by the CSS. */}
            <path d="M0 72 L38 56 L70 63 L104 32 L138 44 L170 30" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M104 32 L104 14 L120 19 L104 24 Z" fill="currentColor" />
          </svg>

          <span className="daily-banner-ic">
            {dailyDone ? <CheckCircle2 className="h-5 w-5" /> : <Flag className="h-5 w-5" />}
          </span>

          <span className="daily-banner-body">
            <span className="daily-banner-k">Daily Challenge</span>
            <span className="daily-banner-title">
              {!dashboardReady
                ? `Today's ${dailyTotal} drills`
                : dailyDone
                  ? `${dailyTotal} / ${dailyTotal} complete`
                  : dailyStarted
                    ? `${daily.completedCount} / ${dailyTotal} complete`
                    : `Complete today's ${dailyTotal} drills`}
            </span>
            <span className="daily-banner-sub">
              {dashboardReady && dailyDone ? (
                'Daily challenge complete ✓'
              ) : (
                <>
                  <b className="font-hud">2&times;</b> XP · {dashboardReady && dailyStarted ? 'Continue' : 'Keep your streak'}
                </>
              )}
            </span>
          </span>

          <ArrowRight className="daily-banner-arrow" />
        </Link>

        {/* 3. Category browser.
             The chips filter the drill rail directly beneath them, in place —
             no hop to the hub. "All" leads and covers the whole catalogue,
             which is why the old "All Drills — browse all N" wayfinding link
             that used to sit here is gone. */}
        <div className="section-label">Categories</div>
        <div className="cat-rail home-scroll mb-3">
          {CATEGORY_TABS.map(cat => {
            const Icon = cat.icon;
            const count = cat.slug === 'all' ? DRILL_INDEX.length : getDrillCount(cat.slug);
            return (
              <button
                key={cat.slug}
                type="button"
                onClick={() => setActiveCategory(cat.slug)}
                className={`cat-chip ${activeCategory === cat.slug ? 'active' : ''}`}
                style={{ '--a': cat.accent }}
              >
                <span className="ic">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="nm">{cat.name}</span>
                <span className="cnt">{count}</span>
              </button>
            );
          })}
        </div>

        {/* 5. Drill rail — the selected category's drills as picture cards,
             the same "little video thumbnail" language as the /drills hub
             (artwork + difficulty + duration + play). Roughly two per screen
             so the row carries real weight, and it scrolls to the rest.
             Keyed on the active category so switching chips remounts the row
             and replays the slide-in (see .rail-swap in globals.css). */}
        <div className="section-label">
          {activeCategory === 'all' ? 'All drills' : `${activeCategoryName} drills`}
        </div>
        <div key={activeCategory} className="drill-rail home-scroll rail-swap mb-6">
          {railDrills.map(drill => {
            const group = getDrillGroup(drill);
            const DrillIcon = getGroupIcon(group);
            const accent = HOMEPAGE_CATEGORIES.find(c => c.slug === group)?.accent || 'var(--c-cognitive)';
            const diffId = DIFFICULTY_CLASS[String(drill.difficulty || '').toLowerCase()] || 'elite';
            const diffLabel = diffId.charAt(0).toUpperCase() + diffId.slice(1);
            return (
              <Link
                key={drill.id}
                href={drill.path || '/drills'}
                className="drill-rail-card"
                style={{ '--a': accent }}
              >
                <span className="thumb">
                  <span className={`diff-pill ${diffId}`}>{diffLabel}</span>
                  <img
                    src={DRILL_ART.has(drill.id)
                      ? `/drill-art/${drill.id}.webp`
                      : `/previews/cards/${drill.id}.webp`}
                    alt=""
                    width={640}
                    height={480}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="dur">{drill.duration || '45s'}</span>
                  <span className="play"><Play className="h-3 w-3 fill-current" /></span>
                </span>
                <span className="body">
                  <span className="ic"><DrillIcon className="h-3.5 w-3.5" /></span>
                  <span className="nm">{drill.name}</span>
                </span>
              </Link>
            );
          })}
        </div>

        {/* 6. Live Arena Matches — full-width flat cards (spans the same width as a
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
                      <h3 className="mt-2 truncate font-display text-xl text-white">{challenge.drillName || 'Arena Challenge'}</h3>
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
