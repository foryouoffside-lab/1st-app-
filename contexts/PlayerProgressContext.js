'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { getPlayerLevel, getStreak, getTopScores } from '../lib/progressStore';
import { startProgressCloudSync } from '../lib/progressCloud';

const PlayerProgressContext = createContext({ progress: null, status: 'loading' });

// Home and Progress consume the same snapshot. Neither page has to be opened
// to initialize it, and no pre-restore Level 1 snapshot is shown as final data.
export function PlayerProgressProvider({ children }) {
  const { user } = useAuth();
  const uid = user?.uid || null;
  const [state, setState] = useState({ uid: null, progress: null, status: 'loading' });

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let restored = !uid;
    setState({ uid, progress: null, status: 'loading' });
    const refresh = async ({ allowLocal = false } = {}) => {
      if (!restored && !allowLocal) return;
      const read = ++generation;
      try {
        const [level, streak, top] = await Promise.all([
          getPlayerLevel(), getStreak(), getTopScores(1),
        ]);
        if (disposed || read !== generation) return;
        // Existing local progress remains usable offline. An empty reinstall
        // must keep waiting instead of presenting a fabricated Level 1.
        if (!restored && level.xp <= 0) {
          setState({ uid, status: 'unavailable', progress: null });
          return;
        }
        setState({ uid, status: restored ? 'ready' : 'offline', progress: {
          ...level, streak: streak.current, best: top[0]?.best || 0,
          bestDrillId: top[0]?.drillId || null,
        } });
      } catch {
        if (!disposed && read === generation) {
          setState({ uid, status: 'unavailable', progress: null });
        }
      }
    };
    const onReady = (ok) => {
      if (disposed) return;
      if (!ok) {
        refresh({ allowLocal: true });
        return;
      }
      restored = true;
      refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('sd:progress-changed', refresh);
    window.addEventListener('sd:progress-restored', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const stop = uid ? startProgressCloudSync(uid, { onReady }) : () => {};
    if (!uid) refresh();
    return () => {
      disposed = true;
      stop();
      window.removeEventListener('sd:progress-changed', refresh);
      window.removeEventListener('sd:progress-restored', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [uid]);

  const value = state.uid === uid ? state : { progress: null, status: 'loading' };
  return <PlayerProgressContext.Provider value={value}>{children}</PlayerProgressContext.Provider>;
}

export const usePlayerProgress = () => useContext(PlayerProgressContext);
