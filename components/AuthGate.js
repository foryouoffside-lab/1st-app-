'use client';

// components/AuthGate.js
// SkillDrills Pro — Real Google Sign-In Gate

import React, { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { ShieldCheck, Loader2, User, Trophy, CalendarDays, TrendingUp } from 'lucide-react';
import { DRILL_INDEX } from '../lib/drillIndex';
import { DRILL_GROUPS } from '../lib/drillGroups';

// Legal pages must stay readable without signing in — app store reviewers
// and prospective users who haven't created an account yet both need to
// reach these before the sign-in wall, not after it.
const PUBLIC_PATHS = ['/privacy', '/terms', '/delete-account'];

// next.config.js sets trailingSlash: true, so these routes are exported as
// /privacy/index.html and the WebView loads them at "/privacy/". Comparing
// the raw pathname against the list above therefore missed every one of
// them and put the legal pages behind the sign-in wall — the exact thing
// the list exists to prevent. Normalise before comparing.
function isPublicPath(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PUBLIC_PATHS.includes(p);
}

// Real vector art (same design as public/favicon.svg), not a raster <img> —
// crisp at any size/DPI instead of a PNG that looks soft when scaled.
function LogoMark({ className }) {
  return (
    <svg viewBox="0 0 100 100" className={className} role="img" aria-label="SkillDrills">
      <defs>
        <linearGradient id="sdLogoBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id="sdLogoBgStroke" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1e40af" />
          <stop offset="100%" stopColor="#5b21b6" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#sdLogoBg)" stroke="url(#sdLogoBgStroke)" strokeWidth="2" />
      <circle cx="50" cy="50" r="22" fill="none" stroke="#fff" strokeWidth="3" opacity="0.9" />
      <circle cx="50" cy="50" r="14" fill="none" stroke="#fff" strokeWidth="2" opacity="0.8" />
      <circle cx="50" cy="50" r="6" fill="#fff" opacity="0.9" />
      <line x1="50" y1="18" x2="50" y2="32" stroke="#fff" strokeWidth="2.5" opacity="0.9" />
      <line x1="50" y1="68" x2="50" y2="82" stroke="#fff" strokeWidth="2.5" opacity="0.9" />
      <line x1="18" y1="50" x2="32" y2="50" stroke="#fff" strokeWidth="2.5" opacity="0.9" />
      <line x1="68" y1="50" x2="82" y2="50" stroke="#fff" strokeWidth="2.5" opacity="0.9" />
      <line x1="30" y1="30" x2="38" y2="38" stroke="#fff" strokeWidth="2" opacity="0.6" />
      <line x1="70" y1="30" x2="62" y2="38" stroke="#fff" strokeWidth="2" opacity="0.6" />
      <line x1="30" y1="70" x2="38" y2="62" stroke="#fff" strokeWidth="2" opacity="0.6" />
      <line x1="70" y1="70" x2="62" y2="62" stroke="#fff" strokeWidth="2" opacity="0.6" />
      <circle cx="50" cy="50" r="2.5" fill="#fff" />
    </svg>
  );
}

function GoogleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" {...props}>
      <path fill="#4285F4" d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.47a5.54 5.54 0 0 1-2.4 3.64v3h3.87c2.27-2.09 3.58-5.17 3.58-8.75z"/>
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.11A12 12 0 0 0 12 24z"/>
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.27a12 12 0 0 0 0 10.8l4-3.11z"/>
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.6 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.6l4 3.11C6.22 6.86 8.87 4.75 12 4.75z"/>
    </svg>
  );
}

// No `font-sans` here on purpose. Tailwind's font-sans is the generic
// `ui-sans-serif, system-ui, ...` stack, and putting it on this wrapper was
// overriding the app's own Inter (set on <body> in app/layout.js) for every
// piece of body copy on the sign-in screens — they were rendering in
// whatever the OS default happened to be. Dropping it lets Inter inherit
// for these functional prompts; only the Brand() wordmark below opts into
// Anton via .font-display (see globals.css).
function Frame({ children }) {
  return (
    <div className="min-h-[100dvh] bg-[#050508] flex items-center justify-center text-white p-5 relative overflow-hidden">
      <div className="w-full max-w-[380px] relative z-10">{children}</div>
    </div>
  );
}

// Horizontal lockup: mark first, wordmark second, both on a single
// baseline. Anton (the app's display face, see .font-display in
// globals.css) ships one weight only — .font-display forces
// font-weight:400 !important for exactly this reason, so nothing here
// asks the browser to synthesise a bold or black cut that doesn't exist.
function Brand() {
  return (
    <div className="flex items-center justify-center gap-2.5">
      <LogoMark className="w-9 h-9 shrink-0 drop-shadow-[0_0_18px_rgba(139,92,246,.45)]" />
      <h1 className="font-display text-[30px] text-white">
        SkillDrills
      </h1>
    </div>
  );
}

