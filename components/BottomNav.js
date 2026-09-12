'use client';
 
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart3, CalendarDays, Home, Swords, Trophy } from 'lucide-react';
import { ARENA_ENABLED } from '../lib/featureFlags';

// The Arena tab follows lib/featureFlags.js's ARENA_ENABLED, the single
// switch for all Arena entry points — hidden while Arena is off so its
// realtime listeners and duel UI stay completely unreachable on phones.
const TABS = [
  { label: 'Home', href: '/', icon: Home, active: (pathname, hash) => pathname === '/' && hash !== '#daily-challenge' },
  { label: 'Daily', href: '/daily', icon: CalendarDays, active: (pathname) => pathname.startsWith('/daily') },
  ...(ARENA_ENABLED ? [
    { label: 'Arena', href: '/challenge', icon: Swords, active: (pathname, hash, searchParams) => pathname.startsWith('/challenge') && searchParams?.get('tab') !== 'leaderboard' },
    { label: 'Ranks', href: '/challenge?tab=leaderboard', icon: Trophy, active: (pathname, hash, searchParams) => pathname.startsWith('/challenge') && searchParams?.get('tab') === 'leaderboard' },
  ] : []),
  { label: 'Progress', href: '/progress', icon: BarChart3, active: (pathname) => pathname.startsWith('/progress') },
];
 
export default function BottomNav() {
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const [hash, setHash] = useState('');
 
  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [pathname]);

  return (
    <>
      <div className="h-[72px] md:hidden" aria-hidden="true" />
      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--line)] bg-[var(--panel)] md:hidden" aria-label="Main navigation" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto flex h-16 max-w-lg items-center justify-around px-1">
          {TABS.map(({ label, href, icon: Icon, active }) => {
            const isActive = active(pathname, hash, searchParams);
            return <Link key={label} href={href} aria-label={label} aria-current={isActive ? 'page' : undefined} className="flex min-w-0 flex-1 flex-col items-center gap-1 py-2 text-[10px] font-bold transition">
              <span className={`flex h-7 w-9 items-center justify-center rounded-xl transition ${isActive ? 'bg-violet-400/15 text-violet-300' : 'text-slate-500'}`}><Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.5 : 2} /></span>
              <span className={isActive ? 'text-violet-200' : 'text-slate-500'}>{label}</span>
            </Link>;
          })}
        </div>
      </nav>
    </>
  );
}
