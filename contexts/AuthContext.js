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

const fallbackAvatar = (seed) =>
  `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(seed)}`;

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
    if (fbUser.photoURL && fbUser.photoURL !== data.photoURL) updates.photoURL = fbUser.photoURL;
    await updateDoc(userRef, updates);
    return { status: 'ready', profile: { uid: fbUser.uid, ...data, ...updates } };
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
      email: fbUser.email || legacy.email || '',
      photoURL: fbUser.photoURL || legacy.photoURL || fallbackAvatar(fbUser.email || fbUser.uid),
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
      await updateDoc(doc(db, 'users', legacy.id), { migratedTo: fbUser.uid, online: false });
    } catch (e) {
      console.error('Failed to tag migrated legacy account:', e);
    }
    return { status: 'ready', profile: merged };
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
      photoURL: fbUser.photoURL || fallbackAvatar(fbUser.email || fbUser.uid),
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
      if (cached) setUser(JSON.parse(cached));
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
  const completeSignup = async (displayName) => {
    if (!pendingSignup || !dbInstance) return { ok: false, error: 'Not ready — try again.' };

    const clean = displayName.trim();
    if (clean.length < 3) return { ok: false, error: 'Must be at least 3 characters.' };
    if (clean.length > 20) return { ok: false, error: 'Must be 20 characters or fewer.' };

    try {
      const usersRef = collection(dbInstance, 'users');
      const q = query(usersRef, where('displayName', '==', clean));
      const snap = await getDocs(q);
      if (!snap.empty) return { ok: false, error: 'That name is already taken.' };

      const profile = {
        uid: pendingSignup.uid,
        displayName: clean,
        email: pendingSignup.email,
        photoURL: pendingSignup.photoURL,
        online: true,
        wins: 0,
        losses: 0,
        streak: 0,
        eiq: 0,
        createdAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
      };
      await setDoc(doc(dbInstance, 'users', pendingSignup.uid), profile);

      setUser(profile);
      setPendingSignup(null);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(profile)); } catch (e) {}
      return { ok: true };
    } catch (err) {
      console.error('Failed to complete signup:', err);
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
