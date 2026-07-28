'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { initFirebase } from '../lib/firebase';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  serverTimestamp
} from 'firebase/firestore';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  onAuthStateChanged,
  signOut as firebaseSignOut,
  deleteUser,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
} from 'firebase/auth';
import { clearAllProgress } from '../lib/progressStore';
import { getServerClockOffset } from '../lib/challengeEngine';
import { ARENA_ENABLED } from '../lib/featureFlags';

const AuthContext = createContext({
  user: null,
  loading: true,
  pendingSignup: null,
  completeSignup: async (displayName) => ({ ok: false, error: 'Not ready.' }),
  signInWithGoogle: async () => {},
  signOut: async () => {},
  deleteAccount: async () => ({ ok: false, error: 'Not ready.' }),
  db: null
});

const SESSION_KEY = 'sd_user_session';
// Holds a Google photoURL that changed from what's stored, until it's seen
// again on a second sign-in — see the note in resolveProfile below.
const PHOTO_CANDIDATE_KEY = 'sd_photo_candidate';

const fallbackAvatar = (seed) =>
  `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(seed)}`;

// Warms the browser's own image cache for this user's profile photo as
// early as possible — the header (components/MobileHeader.js) shows it on
// every single screen, so the sooner this fetch starts, the less often
// that header is still on its placeholder by the time it renders.
// referrerPolicy matches Avatar.js: Capacitor serves the app from an
// unusual origin (https://localhost), and Google's photo CDN can reject a
// request that carries that origin's Referer header.
const preloadImage = (src) => {
  if (typeof window === 'undefined' || !src) return;
  const img = new window.Image();
  img.referrerPolicy = 'no-referrer';
  img.src = src;
};

