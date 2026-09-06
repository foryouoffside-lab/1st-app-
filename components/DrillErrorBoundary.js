'use client';

// components/DrillErrorBoundary.js
// Catches a render/lifecycle crash inside a drill and shows a recoverable
// screen instead of the black one.
//
// Why this lives in DrillWrapper rather than in each drill: a thrown error
// unmounts the whole React subtree, so without a boundary above it the drill
// area renders nothing at all — the "black screen on START" signature. Two
// drills used to carry their own private copy of a boundary class and the
// other 22 had none; this is the single one that wraps all of them.
//
// It deliberately does NOT catch errors thrown from inside an event handler,
// a setTimeout, or a rAF callback — React error boundaries can't. Those still
// need the try/catch the drills already use around their game loops.

import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';
import { reportError } from '../lib/crashReporting';

export default class DrillErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    // reportError goes to Crashlytics on device and to console on web, so a
    // crash that only reproduces on a real phone still leaves a trail.
    try {
      reportError(error, `drill:${this.props.drillName || 'unknown'}`);
    } catch {}
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[#050508] p-6">
        <div className="max-w-sm text-center">
          <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-amber-400" />
          <h3 className="mb-2 text-lg font-bold text-white">This drill hit an error</h3>
          <p className="mb-6 text-sm text-gray-400">
            Your saved scores and progress are safe. Restarting the drill usually clears it.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => window.location.reload()}
              className="w-full rounded-xl bg-violet-600 py-3 font-bold text-white transition-colors hover:bg-violet-500"
            >
              Restart drill
            </button>
            <a
              href={this.props.backHref || '/drills/cognitive'}
              className="w-full rounded-xl border border-white/10 py-3 font-bold text-gray-300 transition-colors hover:bg-white/5"
            >
              Back to drills
            </a>
          </div>
        </div>
      </div>
    );
  }
}
