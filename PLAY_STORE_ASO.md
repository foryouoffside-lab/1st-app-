# Ranking on Google Play — What Actually Moves the Needle

How Play ranking works for an app in your position, what to do about it, and
what not to waste money on.

---

## 0. The honest starting position

Play ranking is **mostly a retention and quality machine, not a keyword
machine.** Google's ranking signals, in rough order of weight:

1. **Retention** — D1, D7, D30. The single biggest factor.
2. **Install velocity** relative to your category, and conversion rate from
   store-listing view to install.
3. **Uninstall rate** — a fast uninstall is a strong negative signal.
4. **Ratings and review volume**, and how recent they are.
5. **Android vitals** — crash rate and ANR rate. Bad vitals get you actively
   demoted and can remove you from recommendations entirely.
6. **Keyword relevance** — title, short description, long description.
7. **Update frequency** — a maintained app outranks an abandoned one.

Note where keywords sit: **sixth**. Most "ASO advice" online is about keywords
because keywords are the part you can change in five minutes. It is not where
the leverage is.

**Set expectations honestly:** you will not rank for "brain training" or "brain
games". Those are owned by Lumosity, Elevate, Peak, and CogniFit, who have tens
of millions of installs and full-time marketing teams. Competing there head-on
is not a strategy. Everything below is about winning the long tail and building
the retention signal that eventually earns broader ranking.

---

## 1. Before ranking matters at all — Android vitals

This comes first because it can silently cap everything else.

Play sets **bad behaviour thresholds**: roughly 1.09% user-perceived crash rate
and 0.47% ANR rate. Cross them and Play reduces your visibility, warns you in
Console, and can exclude you from recommendation surfaces. It does this quietly.

You already ship Crashlytics, so you will see problems. What matters:

- Watch **Android vitals** in Play Console from the first day of closed testing.
- Your drills are canvas + `requestAnimationFrame` heavy. ANRs on low-end
  devices are the realistic risk, not crashes.
- The rotation and render work already done helps here directly. Frame drops
  and jank are measured.

**A technically smooth app is an ASO strategy.** This is the least glamorous and
highest-value item on this page.

---

## 2. The listing — where keywords actually count

**Title (30 characters).** Highest keyword weight of anything.

Current: `SkillDrills Pro` — 15 characters, and half of them are "Pro", which no
one searches for. That is 15 wasted characters of your strongest ranking field.

Better: `SkillDrills: Focus & Reaction` (29 chars) or
`SkillDrills: Reaction Training` (30 chars).

Keep the brand first so the name still reads as a brand, and spend the rest on
words people actually type. Avoid "brain training" in the title given the claims
issue in `LAUNCH_COMPLIANCE.md` §4 — "reaction", "focus", "memory", and
"training" are descriptive of what the app *is* and carry no efficacy promise.

**Short description (80 characters).** Second-highest weight, and it is the line
that converts — it is what people read before deciding to expand. Make it a
reason to install, not a keyword dump.

**Long description (4000 characters).** Lower weight, but it is indexed. Use the
words naturally, repeat the important ones two or three times, and never stuff.
Play penalises keyword stuffing and it reads badly to humans, who are the ones
deciding whether to install.

**Do not**: put keywords in the developer name, repeat the title inside the
short description, or use competitor brand names. All are policy violations.

---

## 3. Localisation — your single biggest global lever

You said the app is for a worldwide audience. This is how you actually get that,
and it is cheap.

Play ranks you **separately in every country and language**. An app localised
into 10 languages competes in 10 much less crowded markets instead of fighting
for one English-language slot against Lumosity.

**You do not have to translate the app to do this.** Translating only the
**store listing** already gets you indexed and ranked in that language. The app
itself can stay in English while you test which markets respond.

Priority order for a reaction/training game:
1. Portuguese (Brazil) — huge Android base, high game engagement, weak
   competition in this niche
2. Spanish (Spain + Latin America — they are separate listings)
3. Indonesian — enormous and under-served Android market
4. Hindi
5. Russian
6. German, French, Japanese, Korean, Turkish

