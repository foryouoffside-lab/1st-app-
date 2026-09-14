# SkillDrills — sound effect generation brief (ElevenLabs)

Seven sounds cover the whole game. Generate each one, then drop the files into
`public/sfx/` using the exact filenames below.

---

## Read this first — it decides whether they sound good on a phone

The current synthesized sounds fail for one measurable reason: their energy sits
where a phone speaker cannot radiate. A handset driver is about 11mm across and
produces almost nothing below **400Hz**. Anything you put down there is not heard,
it is *felt* as chassis buzz — which is why the old set sounded like it was coming
from inside the phone rather than out of it.

So every prompt below must produce a sound that:

- **Has its weight between 800Hz and 6kHz.** That is the band a phone actually throws.
- **Starts with a transient.** A hard onset in the 2–6kHz range is what makes the
  ear place a sound outside the handset. No slow fade-ins.
- **Has no sub-bass.** No 808s, no deep booms, no rumble. They will be inaudible
  on a phone and will just eat headroom.
- **Is dry.** No reverb tails, no big room. These fire up to several times per
  second — tails smear into mud.
- **Is short.** Times below are maximums, not targets.

### Export settings

| Setting | Value |
|---|---|
| Format | WAV, 48kHz, 16-bit (I will convert) |
| Channels | Mono |
| Peak level | around −6 dBFS — leave headroom, do not maximise |
| Trim | zero silence at the head; the sound must start on sample 1 |

Mono is deliberate: the app's audio bus already adds stereo width and a limiter.
A pre-widened stereo file will fight it.

### ElevenLabs settings

- Use **Sound Effects**, not Text-to-Speech.
- Set **Duration** explicitly to the value in each section. Left on auto it pads
  with silence and tails.
- **Prompt influence: high (~0.7–0.9).** These are precise functional sounds, not
  creative interpretations.
- Generate **4 variations of each** and keep the tightest one. The first result is
  rarely the shortest.

---

## 1. Correct tap — `hit.wav`

**Duration: 0.12s**

> A short, bright, dry UI confirmation tick. A single crisp attack with a clean
> high-frequency snap, like a fingernail flicking a small glass rod. Pitched around
> 1kHz with airy 3–4kHz sparkle on the onset. Instant decay, no tail, no reverb,
> no bass. Clean and precise, not musical.

Fires up to several times per second. If it has any tail at all it will turn into
a wash during fast play. Err shorter than you think.

**Avoid:** bell tones, coins, video-game "ding", anything with sustain.

---

## 2. Countdown tick — `tick.wav`

**Duration: 0.10s**

> A tight mechanical clock tick. Dry wooden click with a sharp 2–3kHz transient
> and almost no pitch. Like a metronome or a relay switch. Extremely short, hard
> onset, dead stop. No ring, no reverb, no low end.

Plays three times, one per second, for "3 · 2 · 1". It must read as *counting*,
which means neutral and repetitive — it is the GO that pays it off, not this.

**Avoid:** beeps, tones, anything melodic. A pitched tick makes three of them
sound like a tune.

---

## 3. GO — `go.wav`

**Duration: 0.45s**

> A single struck wooden marimba bar, warm and confident. A brief woody beater
> knock on the attack, then a clear pitched body around C5 with a soft octave
> shimmer above it. Decays naturally over a third of a second. Dry and close-miked.
> Encouraging, not an alarm.

This is the last beat of the countdown and the moment the drill starts. It has to
feel *bigger* than the ticks without becoming aggressive — this is a focus app, not
an arcade cabinet.

**Avoid:** buzzers, air horns, risers, whooshes, anything with a build-up. The
sound is the downbeat, not the approach to it.

---

## 4. Wrong tap / miss — `wrong.wav`

**Duration: 0.30s**

> Two soft descending chime notes, gentle and clean. A light muted mallet tone
> falling about a third, around 470Hz then 350Hz. Slightly dull and rounded, with a
> small soft tick on the first note. Warm, unhurried, clearly negative but never
> harsh. Dry, no reverb.

**This one is a design constraint, not taste.** In solo play a mistake costs no
score — only time. The sound must read as *"not that one"*, never as punishment.
A harsh buzzer here makes the whole app feel like it is scolding the player.

**Avoid:** buzzers, error klaxons, distortion, low booms, anything aggressive or
comedic. No "wah wah".

---

## 5. Low on time — `heartbeat.wav`

**Duration: 0.30s**

> A soft double thump, like a muffled heartbeat through fabric. Two quick pulses
> about 140ms apart, rounded and dark but with enough midrange body to be audible
> on a small speaker. Centred around 220Hz with a soft knock on each attack. Tense
> and organic, low volume, no reverb.

Loops while the clock is nearly out, getting louder as time runs down. It must
build pressure without becoming annoying on the twentieth repeat.

**Avoid:** anything below 200Hz — it will be inaudible on a phone and will only
vibrate the case. This was the single worst offender in the old set.

---

## 6. Results reveal — `results.wav`

**Duration: 1.0s**

> A clean ascending three-note chime resolving onto a bright sustained top note.
> Warm glassy bell tones, gently struck, rising in pitch. Clear and satisfying,
> slightly reverberant but tight. Hopeful and neutral — a summary, not a victory.

Plays at the end of **every** run, good or bad. That is why it must stay neutral:
a triumphant fanfare after a poor run reads as sarcasm.

**Avoid:** orchestral stings, applause, fanfares, anything that sounds like winning.

---

## 7. New best / level up — `fanfare.wav`

**Duration: 1.4s**

> A bright four-note ascending arpeggio on warm glass bells, resolving up an octave
> and ringing out. Clean, crystalline, celebratory but elegant. Light shimmer on the
> final note. Tight reverb, no orchestration.

The **only** genuinely celebratory sound in the game. It fires on a personal best
or a level-up, so it is allowed to feel like a reward — but it should sound like the
same instrument family as `results.wav`, one step up in brightness and length.

**Avoid:** brass fanfares, crowd noise, coin showers, slot-machine payouts.

---

## Keeping them a set

The seven must sound like one instrument family, not seven downloads. Practical way
to get that:

1. Generate `go.wav` first and keep the best one.
2. Judge every other sound against it. If a candidate sounds like it came from a
   different product, regenerate rather than settle.
3. `hit` / `tick` are the percussive family; `wrong` / `results` / `fanfare` are the
   tuned family; `heartbeat` stands alone.

Easiest failure to avoid: generating each prompt in isolation and ending up with a
wooden GO, a glassy hit, and a synthetic tick.

---

## When the files are ready

Put them in `public/sfx/` with exactly these names:

```
hit.wav  tick.wav  go.wav  wrong.wav  heartbeat.wav  results.wav  fanfare.wav
```

Then tell me and I will do the code side:

- A sample player to replace the oscillators in `lib/gameAudio.js`, decoded once at
  startup and fired from a pooled buffer source so tapping stays zero-latency.
- The existing master bus (highpass, presence shelf, stereo widener, limiter) stays
  — it is what makes anything sound like it is coming out of the speaker rather than
  the middle of the phone, and it applies to samples just as well as to oscillators.
- A fallback to the current synth if a file fails to decode, so a bad export can
  never leave a drill silent.
- The mute toggle and every existing call site (`playHit()`, `playGo()`, …) keep
  working unchanged — only the sound source swaps.

Note on size: seven WAVs at these lengths is roughly 300–500KB. The app currently
ships at about 4.6MB, so this is a real but acceptable increase. I will convert them
to compressed audio during the build if you would rather not carry it.
