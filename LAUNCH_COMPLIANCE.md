# Launch Compliance — Global Release Checklist

Everything legal and policy-related that has to be true before SkillDrills goes
to Production on Google Play, for a worldwide audience.

> **This is not legal advice.** It is an engineer's checklist of the obligations
> that apply to an app of this shape. The items marked **LAWYER** below are the
> ones where a real lawyer's half-hour is worth more than any amount of careful
> reading — they involve naming a legal entity, accepting jurisdiction, and
> making claims about what the product does.

---

## 0. Status at a glance

| Item | State |
|---|---|
| Privacy policy (in-app + web) | Done — GDPR/CCPA sections added 2026-08-22 |
| Terms of Service | Done — age, disclaimer, governing law added 2026-08-22 |
| Account deletion — in app | Done (`Progress → Delete Account & Wipe Data`) |
| Account deletion — public URL | Done — `/delete-account` page added 2026-08-22 |
| Firestore security rules | Published and verified live |
| Data Safety form answers | Drafted in `PLAY_STORE_SUBMISSION.md` §6 |
| Content rating questionnaire | Drafted in `PLAY_STORE_SUBMISSION.md` §4 |
| Placeholders in legal pages | Done 2026-08-22 — Sangmesh, India |
| Store listing claims | Rewritten 2026-08-22 — see §4 |
| **OAuth consent screen branding** | Outstanding (Console only) |
| Privacy policy version drift | Done — resolved 2026-08-23, see §2 |
| Legal URLs reachable | Verified live 2026-09-02 — /privacy, /terms, /delete-account all HTTP 200 |

---

## 1. Operator identity — filled in

The legal pages now name the operator:

- **Data controller:** Sangmesh, based in India (`app/privacy/page.js`)
- **Governing law:** the laws of India; jurisdiction, the courts of India
  (`app/terms/page.js`)

Two refinements worth considering, neither blocking:

- **Full legal name.** "Sangmesh" is what appears publicly. If that is a first
  name only, a full legal name is a stronger controller identification under
  GDPR and India's DPDP Act. Be aware this publishes your real name to the
  world — that is the normal trade-off for a solo developer, and the way to
  avoid it is to register a company and name that instead.