Do these as **custom store listings** in Play Console. Then check
**Store performance → conversion by country** after a few weeks and translate
the *app* only for the markets that actually converted.

One caution: machine-translated listings that read badly convert worse than
English. For 80 characters of short description it is worth paying a human or
checking with a native speaker.

---

## 4. Ratings and reviews

Ratings are a ranking factor *and* the biggest conversion factor on the listing
page. The difference between 4.2 and 4.6 stars is enormous for install rate.

- **Use the In-App Review API** (`com.google.android.play:review`). Do not send
  people to the Play page manually — Google explicitly prefers the in-app flow
  and it converts far better. **You do not currently ship this**; it is worth
  adding.
- **Ask at the right moment.** After a personal best, a completed daily streak,
  or a duel win — never on launch, never mid-drill. A prompt during a failure
  earns a one-star.
- **Never incentivise reviews.** Offering rewards for ratings is a policy
  violation and a suspension risk.
- **Reply to every review** for the first few months. Reply rate is visible to
  users, it lifts your rating over time as people revise scores, and Google has
  said it factors into quality signals.

---

## 5. Retention — the actual ranking engine

Your app has one structural advantage and one structural risk.

**Advantage:** daily challenges and streaks are exactly the right retention
mechanic. A streak that resets creates a genuine reason to return daily, and D7
retention is the signal Play weights most.

**Risk:** 30–45 second drills mean very short sessions. Short session length is
not itself penalised — but it makes the *habit* fragile. One missed day breaks a
streak, and a broken streak is a common quit trigger.

Concrete things that help, in order of value per unit of work:

1. **Local notifications for the daily challenge.** You already ship
   `@capacitor/local-notifications` and `lib/dailyReminder.js`. A single
   well-timed daily reminder is the highest-ROI retention feature available to
   you. Make sure it is actually scheduled and respects the user's timezone.
2. **Streak insurance** — one free "skip" per week, or a grace period. Losing a
   40-day streak to one busy day makes people delete the app. This converts your
   biggest retention risk into a retention feature.
3. **Onboarding to first score fast.** Time-to-first-drill is a strong D1 signal.
   Your "Start now" first-daily flow already does this.
4. **Arena matchmaking must not feel empty.** A duel that never finds an opponent
   is a quit moment. Consider what a new player in a small player base actually
   experiences at 3am in their timezone.

---

## 6. The closed-testing period is not dead time

You need 12 testers for 14 days before Production. Use it:

- Watch Android vitals and fix what appears (§1).
- Watch D1/D7 retention in Console — if D1 is poor, fix that **before**
  Production. Launching into bad retention wastes your one launch window.
- Get those testers to leave honest reviews once you are live. Your first 20
  ratings disproportionately shape your rating for months.

---

## 7. Store listing experiments

Once you have steady traffic, Play Console's **Store listing experiments** let
you A/B test icon, screenshots, short description, and feature graphic against
real traffic with statistical significance built in.

The **icon** and the **first two screenshots** drive conversion more than any
text. Test those first. Do not run experiments before you have enough traffic
for significance — you will read noise as signal.

---

## 8. What not to bother with

- **Buying installs.** Detectable, gets you suspended, and bought installs have
  zero retention, which actively damages the signal that matters most.
- **Review farms.** Same, plus a permanent-ban risk.
- **Keyword stuffing.** Penalised, and hurts conversion.
- **Backlink/SEO services sold as "ASO".** Play ranking is not web SEO. Website
  backlinks do essentially nothing for Play rank.
- **Launching in every language at once with machine translation.** Bad listings
  convert badly and you will not know which market actually had potential.

---

## 9. Realistic sequence

1. Fix `LAUNCH_COMPLIANCE.md` blockers, ship to closed testing.
2. Fix vitals and D1 retention during the 14 days.
3. Rewrite the title to use all 30 characters (§2).
4. Launch to Production in English.
5. Add In-App Review API, and the notification/streak-insurance retention work.
6. Add 3–5 localised listings, measure, then expand into what converts.
7. Start listing experiments once traffic supports significance.

Ranking follows retention. Everything else is a multiplier on a number that has
to be good first.
