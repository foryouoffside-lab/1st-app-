'use client';

import React, { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useChallenge } from '../contexts/ChallengeContext';
import { isInviteFresh } from '../lib/challengeEngine';
import { useRouter } from 'next/navigation';
import { X, Play, Swords } from 'lucide-react';

export default function ChallengeNotificationBanner() {
  const { user } = useAuth();
  const { incomingChallenges, acceptChallenge, declineChallenge } = useChallenge();
  const router = useRouter();
  // Only ever offer an invite that's still worth answering. Pending invites
  // linger in Firestore for 20 minutes before the stale sweep collects them
  // (STALE_CHALLENGE_MS), so without this an invite from long ago popped up
  // as a live "wants to duel" card — and accepting it dropped the player into
  // a lobby against someone who had closed the app ages before.
  const activeChallenge = incomingChallenges.find(isInviteFresh) || null;
  const announcedRef = useRef(new Set());

  useEffect(() => {
    if (!activeChallenge || announcedRef.current.has(activeChallenge.id)) return;
    announcedRef.current.add(activeChallenge.id);
    // Play notification sound if browser permits
    try {
      const contextSettings = JSON.parse(localStorage.getItem('sd_settings') || '{}');
      if (contextSettings.soundEnabled !== false) {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.15); // A5
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
        // Release the context once the chime finishes. A fresh AudioContext was
        // being created per invite and never closed, and browsers cap how many
        // can exist at once (Chrome allows ~6) — so after a handful of invites
        // in one session the constructor started throwing and the notification
        // sound silently stopped working for the rest of the session.
        osc.onended = () => { audioCtx.close().catch(() => {}); };
      }
    } catch (e) {
      console.warn("Could not play challenge sound:", e);
    }
  }, [activeChallenge]);

  const handleAccept = async () => {
    if (!activeChallenge) return;
    try {
      await acceptChallenge(activeChallenge.id, user);
      // Route player directly to the game with challengeId parameter
      router.push(`/drills/${activeChallenge.drillSlug}?challengeId=${activeChallenge.id}`);
    } catch (e) {
      if (e?.code === 'arena/locked-out' || e?.code === 'challenge/taken' || e?.code === 'challenge/expired') {
        alert(e.message);
        return;
      }
      console.error(e);
      alert("Failed to accept challenge. The challenge may have expired or been cancelled.");
    }
  };

  const handleDecline = async () => {
    if (!activeChallenge) return;
    try {
      await declineChallenge(activeChallenge.id);
    } catch (e) {
      console.error(e);
    }
  };

  if (!activeChallenge) return null;

  return (
    <div
      className="fixed left-1/2 z-[9999] w-full max-w-md -translate-x-1/2 px-3 pointer-events-none"
      style={{ top: 'calc(12px + env(safe-area-inset-top))' }}
    >
      {/* Card colour matches the Arena's own cards (#12131c) instead of the
          translucent neutral-900 this used to be: over the app's near-black
          ground that washed out into a flat grey slab that looked like a
          different app's component. One purple ring + one soft glow carries
          the "this is a duel" signal; the backdrop-blur is gone (it bought
          nothing over an opaque card and cost a compositor pass on every
          frame it was on screen). */}
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-purple-500/40 bg-[#12131c] p-3 shadow-[0_8px_30px_rgba(0,0,0,.55),0_0_20px_rgba(168,85,247,.12)]">
        <div className="relative shrink-0">
          {activeChallenge.fromPhoto ? (
            <img
              src={activeChallenge.fromPhoto}
              alt={activeChallenge.fromName}
              referrerPolicy="no-referrer"
              className="h-11 w-11 rounded-full border border-purple-500/40 object-cover"
            />
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-purple-500/40 bg-purple-600/15">
              <Swords className="h-5 w-5 text-purple-300" />
            </div>
          )}
          {/* Static dot. The old one was two stacked spans, the upper running
              `animate-ping` forever — a permanently animating layer on a card
              that can sit on screen for the full two-minute invite TTL. */}
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-[#12131c] bg-emerald-500" />
        </div>

        {/* min-w-0 is load-bearing: without it a long display name refuses to
            shrink and pushes the buttons off the card. That is what made the
            old banner wrap "For You" onto its own line and split the drill
            name across two more. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-black text-white">{activeChallenge.fromName}</span>
            <span className="shrink-0 rounded-full border border-purple-500/30 bg-purple-500/15 px-1.5 py-px text-[9px] font-black uppercase tracking-wider text-purple-300">
              Challenge
            </span>
          </div>
          {/* Just the drill. "wants to duel in" was a sentence wrapped around
              the only word here that carries information. */}
          <p className="mt-0.5 truncate text-xs font-bold text-purple-300">{activeChallenge.drillName}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={handleDecline}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-neutral-500 transition hover:bg-white/5 hover:text-neutral-300 active:scale-95"
            aria-label="Decline duel"
          >
            <X className="h-4 w-4" />
          </button>

          <button
            onClick={handleAccept}
            className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2.5 text-xs font-black text-white transition hover:bg-violet-500 active:scale-95"
          >
            <Play className="h-3.5 w-3.5 fill-white" />
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
