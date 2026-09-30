// lib/ads.js
// Flint — full-screen (interstitial) ads, and the ONE place that decides when
// one may appear.
//
// ── Where ads show (and where they never do) ────────────────────────────────
//   • Solo: after the player LEAVES a result screen (Play again / back / Done),
//     before the next screen appears — see ResultActions in
//     components/drill/ResultScreen.js. Never during a drill, never on top of
//     the result itself, and never on "Next drill" mid daily-session.
//   • Arena: after the player leaves the duel result card (Home / Arena /
//     New duel) — see leaveDuelResult in components/DrillWrapper.js. Never
//     before or during a duel, and never on Rematch (a live opponent is
//     waiting on the other end).
//   • No banners anywhere.
//
// ── The remote switch ───────────────────────────────────────────────────────
// Ads ship OFF. They are turned on from the Firebase console → Remote Config
// by setting `ads_enabled` = true — no app update needed. Until then the ad
// SDK is never even initialised (no ad requests, no consent popup). Two
// tuning knobs live beside it:
//   ads_solo_every       — show at most one ad per N solo result exits (default 3)
//   ads_min_gap_seconds  — minimum time between any two ads (default 180)
//
// ── IDs ─────────────────────────────────────────────────────────────────────
// INTERSTITIAL_ID is Flint's real AdMob unit; the App ID lives in
// AndroidManifest.xml. To test on a phone, temporarily set INTERSTITIAL_ID to
// Google's sample unit ca-app-pub-3940256099942544/1033173712 — USING_TEST_IDS
// then flips on by itself. Never tap a real ad on your own phone: AdMob bans
// the whole account (which also carries the owner's other app).

import { Capacitor } from '@capacitor/core';

const INTERSTITIAL_ID = 'ca-app-pub-4598618663370785/7822544413'; // Flint interstitial
const USING_TEST_IDS = INTERSTITIAL_ID.startsWith('ca-app-pub-3940256099942544/');

const DEFAULTS = { enabled: false, soloEvery: 3, minGapMs: 180_000 };
// If a dismiss event is ever lost, never strand the player behind the ad.
const SHOW_TIMEOUT_MS = 90_000;
const LAST_SHOWN_KEY = 'flint_ads_last_shown';

let config = { ...DEFAULTS };
let ready = false;          // an interstitial is loaded and waiting
let loading = false;
let started = false;        // initAds() has run
let active = false;         // SDK initialised + consent allows ads
let soloExitsSinceAd = 0;
let pending = null;         // the in-flight maybeShowAd promise (double-tap guard)
let privacyOptionsRequired = false; // EEA/UK/CH players must be able to revisit consent

// Fired on window when privacyOptionsRequired becomes known (Progress screen
// shows its "Ad privacy choices" row off this).
export const AD_PRIVACY_EVENT = 'flint-ad-privacy';

const isNative = () => Capacitor.isNativePlatform();

function readLastShown() {
  try { return Number(localStorage.getItem(LAST_SHOWN_KEY)) || 0; } catch { return 0; }
}
function writeLastShown(t) {
  try { localStorage.setItem(LAST_SHOWN_KEY, String(t)); } catch { /* ignore */ }
}

async function loadRemoteConfig() {
  const { FirebaseRemoteConfig } = await import('@capacitor-firebase/remote-config');
  await FirebaseRemoteConfig.setSettings({ minimumFetchIntervalInSeconds: 3600, fetchTimeoutInSeconds: 10 });
  await FirebaseRemoteConfig.fetchAndActivate();
  const [on, every, gap] = await Promise.all([
    FirebaseRemoteConfig.getBoolean({ key: 'ads_enabled' }),
    FirebaseRemoteConfig.getNumber({ key: 'ads_solo_every' }),
    FirebaseRemoteConfig.getNumber({ key: 'ads_min_gap_seconds' }),
  ]);
  config = {
    enabled: on?.value === true,
    soloEvery: every?.value > 0 ? Math.round(every.value) : DEFAULTS.soloEvery,
    minGapMs: gap?.value > 0 ? gap.value * 1000 : DEFAULTS.minGapMs,
  };
}

async function preload() {
  if (!active || ready || loading) return;
  loading = true;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.prepareInterstitial({ adId: INTERSTITIAL_ID, isTesting: USING_TEST_IDS });
    ready = true;
  } catch {
    ready = false; // no fill / offline — try again on the next exit
  } finally {
    loading = false;
  }
}

// Called once at app start (AppShellClient). Safe to call more than once.
export async function initAds() {
  if (!isNative() || started) return;
  started = true;
  try {
    await loadRemoteConfig();
  } catch {
    return; // offline or config unreachable → stay ad-free this session
  }
  if (!config.enabled) return;
  try {
    const { AdMob, AdmobConsentStatus } = await import('@capacitor-community/admob');
    // Google's consent form (UMP). Only appears where the law requires it
    // (EEA/UK/Switzerland) — elsewhere this resolves silently.
    let consent = await AdMob.requestConsentInfo();
    if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
      consent = await AdMob.showConsentForm();
    }
    privacyOptionsRequired = consent.privacyOptionsRequirementStatus === 'REQUIRED';
    if (privacyOptionsRequired) window.dispatchEvent(new Event(AD_PRIVACY_EVENT));
    if (!consent.canRequestAds) return;
    await AdMob.initialize({ initializeForTesting: USING_TEST_IDS });
    active = true;
    preload();
  } catch {
    active = false;
  }
}

// Resolves once it is safe to carry on (ad dismissed, or no ad due). Never
// rejects, never blocks when no ad is already loaded.
// kind: 'solo' (counts toward ads_solo_every) | 'duel' (gap rule only).
export function maybeShowAd(kind = 'solo') {
  if (pending) return pending;
  if (!isNative() || !active) return Promise.resolve();

  if (kind === 'solo') soloExitsSinceAd += 1;
  const dueByCount = kind === 'duel' || soloExitsSinceAd >= config.soloEvery;
  const dueByGap = Date.now() - readLastShown() >= config.minGapMs;
  if (!dueByCount || !dueByGap || !ready) {
    preload();
    return Promise.resolve();
  }

  pending = (async () => {
    const { AdMob, InterstitialAdPluginEvents } = await import('@capacitor-community/admob');
    const handles = [];
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, SHOW_TIMEOUT_MS);
        const done = () => { clearTimeout(timer); resolve(); };
        Promise.all([
          AdMob.addListener(InterstitialAdPluginEvents.Dismissed, done),
          AdMob.addListener(InterstitialAdPluginEvents.FailedToShow, done),
        ]).then((h) => {
          handles.push(...h);
          return AdMob.showInterstitial();
        }).then(() => {
          ready = false;
          soloExitsSinceAd = 0;
          writeLastShown(Date.now());
        }).catch(done);
      });
    } catch { /* never block navigation on an ad */ }
    handles.forEach((h) => h.remove().catch(() => {}));
    ready = false;
    pending = null;
    preload();
  })();
  return pending;
}

// Google's consent policy: where consent was asked (EEA/UK/Switzerland) the
// player must be able to change their answer later — the "revocation link".
// The Progress screen shows the entry point only when this is true.
export function isAdPrivacyOptionsRequired() {
  return privacyOptionsRequired;
}

export async function openAdPrivacyOptions() {
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.showPrivacyOptionsForm();
  } catch { /* form unavailable — nothing to show */ }
}
