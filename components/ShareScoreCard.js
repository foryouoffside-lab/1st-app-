'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { drawShareCard, CARD_W, CARD_H } from './shareCardRenderer';

/**
 * Generate a shareable score card image and share it via Web Share API.
 *
 * Canvas setup and native plumbing only — the drawing lives in
 * components/shareCardRenderer.js, which is pure so the card can be rendered
 * and reviewed outside the app instead of via a full rebuild per tweak.
 *
 * Drills should use the useShareCard() hook at the bottom of this file rather
 * than calling this directly — it does the same work off the tap path.
 */
export default function generateShareCard(card) {
  return renderCard(card, pickScale());
}

/**
 * Draw one card at a fixed supersample scale.
 *
 * Split out from generateShareCard so the share path can retry at a smaller
 * scale when the big one fails, instead of silently degrading to a bare link
 * (see encodeCard).
 */
function renderCard(card, scale) {
  const {
    score, bestScore, accuracy, bestCombo, rating, newBest,
    visualHits = undefined, numberHits = undefined, drillName, playerName,
  } = card;
  const isNewBest = newBest && score >= bestScore && bestScore > 0;

  const t0 = now();
  // willReadFrequently keeps the canvas CPU-backed. Without it the canvas is
  // GPU-backed and every draw is deferred, so the entire render is rasterised
  // and read back during the export call — turning "encode" into the most
  // expensive step in the share path on a mobile GPU.
  //
  // It has to be requested on the FIRST getContext call for this canvas: a
  // second call with different attributes silently returns the context that
  // already exists and throws the new attributes away.
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W * scale;
  canvas.height = CARD_H * scale;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!ctx) throw new Error(`Score card canvas refused at ${scale}x`);
  const tAlloc = now();
  ctx.scale(scale, scale);

  // getPlayerName() returns 'You' when signed out; the card would rather show
  // no handle at all than sign someone else's screenshot "You".
  const handle = playerName && playerName !== 'You' ? playerName : null;

  drawShareCard(ctx, {
    score, bestScore, accuracy, bestCombo, rating: normalizeRating(rating), isNewBest,
    drillName, playerName: handle, visualHits, numberHits,
    fonts: resolveFonts(),
  });
  perf(`canvas alloc ${scale}x`, t0, tAlloc);
  perf('draw', tAlloc, now());

  return canvas;
}

/**
 * Accept either shape of grade.
 *
 * The card wants `{ letter, label, emoji }`, but what every drill actually has
 * on hand is a tier straight out of scoringEngine's getGrade(), whose letter
 * lives on `.grade`. All 24 call sites used to spell out the conversion
 * inline; taking the tier as-is means a drill can pass getGrade(accuracy)
 * straight through and there is one fewer thing to get wrong per drill.
 */
function normalizeRating(rating) {
  if (!rating) return rating;
  if (rating.letter) return rating;
  if (rating.grade) {
    return { letter: rating.grade, label: rating.label, emoji: rating.emoji };
  }
  return rating;
}

/**
 * Largest scale this device will actually hand out, probed once.
 *
 * The probe writes two red pixels and reads one back: a canvas the WebView has
 * refused to allocate silently accepts draw calls and returns transparent
 * black, so "getContext returned something" is not proof it works. Cached
 * because the answer is a property of the device, and re-probing on every
 * share meant an extra allocate + getImageData on the tap path.
 */
let scaleProbe = 0;
function pickScale() {
  if (scaleProbe) return scaleProbe;
  for (const scale of CARD_SCALES) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = CARD_W * scale;
      canvas.height = CARD_H * scale;
      const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
      if (!ctx) continue;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 2, 2);
      const probe = ctx.getImageData(0, 0, 1, 1).data;
      if (probe[0] === 255 && probe[3] === 255) {
        scaleProbe = scale;
        return scale;
      }
    } catch {
      // Allocation refused at this size — try the next one down.
    }
  }
  scaleProbe = CARD_SCALES[CARD_SCALES.length - 1];
  return scaleProbe;
}

/**
 * Share-path timing, read back on-device with:
 *   adb logcat -s Capacitor/Console | grep share-perf
 *
 * Left in permanently and cheap (a handful of performance.now() reads): every
 * previous attempt to make this path fast was guesswork that measured wrong —
 * resolution and shadowBlur both looked like the culprit and neither moved the
 * device number. The numbers are the only thing that has ever settled it.
 *
 * console.WARN, not console.log, and that is load-bearing. next.config.mjs
 * sets `compiler.removeConsole` with `exclude: ['error', 'warn']` for
 * production builds, so console.log is stripped out of the bundle entirely —
 * this instrumentation produced nothing at all in an installed APK, which is
 * the only build that matters here. Verified on-device: the string
 * "share-perf" was absent from the shipped chunk.
 */
