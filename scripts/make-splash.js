#!/usr/bin/env node
/*
 * scripts/make-splash.js — rebuild the Android splash screens from the app logo.
 *
 * Renders from public/favicon.svg (vector) rather than a raster PNG, so every
 * density variant is generated fresh at its exact target resolution instead
 * of being resized from a fixed-size bitmap — no upscaling softness at any
 * density. Run again any time the logo artwork changes.
 *
 *   node scripts/make-splash.js
 *
 * Note: the Android 12+ SplashScreen API icon (windowSplashScreenAnimatedIcon
 * in styles.xml) is NOT generated here — it's a real Android VectorDrawable
 * at android/app/src/main/res/drawable/splash_icon_vector.xml, which is
 * already resolution-independent and needs no build step.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const SOURCE_SVG = path.join(root, 'public', 'favicon.svg');
const RES_DIR = path.join(root, 'android', 'app', 'src', 'main', 'res');
const BACKGROUND = { r: 5, g: 5, b: 8, alpha: 1 }; // #050508, matches --ink

// Fraction of the shorter screen edge the logo should occupy. Small enough to
// read as a splash mark rather than a stretched image on any aspect ratio.
const LOGO_SCALE = 0.14;

async function main() {
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error(`Source SVG not found: ${SOURCE_SVG}`);
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

    // Rasterized directly from the vector source at the exact target size —
    // not resized from an existing bitmap — so it's crisp at every density.
    const logo = await sharp(SOURCE_SVG, { density: 384 })
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
