#!/usr/bin/env node
//
// scripts/preload-fonts.js — kills the "text pops in, then jumps into place"
// flash when opening a page in the packaged app.
//
// THE PROBLEM
// -----------
// next/font self-hosts Inter and Space Grotesk under /_next/static/media/ and
// declares them with `font-display: swap`. Nothing in the exported HTML points
// at those files, though — they are only named inside the compiled CSS. So the
// browser's discovery order is:
//
//     parse HTML -> download CSS -> parse CSS -> discover woff2 -> download it
//
// and `swap` means it paints the whole screen in the fallback face the moment
// the CSS lands, then repaints in the real face when the font finally arrives.
// The fallback has different metrics, so that second paint MOVES text and
// changes its size. That is the flash: it is not slowness, it is two paints.
//
// A normal Next.js server emits <link rel="preload"> for these automatically.
// A static export (output: 'export') does not, and the app ships as a static
// export inside a WebView — so nobody was ever preloading them.
//
// THE FIX
// -------
// Inject the preload links ourselves, at the very top of <head>, so the font
// download starts in parallel with the CSS instead of after it. In a WebView
// the files are local, so they arrive well before first paint and the fallback
// is never shown.
//
// Only the basic-latin subsets are preloaded — next/font marks those with a
// `.p.woff2` suffix ("p" for preload), and they are the only ones an English UI
// touches. Preloading the cyrillic/greek/vietnamese subsets too would download
// ~8 extra files nothing renders.
//
// Filenames are content-hashed and change on every build, which is exactly why
// this runs as a post-build step that reads them back out of the emitted CSS
// rather than hard-coding them anywhere.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');

function walk(dir, ext, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, found);
    else if (entry.name.endsWith(ext)) found.push(full);
  }
  return found;
}

if (!fs.existsSync(OUT)) {
  console.error('[preload-fonts] no out/ directory — run the build first.');
  process.exit(1);
}

// 1. Find the preloadable (basic-latin) font files named by the compiled CSS.
const cssDir = path.join(OUT, '_next', 'static', 'css');
const css = fs.existsSync(cssDir)
  ? walk(cssDir, '.css').map(f => fs.readFileSync(f, 'utf8')).join('')
  : '';

const fonts = [...new Set(
  [...css.matchAll(/url\((\/_next\/static\/media\/[^)]+\.p\.woff2)\)/g)].map(m => m[1])
)];

if (fonts.length === 0) {
  // Not fatal: a build that genuinely uses no preloadable subset is possible,
  // and failing here would break the release pipeline over a cosmetic step.
  console.warn('[preload-fonts] no .p.woff2 subsets found in the CSS — nothing to preload.');
  process.exit(0);
}

const tags = fonts
  .map(href => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin="anonymous"/>`)
  .join('');

// 2. Put them first in <head>, ahead of the stylesheet links, so the fetch
//    starts immediately rather than after the CSS round trip.
const pages = walk(OUT, '.html');
let patched = 0;

for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  if (html.includes('as="font"')) continue;      // already done, stay idempotent
  const at = html.indexOf('<head>');
  if (at === -1) continue;
  const insertAt = at + '<head>'.length;
  fs.writeFileSync(page, html.slice(0, insertAt) + tags + html.slice(insertAt));
  patched++;
}

console.log(
  `[preload-fonts] preloaded ${fonts.length} font subset(s) across ${patched}/${pages.length} page(s):\n` +
  fonts.map(f => '  ' + f).join('\n')
);