// Resolve the Firestore profile for a real Firebase Auth user.
// - Returning users (doc already exists at users/{uid}) sign straight in.
// - Legacy fake accounts (pre-Google-auth, keyed by a random 'usr_xxxxx' id)
//   are matched by email and migrated silently — they already have a name.
// - Brand-new users are handed back as 'needs-username' so the UI can collect
//   a unique display name before the profile doc is actually created.
async function resolveProfile(db, fbUser) {
  const userRef = doc(db, 'users', fbUser.uid);
  const existing = await getDoc(userRef);

  if (existing.exists()) {
    const data = existing.data();
    const updates = { online: true, lastSeen: serverTimestamp() };

    // Sync the profile photo from Google, but don't trust a changed value on
    // a single sign-in — native Google Sign-In has occasionally handed back
    // a generic placeholder photo instead of the account's real one on one
    // sign-in out of several, and that used to get written straight over a
    // perfectly good stored photo, permanently. Require the SAME new URL to
    // show up on two sign-ins in a row before committing it: a real photo
    // change stays consistent across logins and passes on the second one; a
    // one-off glitch shows something different (or the original URL) next
    // time and never gets committed.
    //
    // BUG FIX: this guard only protected against a bad Google URL replacing a
    // good Google URL — it never accounted for a custom-uploaded photo (see
    // ProgressClient's handleSavePhoto, stored as a `data:image/...;base64,`
    // URL). Since a user's real Google photoURL is itself stable across
    // sign-ins, once a custom photo was set this same "confirmed twice" logic
    // would always eventually confirm the Google URL as a legitimate change
    // and silently overwrite the custom upload within two app restarts, every
    // time. A custom photo is a deliberate, permanent user choice — never let
    // this Google-sync path touch it at all.
    const hasCustomPhoto = typeof data.photoURL === 'string' && data.photoURL.startsWith('data:');
    if (hasCustomPhoto) {
      try { localStorage.removeItem(PHOTO_CANDIDATE_KEY); } catch (e) {}
    } else if (fbUser.photoURL && fbUser.photoURL !== data.photoURL) {
      let candidate = null;
      try { candidate = JSON.parse(localStorage.getItem(PHOTO_CANDIDATE_KEY) || 'null'); } catch (e) {}
      if (candidate && candidate.uid === fbUser.uid && candidate.url === fbUser.photoURL) {
        updates.photoURL = fbUser.photoURL;
        try { localStorage.removeItem(PHOTO_CANDIDATE_KEY); } catch (e) {}
      } else {
        try { localStorage.setItem(PHOTO_CANDIDATE_KEY, JSON.stringify({ uid: fbUser.uid, url: fbUser.photoURL })); } catch (e) {}
      }
    } else if (fbUser.photoURL) {
      try { localStorage.removeItem(PHOTO_CANDIDATE_KEY); } catch (e) {}
    }
    // Self-heal: earlier versions stored email on this publicly-readable doc.
    // Strip it going forward — it only ever needs to live in Firebase Auth
    // (fbUser.email below), never in the world-readable Firestore document.
    if ('email' in data) updates.email = deleteField();
    await updateDoc(userRef, updates);
    const publicData = { ...data };
    delete publicData.email;
    return { status: 'ready', profile: { uid: fbUser.uid, ...publicData, ...updates, email: fbUser.email || '' } };
  }

  let legacy = null;
  if (fbUser.email) {
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('email', '==', fbUser.email));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const candidates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      candidates.sort((a, b) => {
        const activity = ((b.wins || 0) + (b.losses || 0)) - ((a.wins || 0) + (a.losses || 0));
        if (activity !== 0) return activity;
        const aSeen = a.lastSeen?.toMillis ? a.lastSeen.toMillis() : 0;
        const bSeen = b.lastSeen?.toMillis ? b.lastSeen.toMillis() : 0;
        return bSeen - aSeen;
      });
      legacy = candidates[0];
    }
  }

  if (legacy) {
    const merged = {
      uid: fbUser.uid,
      displayName: legacy.displayName,
      photoURL: fbUser.photoURL || legacy.photoURL || fallbackAvatar(fbUser.uid),
      online: true,
      wins: legacy.wins || 0,
      losses: legacy.losses || 0,
      streak: legacy.streak || 0,
      eiq: legacy.eiq || 0,
      createdAt: legacy.createdAt || serverTimestamp(),
      lastSeen: serverTimestamp(),
    };
    await setDoc(userRef, merged);
    try {
      // Also scrub email off the old doc being retired — it's no longer
      // read anywhere, and this is the one place old leaked data gets cleaned up.
      await updateDoc(doc(db, 'users', legacy.id), { migratedTo: fbUser.uid, online: false, email: deleteField() });
    } catch (e) {
      console.error('Failed to tag migrated legacy account:', e);
    }
    try {
      // Back-fill this legacy name into the same reservation collection new
      // signups check in completeSignup, so a brand-new user can no longer
      // claim a name a migrated account is already using. Best-effort and
      // never blocks sign-in: if it's already reserved (e.g. this account
      // was migrated once before) or the write fails, this account still
      // owns the name via its users/{uid} doc either way.
      await setDoc(doc(db, 'usernames', merged.displayName.toLowerCase()), { uid: fbUser.uid }, { merge: false });
    } catch (e) {}
    return { status: 'ready', profile: { ...merged, email: fbUser.email || legacy.email || '' } };
  }

  // Brand-new player — don't create the doc yet, they still need to pick a
  // unique display name (see completeSignup below).
  const suggested = (fbUser.displayName || fbUser.email?.split('@')[0] || 'Player')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .slice(0, 20);

  return {
    status: 'needs-username',
    pending: {
      uid: fbUser.uid,
      email: fbUser.email || '',
      photoURL: fbUser.photoURL || fallbackAvatar(fbUser.uid),
      suggested,
    },
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [pendingSignup, setPendingSignup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dbInstance, setDbInstance] = useState(null);
  const [authInstance, setAuthInstance] = useState(null);

  // 1. Initialize Firebase and subscribe to real auth state. `onAuthStateChanged`
  //    is the source of truth for whether a session is active — the localStorage
  //    cache below is only used to paint instantly on load, never trusted alone.
  useEffect(() => {
    const initialized = initFirebase();
    if (!initialized) { setLoading(false); return; }

    setDbInstance(initialized.db);
    setAuthInstance(initialized.auth);

    try {
      const cached = localStorage.getItem(SESSION_KEY);
      if (cached) {
        const cachedUser = JSON.parse(cached);
        setUser(cachedUser);
        preloadImage(cachedUser?.photoURL);
        // Paint the cached profile (photo included) immediately instead of
        // blocking the whole app behind AuthGate's spinner for a fresh
        // Firebase Auth + Firestore round-trip on every single open/re-login
        // — that round-trip was the "profile image takes forever to load"
        // complaint, since the cached data was already sitting right here.
        // onAuthStateChanged below still runs and reconciles this in the
        // background (including signing out if the session actually
        // expired) — this only changes what's shown while that happens.
        setLoading(false);
      }
    } catch (e) {}

    const unsubscribe = onAuthStateChanged(initialized.auth, async (fbUser) => {
      if (!fbUser) {
        setUser(null);
        setPendingSignup(null);
        try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
        setLoading(false);
        return;
      }
      try {
        const result = await resolveProfile(initialized.db, fbUser);
        if (result.status === 'ready') {
          setUser(result.profile);
          preloadImage(result.profile?.photoURL);
          setPendingSignup(null);
          try { localStorage.setItem(SESSION_KEY, JSON.stringify(result.profile)); } catch (e) {}
        } else {
          setUser(null);
          setPendingSignup(result.pending);
        }
      } catch (err) {
        console.error("Failed to resolve user profile:", err);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // 1b. Live-sync this signed-in user's own profile doc. resolveProfile
  // above is a one-shot read at sign-in — without this, `user.eiq`/`wins`/
  // `losses`/`streak` (read all over the Arena UI: leaderboard "you" row,
  // Results tab summary, matchmaking pairing) stay frozen at their
  // sign-in-time values for the rest of the session, even though every Arena
  // duel writes fresh values to this same doc via submitScore. Merged onto
  // the existing `user` object (not replaced) so nothing else this file sets
  // locally (e.g. right after completeSignup) gets clobbered by a snapshot
  // that hasn't caught up yet.
  useEffect(() => {
    if (!dbInstance || !user?.uid) return;
    const userRef = doc(dbInstance, 'users', user.uid);
    const unsubscribe = onSnapshot(userRef, (snap) => {
      if (!snap.exists()) return;
      setUser((prev) => {
        if (!prev) return prev;
        const merged = { ...prev, ...snap.data(), uid: prev.uid };
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(merged)); } catch (e) {}
        return merged;
      });
    }, (err) => console.error('Profile live-sync error:', err));
    return () => unsubscribe();
  }, [dbInstance, user?.uid]);

  // 1c. Prewarm the Arena clock-sync measurement as soon as we know who's
  // signed in, long before any duel actually needs it. getServerClockOffset()
  // (lib/challengeEngine.js) runs 5 sequential Firestore round trips to
  // measure this device's clock drift from the server — on a real mobile
  // network that's routinely 1-3 seconds. It used to only ever get called
  // for the first time once a duel's lobby reached "both ready", which put
  // that whole measurement directly on the critical path of writing/reading
  // `matchStartAt` — the exact 1-3s of "sometimes the duel takes a couple
  // extra seconds to actually start" a player would see on their very first
  // match of a session. Firing it here means it's almost always already
  // resolved and cached by the time anyone reaches a duel. Fire-and-forget:
  // the result is cached at module scope in challengeEngine.js and read from
  // there by DrillWrapper/useDuelMatchStart whenever a duel actually happens.
  useEffect(() => {
    if (!ARENA_ENABLED || !user?.uid) return;
    getServerClockOffset().catch(() => {});
  }, [user?.uid]);

  // 2. Set up visibility presence tracking
  useEffect(() => {
    if (!dbInstance || !user) return;

    const userRef = doc(dbInstance, 'users', user.uid);

    const setPresence = async (isOnline) => {
      try {
        await updateDoc(userRef, {
          online: isOnline,
          lastSeen: serverTimestamp()
        });
      } catch (err) {
        console.error("Presence status update failed:", err);
      }
    };

    const handleVisibilityChange = () => {
      setPresence(document.visibilityState === 'visible');
    };
    const handleBeforeUnload = () => setPresence(false);

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [dbInstance, user?.uid]);

  // 3. Real Google sign-in. A browser popup doesn't work inside the app's
  //    embedded WebView on Android/iOS (Google blocks OAuth from WebViews
  //    outright) — native platforms go through the real native Google
  //    Sign-In SDK instead, then bridge the resulting credential into the
  //    Firebase JS SDK so the rest of this file (onAuthStateChanged, etc.)
  //    doesn't need to know the difference.
  const signInWithGoogle = async () => {
    if (!authInstance) {
      alert("Database connection is not ready. Please try again in a moment.");
      return;
    }
    try {
      if (Capacitor.isNativePlatform()) {
        // useCredentialManager defaults to true, but that API isn't
        // supported on all devices (outdated/non-Google Play Services) —
        // the legacy Google Sign-In flow works everywhere.
        const result = await FirebaseAuthentication.signInWithGoogle({ useCredentialManager: false });
        const credential = GoogleAuthProvider.credential(result.credential?.idToken);
        await signInWithCredential(authInstance, credential);
      } else {
        await signInWithPopup(authInstance, new GoogleAuthProvider());
      }
      // onAuthStateChanged (above) picks up the new session and resolves the profile.
    } catch (error) {
      if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
        console.error("Google sign-in failed:", error);
        alert("Sign-in failed: " + error.message);
      }
    }
  };

  // 4. Finish a brand-new signup once the player has chosen a unique display name.
  //
  // Display names are permanent from this point on (see firestore.rules —
  // the users/{uid} update rule locks the field out entirely) and globally
  // unique, case-insensitively: the Arena's "invite a friend" flow searches
  // the online player list by this exact name, so two people sharing one
  // would make that search useless, and a name that could later change would
  // let someone quietly stop being findable — or hand their identity to
  // whoever claims it next.
  //
  // Uniqueness is enforced two ways, because this project has one generation
  // of accounts that predates the second:
  //  1. usernames/{lowercased name} — a reservation doc created atomically
  //     alongside the profile in one batch. Firestore only allows a `create`
  //     when the doc doesn't already exist, so if two people submit the same
  //     name in the same instant, only one batch can ever actually commit —
  //     this is the real guarantee, not just a client-side courtesy check.
  //  2. A query against existing users/{uid} docs, case-sensitive — a
  //     fallback that catches collisions with pre-existing accounts created
  //     before the usernames/ collection existed (and therefore never
  //     reserved their name there). New accounts are always covered by #1.
  const completeSignup = async (displayName) => {
    if (!pendingSignup || !dbInstance) return { ok: false, error: 'Not ready — try again.' };

    const clean = displayName.trim();
    if (clean.length < 3) return { ok: false, error: 'Must be at least 3 characters.' };
    if (clean.length > 20) return { ok: false, error: 'Must be 20 characters or fewer.' };

    const nameKey = clean.toLowerCase();

    try {
      const nameRef = doc(dbInstance, 'usernames', nameKey);
      const nameSnap = await getDoc(nameRef);
      if (nameSnap.exists()) return { ok: false, error: 'That name is already taken.' };

      // Fallback check for pre-existing accounts not yet in usernames/ (see
      // note above) — exact-match only, but that's the same guarantee this
      // whole check used to be, so it's strictly an improvement, never a
      // regression.
      const usersRef = collection(dbInstance, 'users');
      const q = query(usersRef, where('displayName', '==', clean));
      const snap = await getDocs(q);
      if (!snap.empty) return { ok: false, error: 'That name is already taken.' };

      // email deliberately left off this doc — users/{uid} is world-readable
      // (leaderboards/opponent cards need it), so email lives only in
      // Firebase Auth + the in-memory/local-storage profile below, never here.
      const publicProfile = {
        uid: pendingSignup.uid,
        displayName: clean,
        photoURL: pendingSignup.photoURL,
        online: true,
        wins: 0,
        losses: 0,
        streak: 0,
        eiq: 0,
        createdAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
      };

      // Reserve the name and create the profile together — if someone else's
      // signup wins the race and reserves nameKey a moment after the checks
      // above, this whole batch is rejected by firestore.rules (no `update`
      // path for usernames/{name}) and NEITHER document is written, so the
      // profile can never exist without a matching reservation.
      const batch = writeBatch(dbInstance);
      batch.set(nameRef, { uid: pendingSignup.uid });
      batch.set(doc(dbInstance, 'users', pendingSignup.uid), publicProfile);
      await batch.commit();

      const profile = { ...publicProfile, email: pendingSignup.email || '' };
      setUser(profile);
      setPendingSignup(null);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(profile)); } catch (e) {}
      return { ok: true };
    } catch (err) {
      console.error('Failed to complete signup:', err);
      if (err?.code === 'permission-denied') {
        return { ok: false, error: 'That name is already taken.' };
      }
      return { ok: false, error: 'Something went wrong — try again.' };
    }
  };

  const signOut = async () => {
    if (user && dbInstance) {
      try {
        await updateDoc(doc(dbInstance, 'users', user.uid), {
          online: false,
          lastSeen: serverTimestamp()
        });
      } catch (e) {
        console.error(e);
      }
    }
    if (authInstance) {
      try { await firebaseSignOut(authInstance); } catch (e) { console.error(e); }
    }
    if (Capacitor.isNativePlatform()) {
      try { await FirebaseAuthentication.signOut(); } catch (e) { console.error(e); }
    }
    setUser(null);
    setPendingSignup(null);
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  };

  // 5. Permanently delete the account: duel/challenge history, Firestore
  //    profile, the actual Firebase login itself, and all local device data.
  //    Deleting a Firebase Auth user can require a very recent sign-in
  //    (auth/requires-recent-login) — if so, silently re-authenticate via
  //    Google once and retry, rather than failing the whole deletion.
  const deleteAccount = async () => {
    if (!authInstance?.currentUser || !dbInstance || !user) {
      return { ok: false, error: 'Not signed in.' };
    }
    const uid = user.uid;

    try {
      // Delete duel/challenge history this account is part of
      try {
        const fromQ = query(collection(dbInstance, 'challenges'), where('fromUid', '==', uid));
        const toQ = query(collection(dbInstance, 'challenges'), where('toUid', '==', uid));
        const [fromSnap, toSnap] = await Promise.all([getDocs(fromQ), getDocs(toQ)]);
        const batch = writeBatch(dbInstance);
        fromSnap.forEach((d) => batch.delete(d.ref));
        toSnap.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      } catch (e) {
        console.error('Failed to delete challenge history:', e);
      }

      // Delete the Firestore profile doc
      try {
        await deleteDoc(doc(dbInstance, 'users', uid));
      } catch (e) {
        console.error('Failed to delete profile doc:', e);
      }


      // Delete the actual Firebase Auth login
      try {
        await deleteUser(authInstance.currentUser);
      } catch (e) {
        if (e?.code === 'auth/requires-recent-login') {
          if (Capacitor.isNativePlatform()) {
            const result = await FirebaseAuthentication.signInWithGoogle({ useCredentialManager: false });
            const credential = GoogleAuthProvider.credential(result.credential?.idToken);
            await reauthenticateWithCredential(authInstance.currentUser, credential);
          } else {
            await reauthenticateWithPopup(authInstance.currentUser, new GoogleAuthProvider());
          }
          await deleteUser(authInstance.currentUser);
        } else {
          throw e;
        }
      }

      // Wipe local on-device data too
      try { await clearAllProgress(); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        try { await FirebaseAuthentication.signOut(); } catch (e) {}
      }
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}

      setUser(null);
      setPendingSignup(null);
      return { ok: true };
    } catch (err) {
      console.error('Failed to delete account:', err);
      return { ok: false, error: err.message || 'Something went wrong — try again.' };
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, pendingSignup, completeSignup, signInWithGoogle, signOut, deleteAccount, db: dbInstance }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
