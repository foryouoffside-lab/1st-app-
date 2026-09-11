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
// Safe to import here: lib/challengeEngine.js only reaches for lib/firebase.js
// and react, never back into this file, so there is no import cycle.
import { leaveMatchmakingQueue } from '../lib/challengeEngine';
import { clearAllProgress } from '../lib/progressStore';
import { deleteCloudProgress } from '../lib/progressCloud';
import { setPlayerName, sanitizeUsername, validateUsername } from '../lib/playerIdentity';

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
// early as possible — the Arena, Progress, the drill shell and the sign-in
// gate all render it, so the sooner this fetch starts, the less often those
// screens are still on their placeholder by the time they render.
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
    // wins/losses/streak/eiq intentionally start at 0, NOT carried over from
    // the legacy doc — firestore.rules' create rule now requires every stat
    // field be exactly 0 on a brand-new users/{uid} doc (closes a hole where
    // a forged create call could self-assign a starting EIQ/win count), and
    // that applies here too since this is itself a create (no doc exists yet
    // at fbUser.uid). If a legacy account genuinely has real stats worth
    // preserving, carry them over as a one-off manual edit in the Firebase
    // Console after this migration runs — not a client-writable path.
    const merged = {
      uid: fbUser.uid,
      displayName: legacy.displayName,
      photoURL: fbUser.photoURL || legacy.photoURL || fallbackAvatar(fbUser.uid),
      online: true,
      wins: 0,
      losses: 0,
      streak: 0,
      eiq: 0,
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
  // Sanitized to the username format (see lib/playerIdentity.js) rather
  // than just trimmed: Google display names are real-world names with spaces
  // in them ("Sam Patel"), and a pre-filled suggestion that the Continue
  // button then refuses is a dead end on the very first screen.
  const suggested = sanitizeUsername(fbUser.displayName || fbUser.email?.split('@')[0] || 'Player');

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

  // Publish the username for the non-React readers — chiefly the shared score
  // card, which is drawn by a plain function called from ~24 drills and so has
  // no way to reach this context. Keyed on the whole `user` so it re-syncs on
  // every path that sets it (cache paint, auth listener, signup completion,
  // sign-out) rather than duplicating a call at each setUser site.
  useEffect(() => {
    setPlayerName(user?.displayName || null);
  }, [user]);

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

  // 1c. The Arena clock-sync measurement (getServerClockOffset, in
  // lib/challengeEngine.js) used to be prewarmed here, for every signed-in
  // user on every app open. It's a handful of sequential Firestore WRITES to
  // the profile doc, and this file runs for the whole userbase — including
  // the large majority who only ever play solo drills and never open the
  // Arena at all. That made it the app's biggest write cost, paid mostly on
  // behalf of players who never needed the result.
  //
  // It now runs on entering the Arena instead (see ChallengeArenaClient),
  // which is still comfortably ahead of any duel — so the measurement stays
  // off the critical path of a duel's countdown, which is the reason it was
  // prewarmed in the first place — while costing nothing for solo players.
  // The value is cached at module scope, so useDuelMatchStart still reads it
  // for free whenever a duel actually happens.

  // 2. Presence tracking USED TO LIVE HERE — a visibilitychange/beforeunload
  // pair writing { online, lastSeen } to this user's doc. It was removed on
  // 2026-09-10 because lib/presence.js (started in AppShellClient) had since
  // been added and writes the SAME two fields on the SAME events, so every
  // foreground and background was billed twice: two writes, plus two reads,
  // because the profile onSnapshot listener above is watching the very doc
  // being written and delivers each change straight back.
  //
  // presence.js is the one to keep — it also covers Capacitor's native
  // appStateChange (visibilitychange is unreliable in Android's WebView when
  // the whole app backgrounds), coalesces bursts, and carries the 3-minute
  // backstop heartbeat. Nothing was lost by deleting this copy.

  // 2c. Publish the player's XP level onto their public profile doc, so it
  // shows as a rank badge on the Arena profile sheet / leaderboard for other
  // players (see components/LevelBadge.js). XP itself stays on-device — only
  // the derived level (floor(xp/1000)+1) is shared. One write, and only when
  // the level has actually moved: once on app open if it drifted up since the
  // last sync, and again in-session the moment a run levels the player up
  // (the same 'sd:celebration' event the toast listens to). Never on every
  // open — level changes at most about once a day for an active player.
  useEffect(() => {
    if (!dbInstance || !user?.uid) return;
    const userRef = doc(dbInstance, 'users', user.uid);
    let lastPushed = Number(user.level) || 0;

    const push = async (level) => {
      const lv = Math.floor(Number(level) || 0);
      if (lv < 1 || lv === lastPushed) return;
      lastPushed = lv;
      try {
        await updateDoc(userRef, { level: lv });
      } catch (err) {
        // Non-critical — the badge just stays a level behind until next open.
      }
    };

    const pushCurrentLevel = async () => {
      try {
        const { getPlayerLevel } = await import('../lib/progressStore');
        const { level } = await getPlayerLevel();
        push(level);
      } catch (err) { /* progress store unavailable */ }
    };

    pushCurrentLevel();

    const onCelebration = (e) => {
      if (e.detail && e.detail.leveledUp) push(e.detail.leveledUp);
    };
    // A cloud restore can raise the level well after this effect's first read —
    // on a reinstall it goes from 1 to whatever the account had earned (see
    // lib/progressCloud.js). Without this the public badge other players see
    // would stay stuck at the pre-restore level until the next app open.
    const onRestored = () => { pushCurrentLevel(); };

    window.addEventListener('sd:celebration', onCelebration);
    window.addEventListener('sd:progress-restored', onRestored);
    return () => {
      window.removeEventListener('sd:celebration', onCelebration);
      window.removeEventListener('sd:progress-restored', onRestored);
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

    // Sanitize first, then validate what's left: a caller that somehow
    // arrives with a space in the string gets it stripped rather than
    // silently reserving a name nobody can type into the friend search.
    const clean = sanitizeUsername(displayName);
    const problem = validateUsername(clean);
    if (problem) return { ok: false, error: problem };

    const nameKey = clean.toLowerCase();

    try {
      const nameRef = doc(dbInstance, 'usernames', nameKey);
      const nameSnap = await getDoc(nameRef);
      // A reservation this SAME uid already owns is not someone else's name —
      // it is this account's own leftover. That happens when a deletion got
      // part-way through (profile doc gone, reservation still standing) and
      // the player signs back in to the same Google account, which keeps the
      // same uid. Treating it as "taken" would lock a person out of their own
      // name forever, because firestore.rules has no path that hands a
      // reservation to anybody else. Reuse it instead: it already points where
      // it should, so the batch below simply skips re-writing it.
      const ownStaleReservation = nameSnap.exists() && nameSnap.data()?.uid === pendingSignup.uid;
      if (nameSnap.exists() && !ownStaleReservation) {
        return { ok: false, error: 'That name is already taken.' };
      }

      // Fallback check for pre-existing accounts not yet in usernames/ (see
      // note above) — exact-match only, but that's the same guarantee this
      // whole check used to be, so it's strictly an improvement, never a
      // regression.
      const usersRef = collection(dbInstance, 'users');
      const q = query(usersRef, where('displayName', '==', clean));
      const snap = await getDocs(q);
      if (snap.docs.some((d) => d.id !== pendingSignup.uid)) {
        return { ok: false, error: 'That name is already taken.' };
      }

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
      // Skipped when this uid already holds the reservation — rewriting it
      // would be an `update`, which firestore.rules forbids outright, and the
      // whole batch (profile included) would be rejected.
      if (!ownStaleReservation) {
        batch.set(nameRef, { uid: pendingSignup.uid });
      }
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
      // Take down everything that advertises this player as available before
      // dropping the session. Signing out used to write `online: false` and
      // nothing else, which left two things pointing at an account that was
      // no longer there:
      //
      //  - a matchmaking_queue row, if they signed out mid-search. Another
      //    player could still match it and would then sit through the whole
      //    accept timeout waiting on somebody who had logged out. It ages out
      //    on its own after MATCHMAKING_FRESHNESS_MS, but not before someone
      //    can pair with it.
      //  - a `busyUntil` claim, if they signed out shortly after a duel. That
      //    hides them from every other player's opponent list for the rest of
      //    BUSY_TTL_MS — including from themselves after signing back in,
      //    since the claim is on the profile, not the session.
      //
      // Both are fire-and-forget: a sign-out must never fail or hang on
      // cleanup, and both self-heal on their own timers if the writes don't
      // land.
      leaveMatchmakingQueue(user.uid).catch(() => {});
      try {
        await updateDoc(doc(dbInstance, 'users', user.uid), {
          online: false,
          busyUntil: 0,
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
  // Firebase refuses deleteUser() on a session older than a few minutes
  // (auth/requires-recent-login), so the account has to be re-authenticated.
  //
  // On the WEB that re-authentication is a popup, and a browser only allows
  // window.open while a user gesture is still fresh. This used to be done
  // lazily, from the catch around deleteUser() further down — by which point
  // several awaited Firestore round-trips (the challenge sweep, the profile
  // doc) had already run, the click was long stale, and the browser blocked
  // the popup outright. That is the `auth/popup-blocked` the Delete Account
  // button failed with in a browser: the deletion had already half-happened,
  // and then the sign-in it needed to finish could never open.
  //
  // So it runs FIRST instead, before a single await, while the gesture that
  // opened the confirm() is still live. Native is unaffected either way (the
  // Google Sign-In SDK is not a popup), but both paths share this helper so
  // they cannot drift apart again.
  const REAUTH_AFTER_MS = 4 * 60 * 1000;

  const reauthenticate = async () => {
    if (Capacitor.isNativePlatform()) {
      const result = await FirebaseAuthentication.signInWithGoogle({ useCredentialManager: false });
      const credential = GoogleAuthProvider.credential(result.credential?.idToken);
      await reauthenticateWithCredential(authInstance.currentUser, credential);
    } else {
      await reauthenticateWithPopup(authInstance.currentUser, new GoogleAuthProvider());
    }
  };

  const deleteAccount = async () => {
    if (!authInstance?.currentUser || !dbInstance || !user) {
      return { ok: false, error: 'Not signed in.' };
    }
    const uid = user.uid;

    try {
      // Re-auth up front if the session is old enough that deleteUser() would
      // demand it. Nothing has been deleted yet at this point, so a cancelled
      // or blocked sign-in here leaves the account completely intact.
      const lastSignIn = Date.parse(authInstance.currentUser.metadata?.lastSignInTime || '');
      if (!Number.isFinite(lastSignIn) || Date.now() - lastSignIn > REAUTH_AFTER_MS) {
        await reauthenticate();
      }

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

      // Delete the private progress backup (users/{uid}/private/progress —
      // see lib/progressCloud.js). This has to happen BEFORE the profile doc
      // and the auth user go, because the rule guarding it needs this player
      // to still be signed in; and it has to happen at all because deleting
      // users/{uid} does NOT delete its subcollections. Left behind, the
      // backup would outlive the deleted account and silently restore all of
      // this player's XP and bests if they ever signed up again with the same
      // Google account — after being told it was permanently deleted.
      await deleteCloudProgress(uid);

      // Delete the Firestore profile doc
      try {
        await deleteDoc(doc(dbInstance, 'users', uid));
      } catch (e) {
        console.error('Failed to delete profile doc:', e);
      }

      // The usernames/{name} reservation is deliberately LEFT STANDING. A name
      // is claimed permanently: deleting the account must not put it back in
      // circulation for someone else to take (see firestore.rules). If this
      // same person signs in again with the same Google account, completeSignup
      // recognises the reservation as their own and lets them re-take it.


      // Delete the actual Firebase Auth login
      try {
        await deleteUser(authInstance.currentUser);
      } catch (e) {
        if (e?.code === 'auth/requires-recent-login') {
          // Safety net: the up-front check above normally makes this
          // unreachable, but a session can cross the threshold mid-deletion.
          await reauthenticate();
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
      // Raw Firebase codes ("Firebase: Error (auth/popup-blocked).") mean
      // nothing to a player, and these three are the ones a real person
      // actually hits.
      const friendly = {
        'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.',
        'auth/popup-closed-by-user': 'Sign-in was cancelled, so nothing was deleted.',
        'auth/cancelled-popup-request': 'Sign-in was cancelled, so nothing was deleted.',
      }[err?.code];
      return { ok: false, error: friendly || err.message || 'Something went wrong — try again.' };
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
