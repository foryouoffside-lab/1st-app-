'use client';

// components/ChallengeStatusToast.js
// SkillDrills Pro — notifies the sender of a duel when their invite is
// accepted (auto-routes into the drill) or declined (dismissible toast).
// Driven by the shared ChallengeContext, so it works regardless of which
// screen the sender is on — not tied to local per-page state.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X, Swords } from 'lucide-react';
import { useChallenge } from '../contexts/ChallengeContext';
import { useAuth } from '../contexts/AuthContext';

// An invite older than this is never auto-joined, however its status reads — a
// second safety net behind the transition check below.
const MAX_AUTO_JOIN_AGE_MS = 3 * 60 * 1000;

export default function ChallengeStatusToast() {
  const { outgoingChallenge } = useChallenge();
  const { user } = useAuth();
  const router = useRouter();
  const [declinedNotice, setDeclinedNotice] = useState(null);
  // Last status we actually OBSERVED per challenge id, so we can tell a live
  // answer apart from one that happened before we were watching.
  const seenStatusRef = useRef(new Map());

  useEffect(() => {
    if (!outgoingChallenge) return;
    const { id, status, drillSlug, toName, createdAt, withdrawnBySender, cancelledBy } = outgoingChallenge;

    const previousStatus = seenStatusRef.current.get(id);
    if (previousStatus === status) return;
    seenStatusRef.current.set(id, status);

    // Only act on a transition we watched happen (pending -> accepted/declined).
    //
    // This used to fire whenever it merely SAW status 'accepted', which turned
    // any challenge left sitting at 'accepted' — a match that never reached
    // 'playing', so nothing ever resolved it — into a trap. This component is
    // unmounted on drill routes and remounted on every return, and a fresh
    // mount had no memory, so each time the player came back to a normal screen
    // it pushed them straight back into that same stale match. Exit, get pulled
    // in again, exit again. That's the "auto rematch" loop: an invite nobody
    // had just answered, re-joining itself.
    //
    // Seeing 'accepted' as the FIRST status for an id means the answer landed
    // while we weren't looking, so it's history — not an invitation to navigate.
    if (previousStatus !== 'pending') return;

    const createdMs = createdAt?.toMillis ? createdAt.toMillis() : 0;
    if (createdMs && Date.now() - createdMs > MAX_AUTO_JOIN_AGE_MS) return;

    if (status === 'accepted') {
      router.push(`/drills/${drillSlug}?challengeId=${id}`);
    } else if (status === 'declined' && !withdrawnBySender && cancelledBy !== user?.uid) {
      // `withdrawnBySender` means WE cancelled this invite — see
      // withdrawChallenge. A cancellation and a decline both land as
      // status:'declined', so without this check the sender's own Cancel
      // Request came back to them as "Global Arena Pool declined your duel"
      // a moment later, which is the opposite of what happened.
      setDeclinedNotice({ id, toName, left: Boolean(cancelledBy) });
    }
  }, [outgoingChallenge, router, user?.uid]);

  // The decline notice dismisses itself — it carries no action, so there is
  // nothing lost by letting it slide away on its own. The X stays for anyone
  // who wants it gone sooner.
  useEffect(() => {
    if (!declinedNotice) return undefined;
    const t = setTimeout(() => setDeclinedNotice(null), 4000);
    return () => clearTimeout(t);
  }, [declinedNotice]);

  if (!declinedNotice) return null;

  return (
    <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[9999] w-full max-w-md px-4 pointer-events-none">
      <div className="bg-[#12131c] border border-red-500/30 rounded-2xl p-4 flex items-center justify-between gap-3 pointer-events-auto shadow-[0_8px_30px_rgba(0,0,0,.5)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <Swords className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-neutral-200 min-w-0 truncate">
            <strong className="text-white">{declinedNotice.toName || 'Your opponent'}</strong>{' '}
            {declinedNotice.left ? 'left the duel.' : 'declined your duel.'}
          </p>
        </div>
        <button
          onClick={() => setDeclinedNotice(null)}
          className="p-1.5 text-neutral-500 hover:text-white shrink-0"
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
