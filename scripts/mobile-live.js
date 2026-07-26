#!/usr/bin/env node
/*
 * scripts/mobile-live.js — on-device live reload, and the way back out.
 *
 * WHY THIS EXISTS
 * The normal way to see a change on the phone is `next build` + `cap sync` +
 * `gradlew assembleDebug` + `adb install`, which takes about a minute — and
 * roughly 45s of that is `next build` doing a full 35-page production static
 * export. That's the wrong tool to run after editing one line.
 *
 * Instead, install the app ONCE pointed at the Next.js dev server on this
 * machine. From then on a code change appears on the phone in about a second,
 * with no rebuild, no sync, and no reinstall.
 *
 *   npm run mobile:live      # one-time: point the app at this machine + install
 *   npm run dev              # leave running; edit code, changes hot-reload
 *   npm run mobile:restore   # done: put the app back on bundled assets
 *
 * SAFETY
 * The dev URL is never written to a committed file — capacitor.config.ts reads
 * it from CAP_DEV_URL, so with no env var the config is an ordinary production
 * build. The URL DOES get baked into the native project at sync time
 * (android/app/src/main/assets/capacitor.config.json), which is what
 * `mobile:restore` clears. As a backstop, `mobile:release` always re-syncs
 * before bundling, so a release build cannot ship a dev URL even if you forget.
 */

const { execSync } = require('child_process');
const { networkInterfaces } = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const restore = process.argv.includes('--restore');

function run(cmd, env) {
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** First non-loopback, non-link-local IPv4 address — the one the phone can reach. */
function lanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        return a.address;
      }
    }
  }
  return null;
}

if (restore) {
  console.log('\nRestoring bundled-assets (production) mode...\n');
  // No CAP_DEV_URL in the environment, so this sync rewrites the native config
  // without a server URL. A full build first, so the bundled assets are current.
  run('npx next build');
  run('npx cap sync android');
  console.log('\nDone. Rebuild and reinstall to run fully offline again:');
  console.log('  cd android && gradlew assembleDebug && npx cap run android\n');
  process.exit(0);
}

const ip = lanIp();
if (!ip) {
  console.error('Could not find a LAN IP address. Are you connected to Wi-Fi?');
  process.exit(1);
}

const url = `http://${ip}:3000`;
console.log(`\nLive reload target: ${url}`);
console.log('The phone must be on this same Wi-Fi network.\n');

// Assets still get copied so the app has something to fall back on, and so the
// native project is in a consistent state.
run('npx cap sync android', { CAP_DEV_URL: url });

console.log('\nInstalling the dev build on the connected device...\n');
run('npx cap run android --no-sync', { CAP_DEV_URL: url });

console.log(`
Installed and pointed at the dev server.

Next:
  1. npm run dev          (leave it running in its own terminal)
  2. Edit code — the phone reloads on save, no rebuild needed.

When you're finished developing:
  npm run mobile:restore  (puts the app back on bundled assets)

Note: while in live mode the app only works with the dev server running and the
phone on the same Wi-Fi. It is NOT a shippable build.
`);
