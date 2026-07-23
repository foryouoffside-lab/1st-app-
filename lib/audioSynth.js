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
    } catch (e) {}
  }

  playHit() {
    this.tone(880, 0.12, 'sine', 0.16, 1760);
  }

  playCountdownTick() {
    this.tone(440, 0.09, 'sine', 0.12, 440);
  }

  playGo() {
    this.tone(660, 0.16, 'triangle', 0.16, 990);
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
    } catch (e) {}
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
    } catch (e) {}
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
    } catch (e) {}
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
    } catch (e) {}
  }

  playSync() {
    this.tone(523.25, 0.1, 'sine', 0.12, 1046.5);
    setTimeout(() => this.tone(783.99, 0.15, 'sine', 0.12, 1567.98), 80);
  }

  setEnabled(status) {
    this.enabled = status;
  }
}
