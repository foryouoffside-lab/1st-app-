// lib/shareLinks.js
// SkillDrills — the single place the "where does a shared score send people?"
// decision lives.
//
// This used to be a hardcoded website URL repeated in all 24 drill components,
// each pointing at its own drill page. The product decision is that a shared
// score should get the recipient to INSTALL the app, not to play one drill in a
// browser, so every share now points at the Play Store listing.
//
// KNOWN, ACCEPTED TRADE-OFF: until the listing is actually published, this URL
// 404s for anyone who opens it, and desktop/iPhone recipients land on a store
// page they can't act on. That was a deliberate call — the alternative was a
// redirector page on the website. Because every drill now reads from here,
// switching to one is a one-line change rather than a 24-file edit.

/** Play Store listing for the Android app. */
export const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.skilldrills.pro';

/** Where a shared score card / score message points. */
export const APP_SHARE_URL = PLAY_STORE_URL;
