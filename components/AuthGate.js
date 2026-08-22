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
const PUBLIC_PATHS = ['/privacy', '/terms'];

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

function Frame({ children }) {
  return (
    <div className="min-h-[100dvh] bg-[#050508] flex items-center justify-center text-white p-5 relative overflow-hidden font-sans">
      <div className="w-full max-w-[380px] relative z-10">{children}</div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex flex-col items-center text-center mb-7">
      <LogoMark className="w-14 h-14 mb-4 drop-shadow-[0_0_20px_rgba(139,92,246,.5)]" />
      <h1 className="text-[22px] font-black tracking-tight text-white">
        SkillDrills <span className="text-violet-400 font-bold text-[10px] uppercase tracking-widest ml-1 bg-violet-500/10 px-2 py-0.5 rounded-full border border-violet-500/20 align-middle">Pro</span>
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
      <div className="rounded-[24px] border border-white/5 bg-[#0b0b14]/80 backdrop-blur-2xl p-7 shadow-[0_24px_60px_rgba(0,0,0,.55)]">
        <div className="flex flex-col items-center text-center mb-6">
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
          <h1 className="text-[19px] font-black tracking-tight text-white">Choose your player name</h1>
          <p className="text-slate-400 text-[11.5px] mt-2 max-w-[26ch] leading-relaxed">
            This is your player name across SkillDrills — pick something unique.
          </p>
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
  { icon: TrendingUp, label: 'Track Progress' },
  { icon: CalendarDays, label: 'Daily Challenges' },
  { icon: Trophy, label: 'Earn XP & Levels' },
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

  if (PUBLIC_PATHS.includes(pathname)) {
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
          <h2 className="text-[15px] font-bold tracking-wide text-white">Loading SkillDrills</h2>
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
      <Frame>
        <div className="rounded-[24px] border border-white/5 bg-[#0b0b14]/80 backdrop-blur-2xl p-7 shadow-[0_24px_60px_rgba(0,0,0,.55)]">
          <Brand />

          <p className="text-slate-400 text-[12.5px] text-center leading-relaxed mb-6 -mt-2">
            Sign in to save your progress and unlock the full training platform.
          </p>

          <div className="grid grid-cols-3 gap-2 mb-6">
            {FEATURES.map(({ icon: Icon, label }) => (
              <div key={label} className="flex flex-col items-center gap-1.5 rounded-[13px] border border-white/5 bg-white/[0.02] py-3 px-1.5 text-center">
                <Icon className="w-4 h-4 text-violet-400" />
                <span className="text-[9px] font-semibold text-slate-400 leading-tight">{label}</span>
              </div>
            ))}
          </div>

          <button
            onClick={handleSignIn}
            disabled={signingIn}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-100 text-slate-900 font-bold py-[13px] rounded-[13px] transition-all duration-200 active:scale-[0.98] shadow-[0_8px_24px_rgba(0,0,0,.3)] disabled:opacity-60 disabled:active:scale-100 text-[13px]"
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

          <div className="flex items-center gap-2 text-[10px] text-slate-500 leading-normal mt-5 pt-5 border-t border-white/5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span>Real Google sign-in — we never see or store your password.</span>
          </div>
        </div>

        <p className="text-center text-[10px] text-slate-600 font-medium mt-5 tracking-wide">
          {DRILL_INDEX.length} free drills · {DRILL_GROUPS.length} categories
        </p>
      </Frame>
    );
  }

  return children;
}
