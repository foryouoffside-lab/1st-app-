'use client';

// components/drill/ResultScreen.js
// SkillDrills — the one result card, shared by every solo drill.
//
// Every drill used to carry its own copy-pasted `ResultScreen` + `ResultStat`
// pair. They were byte-identical apart from the Play Again gradient and the
// left panel's radial wash, so ten files drifted independently and none of
// them animated. This is that same card — same layout, same colours, same
// copy, same buttons — with the motion added once.
//
// Motion rules this file obeys (see xd2.md, they are scars):
//   • transform / opacity only; never width, height, top, left or margin.
//   • anything LOAD-BEARING (the grade letter, the score, the stat tiles)
//     animates transform ONLY and starts from a visible state. `opacity:0`
//     plus `animation-fill-mode:both` can strand an element permanently
//     invisible in Android's WebView if a frame is dropped, which is what the
//     historic "empty countdown ring" bug was. Opacity is reserved for pure
//     decoration that unmounts on its own (the new-best shine, the level-up
//     toast, the XP flash).
//   • no full-screen success flash. The result card is a screen the player
//     reads, not a hit confirmation.
//
// The XP bar animates from the player's PRE-save progress, so the drill must
// capture getPlayerLevel() before it fires the result off to progressStore and
// hand it over as `summary.progress`. Without it the bar simply doesn't render.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Share2, ArrowLeft } from 'lucide-react';
import { getGrade } from '../../lib/scoringEngine';
import useCountUp from '../../lib/useCountUp';

const XP_PER_LEVEL = 1000;

// Bar timings. Kept here rather than inline so the level-up branch and the
// plain branch can't drift apart.
const BAR_DELAY_MS = 420;   // let the card land before the bar moves
const BAR_FILL_MS = 700;
const BAR_SNAP_MS = 60;     // one committed frame at zero before the refill

/**
 * A rising four-note chime for a new best / level-up, built out of the drill's
 * OWN synth so it lands in the same timbre as its playResultsReveal(). Every
 * drill's inline AudioSynthesizer exposes chimeVoice(); tone() is the fallback.
 * Gated on the synth's own `enabled` flag, which is the sound preference.
 */
function playFanfare(synth) {
  if (!synth || !synth.enabled || !synth.ctx) return;
  try {
    if (synth.ctx.state === 'suspended') synth.ctx.resume();
    const t0 = synth.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    if (typeof synth.chimeVoice === 'function') {
      notes.forEach((freq, i) => {
        const last = i === notes.length - 1;
        synth.chimeVoice(freq, t0 + i * 0.07, last ? 0.55 : 0.2, last ? 0.17 : 0.12, 4200);
      });
    } else if (typeof synth.tone === 'function') {
      notes.forEach((freq, i) => setTimeout(() => synth.tone(freq, 0.18, 'sine', 0.13), i * 70));
    }
  } catch {}
}

/**
 * The XP tile's fill bar. `transform:scaleX` on a transform-origin:left node —
 * the compositor moves it, nothing re-lays-out. On a level-up it fills to full,
 * flashes white, snaps to zero and fills the remainder.
 */
function XpBar({ progress, xpEarned, onLevelUp }) {
  const startInLevel = progress?.xpInLevel ?? 0;
  const total = startInLevel + Math.max(0, xpEarned || 0);
  const levelsGained = Math.floor(total / XP_PER_LEVEL);
  const remainder = total % XP_PER_LEVEL;

  const fromFrac = Math.min(1, startInLevel / XP_PER_LEVEL);
  const toFrac = Math.min(1, remainder / XP_PER_LEVEL);

  // 'rest' → 'fill' → (level-up only) 'snap' → 'refill'
  const [frac, setFrac] = useState(fromFrac);
  const [dur, setDur] = useState(0);
  const [flashing, setFlashing] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    const timers = [];
    timers.push(setTimeout(() => {
      setDur(BAR_FILL_MS);
      setFrac(levelsGained > 0 ? 1 : toFrac);
    }, BAR_DELAY_MS));

    if (levelsGained > 0) {
      timers.push(setTimeout(() => {
        setFlashing(true);
        setDur(0);
        setFrac(0);
        if (!firedRef.current) {
          firedRef.current = true;
          onLevelUp?.();
        }
      }, BAR_DELAY_MS + BAR_FILL_MS));
      timers.push(setTimeout(() => {
        setDur(BAR_FILL_MS);
        setFrac(toFrac);
      }, BAR_DELAY_MS + BAR_FILL_MS + BAR_SNAP_MS));
      timers.push(setTimeout(() => setFlashing(false), BAR_DELAY_MS + BAR_FILL_MS + 400));
    }

    return () => timers.forEach(clearTimeout);
    // Result data is fixed for the life of this card; run the sequence once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fx-xp-track">
      <div
        className="fx-xp-fill"
        style={{ transform: `scaleX(${frac})`, transitionDuration: `${dur}ms` }}
      />
      {flashing && <div className="fx-xp-flash" />}
    </div>
  );
}