const SHARE_PERF_LOG = true;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function perf(label, from, to) {
  if (!SHARE_PERF_LOG) return;
  try {
    console.warn(`share-perf ${label}: ${Math.round(to - from)}ms`);
  } catch {}
}

/** A point in the share path, for ordering the timings above. */
function mark(label) {
  if (!SHARE_PERF_LOG) return;
  try {
    console.warn(`share-perf @${label}`);
  } catch {}
}

/**
 * Why a share did not produce a card.
 *
 * This used to be swallowed: every failure anywhere in the chain landed in one
 * bare `catch {}` that copied the link and moved on, so a drill whose card was
 * failing was indistinguishable from one where the user had simply dismissed
 * the sheet — the reported symptom was "this drill only copies a link", with
 * nothing on the device to say why. Read it back with:
 *   adb logcat -s Capacitor/Console | grep share-fail
 */
function shareFail(stage, e) {
  try {
    console.warn(`share-fail ${stage}: ${e?.message || e}`);
  } catch {}
}

/**
 * Did the user dismiss the share sheet, rather than something breaking?
 *
 * Capacitor's Share plugin rejects on cancel and the Web Share API throws
 * AbortError, and both used to be treated as failures — so backing out of the
 * sheet popped a "Link copied!" alert and put the store URL on the clipboard,
 * which is exactly what "the button only copies a link" looks like from the
 * outside. A cancel is a completed share as far as this module is concerned.
 */
function isShareCancel(e) {
  if (!e) return false;
  if (e.name === 'AbortError') return true;
  return /cancel|abort|dismiss/i.test(e.message || '');
}

/**
 * The app's real typefaces, for the canvas.
 *
 * app/layout.js loads Inter and Anton through next/font, which mangles
 * the family names at build time and exposes the real ones through these CSS
 * variables — so they have to be read at runtime rather than hardcoded. The
 * whole UI is already rendered in them by the time any result screen exists,
 * so they're loaded; `document.fonts.check` guards the edge case, because an
 * unloaded family silently falls back to a serif in canvas and would look
 * worse than the honest system stack.
 */
function resolveFonts() {
  const FALLBACK = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  try {
    const css = getComputedStyle(document.documentElement);
    const pick = (varName) => {
      const family = css.getPropertyValue(varName).trim();
      if (!family) return null;
      const stack = `${family}, ${FALLBACK}`;
      return document.fonts?.check?.(`bold 32px ${family}`) ? stack : null;
    };
    const ui = pick('--font-inter') || FALLBACK;
    return { ui, display: pick('--font-anton') || ui };
  } catch {
    return { ui: FALLBACK, display: FALLBACK };
  }
}

/**
 * Supersampling for the exported card, largest first. 3x is 1920x1080.
 *
 * This number is a LATENCY dial, not a quality dial — treat raising it as a
 * regression. Measured on-device (Realme RMX3630), tap-to-share-sheet:
 *
 *   12x  7680x4320  33.2M px  ~34MB base64  many seconds, UI frozen, taps lost
 *    6x  3840x2160   8.3M px   ~8MB base64  ~5s ("not instant" — reported)
 *    3x  1920x1080   2.1M px   ~2MB base64  sub-second
 *
 * Almost all of that time is encoding the canvas; the rest of the chain is
 * cheap (Filesystem.writeFile measured at 474ms, and Share.share opened 180ms
 * after it). Encode cost scales with pixel count, so pixels are the only lever
 * that matters.
 *
 * 1920x1080 costs nothing visually: WhatsApp and Instagram re-compress shared
 * images to roughly 1600px, so anything above this is thrown away before the
 * recipient ever sees it, and it is still full-HD for anyone who saves the
 * file. What makes the card look premium is the typography (Anton /
 * Inter, see resolveFonts) and the layout — not the pixel count.
 */
const CARD_SCALES = [3, 2];

// JPEG, not PNG. PNG-encoding this canvas measured 5.5s on a mid-range Android
// device (13s when the device was still busy from the drill) while every other
// step in the share path totalled ~370ms — PNG's zlib pass is simply the wrong
// tool for a full-screen gradient. JPEG is dramatically cheaper to encode and
// an order of magnitude smaller on the wire to Filesystem.writeFile.
//
// Nothing is lost visually: WhatsApp, Instagram and every other chat app
// re-encode shared images to JPEG regardless, so a PNG here just meant paying
// for lossless twice. 0.92 keeps the dark gradients free of visible banding.
const CARD_MIME = 'image/jpeg';
const CARD_QUALITY = 0.92;

