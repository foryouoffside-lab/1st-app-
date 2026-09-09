'use client';

// components/drill/DrillStartCard.js
// The one start card, shared by every solo drill. Full-bleed "one object"
// layout that rhymes with the shared ResultScreen: mono corner links, the
// drill name huge in Anton clamped by the brand Lock, one strap line, the
// rules behind a "How to play?" toggle, a hairline Readout strip that shows
// ONLY once a best exists (no first-play zeros), and the Lock Start button.
//
// Nothing here reaches inside the drill — a drill still owns its play loop,
// its countdown and its result data. It hands this component copy + a best
// strip + onStart, and picks portrait or landscape.
//
// Accent is the brand violet for every drill (one colour across the whole
// catalogue); `accent` stays a prop so a one-off can override.

import { useState } from 'react';

const BRAND = '#8b5cf6';

export default function DrillStartCard({
  drillName,
  tagline,                 // one short line under the name
  rules = [],              // array of strings, shown behind "How to play?"
  bestStrip = null,        // [{ value, label }] — omit / null hides the strip
  accent = BRAND,
  orientation = 'portrait',
  onStart,
  backHref = '/',
}) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const landscape = orientation === 'landscape';

  const nameStyle = landscape
    ? { fontSize: 'clamp(34px,7vw,50px)', lineHeight: 0.92, '--lm': accent }
    : { fontSize: 'clamp(38px,12vw,52px)', lineHeight: 0.92, '--lm': accent };

  const strip = Array.isArray(bestStrip) && bestStrip.length > 0 ? bestStrip : null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col px-6 pt-6 pb-7 overflow-y-auto pointer-events-auto"
      style={{ background: `radial-gradient(ellipse 94% 48% at 50% 0%, ${accent}24, transparent 70%), #050508` }}
    >
      <div className="flex items-center justify-between shrink-0">
        <a href={backHref} className="rdg-unit text-[10px] text-slate-500 py-1.5 pr-3 -ml-1">← Back</a>
        {rules.length > 0 && (
          <button
            type="button"
            onClick={() => setRulesOpen((v) => !v)}
            className="rdg-unit text-[10px] text-slate-300 border border-white/12 rounded-full px-3.5 py-1.5"
          >
            {rulesOpen ? 'Hide' : 'How to play?'}
          </button>
        )}
      </div>

      {/* Name block sits a touch above the optical centre — a dead-centred
          title forces the eye down to find it; lifting it ~10% reads first. */}
      <div className={`flex-1 flex flex-col justify-center pb-[10vh] ${landscape ? 'max-w-[520px] mx-auto w-full pb-[6vh]' : ''}`}>
        <h1
          className="lock-mark snap font-display text-white inline-block self-start"
          style={nameStyle}
        >
          {drillName}
        </h1>
        {tagline && <p className="rdg-unit text-[10px] text-slate-500 mt-4">{tagline}</p>}

        {rulesOpen && rules.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 max-w-[340px]">
            {rules.map((r) => (
              <p key={r} className="flex gap-2 text-[11.5px] leading-snug text-slate-400">
                <span className="font-bold" style={{ color: accent }}>/</span>{r}
              </p>
            ))}
          </div>
        )}
      </div>

      {strip && (
        <div className={`flex gap-8 py-3 border-y border-white/[0.07] mb-4 shrink-0 ${landscape ? 'max-w-[520px] mx-auto w-full' : ''}`}>
          {strip.map((s) => (
            <div key={s.label}>
              <div className="font-display tabular text-violet-300 text-[22px] leading-none">{s.value}</div>
              <div className="rdg-unit text-[7px] text-slate-500 mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onStart}
        className={`lock-btn shrink-0 ${landscape ? 'max-w-[520px] mx-auto w-full' : ''}`}
        style={{ '--lb': accent }}
      >
        Start
      </button>
    </div>
  );
}
