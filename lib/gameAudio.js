/**
 * lib/gameAudio.js - the one synthesizer every drill plays through.
 *
 * TWO THINGS LIVE IN THIS FILE, AND THEY ARE KEPT STRICTLY APART.
 *
 * 1. THE SOUNDS. Every effect below is parameter-for-parameter the original
 *    design that was copy-pasted into all ten drill clients. Frequencies,
 *    volumes, envelopes, filter cutoffs, detune amounts - all unchanged. These
 *    sounds were liked; nothing here is trying to improve them.
 *
 *    An earlier version of this file rewrote them: it moved the tick from 440Hz
 *    to 1174Hz, the penalty from 220/165Hz up an octave, the heartbeat from
 *    65Hz to 220Hz, and put a noise click on the front of everything - all in
 *    the name of making them audible on a phone speaker. It worked acoustically
 *    and destroyed the character. That was the wrong trade and it is reverted.
 *    If you are here to "fix" these frequencies again: don't. Change the
 *    PROJECTION settings instead.
 *
 * 2. THE PROJECTION BUS. The actual complaint was never about tone - it was
 *    that the sound seemed to come from inside the handset rather than out of
 *    the speaker. That is a SPATIAL problem, so the fix is spatial only:
 *
 *      - A Haas widener. A mono signal played through a phone's two speakers
 *        images dead centre, which is physically the middle of the phone. A
 *        short delayed copy fed in opposite polarity to the two channels puts
 *        energy in the side signal and pushes the image out to the grilles.
 *        This changes WHERE a sound appears to be, not what it sounds like -
 *        the centre content is untouched.
 *
 *      - A limiter with a little makeup gain. These effects peak around 0.12-
 *        0.16, which leaves most of the speaker's range unused. Raising the
 *        level with a limiter catching the peaks makes them present without
 *        altering their shape.
 *
 *    There is deliberately NO equalisation here. No highpass, no presence
 *    shelf, nothing that moves a frequency up or down. Every one of those
 *    changes timbre, and timbre is what was already right.
 *
 *    Set PROJECTION.enabled to false and the chain is bypassed entirely -
 *    every effect then routes straight to ctx.destination, exactly as the
 *    original inline class did. That is the escape hatch if this still isn't
 *    right.
 *
 * The public API matches the old inline class exactly, so drills just import
 * this instead of declaring their own. `ctx` and `enabled` stay public because
 * components/drill/ResultScreen.js reaches in for them.
 *
 * Muting works via AppShellClient wrapping window.AudioContext, so this must
 * construct through the window global, never a cached original.
 */

import { missFeedback } from './haptics';

