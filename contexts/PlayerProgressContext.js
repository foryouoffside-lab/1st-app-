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
    // `restored`: the cloud restore has merged into local storage.
    // `cloudFailed`: the restore attempt came back without data (offline,
    // rules, auth) — only matters while the device has nothing of its own.
    let restored = !uid;
    let cloudFailed = false;
    setState({ uid, progress: null, status: 'loading' });
    // LOCAL-FIRST. The device copy is the live record (lib/progressStore.js),
    // so it is shown the moment it can be read — a few ms — instead of after
    // the cloud restore round trip (auth + a Firestore read, measured in
    // seconds on 4G). The restore can only ever RAISE values (see the merge
    // rule in lib/progressCloud.js), so when it lands the card updates upward
    // in place; nothing shown early is ever wrong in a way it has to undo.
    // The one case that must wait is an empty device (a reinstall) — showing
    // Level 1 there would be the fabricated reset the cloud backup prevents.
    //
    // This also fixes the post-drill lag: refresh used to no-op until a
    // restore had succeeded, so if the restore failed the home card never
    // picked up a finished drill until the next app open.
    const refresh = async () => {
      const read = ++generation;
      try {
        const [level, streak, top] = await Promise.all([
          getPlayerLevel(), getStreak(), getTopScores(1),
        ]);
        if (disposed || read !== generation) return;
        if (!restored && level.xp <= 0) {
          // Empty device: keep "Restoring…" until the cloud answers.
          if (cloudFailed) setState({ uid, status: 'unavailable', progress: null });
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
      if (ok) restored = true;
      else cloudFailed = true;
      refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('sd:progress-changed', refresh);
    window.addEventListener('sd:progress-restored', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const stop = uid ? startProgressCloudSync(uid, { onReady }) : () => {};
    refresh();
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