/**
 * Encode a canvas to a bare base64 string without blocking the UI thread.
 *
 * toDataURL() encodes AND base64s in one synchronous call, freezing the UI for
 * the whole time. toBlob() hands the encode to the browser asynchronously and
 * FileReader does the base64 off the hot path, so the tap registers instantly.
 * The synchronous path is kept only as a fallback — a brief freeze beats no
 * share at all.
 */
function canvasToBase64(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(canvas.toDataURL(CARD_MIME, CARD_QUALITY).split(',')[1]);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        try {
          resolve(canvas.toDataURL(CARD_MIME, CARD_QUALITY).split(',')[1]);
        } catch (e) {
          reject(e);
        }
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('Failed to read score card'));
      reader.readAsDataURL(blob);
    }, CARD_MIME, CARD_QUALITY);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas produced no image'));
      }, CARD_MIME, CARD_QUALITY);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Render and encode a card, dropping a scale step if the big one fails.
 *
 * A failure here is nearly always memory: the device refuses the canvas, or
 * accepts it and then hands back an empty blob at encode time. Both used to
 * end the share — the caller's catch copied the link and that was that. Half
 * resolution is indistinguishable once a chat app has re-compressed it, so it
 * is always a better answer than no card.
 */
async function encodeCard(card) {
  const start = CARD_SCALES.indexOf(pickScale());
  const scales = CARD_SCALES.slice(start < 0 ? 0 : start);
  let lastErr = new Error('No usable card scale');
  for (const scale of scales) {
    try {
      const canvas = renderCard(card, scale);
      const tEncode = now();
      const base64 = await canvasToBase64(canvas);
      if (!base64) throw new Error('Encoder returned nothing');
      perf(`encode+base64 ${scale}x (${Math.round(base64.length / 1024)}KB b64)`, tEncode, now());
      return { canvas, base64, scale };
    } catch (e) {
      lastErr = e;
      shareFail(`encode ${scale}x`, e);
    }
  }
  throw lastErr;
}

/**
 * Delete score cards left in the cache by earlier shares.
 *
 * Every share writes `skilldrills-score-<timestamp>.jpg` and nothing ever
 * removed them — a device in testing had 45 of them sitting in the cache
 * directory. The current file is kept because the share sheet is still
 * reading it, and the whole thing is fire-and-forget: it runs after the sheet
 * has already been handed off, and a failure here must never surface to
 * someone who just shared their score.
 */
function pruneOldCards(keepFileName) {
  Filesystem.readdir({ path: '', directory: Directory.Cache })
    .then(({ files }) => Promise.all(
      files
        .map((f) => f?.name || f)
        .filter((name) => typeof name === 'string'
          && name.startsWith('skilldrills-score-')
          && name !== keepFileName)
        .map((name) => Filesystem.deleteFile({ path: name, directory: Directory.Cache })
          .catch(() => {})),
    ))
    .catch(() => {});
}

/**
 * Hand a finished card to the platform's share sheet.
 *
 * Throws on failure so the caller can decide what to do; the only thing it
 * swallows is a user cancel, which is a normal ending.
 */
async function deliverCard(challengeUrl, asset) {
  if (Capacitor.isNativePlatform()) {
    // Native (Android/iOS): the Web Share API's Blob/File attachment support
    // isn't reliable inside a Capacitor WebView, so write the image to disk
    // first and hand the native share sheet a real file:// path via the Share
    // plugin instead.
    const base64Data = asset.base64 || await canvasToBase64(asset.canvas);
    const fileName = `skilldrills-score-${Date.now()}.jpg`;

    const tWrite = now();
    const written = await Filesystem.writeFile({
      path: fileName,
      data: base64Data,
      directory: Directory.Cache,
    });
    const tWritten = now();
    perf(`writeFile (${Math.round(base64Data.length / 1024)}KB b64)`, tWrite, tWritten);

    mark('opening native share sheet');
    try {
      await Share.share({
        title: 'SkillDrills Score',
        text: 'Can you beat my score? 🎮',
        url: challengeUrl,
        files: [written.uri],
        dialogTitle: 'Share your score',
      });
    } catch (e) {
      if (!isShareCancel(e)) throw e;
      mark('sheet dismissed by user');
    }
    // Share.share resolves when the user picks a target or dismisses, so this
    // number includes their dwell time — it is only useful for telling "the
    // sheet was slow to appear" apart from "the sheet appeared fast".
    perf('Share.share (incl. user)', tWritten, now());
    pruneOldCards(fileName);
    return;
  }

  // Web: Web Share API with a file attachment where supported
  const blob = await canvasToBlob(asset.canvas);
  const file = new File([blob], 'skilldrills-score.jpg', { type: CARD_MIME });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'SkillDrills Score',
        text: 'Can you beat my score? 🎮',
        url: challengeUrl,
        files: [file],
      });
    } catch (e) {
      if (!isShareCancel(e)) throw e;
    }
    return;
  }

  // Fallback: copy image to clipboard + share link.
  // The async clipboard only accepts PNG for images, and the card is encoded
  // as JPEG now (see CARD_MIME), so re-encode just for this path rather than
  // handing ClipboardItem a type it will reject.
  const pngBlob = await new Promise((res) => asset.canvas.toBlob(res, 'image/png'));
  if (pngBlob) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  }
  await navigator.clipboard.writeText(challengeUrl);
  alert('Score image copied to clipboard! Share it with friends.');
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RESULT-SCREEN SHARE BUTTON — used by every drill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identity of a card's contents, so a prewarmed image is only ever reused for
 * the result it was drawn from. Cheaper and more predictable than deep-
 * comparing the object, and every field here is a primitive the drill has.
 */
