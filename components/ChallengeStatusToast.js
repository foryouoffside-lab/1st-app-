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

export default function ChallengeStatusToast() {
  const { outgoingChallenge } = useChallenge();
  const router = useRouter();
  const [declinedNotice, setDeclinedNotice] = useState(null);
  const handledRef = useRef(new Set());

  useEffect(() => {
    if (!outgoingChallenge) return;
    const { id, status, drillSlug, toName } = outgoingChallenge;
    const key = `${id}:${status}`;
    if (handledRef.current.has(key)) return;
    handledRef.current.add(key);

    if (status === 'accepted') {
      router.push(`/drills/${drillSlug}?challengeId=${id}`);
    } else if (status === 'declined') {
      setDeclinedNotice({ id, toName });
    }
  }, [outgoingChallenge, router]);

  if (!declinedNotice) return null;

  return (
    <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[9999] w-full max-w-md px-4 pointer-events-none">
      <div className="bg-neutral-900/95 border border-red-500/40 backdrop-blur-md rounded-2xl p-4 flex items-center justify-between gap-3 pointer-events-auto shadow-[0_0_25px_rgba(239,68,68,0.2)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <Swords className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-neutral-200 min-w-0 truncate">
            <strong className="text-white">{declinedNotice.toName || 'Your opponent'}</strong> declined your duel.
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