export const PROJECTION = {
  // Master switch. false = byte-for-byte the original routing.
  enabled: true,

  // Haas widener. 10ms is long enough to decorrelate the channels and short
  // enough that it never reads as a separate echo on sounds this brief.
  // `width` is how much of the delayed copy goes into the side signal; push it
  // up for a wider image, down toward 0 to collapse back to mono.
  widthDelay: 0.010,
  width: 0.30,

  // Loudness. The limiter exists so `makeup` can be raised without clipping;
  // on its own it does almost nothing to sounds this short and quiet.
  //
  // The effects were authored to peak around 0.12-0.16, which leaves most of
  // the speaker unused. `makeup` is the one dial to turn if the game is too
  // quiet or too loud; the limiter below is what keeps the peaks safe while it
  // goes up. Threshold raised and ratio softened alongside the gain so the
  // extra level arrives as loudness rather than as squash.
  // Measured: at 1.7 the loudest effect still only peaked at 0.095 of full
  // scale, so nearly all the speaker's range was going unused. 2.4 puts the
  // peak near 0.13 — audibly louder, and still far enough under the limiter
  // threshold that even the GO chord (four overlapping voices) passes through
  // uncompressed. Raise further if it is still quiet; there is headroom.
  makeup: 2.4,
  limiterThreshold: -8,
  limiterKnee: 4,
  limiterRatio: 4,
  limiterAttack: 0.003,
  limiterRelease: 0.15,
};

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.bus = null;
  }

  init() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
      if (this.ctx) this._buildBus();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Where every voice connects. One indirection so the effects below never
   * mention ctx.destination and the routing can change in one place.
   */
  get out() {
    return this.bus || this.ctx.destination;
  }

  _buildBus() {
    const ctx = this.ctx;
    if (!PROJECTION.enabled) { this.bus = null; return; }

    try {
      const input = ctx.createGain();
      input.gain.value = PROJECTION.makeup;

      // Dry signal to both channels - this is the original mono sound,
      // unaltered, and it stays the centre of the image.
      const merger = ctx.createChannelMerger(2);
      input.connect(merger, 0, 0);
      input.connect(merger, 0, 1);

      // Delayed copy, opposite polarity per channel, so it lands purely in the
      // side signal. Nothing is added to the centre; the sound simply stops
      // being a single point between the two speakers.
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = PROJECTION.widthDelay;
      input.connect(delay);

      const sideL = ctx.createGain();
      sideL.gain.value = -PROJECTION.width;
      const sideR = ctx.createGain();
      sideR.gain.value = PROJECTION.width;
      delay.connect(sideL);
      delay.connect(sideR);
      sideL.connect(merger, 0, 0);
      sideR.connect(merger, 0, 1);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = PROJECTION.limiterThreshold;
      comp.knee.value = PROJECTION.limiterKnee;
      comp.ratio.value = PROJECTION.limiterRatio;
      comp.attack.value = PROJECTION.limiterAttack;
      comp.release.value = PROJECTION.limiterRelease;

      merger.connect(comp);
      comp.connect(ctx.destination);

      this.bus = input;
    } catch {
      // Any failure here falls back to the original direct routing rather than
      // leaving the game silent.
      this.bus = null;
    }
  }

  // ==========================================================================
  // THE SOUNDS - unchanged from the original design. See the header.
  // ==========================================================================

  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      if (sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(sweepTo, this.ctx.currentTime + dur);
      }
      gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      osc.connect(gainNode);
      gainNode.connect(this.out);
      osc.start();
      osc.stop(this.ctx.currentTime + dur);
    } catch {}
  }

  // 1. Hit sound
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }
  /** DualTargetFlow's name for the same cue. */
  playPulseHit() { this.playHit(); }

  // 2. Countdown tick sound
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }

  // GO — a struck wooden bar. Warm rather than urgent: this is the last beat
  // of 3-2-1, so it has to feel bigger than the 440Hz ticks without turning
  // the start of a focus drill into an alarm.
  //
  // Earlier versions chased impact and got harshness instead — a bright A5
  // mallet, a four-note arpeggio over a sub drop, a chord with a glide into
  // it. Next to the ticks they all read as ARCADE.
  //
  // What works is a marimba tap. A 12ms noise burst bandpassed at 900Hz is
  // the beater contacting wood — low and short enough that it never reads as
  // a drum, but without it the tone has no onset and nothing feels struck.
  // Behind it, three voices 5ms later: C5 as the bar, its octave for a little
  // air, C4 underneath for warmth. Each is a pair of sines detuned four cents
  // apart through a lowpass — the same construction as chimeVoice — which is
  // why nothing here buzzes. C is a minor third above the 440Hz ticks, so it
  // resolves upward and lands clearly without shouting. Decays over ~350ms.
  //
  // Scheduled on the AudioContext clock, not with setTimeout: the main thread
  // is setting the round up at exactly this instant.
  playGo() {
    if (!this.enabled || !this.ctx) return;
    try {
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime;

      // The beater. Linearly-decaying white noise through a bandpass — a
      // wooden knock, not a snare.
      const nLen = Math.max(1, Math.floor(ctx.sampleRate * 0.012));
      const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
      const nData = nBuf.getChannelData(0);
      for (let i = 0; i < nLen; i++) {
        nData[i] = (Math.random() * 2 - 1) * (1 - i / nLen);
      }
      const nSrc = ctx.createBufferSource();
      nSrc.buffer = nBuf;
      const nBand = ctx.createBiquadFilter();
      nBand.type = 'bandpass';
      nBand.frequency.setValueAtTime(900, t0);
      nBand.Q.setValueAtTime(1.6, t0);
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.042, t0);
      nGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.012);
      nSrc.connect(nBand);
      nBand.connect(nGain);
      nGain.connect(this.out);
      nSrc.start(t0);
      nSrc.stop(t0 + 0.012);

      // The bar. 5ms behind the knock so the two read as one event.
      [
        // freq    at     dur   vol    cut   attack
        [523.25,  0.005, 0.35, 0.120, 2000, 0.008], // body — C5
        [1046.50, 0.005, 0.13, 0.034, 3200, 0.008], // octave — air
        [261.63,  0.005, 0.30, 0.040, 1200, 0.012]  // foundation — C4
      ].forEach(([freq, at, dur, vol, cut, attack]) => {
        const startAt = t0 + at;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cut, startAt);
        filter.Q.setValueAtTime(0.5, startAt);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.linearRampToValueAtTime(vol, startAt + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
        filter.connect(gain);
        gain.connect(this.out);
        [-4, 4].forEach((cents) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, startAt);
          osc.detune.setValueAtTime(cents, startAt);
          osc.connect(filter);
          osc.start(startAt);
          osc.stop(startAt + dur);
        });
      });
    } catch {}
  }

  // 4. Penalty / Miss sound
  //
  // Two descending sines, originally 220Hz then 165Hz. That is a descending
  // perfect fourth, and it is the right gesture — falling, soft, clearly "not
  // that one" without being a buzzer. The problem was only the register: a
  // phone driver radiates almost nothing down there, so the note never left
  // the handset and the mistake registered as a buzz in the hand rather than
  // a sound. The hit (880Hz) had no such trouble, which is why one projected
  // and the other did not.
  //
  // Both notes are moved up by a fifth and an octave — 220 -> 587 (D5),
  // 165 -> 440 (A4). The RATIO between them is untouched (587/440 = 1.334,
  // 220/165 = 1.333), so the interval, the falling direction, the sine timbre,
  // the envelope and the timing are all unchanged. Same sound, played where
  // the speaker can reach it. If it ever needs to move again, scale BOTH notes
  // by the same factor or the interval breaks and it stops sounding like
  // itself.
  //
  // It also got QUIETER: 0.12 -> 0.075. Measured through the projection bus,
  // the old penalty peaked at 0.30 against the hit's 0.13 — the sound for
  // getting something WRONG was more than twice as loud as the sound for
  // getting it right, which is backwards, and loudness is what drives case
  // vibration. Together the two changes cut its sub-300Hz energy (the band
  // that shakes a handset rather than leaving it) by about 62%.
  //
  // Still plainly distinct from the hit: two notes vs one, falling vs rising,
  // duller vs brighter.
  playPenalty() {
    // The felt half of the cue, deliberately BEFORE the sound guard below:
    // a player who has muted the game still wants to know they got it wrong,
    // and silent play is exactly when the tap matters most. It has its own
    // setting (Progress -> Vibration) for anyone who wants neither.
    //
    // This lives here rather than in the drills because every drill's wrong
    // answer, miss, timeout and trap tap routes through playPenalty() — it is
    // the one chokepoint that covers all ten without touching any of them.
    missFeedback();

    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const t0 = this.ctx.currentTime;
      [
        { freq: 587.33, delay: 0 },
        { freq: 440, delay: 0.06 }
      ].forEach(({ freq, delay }) => {
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0 + delay);
        gainNode.gain.setValueAtTime(0, t0 + delay);
        gainNode.gain.linearRampToValueAtTime(0.075, t0 + delay + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + delay + 0.08);
        osc.connect(gainNode);
        gainNode.connect(this.out);
        osc.start(t0 + delay);
        osc.stop(t0 + delay + 0.08);
      });
    } catch {}
  }

  playMiss() { this.playPenalty(); }
  playWrong() { this.playPenalty(); }
  playWrongBoom() { this.playPenalty(); }
  playFail() { this.playPenalty(); }
  playWrongOrder() { this.playPenalty(); }
  playTrapTap() { this.playPenalty(); }

  // 5. Heartbeat sound
  playHeartbeat(danger = 0) {
    if (!this.enabled || !this.ctx || danger <= 0) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const vol = 0.04 + danger * 0.10;
      const t0 = this.ctx.currentTime;
      [0, 0.15].forEach((offset) => {
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(65, t0 + offset);
        gainNode.gain.setValueAtTime(vol, t0 + offset);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.15);
        osc.connect(gainNode);
        gainNode.connect(this.out);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.15);
      });
    } catch {}
  }

  chimeVoice(freq, startAt, dur, vol, filterFreq = 2600) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t0 = startAt;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, t0);
    filter.Q.setValueAtTime(0.5, t0);
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    filter.connect(gainNode);
    gainNode.connect(this.out);
    [-4, 4].forEach((cents) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      osc.detune.setValueAtTime(cents, t0);
      osc.connect(filter);
      osc.start(t0);
      osc.stop(t0 + dur);
    });
  }

  // 6. Results reveal sound
  playResultsReveal() {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const t0 = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        this.chimeVoice(freq, t0 + i * 0.08, 0.24, 0.13, 3200);
      });
      this.chimeVoice(1046.50, t0 + 0.26, 0.6, 0.16, 4200);
    } catch {}
  }

  setEnabled(status) {
    this.enabled = status;
  }
}