function UsernameStep({ pendingSignup, completeSignup }) {
  const [name, setName] = useState(pendingSignup.suggested || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    const result = await completeSignup(name);
    if (!result.ok) setError(result.error);
    setSubmitting(false);
  };

  return (
    <Frame>
      <div className="rounded-[24px] border border-[var(--line)] bg-[var(--card)] p-7 shadow-[0_24px_60px_rgba(0,0,0,.55)]">
        <div className="flex flex-col items-center text-center mb-7">
          <div className="relative mb-4">
            <img
              src={pendingSignup.photoURL}
              alt=""
              className="w-16 h-16 rounded-2xl border border-white/10 object-cover"
            />
            <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-emerald-500 border-2 border-[#0b0b14] flex items-center justify-center">
              <ShieldCheck className="w-3 h-3 text-white" />
            </div>
          </div>
          {/* 18px, not 19: `whitespace-nowrap` guarantees the one-line
              heading, so the size has to be one that still fits the ~224px
              of card interior left on a 320px-wide phone. At 19px it
              measured exactly 224px and would have clipped there. */}
          <h1 className="text-[18px] font-bold tracking-[-0.02em] leading-none whitespace-nowrap text-white">Choose your player name</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="relative">
            <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              required
              minLength={3}
              maxLength={20}
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="Enter a unique name"
              className="w-full bg-black/40 border border-white/10 rounded-[13px] py-3.5 pl-11 pr-4 text-[13px] text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/50 transition-colors"
            />
          </div>

          {error && (
            <p className="text-[11px] text-rose-400 font-medium bg-rose-500/10 border border-rose-500/20 rounded-[10px] px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || name.trim().length < 3}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 text-white font-bold py-[13px] rounded-[13px] transition-all duration-200 active:scale-[0.98] shadow-[0_0_24px_rgba(139,92,246,.3)] disabled:opacity-40 disabled:active:scale-100 text-[13px] tracking-wide"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Continue'
            )}
          </button>
        </form>
      </div>
    </Frame>
  );
}

// Arena/leaderboard are hidden for now (see lib/featureFlags.js) — these
// perks only list things actually available today.
const FEATURES = [
  { icon: TrendingUp, label: 'Track Progress', blurb: 'Every score saved and charted.' },
  { icon: CalendarDays, label: 'Daily Challenges', blurb: 'Three fresh drills a day, at 2x XP.' },
  { icon: Trophy, label: 'Earn XP & Levels', blurb: 'Level up as you train.' },
];

export default function AuthGate({ children }) {
  const pathname = usePathname() || '';
  const { user, loading, pendingSignup, completeSignup, signInWithGoogle } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  // A returning session now resolves from cache almost instantly (see
  // AuthContext), which was the right fix for the old multi-second wait —
  // but it also meant this branded loading moment barely appeared at all.
  // Hold it visible for a short, fixed minimum so it still reads as a
  // deliberate loading screen rather than a flash, without reintroducing
  // any real wait: this is presentation-only and never delays anything
  // network-bound, which already takes longer than this on its own.
  const [minHoldDone, setMinHoldDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinHoldDone(true), 900);
    return () => clearTimeout(t);
  }, []);

  if (isPublicPath(pathname)) {
    return children;
  }

  // scripts/capture-previews.js drives the real app to screenshot each drill
  // mid-play for the hub's preview cards. It has no Google account, so the
  // gate would stop it on the very first screen.
  //
  // Deliberately guarded on NODE_ENV as well as the flag, so this can never
  // reach a user: `next build` substitutes the literal 'production' here, the
  // condition folds to false, and the minifier drops the branch entirely.
  // Every shipping path (mobile:build, mobile:release, the website deploy)
  // goes through `next build`, so there is no temporary switch that has to be
  // remembered and reverted — the capture only works under `next dev`.
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_CAPTURE_PREVIEWS === '1') {
    return children;
  }

  const handleSignIn = async () => {
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } finally {
      setSigningIn(false);
    }
  };

  if (loading || !minHoldDone) {
    return (
      <Frame>
        <div className="flex flex-col items-center text-center">
          <div className="relative flex items-center justify-center mb-6">
            <div className="absolute w-16 h-16 rounded-full border-[3px] border-t-violet-500 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
            <LogoMark className="w-11 h-11 drop-shadow-[0_0_20px_rgba(139,92,246,.5)]" />
          </div>
          <h2 className="text-[15px] font-bold tracking-[-0.01em] text-white">Loading SkillDrills</h2>
          <p className="text-slate-500 text-[11px] mt-1.5">Connecting to secure servers...</p>
        </div>
      </Frame>
    );
  }

  if (pendingSignup) {
    return <UsernameStep pendingSignup={pendingSignup} completeSignup={completeSignup} />;
  }

  if (!user) {
    return (
      // Full-height, not a floating card. This is the app's front door and
      // the only thing on screen, so a bordered box centred in a field of
      // black just drew a rectangle around empty space — and it put the one
      // button the player has to press in the middle of the display, the
      // hardest place on a phone to reach. Everything the player reads or
      // presses is ONE centred column — brand, line, perks, button, trust —
      // so spare height collects evenly above and below it instead of pooling
      // in a single void. Only the drill count is pinned to the bottom.
      <div className="relative min-h-[100dvh] bg-[#050508] text-white flex flex-col overflow-y-auto">
        <div className="relative mx-auto flex w-full max-w-[340px] flex-1 flex-col px-6 pt-10 pb-[max(28px,env(safe-area-inset-bottom))]">
          {/* The centred group. This used to be a brand pinned high with the
              perks pushed to the bottom of a flexible band, which put every
              spare pixel of a tall phone into one void between the wordmark
              and the tiles — read as a layout mistake, not as breathing room.
              Centring divides the slack evenly above and below instead, and
              the fixed margins inside keep the pieces a single unit at any
              screen height. */}
          <div className="flex flex-1 flex-col justify-center">
            {/* Depth behind the mark — flat black under a logo is what made
                the top half read as unfinished rather than minimal. The glow
                is anchored to the brand, so it travels with it. */}
            <div className="relative">
              <div
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 h-[320px] w-[320px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ background: 'radial-gradient(circle, rgba(124,58,237,.22), transparent 68%)' }}
              />
              <div className="relative">
                <Brand />

                {/* One line, always: the column is only ~292px wide inside its
                    padding on a 360px phone, so this stays short enough that
                    it can never wrap to an orphaned word. The three tiles
                    below do the selling, so the sentence does not have to. */}
                <p className="text-slate-400 text-[12.5px] text-center tracking-[-0.005em] whitespace-nowrap mt-3.5">
                  Sign in to save your progress.
                </p>
              </div>
            </div>

            {/* Rows, not three small tiles side by side. Squeezed into thirds
                of a 340px column the labels wrapped to two lines at 9.5px and
                said nothing beyond their own name; as rows they have room for
                the line that actually sells them. The gap above them is a
                fixed, deliberate margin now — while it was flexible it
                stretched to absorb every spare pixel on a tall phone, which
                is what made the wordmark look stranded. */}
            <div className="mt-9 space-y-2">
              {FEATURES.map(({ icon: Icon, label, blurb }) => (
                <div key={label} className="flex items-center gap-3 rounded-[13px] border border-white/[0.06] bg-white/[0.025] px-3.5 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-violet-400/10 text-violet-300">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold tracking-[-0.01em] text-slate-100 leading-tight">{label}</span>
                    <span className="mt-0.5 block text-[10.5px] text-slate-500 leading-tight">{blurb}</span>
                  </span>
                </div>
              ))}
            </div>

            {/* The button belongs to the centred group rather than being
                pinned to the bottom edge. Pinned, it left a second void — the
                gap simply moved from above the perks to below them, which on
                a tall phone was worse, because a lone button floating over
                340px of black reads as a page that failed to load. Inside the
                group it still lands in the lower half of the display, which
                is the part of the thumb zone that matters. */}
            <div className="pt-8" />

            <button
              onClick={handleSignIn}
              disabled={signingIn}
              className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-100 text-slate-900 font-bold py-[15px] rounded-[14px] transition-all duration-200 active:scale-[0.98] shadow-[0_10px_30px_rgba(0,0,0,.45)] disabled:opacity-60 disabled:active:scale-100 text-[13.5px] tracking-[-0.01em]"
            >
              {signingIn ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                <>
                  <GoogleIcon />
                  Continue with Google
                </>
              )}
            </button>

            <div className="flex items-start justify-center gap-2 text-[10px] text-slate-500 leading-normal mt-4">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-px" />
              <span>Real Google sign-in — we never see or store your password.</span>
            </div>
          </div>

          {/* The one thing that stays pinned to the bottom edge: a footnote,
              not something the player has to read or reach. */}
          <p className="text-center text-[10px] text-slate-600 font-medium mt-5 tracking-wide">
            {DRILL_INDEX.length} free drills · {DRILL_GROUPS.length} categories
          </p>
        </div>
      </div>
    );
  }

  return children;
}
