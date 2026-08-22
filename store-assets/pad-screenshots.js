// Google Play rejects a screenshot whose long side is more than TWICE its
// short side. A modern tall phone (1080x2288 and similar) is ~2.12:1, so raw
// device screenshots fail this check every time — including any you retake
// on the same phone.
//
// Fix: pad the sides with the app's background colour until the ratio is
// exactly within the limit. Nothing is cropped, so no UI is lost.
//
//   node store-assets/pad-screenshots.js
//
// Reads  store-assets/screenshots/
// Writes store-assets/screenshots-play/   <- upload THESE to Play Console

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, 'screenshots');
const OUT = path.join(__dirname, 'screenshots-play');
const BG = { r: 5, g: 5, b: 8 }; // #050508, the app background
const MAX_RATIO = 2;

// Play also caps each side at 3840px and requires at least 320px.
const MAX_SIDE = 3840;
const MIN_SIDE = 320;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const files = fs
    .readdirSync(SRC)
    .filter((f) => /\.(png|jpe?g)$/i.test(f));

  if (files.length === 0) {
    console.log('No screenshots found in', SRC);
    return;
  }

  for (const file of files) {
    const src = path.join(SRC, file);
    const { width, height } = await sharp(src).metadata();

    // Width needed so that height / width <= MAX_RATIO.
    const neededWidth = Math.ceil(height / MAX_RATIO);
    const targetWidth = Math.max(width, neededWidth);

    const padTotal = targetWidth - width;
    const left = Math.floor(padTotal / 2);
    const right = padTotal - left;

    const outName = path.parse(file).name.replace(/\.jpg$/i, '') + '.png';
    const dest = path.join(OUT, outName);

    await sharp(src)
      .extend({ top: 0, bottom: 0, left, right, background: BG })
      .png()
      .toFile(dest);

    const ratio = (height / targetWidth).toFixed(3);
    const sideOk = height <= MAX_SIDE && targetWidth >= MIN_SIDE;
    console.log(
      `${file}\n  ${width}x${height} (${(height / width).toFixed(3)}:1)` +
        ` -> ${targetWidth}x${height} (${ratio}:1)` +
        ` ${ratio <= MAX_RATIO && sideOk ? 'OK' : 'STILL INVALID'}`
    );
  }

  console.log(`\nDone. Upload the files in ${OUT} to Play Console.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
