// lib/friends.js
// SkillDrills — friend requests + friends list.
//
// ONE collection carries the whole thing: friendRequests/{pairId}, where
//   pairId = [uidA, uidB].sort().join('_')
// so there is exactly one doc per relationship and its id is derivable from
// either side without a lookup. The doc holds a `users: [a, b]` array, which
// makes "who are my friends" a single array-contains query.
//
// status is only ever 'pending' | 'accepted'. A decline DELETES the doc
// (rather than parking it at 'declined'), so a later re-request is just a
// fresh create — no reopen rule, no permanently-stuck pairs.
//
// Deliberately composite-index-free: every query below is either two
// equality filters (served by merged single-field indexes, same as the
// invites listener in challengeEngine) or one array-contains (auto-indexed).
// Nothing here needs firestore.indexes.json touched.
//
// Photos are NOT denormalised onto the request doc — a base64 data-URI
// avatar is up to 300KB and listenFriends reads every friend doc, so that
// would turn a 40-friend list into a multi-megabyte read. Names only; the
// Friends tab batch-fetches the real user docs (for photo + live EIQ) once
// when it opens.

import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, serverTimestamp,
} from 'firebase/firestore';

export function friendPairId(a, b) {
  return [a, b].sort().join('_');
}

// Resolve an exact (case-insensitive) username to a public profile, or null.
// Uses the usernames/{nameLower} reservation collection (already readable by
// any signed-in user) then the users/{uid} doc.
export async function searchUserByName(db, rawName) {
  const name = String(rawName || '').trim().toLowerCase();
  if (!name) return null;
  try {
    const reservation = await getDoc(doc(db, 'usernames', name));
    if (!reservation.exists()) return null;
    const uid = reservation.data().uid;
    if (!uid) return null;
    const profile = await getDoc(doc(db, 'users', uid));
    if (!profile.exists()) return null;
    return { uid, ...profile.data() };
  } catch (e) {
    console.error('friend search failed', e);
    return null;
  }
}

// Returns one of:
//   'sent'            — a new pending request was written
//   'already-friends' — you are already friends
//   'already-pending' — you already have a pending request out to them
//   'incoming'        — THEY already have a pending request out to you (accept it instead)
export async function sendFriendRequest(db, fromUser, toUser) {
  if (!fromUser?.uid || !toUser?.uid || fromUser.uid === toUser.uid) {
    throw new Error('invalid friend request');
  }
  const ref = doc(db, 'friendRequests', friendPairId(fromUser.uid, toUser.uid));
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const data = existing.data();
    if (data.status === 'accepted') return 'already-friends';
    return data.from === fromUser.uid ? 'already-pending' : 'incoming';
  }
  await setDoc(ref, {
    users: [fromUser.uid, toUser.uid],
    from: fromUser.uid,
    to: toUser.uid,
    fromName: fromUser.displayName || 'Player',
    toName: toUser.displayName || 'Player',
    status: 'pending',
    createdAt: serverTimestamp(),
    respondedAt: null,
  });
  return 'sent';
}

export function acceptFriendRequest(db, pairId) {
  return updateDoc(doc(db, 'friendRequests', pairId), {
    status: 'accepted',
    respondedAt: serverTimestamp(),
  });
}

// Decline an incoming request / cancel one you sent / unfriend — all just
// remove the single relationship doc.
export function removeFriendRelationship(db, pairId) {
  return deleteDoc(doc(db, 'friendRequests', pairId));
}
export const declineFriendRequest = removeFriendRelationship;
export const cancelFriendRequest = removeFriendRelationship;
export const removeFriend = removeFriendRelationship;

// Live: incoming pending requests addressed to me. Two equality filters —
// no composite index.
export function listenIncomingRequests(db, uid, cb) {
  const q = query(
    collection(db, 'friendRequests'),
    where('to', '==', uid),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.error('incoming friend-requests listener failed', e); cb([]); },
  );
}

// Live: pending requests I have sent (so the Add-friend UI can show "Requested").
export function listenOutgoingRequests(db, uid, cb) {
  const q = query(
    collection(db, 'friendRequests'),
    where('from', '==', uid),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.error('outgoing friend-requests listener failed', e); cb([]); },
  );
}

// Live: my accepted friendships, normalised to the OTHER person. status is
// filtered client-side so this stays a single array-contains query.
export function listenFriends(db, uid, cb) {
  const q = query(collection(db, 'friendRequests'), where('users', 'array-contains', uid));
  return onSnapshot(
    q,
    (snap) => {
      const friends = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => r.status === 'accepted')
        .map((r) => {
          const isFrom = r.from === uid;
          return {
            pairId: r.id,
            uid: isFrom ? r.to : r.from,
            displayName: isFrom ? r.toName : r.fromName,
            since: r.respondedAt || r.createdAt || null,
          };
        });
      cb(friends);
    },
    (e) => { console.error('friends listener failed', e); cb([]); },
  );
}
