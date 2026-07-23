'use client';

import React, { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useChallenge } from '../contexts/ChallengeContext';
import { useRouter } from 'next/navigation';
import { X, Play, LogOut, Swords } from 'lucide-react';

export default function ChallengeNotificationBanner() {
  const { user } = useAuth();
  const { incomingChallenges, acceptChallenge, declineChallenge } = useChallenge();
  const router = useRouter();
  const activeChallenge = incomingChallenges[0] || null;
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
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[9999] w-full max-w-md px-4 pointer-events-none">
      <div className="bg-neutral-900/95 border-2 border-purple-500/80 shadow-[0_0_25px_rgba(168,85,247,0.3)] backdrop-blur-md rounded-2xl p-4 flex items-center justify-between gap-4 pointer-events-auto animate-bounce-short">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0">
            {activeChallenge.fromPhoto ? (
              <img 
                src={activeChallenge.fromPhoto} 
                alt={activeChallenge.fromName} 
                className="w-11 h-11 rounded-full border border-purple-500"
              />
            ) : (
              <div className="w-11 h-11 rounded-full bg-purple-900/60 flex items-center justify-center border border-purple-500">
                <Swords className="w-5 h-5 text-purple-400" />
              </div>
            )}
            <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-neutral-900 rounded-full animate-ping"></span>
            <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-neutral-900 rounded-full"></span>
          </div>
          
          <div>
            <h4 className="text-sm font-bold text-white flex items-center gap-1.5">
              <span>{activeChallenge.fromName}</span>
              <span className="text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded-full font-normal">CHALLENGE</span>
            </h4>
            <p className="text-xs text-neutral-400">wants to duel in <strong className="text-purple-300">{activeChallenge.drillName}</strong></p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleDecline}
            className="p-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white rounded-xl transition duration-200"
            title="Decline"
          >
            <X className="w-5 h-5" />
          </button>
          
          <button
            onClick={handleAccept}
            className="flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-purple-500/10 transition duration-200"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
