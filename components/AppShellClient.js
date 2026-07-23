'use client';

// components/AppShellClient.js
// SkillDrills Pro — Central App Shell Controller
// Standardizes global audio muting, screen orientation, safe areas, 
// and floating controls for gameplay.

import { useEffect, useState, Suspense } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { lockPortrait, unlockOrientation } from '../lib/orientation';
import MobileHeader from './MobileHeader';
import BottomNav from './BottomNav';
import ChallengeNotificationBanner from './ChallengeNotificationBanner';
import ChallengeStatusToast from './ChallengeStatusToast';
import CelebrationToast from './CelebrationToast';
import { ChallengeProvider } from '../contexts/ChallengeContext';
import { useAuth } from '../contexts/AuthContext';
import { reportError, identifyUser } from '../lib/crashReporting';
import { logScreenView, identifyAnalyticsUser } from '../lib/analytics';
import { ensureDailyReminderScheduled } from '../lib/dailyReminder';
import { LocalNotifications } from '@capacitor/local-notifications';

export default function AppShellClient({ children }) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const { user } = useAuth();

  const [isDrill, setIsDrill] = useState(false);
  const [parentPath, setParentPath] = useState('/drills');
  const [hideControls, setHideControls] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateStatus = () => {
      setHideControls(
        document.body.classList.contains('hide-drill-controls') || 
        document.body.classList.contains('game-active')
      );
    };
    updateStatus();
    const observer = new MutationObserver(updateStatus);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

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
      setParentPath('/' + segments.slice(0, 2).join('/'));
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
    if (OriginalAudioContext && !OriginalAudioContext.__isMocked) {
      class MockAudioContext extends OriginalAudioContext {
        constructor(...args) {
          super(...args);
          
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
  }, []);

  // ─── Touch-To-Mouse Event Converter for Mobile ────────────────────────────
  // Converts mobile touch drags and taps on the gameplay canvas into simulated
  // mouse movements (with movementX/Y deltas) and mousedown events so pointer-lock 
  // and click-to-shoot aim trainers work smoothly on touchscreens.
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

  const handleExit = async () => {
    await lockPortrait().catch(() => {});
    router.push(parentPath);
  };

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

      {/* Floating Gameplay HUD Controls (Exit) overlay on drills */}
      {isDrill && !hideControls && (
        <div className="fixed top-4 right-4 z-[999] flex items-center gap-2 pointer-events-auto">
          {/* Close/Exit Button */}
          <button
            onClick={handleExit}
            className="w-10 h-10 rounded-full flex items-center justify-center backdrop-blur-md active:scale-90 transition-transform shadow-lg border"
            style={{ 
              background: 'rgba(5, 5, 8, 0.75)', 
              borderColor: 'rgba(255, 255, 255, 0.1)',
              color: '#f87171' // soft red
            }}
            title="Exit Drill"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </ChallengeProvider>
  );
}