- **A named city.** The clause currently says "the courts of India", which is
  workable but broad. Naming your actual city (e.g. "the courts of Pune,
  Maharashtra, India") is the stronger form. Tell me the city and it is a
  one-line change.

---

## 2. Two different privacy policies existed — RESOLVED 2026-08-23

**Status: done and verified live.** The live site now serves the August 22
policy, with the GDPR, CCPA, controller-identity and transfer sections.

Important structural note for future edits: **the website is a separate
project from this one.** It lives at `Desktop/global-drill-system-nextjs -
Copy` and deploys to Vercel from the `main` branch of the shared GitHub repo.
This folder (the mobile app) had the website's SEO layer stripped out in
commit `082882f` and must **never** be pushed to that branch — doing so would
replace skilldrills.online with the app build.

So a legal-text change has to be made in **both** places: here for the APK,
and in the website folder for the URL that Play links.

The Vercel Analytics and Speed Insights disclosure is website-only and was
deliberately retained there (the site really does run it) while staying out of
the app's copy (the app does not). It is now also reflected in the website's
GDPR legitimate-interests and CCPA sections.

Also added to the website in the same pass: `/delete-account`, which Play
requires to be reachable without installing the app.

---

## 3. Google Play policy requirements

| Requirement | Status | Notes |
|---|---|---|
| Privacy policy URL, publicly reachable, no login | Live | Fix version drift first (§2) |
| Data deletion URL | Ready | Use `https://skilldrills.online/delete-account` |
| In-app account deletion | Done | Play requires both routes; you have both |
| Data Safety form matches reality | Draft | Must declare Crashlytics + Analytics |
| Target audience & content | Draft | Declare **13+**, never "children" |
| Content rating (IARC) | Draft | Answers in `PLAY_STORE_SUBMISSION.md` §4 |
| Ads declaration | None | Correct — no ad SDK present |
| Financial features | None | No IAP, no payments |
| Permissions justified | Yes | Only INTERNET + VIBRATE |
| App access for reviewer | Draft | Google sign-in — reviewer needs instructions |

**On target audience:** the moment you tick any age band under 13, Play's
Families policy applies, which brings COPPA obligations, a mandatory neutral age
screen, restrictions on analytics, and a separate review. Your privacy policy
already says the app is not directed at children — **keep the Play declaration
consistent with that** and select 13+ only. Mismatch between the two is a
common rejection reason.

**On App access:** the reviewer cannot sign in with Google without help. Give
them a working test account, or explain in the App access notes that sign-in is
Google-only and provide credentials for a dedicated review account. Reviews get
rejected over this routinely.

---

## 4. The store listing claims — the real legal risk

This matters more than everything else on this page, because it is the one place
where a regulator has actually fined companies in this exact category.

The current listing copy in `PLAY_STORE_SUBMISSION.md` says:

- "24 **science-based** drills"
- "**Sharpen the mental skills that matter every day** ... staying focused under
  distraction, holding information in working memory, reacting faster, and
  thinking clearly under pressure"

Both are **efficacy claims about real-world cognitive improvement**. In 2016 the
US FTC fined Lumosity $2 million over precisely this kind of marketing — claims
that brain-training games improve performance at school and work, made without
studies that actually supported them. Similar consumer-protection rules apply in
the EU (Unfair Commercial Practices Directive), the UK (CAP Code), and
elsewhere. The exposure is not theoretical and it is not limited to the US.

The safe test: **can you point at a published study of *your* drills showing
that improvement transfers outside the app?** If not, do not claim it.

**Recommended rewrite** — same appeal, no unsupported claim:

> Short description:
> `24 free reaction, memory and focus drills. Train daily, duel players worldwide.`

> Full description opening:
> `SkillDrills is a free training-game app with 24 drills across five categories
> — Attention, Focus, Memory, Problem Solving, and Processing Speed.`
>
> `TRAIN AND COMPETE`
> `Practise the skills each drill measures: holding attention under distraction,
> keeping information in working memory, and reacting quickly under time
> pressure. Every drill adapts its difficulty as you improve, so you are always
> playing at the edge of your ability.`

What changed: "science-based" is gone, and "sharpen the mental skills that
matter every day" — a transfer-to-real-life claim — became "practise the skills
each drill measures", which is simply true and still sells the product.

**Also rename EIQ in the listing.** "EIQ" reads as an IQ measurement. Describe
it as a competitive ranking, never as an intelligence score. The Terms page now
says this explicitly; the listing should not contradict it.

**LAWYER:** if you want to keep "science-based", that is a substantiation
question, and the answer depends on evidence you would need to hold.

---

## 5. Regional obligations for a worldwide release

**EEA / UK (GDPR, UK GDPR).** Covered by the new policy sections: lawful basis,
data subject rights, international transfers, right to complain to a supervisory
authority.

> **LAWYER — GDPR Article 27 representative. This one is now live.** You are
> established in India, i.e. outside the EU, and you intend to offer the app
> to people inside it — which is exactly the trigger condition. You may be
> legally required to
> appoint a representative *inside* the EU (and separately, one in the UK).
> There are exemptions for small-scale, low-risk processing, and an argument
> exists that this app qualifies — but that is a judgement call with a real
> penalty attached if it is wrong. Ask. This is the single most commonly
> ignored GDPR obligation by solo developers.

**California (CCPA/CPRA).** Covered. You do not sell or share data, which
removes the hardest requirements. The "Do Not Sell or Share My Personal
Information" link is not required for you *because* you genuinely do not — keep
it that way, and if that ever changes the obligation appears immediately.

**Children (COPPA / UK Age Appropriate Design Code).** Policy says 13+, Terms
now say 13+ (16 where required). Keep the Play declaration matching.

**India (DPDP Act 2023) — this is your home jurisdiction and applies
directly.** You are a Data Fiduciary under the Act. The current policy covers
the notice obligations well. Two things the Act adds that a GDPR-shaped policy
does not automatically give you: a defined route for a Data Principal to raise
a grievance (your contact email serves, but it should be described as the
grievance channel), and breach notification to the Data Protection Board and
to affected users. Verifiable parental consent is required for under-18s,
which is a stricter age line than the 13+ used elsewhere — your app is not
directed at children, which is the right posture, but keep it that way.

> **LAWYER:** the DPDP Act's rules are still being operationalised. Worth
> asking specifically about the under-18 consent rule, since India's age
> threshold is higher than the 13+ your Play declaration will use.

**Brazil (LGPD), Canada (PIPEDA), Australia (Privacy Act).** The GDPR-shaped
policy you now have covers the substance of these. No separate action for an
app of this size.

---

## 6. Data Safety form — keep it truthful

Play cross-checks this against the app's actual behaviour, and getting it wrong
is a suspension risk, not a warning risk. Declare, at minimum:

- **Personal info → Name, Email address** — collected, linked to the user,
  required, for app functionality and account management.
- **Photos** — profile photo, collected, linked to the user.
- **App activity → In-app actions** — gameplay events via Firebase Analytics.
- **App info & performance → Crash logs, Diagnostics** — via Crashlytics.
- **Data is encrypted in transit** — yes (Firebase/HTTPS).
- **Users can request data deletion** — yes, and give the `/delete-account` URL.
- **Data is not sold or shared with third parties** — correct.

Note that the profile photo is stored as a base64 data URI **inside the user
document**, and user documents are **world-readable** so leaderboards work.
That means display name and profile photo are effectively public to anyone who
can query the database. This is a deliberate design decision and it is fine —
but the privacy policy should not imply those two fields are private. They are
the only fields in that category; email is correctly excluded from the document.

---

## 7. Pre-submission checklist

- [x] Fill the operator identity (§1) — Sangmesh, India
- [x] Redeploy the website so both privacy policies match (§2) — live 2026-08-23
- [x] Rewrite the store listing claims (§4) — done, copy is in the submission doc
- [ ] Set the OAuth consent screen App name (see `PLAY_STORE_SUBMISSION.md` §1)
- [ ] Enter the data deletion URL in Play Console —
      `https://skilldrills.online/delete-account` (live and returning 200 as of
      2026-08-23; Data safety → Data deletion)
- [ ] Create a reviewer test account and document it in App access
- [ ] Complete Data Safety exactly as §6
- [ ] Declare target audience 13+ and nothing younger
- [ ] Confirm `firestore.rules` is still the published version at submission time
- [ ] **LAWYER:** entity/controller identity, governing law, EU + UK
      representative, and any claim you want to keep that §4 flags

---

## 8. What was changed on 2026-08-22

- Added `app/delete-account/page.js` — Play-required public deletion URL.
- Privacy policy: added controller identity, GDPR lawful basis, data subject
  rights, California/CCPA, and international transfer sections.
- Terms: added age requirement, an explicit "not a medical device / EIQ is not
  an IQ score / no real-world improvement promised" section, and governing law.
- Both legal pages re-dated to August 22, 2026.

---

## 9. What was changed on 2026-08-23

The website (`Desktop/global-drill-system-nextjs - Copy`, a **separate project**
— see §2) was brought up to the same standard and deployed. Verified live.

- `app/privacy/page.js` — merged in controller identity, GDPR lawful bases,
  data subject rights, CCPA/CPRA, and international transfers. Kept the
  website-only Vercel Analytics/Speed Insights disclosure and folded it into
  the legitimate-interests and CCPA sections. Added a section stating plainly
  that display name and profile photo are visible to other players, since user
  documents are world-readable for the leaderboard (§6 flagged this).
- `app/terms/page.js` — added the 13+/16+ age requirement, the "not a medical
  device / EIQ is not an IQ score / no real-world improvement promised"
  section, and governing law.
- `app/delete-account/page.js` — new. Play requires this URL to work without
  installing the app, and the website had no such page.
- `app/sitemap.js` — listed `/delete-account`, bumped the legal date.

In this repo (the app), `app/terms/page.js` had gained the new sections on
Aug 22 but `LAST_UPDATED` was left at July 17, which contradicted the page's
own promise that the date changes when the terms change. Corrected to
August 22, 2026.

Still open after this pass: the OAuth consent screen name (Console only), and
the lawyer question below — the EU/UK Article 27 representative is the live
part of it, because the controller is established in India rather than the
EEA/UK.
