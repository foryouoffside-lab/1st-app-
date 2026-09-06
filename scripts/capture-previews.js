#!/usr/bin/env node
'use strict';

// scripts/capture-previews.js
// SkillDrills — drill preview capture
//
// Screenshots every drill mid-play so the Cognitive hub can show a real
// picture of each drill instead of a generic category icon. Names like
// "Ghost Link" or "Batch Processing" tell a new user nothing; a frame of the
// drill actually running does.
//
// Deliberately NOT live mini-drills rendered in the hub: running a rAF loop
// per card inside a scrolling list is the same frame-pacing/heat problem this
// app spent months fixing. One script, re-run whenever the visuals change,
// costs nothing at runtime.
//
//   npm run previews                              capture every drill
//   npm run previews -- quick-dodge shade-finder  capture just these
//
// Runs against `next dev`, not the static export, because the sign-in gate
// has to be walked past and its bypass is deliberately dev-only — see the
// NODE_ENV guard in components/AuthGate.js. Nothing about the drills
// themselves renders differently between the two.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
// Raw full-frame captures live OUTSIDE public/ on purpose: they are source
// material for re-cropping, ~2MB all told, and every byte under public/ is
// bundled into the APK. Only the cropped cards below get shipped.
const SHOT_DIR = path.join(ROOT, 'previews-raw');
const CARD_DIR = path.join(ROOT, 'public', 'previews', 'cards');
const PORT = 4321;

// Drills that lock landscape get a landscape viewport; the rest are portrait.
// `settle` is how long to let the drill run after START before the shutter:
// it has to clear the 3-2-1-GO countdown and land on a frame that actually
// shows the mechanic. Memory drills need longer so we catch the recall phase
// rather than a blank grid.
const DRILLS = [
  { id: 'quick-dodge',                path: '/drills/cognitive/processing-speed/quick-dodge/',                landscape: true,  settle: 3000, drag: [[0.5, 0.5], [0.25, 0.3], [0.7, 0.7], [0.4, 0.45], [0.75, 0.3], [0.3, 0.65]], dragMs: 6000 },
  { id: 'distraction-fighter',        path: '/drills/cognitive/focus/distraction-fighter/',                   landscape: false, settle: 4600 },
  { id: 'card-matching',              path: '/drills/cognitive/memory/card-matching/',                        landscape: false, settle: 4200, taps: [[0.28, 0.42], [0.72, 0.58]] },
  { id: 'multi-tasking',              path: '/drills/cognitive/attention/multi-tasking/',                     landscape: true,  settle: 5000 },
  { id: 'moving-target',              path: '/drills/cognitive/focus/moving-target/',                         landscape: true,  settle: 7000 },
  { id: 'grid-memorization',          path: '/drills/cognitive/memory/grid-memorization/',                    landscape: false, settle: 4200 },
  { id: 'shade-finder',               path: '/drills/cognitive/focus/shade-finder/',                          landscape: false, settle: 4600 },
  { id: 'tower-of-hanoi',             path: '/drills/cognitive/problem-solving/tower-of-hanoi/',              landscape: true,  settle: 4600 },
  { id: 'concentration-grid',         path: '/drills/cognitive/focus/concentration-grid/',                    landscape: false, settle: 4600 },
  { id: 'finger-sequencing',          path: '/drills/cognitive/processing-speed/finger-sequencing/',          landscape: true,  settle: 5000 },
];

// The signed-out app still talks to Firebase; with no account behind the
// capture those calls only add slow retries and console noise to every shot.
const BLOCKED = [
  '**identitytoolkit.googleapis.com/**',
  '**securetoken.googleapis.com/**',
  '**firestore.googleapis.com/**',
];

// Kill anything still holding our port. A `next dev` spawned through a shell
// outlives child.kill() on Windows — that leaves a wedged server on the port
// and every later run silently talks to the STALE one, which looks like a
// mysterious timeout rather than a leftover process. Scoped to PORT so the
// dev server the user has open on 3000 is never touched.
function freePort() {
  if (process.platform !== 'win32') {
    try { execSync(`fuser -k ${PORT}/tcp`, { stdio: 'ignore' }); } catch (e) {}
    return;
  }
  try {
    const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${PORT}`, {
      encoding: 'utf8',
    });
    const pids = new Set(
      out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p))
    );
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    }
  } catch (e) {
    // findstr exits non-zero when nothing matches — the port was already free.
  }
}

// A dev server of our own on a dedicated port, so a capture run never
// collides with the `next dev` the user already has open on 3000.
function startDevServer() {
  freePort();

  // `shell: true` because on Windows npx is a .cmd, which Node refuses to
  // spawn directly (EINVAL).
  const child = spawn('npx next dev -p ' + PORT, {
    cwd: ROOT,
    env: { ...process.env, NEXT_PUBLIC_CAPTURE_PREVIEWS: '1', NEXT_CAPTURE_DIST: '.next-previews' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server did not come up in 90s')), 90000);
    const onData = (buf) => {
      if (/Ready in|started server on|Local:/i.test(String(buf))) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited with code ${code}`));
    });
  });
}