function ResultStat({ label, value, color, delay = 0, children }) {
  return (
    <div
      className="fx-res-in rounded-[11px] border border-white/5 bg-white/[0.03] py-2 px-1 text-center"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`text-base font-display tabular ${color}`}>{value}</div>
      <div className="text-[7px] rdg-unit text-slate-500 mt-0.5">{label}</div>
      {children}
    </div>
  );
}

export default function ResultScreen({
  summary,
  // Everything below defaults out of `summary` so a drill can keep passing the
  // end-summary object it already builds, and override just what differs.
  score = summary?.score ?? 0,
  accuracy = summary?.accuracy ?? 0,
  xpEarned = summary?.xpEarned ?? 0,
  isNewBest = summary?.isNewBest ?? false,
  prevBest = summary?.prevBest ?? null,
  progressSummary = summary?.progress ?? null,
  grade = getGrade(summary?.accuracy ?? 0),
  bestScore = 0,
  // Per-drill skin. Solid accent for the Lock button + score brackets — matches
  // the start card's Start button. A hex, not a gradient; defaults to brand
  // violet. (Drills may still pass the old `accent` gradient prop; it is unused.)
  lockColor = '#8b5cf6',
  wash = 'rgba(250,204,21,.08)',
  extraStats = null,
  synth = null,
  onPlayAgain,
  onShare,
  backHref = '/',
  // `signature` = the full-bleed "one object" layout that matches the new
  // start card (mono corner links, a Lock-clamped score that resolves, the
  // Lock Play Again button). Opt-in per drill while it is piloted.
  signature = false,
}) {
  const isTopGrade = grade.grade === 'S+' || grade.grade === 'S';
  const gradeColor = isTopGrade ? '#fbbf24' : '#a78bfa';

  const shownScore = useCountUp(score, 700);
  const shownAccuracy = useCountUp(accuracy, 600);
  const shownXp = useCountUp(xpEarned, 600);
  const shownBest = useCountUp(bestScore ?? 0, 600);

  const [levelToast, setLevelToast] = useState(null);
  const stats = Array.isArray(extraStats) ? extraStats : [];
  const statCols = stats.length > 0 ? 'grid-cols-4' : 'grid-cols-3';

  // A new best gets its own fanfare, once, shortly after the stamp lands.
  useEffect(() => {
    if (!isNewBest) return undefined;
    const t = setTimeout(() => playFanfare(synth), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The global CelebrationToast is deliberately unmounted on drill routes
  // (see AppShellClient), so a level-up reached on this run has no other
  // surface. This banner is non-blocking, takes no input and unmounts itself.
  const handleLevelUp = () => {
    const gained = Math.floor(((progressSummary?.xpInLevel ?? 0) + Math.max(0, xpEarned)) / XP_PER_LEVEL);
    const next = (progressSummary?.level ?? 1) + gained;
    setLevelToast(next);
    playFanfare(synth);
    setTimeout(() => setLevelToast(null), 1400);
  };

  const LevelToast = levelToast !== null ? (
    <div className="absolute inset-x-0 top-[8%] z-50 flex justify-center pointer-events-none">
      <div className="fx-pop-in px-5 py-2 rounded-full bg-black/70 border border-yellow-500/35 text-yellow-400 font-display text-lg tracking-wide shadow-[0_0_28px_rgba(251,191,36,.3)]">
        LEVEL {levelToast}
      </div>
    </div>
  ) : null;

  // ── The signature layout ──────────────────────────────────────────────────
  // One column, full bleed, framed like the start card so a screenshot of
  // either reads as the same object.
  if (signature) {
    const beat = isNewBest && prevBest > 0;
    const sigCols = stats.length > 0 ? 'grid-cols-4' : 'grid-cols-3';
    return (
      <div
        className="absolute inset-0 z-40 flex flex-col px-6 pt-6 pb-7 select-none overflow-y-auto"
        style={{ background: `radial-gradient(ellipse 94% 44% at 50% 100%, ${lockColor}1f, transparent 70%), #050508` }}
      >
        <div className="flex items-center justify-between">
          <a href={backHref} className="rdg-unit text-[10px] text-slate-500 py-1.5 pr-3 -ml-1">⌂ Home</a>
          <button type="button" onClick={onShare} className="rdg-unit text-[10px] text-slate-300 py-1.5 pl-3 -mr-1">Share ↗</button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center text-center gap-7">
          <div className="flex flex-col items-center gap-1">
            {isNewBest && (
              <span className="fx-res-stamp relative overflow-hidden text-[10px] font-display text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-1 rounded-full mb-2">
                NEW BEST<span className="fx-res-shine" />
              </span>
            )}
            <div className={`rdg-unit text-[9px] ${isTopGrade ? 'text-yellow-400' : 'text-slate-500'}`}>{grade.label}</div>
            <div
              className={`lock-mark snap fx-rdg-settle font-display text-white tabular-nums ${isTopGrade ? 'fx-res-grade-s' : ''}`}
              style={{ fontSize: 'clamp(52px,16vw,80px)', '--lm': lockColor }}
            >
              {shownScore.toLocaleString()}
            </div>
            <div className="rdg-unit text-[8px] text-slate-500 mt-1">Points</div>
            <div className="rdg-unit text-[9px] text-slate-500 mt-3">
              {beat
                ? <>Prev best {prevBest.toLocaleString()} · <span className="text-emerald-400">+{(score - prevBest).toLocaleString()}</span></>
                : (prevBest > 0 ? <>Best {Math.max(prevBest, score).toLocaleString()}</> : <>First run banked</>)}
            </div>
          </div>

          <div className={`grid ${sigCols} gap-2 w-full`}>
            <ResultStat label="Best" value={shownBest.toLocaleString()} color="text-yellow-400" delay={40} />
            <ResultStat label="Accuracy" value={`${shownAccuracy}%`} color="text-blue-400" delay={110} />
            <ResultStat label="XP" value={`+${shownXp}`} color="text-violet-400" delay={180}>
              {progressSummary && <XpBar progress={progressSummary} xpEarned={xpEarned} onLevelUp={handleLevelUp} />}
            </ResultStat>
            {stats.map((s, i) => (
              <ResultStat key={s.label} label={s.label} value={s.value} color={s.color || 'text-slate-300'} delay={250 + i * 70} />
            ))}
          </div>
        </div>

        <button onClick={onPlayAgain} className="lock-btn mt-4" style={{ '--lb': lockColor }}>Play Again</button>

        {LevelToast}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 flex select-none" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div
        className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5"
        style={{ background: `radial-gradient(ellipse 260px 200px at 50% 30%, ${wash}, transparent 70%)` }}
      >
        {isNewBest && (
          <span className="fx-res-stamp relative overflow-hidden text-[11px] font-display text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-1 rounded-full mb-1">
            NEW BEST
            <span className="fx-res-shine" />
          </span>
        )}
        <div
          className={`fx-count-pop text-5xl sm:text-6xl font-display leading-none ${isTopGrade ? 'fx-res-grade-s' : ''}`}
          style={{ color: gradeColor, animationDelay: '60ms' }}
        >
          {grade.grade}
        </div>
        <div className="text-[10px] label-tiny text-slate-500">{grade.label}</div>
        <div
          className="lock-mark snap fx-res-in text-3xl sm:text-4xl font-display text-white mt-1 tabular-nums"
          style={{ animationDelay: '120ms', '--lm': lockColor }}
        >
          {shownScore.toLocaleString()}
        </div>
        <div className="text-[8px] rdg-unit text-slate-500 mt-1">Points</div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        {/* The three tiles are identical in every drill: Best Score, Accuracy,
            XP. Best Score is the one that carries the solo loop — there is no
            public solo leaderboard, so "beat your own number" is the target.
            Combo stays out: an endurance run inflates it without bound, which
            makes it useless for comparing one run against the next. */}
        <div className={`grid ${statCols} gap-2`}>
          <ResultStat label="Best Score" value={shownBest.toLocaleString()} color="text-yellow-400" delay={140} />
          <ResultStat label="Accuracy" value={`${shownAccuracy}%`} color="text-blue-400" delay={210} />
          <ResultStat label="XP" value={`+${shownXp}`} color="text-violet-400" delay={280}>
            {progressSummary && (
              <XpBar progress={progressSummary} xpEarned={xpEarned} onLevelUp={handleLevelUp} />
            )}
          </ResultStat>
          {stats.map((s, i) => (
            <ResultStat key={s.label} label={s.label} value={s.value} color={s.color || 'text-slate-300'} delay={350 + i * 70} />
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onPlayAgain}
            className="lock-btn flex-1"
            style={{ '--lb': lockColor }}
          >
            Play Again
          </button>
          <button
            onClick={onShare}
            className="w-12 min-h-[46px] flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer active:scale-[0.97] transition-transform"
          >
            <Share2 className="w-4 h-4" />
          </button>
          <Link
            href={backHref}
            className="w-12 min-h-[46px] flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white active:scale-[0.97] transition-transform"
          >
            <ArrowLeft className="w-4 h-4 text-slate-400" />
          </Link>
        </div>
      </div>

      {/* Non-blocking: no dim, no pause, no input capture, unmounts itself. */}
      {LevelToast}
    </div>
  );
}
