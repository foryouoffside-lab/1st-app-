#!/usr/bin/env node
/*
 * scripts/make-splash.js — rebuild the Android splash screens from the app icon.
 *
 * The splash images shipped here were Capacitor's DEFAULT placeholder: the
 * framework's own blue "X" mark, centred on a WHITE background. Two problems —
 * it isn't the app's branding at all, and the white background meant every cold
 * start flashed white before the (near-black) app painted.
 *
 * This regenerates every density variant in place: the real app icon centred on
 * the app's own background colour. Run it again any time the icon changes.
 *
 *   node scripts/make-splash.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const SOURCE_ICON = path.join(root, 'public', 'icons', 'icon-512x512.png');
const RES_DIR = path.join(root, 'android', 'app', 'src', 'main', 'res');
const BACKGROUND = { r: 5, g: 5, b: 8, alpha: 1 }; // #050508, matches --ink

// Fraction of the shorter screen edge the logo should occupy. Small enough to
// read as a splash mark rather than a stretched image on any aspect ratio.
const LOGO_SCALE = 0.28;

async function main() {
  if (!fs.existsSync(SOURCE_ICON)) {
    console.error(`Source icon not found: ${SOURCE_ICON}`);
    process.exit(1);
  }

  const targets = fs
    .readdirSync(RES_DIR)
    .filter((d) => d.startsWith('drawable'))
    .map((d) => path.join(RES_DIR, d, 'splash.png'))
    .filter((p) => fs.existsSync(p));

  if (targets.length === 0) {
    console.error('No splash.png files found under android res/.');
    process.exit(1);
  }

  for (const target of targets) {
    // Keep each variant at its existing dimensions so Android keeps picking the
    // right one per density/orientation.
    const { width, height } = await sharp(target).metadata();
    const logoSize = Math.max(48, Math.round(Math.min(width, height) * LOGO_SCALE));

    const logo = await sharp(SOURCE_ICON)
      .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();

    const out = await sharp({
      create: { width, height, channels: 4, background: BACKGROUND },
    })
      .composite([{ input: logo, gravity: 'center' }])
      .png()
      .toBuffer();

    fs.writeFileSync(target, out);
    console.log(`  ${path.relative(root, target)}  ${width}x${height}  logo ${logoSize}px`);
  }

  console.log(`\nRebuilt ${targets.length} splash images on #050508.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