/**
 * One instance for the whole app. Drills mount and unmount constantly and
 * Android caps how many AudioContexts a WebView may hold open, so a shared
 * context is both cheaper and safer than one per drill.
 */
export const gameAudio = typeof window !== 'undefined' ? new GameAudio() : null;

// KEEP THE CONTEXT AWAKE.
//
// Every sound above follows the same shape: if the context is suspended, call
// resume(), then immediately schedule the note against ctx.currentTime. That
// looks right but loses the sound, because resume() is ASYNCHRONOUS and
// currentTime is FROZEN while suspended. The whole envelope — attack, decay,
// stop — gets scheduled at the stale timestamp, and by the time the context is
// genuinely running, that entire window has already passed. The note is silent,
// or clipped to a click.
//
// It bites exactly where it is most noticeable: Android suspends the context
// whenever the app is backgrounded or the WebView is re-created, which includes
// every rotation into a landscape drill and every return from the recents
// screen. The first sounds after that are simply missing, which is the
// "sometimes the sound effects don't come out properly" report.
//
// Rather than rewrite six schedulers, keep the context from being suspended at
// play time at all: resume it the moment the page becomes visible again, and on
// the first touch after that. Both are cheap, idempotent, and resume() on a
// running context is a no-op.
if (gameAudio) {
  const wake = () => {
    try {
      const ctx = gameAudio.ctx;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch {}
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  // Passive + capture so this never interferes with the game's own handlers.
  window.addEventListener('pointerdown', wake, { passive: true, capture: true });
  window.addEventListener('touchstart', wake, { passive: true, capture: true });
}

export default gameAudio;