// Playwright errors carry a long multi-line dump; the first line is the part
// worth printing in a per-drill status list.
function firstLine(err) {
  return String(err && err.message ? err.message : err).split(String.fromCharCode(10))[0];
}

// Prefer the Edge that ships with Windows over Playwright's own Chromium, so
// this works on a clean checkout without a ~150MB `npx playwright install`.
async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'msedge' });
  } catch (e) {
    return await chromium.launch();
  }
}

async function capture(browser, drill) {
  const context = await browser.newContext({
    // A real phone's CSS viewport, not a desktop window: these drills size
    // their boards off the viewport, so shooting them at 1280x720 gives a
    // small board marooned in empty space rather than what a player sees.
    viewport: drill.landscape ? { width: 915, height: 412 } : { width: 412, height: 915 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  for (const pattern of BLOCKED) {
    await context.route(pattern, (route) => route.abort());
  }

  const page = await context.newPage();
  try {
    // 'domcontentloaded', not 'load': the app keeps a Firestore long-poll open
    // and the load event can sit unfired for minutes. Waiting for the START
    // button below is the real readiness signal anyway.
    await page.goto(`http://localhost:${PORT}${drill.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    // Match the button element, not the text node inside it: a few drills
    // wrap the label in a span, and clicking that span does not always reach
    // the button's onClick — the drill then sits on its start card forever and
    // the shot is of the card instead of the game.
    const start = page.locator('button', { hasText: /^\s*START\s*$/ }).first();
    await start.waitFor({ state: 'visible', timeout: 60000 });
    await start.click();

    await page.waitForTimeout(drill.settle);

    // Quick Dodge kills a player who stands still, so the shot would either be
    // an almost-empty opening field or a game-over screen. Dragging the dot
    // along a path keeps it alive into the part of the run where the hazards
    // have multiplied, which is the frame worth showing.
    if (drill.drag) {
      const box = page.viewportSize();
      const pt = (f) => [Math.round(box.width * f[0]), Math.round(box.height * f[1])];
      const [sx, sy] = pt(drill.drag[0]);
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      const legMs = Math.round((drill.dragMs || 4000) / Math.max(1, drill.drag.length - 1));
      for (const f of drill.drag.slice(1)) {
        const [x, y] = pt(f);
        await page.mouse.move(x, y, { steps: 24 });
        await page.waitForTimeout(legMs);
      }
    }

    // Some drills only look like anything once the player has touched them —
    // Card Matching is all face-down cards until you flip two. Tap a couple of
    // spots so the shot shows the mechanic rather than a waiting board.
    for (const [fx, fy] of drill.taps || []) {
      const box = page.viewportSize();
      await page.mouse.click(Math.round(box.width * fx), Math.round(box.height * fy));
      await page.waitForTimeout(320);
    }

    await page.screenshot({
      path: path.join(SHOT_DIR, `${drill.id}.jpg`),
      type: 'jpeg',
      quality: 88,
    });
    return { id: drill.id, ok: true };
  } catch (err) {
    return { id: drill.id, ok: false, error: firstLine(err) };
  } finally {
    await context.close();
  }
}


// ============================================================
// CARD ASSETS
// ============================================================
// The raw captures are full phone frames at 3x — far too heavy to ship, and
// mostly empty on the sparse drills, where two or three objects sit on a big
// black field and read as a blank tile once shrunk to card size.
//
// So each capture is cropped to where the action actually is: find the
// bounding box of everything bright enough to be a game object, pad it, and
// widen that box to the card's aspect. Busy drills end up barely cropped;
// sparse ones zoom in until their few objects fill the tile. The HUD band at
// the top and the sound button at the bottom are excluded from the search —
// they sit in the corners and would stretch every box back out to the full
// frame, which is the crop we are trying to avoid.
const CARD_W = 640;
const CARD_H = 360;
const CARD_ASPECT = CARD_W / CARD_H;
const HUD_TOP = 0.17;      // score / lives
const HUD_BOTTOM = 0.87;   // sound toggle
const INK = 46;            // 0-255; above this a pixel counts as a game object
const MIN_COVERAGE = 0.55; // never crop tighter than this share of the width

async function makeCard(sharp, srcFile, destFile) {
  const meta = await sharp(srcFile).metadata();
  const W = meta.width;
  const H = meta.height;

  const bandTop = Math.round(H * HUD_TOP);
  const bandHeight = Math.round(H * (HUD_BOTTOM - HUD_TOP));
  const probeW = 160;
  const probeH = Math.max(1, Math.round((bandHeight / W) * probeW));

  const probe = await sharp(srcFile)
    .extract({ left: 0, top: bandTop, width: W, height: bandHeight })
    .resize(probeW, probeH, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  let minX = probeW;
  let minY = probeH;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < probeH; y++) {
    for (let x = 0; x < probeW; x++) {
      if (probe[y * probeW + x] > INK) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  let crop;
  if (maxX < 0) {
    crop = { left: 0, top: 0, width: W, height: H }; // found nothing; keep it all
  } else {
    const sx = W / probeW;
    const sy = bandHeight / probeH;
    const padX = W * 0.06;
    const padY = H * 0.06;
    const left = minX * sx - padX;
    const right = (maxX + 1) * sx + padX;
    const top = bandTop + minY * sy - padY;
    const bottom = bandTop + (maxY + 1) * sy + padY;

    let width = Math.max(right - left, W * MIN_COVERAGE);
    let height = width / CARD_ASPECT;
    if (height < bottom - top) {
      height = bottom - top;
      width = height * CARD_ASPECT;
    }
    if (width > W) {
      width = W;
      height = width / CARD_ASPECT;
    }
    if (height > H) {
      height = H;
      width = height * CARD_ASPECT;
    }

    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    crop = {
      left: Math.round(Math.max(0, Math.min(W - width, cx - width / 2))),
      top: Math.round(Math.max(0, Math.min(H - height, cy - height / 2))),
      width: Math.round(Math.min(W, width)),
      height: Math.round(Math.min(H, height)),
    };
  }

  await sharp(srcFile)
    .extract(crop)
    .resize(CARD_W, CARD_H, { fit: 'cover' })
    .webp({ quality: 72 })
    .toFile(destFile);
}

async function buildCards(ids) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.log('sharp not installed — skipping card assets, raw captures kept.');
    return;
  }
  fs.mkdirSync(CARD_DIR, { recursive: true });
  for (const id of ids) {
    const srcFile = path.join(SHOT_DIR, id + '.jpg');
    if (!fs.existsSync(srcFile)) continue;
    try {
      await makeCard(sharp, srcFile, path.join(CARD_DIR, id + '.webp'));
    } catch (e) {
      console.log('card FAIL ' + id + ' — ' + firstLine(e));
    }
  }
  console.log('cards -> public/previews/cards/ (' + CARD_W + 'x' + CARD_H + ' webp)');
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const todo = only.length ? DRILLS.filter((d) => only.includes(d.id)) : DRILLS;
  if (!todo.length) {
    console.error(`No drill matched: ${only.join(', ')}`);
    process.exit(1);
  }

  // Re-crop the captures already on disk without spending ten minutes
  // replaying every drill — the crop constants above are worth tuning by eye,
  // and re-shooting to try a new number is the slow way to do it.
  if (process.argv.includes('--cards-only')) {
    await buildCards(todo.map((d) => d.id));
    process.exit(0);
  }

  console.log('starting dev server...');
  const server = await startDevServer();
  const browser = await launchBrowser();

  // A dev server compiles routes on demand, and the first request also pays
  // for the shared app/layout chunks. Warm it on the hub first, or whichever
  // drill happens to be first in the list eats that cost and times out
  // looking for a START button that has not rendered yet.
  console.log('warming dev server...');
  const warm = await browser.newPage();
  try {
    await warm.goto(`http://localhost:${PORT}/drills/cognitive/`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await warm.waitForTimeout(4000);
  } catch (e) {
    console.log('warmup failed (continuing): ' + firstLine(e));
  }
  await warm.close();

  const results = [];
  try {
    for (const drill of todo) {
      const r = await capture(browser, drill);
      results.push(r);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id}${r.ok ? '' : ' — ' + r.error}`);
    }
  } finally {
    await browser.close();
    server.kill();
    // child.kill() only reaches the shell wrapper; the dev server itself has
    // to be killed by port or it lingers and poisons the next run.
    freePort();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} captured -> previews-raw/`);

  await buildCards(results.filter((r) => r.ok).map((r) => r.id));
  process.exit(failed.length ? 1 : 0);
})();
