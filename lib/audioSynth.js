export class AudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx && typeof window !== 'undefined') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
    if (!this.enabled || !this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      if (sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(sweepTo, this.ctx.currentTime + dur);
      }
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + dur);
    } catch {}
  }

  playHit() {
    this.tone(880, 0.12, 'sine', 0.16, 1760);
  }

  playCountdownTick() {
    this.tone(440, 0.09, 'sine', 0.12, 440);
  }

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
      nGain.connect(ctx.destination);
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
        gain.connect(ctx.destination);
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

  // Short descending two-note chime instead of a harsh sawtooth buzz — same
  // fix already proven for CardMatchingClient.js's playBuzz().
  playPenalty() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      [
        { freq: 392.0, offset: 0, dur: 0.1 },
        { freq: 293.66, offset: 0.08, dur: 0.16 },
      ].forEach(({ freq, offset, dur }) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0 + offset);
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.linearRampToValueAtTime(0.16, t0 + offset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + dur);
      });
    } catch {}
  }

  playWrongBoom() {
    if (!this.enabled || !this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(140, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(35, this.ctx.currentTime + 0.28);
      gain.gain.setValueAtTime(0.28, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.3);
    } catch {}
  }

  // Soft two-note rising chime (D5 → A5) with gentle attack ramps. Replaces
  // the old hard 4-step arpeggio, which read as a harsh "buzz" on every combo.
  playComboTier() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      [
        { freq: 587.33, offset: 0, dur: 0.14 },
        { freq: 880.0, offset: 0.09, dur: 0.2 },
      ].forEach(({ freq, offset, dur }) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0 + offset);
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.linearRampToValueAtTime(0.08, t0 + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + dur);
      });
    } catch {}
  }

  playLevelUp() {
    this.tone(660, 0.1, 'triangle', 0.14, 990);
    setTimeout(() => this.tone(990, 0.14, 'triangle', 0.14, 1320), 90);
  }

  playGameOver() {
    this.tone(400, 0.5, 'sawtooth', 0.16, 80);
  }

  playHeartbeat(danger = 0) {
    if (!this.enabled || !this.ctx || danger <= 0) return;
    try {
      const vol = 0.05 + danger * 0.12;
      const t0 = this.ctx.currentTime;
      [0, 0.14].forEach((offset) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(70, t0 + offset);
        gain.gain.setValueAtTime(vol, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.12);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.12);
      });
    } catch {}
  }

  playSync() {
    this.tone(523.25, 0.1, 'sine', 0.12, 1046.5);
    setTimeout(() => this.tone(783.99, 0.15, 'sine', 0.12, 1567.98), 80);
  }

  setEnabled(status) {
    this.enabled = status;
  }
}
