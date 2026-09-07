'use client';
import { useEffect, useState, Suspense } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { lockPortrait } from '../lib/orientation';
import BottomNav from './BottomNav';
import ChallengeNotificationBanner from './ChallengeNotificationBanner';
import ChallengeStatusToast from './ChallengeStatusToast';
import CelebrationToast from './CelebrationToast';
import { ChallengeProvider } from '../contexts/ChallengeContext';
import { useAuth } from '../contexts/AuthContext';
import { reportError, identifyUser } from '../lib/crashReporting';
import { logScreenView, identifyAnalyticsUser } from '../lib/analytics';
import { ensureDailyReminderScheduled } from '../lib/dailyReminder';
import { reconcileDrillBests } from '../lib/bestScoreSync';
import { LocalNotifications } from '@capacitor/local-notifications';

export default function AppShellClient({ children }) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const { user } = useAuth();

  const [isDrill, setIsDrill] = useState(false);

  // Android hardware/gesture back button — by default Capacitor just exits
  // the app instead of navigating the SPA's history, so wire it up: go back
  // through app history when there's somewhere to go, only exit at the root.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listenerHandle;
    CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        CapacitorApp.exitApp();
      }
    }).then((handle) => { listenerHandle = handle; });

    return () => { listenerHandle?.remove(); };
  }, []);

  // Repair any drill whose own "BEST" has fallen behind the canonical score
  // store. The two live on opposite sides of Android's backup line, so after a
  // reinstall or a device transfer the Progress screen can read "23 drills
  // played" while every start card reads BEST 0. See lib/bestScoreSync.js.
  // Fire-and-forget: a no-op in the normal case, and never worth blocking boot.
  useEffect(() => {
    reconcileDrillBests().catch(() => {});
  }, []);

  // Tag crash reports and analytics with the signed-in user's uid so either
  // can be traced back to a specific player if they reach out.
  useEffect(() => {
    if (user?.uid) {
      identifyUser(user.uid);
      identifyAnalyticsUser(user.uid);
    }
  }, [user?.uid]);

  // Screen-view tracking — this is a single-page app, so route changes never
  // trigger Firebase Analytics' own automatic screen tracking; log them by
  // hand instead, matching what a normal pageview would give on the web.
  useEffect(() => {
    if (pathname) logScreenView(pathname);
  }, [pathname]);

  // Schedule the recurring "come back to your Daily Challenge" reminder once
  // signed in (no-ops on web / when already scheduled — see lib/dailyReminder.js).
  useEffect(() => {
    if (user?.uid) ensureDailyReminderScheduled();
  }, [user?.uid]);

  // Route straight to the Daily tab when the reminder above is tapped.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listenerHandle;
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const route = action.notification?.extra?.route;
      if (route) router.push(route);
    }).then((handle) => { listenerHandle = handle; });
    return () => { listenerHandle?.remove(); };
  }, [router]);

  // Global safety net for crash reporting — catches errors that happen
  // outside of React's render cycle (event handlers, timers, promises),
  // which the app/error.js boundary never sees since those don't throw
  // during render.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleError = (event) => reportError(event.error || event.message, 'window.onerror');
    const handleRejection = (event) => reportError(event.reason, 'unhandledrejection');
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  // Determine if we are on a gameplay/drill page
  useEffect(() => {
    const segments = pathname.split('/').filter(Boolean);
    const isDrillRoute = segments[0] === 'drills' && segments.length >= 3;
    setIsDrill(isDrillRoute);

    // Set parent category path (e.g. /drills/fps)
    if (isDrillRoute) {
      // Append className to body for global CSS targets
      document.body.classList.add('is-drill-page');
    } else {
      document.body.classList.remove('is-drill-page');
      // If we leave a drill, ensure orientation is unlocked or returned to portrait
      lockPortrait().catch(() => {});
    }
  }, [pathname]);

  // ─── Global Audio Muting Interceptor ──────────────────────────────────────
  // Intercepts window.Audio and window.AudioContext creation and silences bleeps
  // if sound is disabled in global settings.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const checkMuted = () => {
      try {
        const settings = JSON.parse(localStorage.getItem('sd_settings') || '{}');
        return settings.soundEnabled === false;
      } catch {
        return false;
      }
    };

    // 1. Override standard Audio constructor play behavior
    if (window.Audio && !window.Audio.__isMocked) {
      const OriginalAudio = window.Audio;
      class MockAudio extends OriginalAudio {
        constructor(...args) {
          super(...args);
          const origPlay = this.play;
          this.play = function() {
            if (checkMuted()) {
              return Promise.resolve(); // silences playback
            }
            return origPlay.apply(this, arguments);
          };
        }
      }
      MockAudio.__isMocked = true;
      window.Audio = MockAudio;
    }

    // 2. Override Web Audio API (AudioContext) oscillator and buffer starts
    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
    // Every live context, so we can suspend them all when the app is
    // backgrounded — a drill is no longer routed away on visibilitychange, so
    // this is what stops its synth bleeping with the screen off.
    if (!window.__sdAudioContexts) window.__sdAudioContexts = new Set();
    if (OriginalAudioContext && !OriginalAudioContext.__isMocked) {
      class MockAudioContext extends OriginalAudioContext {
        constructor(...args) {
          super(...args);
          try { window.__sdAudioContexts.add(this); } catch {}

          const origCreateOscillator = this.createOscillator;
          if (origCreateOscillator) {
            this.createOscillator = function() {
              const osc = origCreateOscillator.apply(this, arguments);
              const origStart = osc.start;
              osc.start = function() {
                if (checkMuted()) return; // skip sound start
                return origStart.apply(this, arguments);
              };
              return osc;
            };
          }

          const origCreateBufferSource = this.createBufferSource;
          if (origCreateBufferSource) {
            this.createBufferSource = function() {
              const src = origCreateBufferSource.apply(this, arguments);
              const origStart = src.start;
              src.start = function() {
                if (checkMuted()) return;
                return origStart.apply(this, arguments);
              };
              return src;
            };
          }
        }
      }
      MockAudioContext.__isMocked = true;
      if (window.AudioContext) window.AudioContext = MockAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = MockAudioContext;
    }

    // 3. Mock pointerLockElement and requestPointerLock for mobile
    let mockedPointerLockElement = null;
    try {
      Object.defineProperty(document, 'pointerLockElement', {
        get: () => mockedPointerLockElement || document.webkitPointerLockElement || document.mozPointerLockElement,
        set: (val) => { mockedPointerLockElement = val; },
        configurable: true
      });
    } catch (e) {
      console.warn("Failed to redefine pointerLockElement:", e);
    }

    if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.__isMocked) {
      HTMLCanvasElement.prototype.__isMocked = true;
      HTMLCanvasElement.prototype.requestPointerLock = function() {
        mockedPointerLockElement = this;
        setTimeout(() => {
          const event = new Event('pointerlockchange');
          document.dispatchEvent(event);
        }, 50);
        return Promise.resolve();
      };
    }

    if (!document.exitPointerLockMocked) {
      document.exitPointerLockMocked = true;
      document.exitPointerLock = function() {
        mockedPointerLockElement = null;
        setTimeout(() => {
          const event = new Event('pointerlockchange');
          document.dispatchEvent(event);
        }, 50);
      };
    }

    // 4. Suspend / resume audio with the app. Backgrounding a drill no longer
    //    routes out of it, so this is what keeps a synth from firing tone cues
    //    with the screen off. Resume only when sound is still enabled.
    const handleAudioVisibility = () => {
      const hidden = document.visibilityState === 'hidden';
      const ctxs = window.__sdAudioContexts;
      if (!ctxs) return;
      for (const ctx of ctxs) {
        try {
          if (ctx.state === 'closed') { ctxs.delete(ctx); continue; }
          if (hidden) {
            if (ctx.state === 'running') ctx.suspend();
          } else if (ctx.state === 'suspended' && !checkMuted()) {
            ctx.resume();
          }
        } catch {}
      }
    };
    document.addEventListener('visibilitychange', handleAudioVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleAudioVisibility);
    };
  }, []);


  useEffect(() => {
    if (typeof window === 'undefined' || !isDrill) return;

    let lastTouchX = null;
    let lastTouchY = null;
    let virtualCursorX = window.innerWidth / 2;
    let virtualCursorY = window.innerHeight / 2;

    const handleTouchStart = (e) => {
      const touch = e.touches[0];
      const target = touch.target;
      if (target.tagName !== 'CANVAS') return;

      const rect = target.getBoundingClientRect();
      const x = (touch.clientX - rect.left) * (target.width / rect.width);
      const y = (touch.clientY - rect.top) * (target.height / rect.height);

      // Snap virtual cursor to tap location
      const dx = x - virtualCursorX;
      const dy = y - virtualCursorY;
      virtualCursorX = x;
      virtualCursorY = y;
      
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;

      // Dispatch mousedown to trigger direct tap-shooting
      const downEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0
      });
      target.dispatchEvent(downEvent);

      // Dispatch simulated mousemove to update cursor coords
      const moveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        movementX: dx,
        movementY: dy
      });
      target.dispatchEvent(moveEvent);
    };

    const handleTouchMove = (e) => {
      const touch = e.touches[0];
      const target = touch.target;
      if (target.tagName !== 'CANVAS' || lastTouchX === null) return;

      // Prevent scrolling the webpage during gameplay
      e.preventDefault();

      const rect = target.getBoundingClientRect();
      const x = (touch.clientX - rect.left) * (target.width / rect.width);
      const y = (touch.clientY - rect.top) * (target.height / rect.height);

      const dx = touch.clientX - lastTouchX;
      const dy = touch.clientY - lastTouchY;

      virtualCursorX = x;
      virtualCursorY = y;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;

      const moveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        movementX: dx,
        movementY: dy
      });
      target.dispatchEvent(moveEvent);
    };

    const handleTouchEnd = (e) => {
      const target = e.target;
      if (target.tagName !== 'CANVAS') return;

      lastTouchX = null;
      lastTouchY = null;

      const upEvent = new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0
      });
      target.dispatchEvent(upEvent);
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: false });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isDrill]);

  return (
    <ChallengeProvider>
      {/* Suppressed on drill routes — a duel invite banner (with sound), a
          "declined" toast, or a level-up celebration popping up over a
          fullscreen drill mid-play looks broken, and ChallengeStatusToast's
          auto-navigate-on-accept would otherwise yank the player out of
          whatever they're currently playing. Unmounting (not just hiding)
          means their effects don't run at all while isDrill is true; the
          underlying state lives in ChallengeContext regardless, so nothing
          is lost — these just reappear the moment the player leaves the
          drill route. */}
      {!isDrill && (
        <>
          <ChallengeNotificationBanner />
          <ChallengeStatusToast />
          <CelebrationToast />
        </>
      )}
      {children}
      {!isDrill && (
        <Suspense fallback={<div className="h-[72px] md:hidden" />}>
          <BottomNav />
        </Suspense>
      )}

      {/* No floating exit control on drills. There used to be a fixed
          top-right X at z-[999] sitting over the play field of all 24 drills;
          it was redundant (Android's back gesture already exits — see the
          backButton listener above, which calls window.history.back()) and it
          put a one-tap quit directly on top of live gameplay. */}
    </ChallengeProvider>
  );
}