function cardKey(card) {
  if (!card) return null;
  return [
    card.drillName, card.score, card.bestScore, card.accuracy, card.bestCombo,
    normalizeRating(card.rating)?.letter, card.newBest ? 1 : 0, card.playerName,
    card.visualHits, card.numberHits,
  ].join('|');
}

/** requestIdleCallback where it exists, a short timer where it doesn't. */
function whenIdle(fn) {
  if (typeof window === 'undefined') return () => {};
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 1500 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 400);
  return () => clearTimeout(id);
}

/**
 * The share button behind every drill's result screen.
 *
 * `card` is the same object generateShareCard takes, or null while there is no
 * result yet. Returns the click handler.
 *
 * Two things this does that 24 hand-rolled copies of the same callback did not:
 *
 * 1. It draws and encodes the card when the RESULT SCREEN APPEARS, not when
 *    the button is tapped. That encode is the whole cost of a share — the file
 *    write and the sheet itself measured ~650ms combined — and the result
 *    screen is the one moment in a drill where the device has nothing to do.
 *    By the time anyone reaches for the button the image already exists, so the
 *    tap only writes a file and opens the sheet. If the prewarm hasn't finished
 *    (or never ran) the tap encodes inline, exactly as it always did.
 *
 * 2. It refuses to re-enter. A tap that took a few seconds got tapped again,
 *    and every one of those taps started its own full encode — so a device
 *    that was already struggling did the expensive part three times over and
 *    the sheet appeared later still.
 *
 * The prewarm is deliberately gated on requestIdleCallback rather than fired
 * in the effect body: the result screen animates in, and a synchronous
 * full-card draw on that frame is a visible hitch.
 */
export function useShareCard(card, { url, title, text } = {}) {
  const cardRef = useRef(card);
  cardRef.current = card;

  const warmRef = useRef(null);   // { key, asset: Promise<asset|null> | null }
  const busyRef = useRef(false);

  const key = cardKey(card);

  useEffect(() => {
    if (!key) {
      warmRef.current = null;
      return undefined;
    }
    if (warmRef.current?.key === key) return undefined;

    let cancelled = false;
    const entry = { key, asset: null };
    warmRef.current = entry;

    mark('result screen up, prewarm queued');
    const cancelIdle = whenIdle(() => {
      if (cancelled) return;
      mark('prewarm start');
      // A rejected prewarm must not surface as an unhandled rejection, and
      // must not poison the tap — resolving to null makes share() rebuild.
      entry.asset = encodeCard(cardRef.current).catch((e) => {
        shareFail('prewarm', e);
        return null;
      });
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [key]);

  return useCallback(async () => {
    const current = cardRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    const tTap = now();
    mark('TAP');

    try {
      const warm = warmRef.current;
      let asset = null;
      if (warm && warm.key === cardKey(current) && warm.asset) {
        asset = await warm.asset;
      }
      if (asset) {
        perf('prewarmed card was ready, waited', tTap, now());
      } else {
        mark('NO prewarm - encoding on the tap');
        asset = await encodeCard(current);
      }
      await deliverCard(url, asset);
      perf('TOTAL tap to sheet closed', tTap, now());
    } catch (e) {
      if (isShareCancel(e)) return;
      shareFail('share', e);
      // Last resort only: the card could not be produced or handed over at
      // all. Still gets the score out, just without the image.
      try {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title, text, url }).catch(() => {});
        } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(`${text} ${url}`);
          alert('Score copied to clipboard!');
        }
      } catch {}
    } finally {
      busyRef.current = false;
    }
  }, [url, title, text]);
}
