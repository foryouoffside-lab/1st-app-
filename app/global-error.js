'use client';

// app/global-error.js
// The last safety net.
//
// app/error.js already catches a render error inside any ROUTE, which covers
// the drills, the Arena, Daily, Progress and Home. What it cannot catch is an
// error thrown by the root layout itself — and that is not a hypothetical
// corner here: the layout is where AuthProvider, ChallengeProvider and
// AppShellClient mount, i.e. Firebase init, the auth listener, the presence
// heartbeat and the duel-invite listeners. A throw in any of those is outside
// every route boundary, so without this file it is a white screen with no
// message, no way back, and nothing reported — the worst failure the app can
// have, and the one a player is most likely to describe as "the app is broken".
//
// Next.js replaces the entire document with this component, which is why it
// has to render its own <html> and <body>: no layout runs above it.
//
// Styling is deliberately inline rather than Tailwind. If the failure happened
// early enough that the stylesheet never applied, class names would render an
// unstyled page on top of an already-bad moment. Inline styles always paint.

import { useEffect } from 'react';
import { reportError } from '../lib/crashReporting';

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    // Best-effort: crashReporting may itself be part of what failed, so this
    // must never throw on top of the error it is reporting.
    try {
      reportError(error, 'Global error boundary');
    } catch {
      /* nothing useful left to do */
    }
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#050508' }}>
        <div
          role="alert"
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            background: '#050508',
            color: '#fff',
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
            textAlign: 'center',
          }}
        >
          <div style={{ maxWidth: '340px' }}>
            <div
              aria-hidden="true"
              style={{
                width: '56px',
                height: '56px',
                margin: '0 auto 18px',
                borderRadius: '16px',
                background: 'rgba(239,68,68,0.14)',
                border: '1px solid rgba(239,68,68,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '26px',
              }}
            >
              !
            </div>
            <h1 style={{ fontSize: '19px', fontWeight: 700, margin: '0 0 8px' }}>
              SkillDrills needs a restart
            </h1>
            <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(255,255,255,0.6)', margin: '0 0 22px' }}>
              Something failed while starting up. Your progress and scores are safe &mdash; they
              are stored on your device and in your account.
            </p>
            {/* reset() re-mounts the tree, which is enough for a transient
                failure (a listener that threw once on a dropped connection).
                The reload is the heavier fallback for anything reset can't
                clear, and is what a player will reach for anyway. */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                onClick={() => reset()}
                style={{
                  padding: '12px 20px',
                  borderRadius: '12px',
                  border: 'none',
                  background: '#7c3aed',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <button
                onClick={() => { try { window.location.assign('/'); } catch { /* ignore */ } }}
                style={{
                  padding: '12px 20px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.14)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Restart app
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
