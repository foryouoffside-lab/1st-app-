// Run against an isolated dev server with NEXT_PUBLIC_CAPTURE_PREVIEWS=1.
// External requests are blocked; this never creates real players or matches.
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 915, height: 412 } });
  await context.route(/https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = 'http://127.0.0.1:3210';
  const drills = [
    'processing-speed/quick-dodge', 'attention/multi-tasking',
    'processing-speed/finger-sequencing', 'focus/concentration-grid',
    'memory/grid-memorization', 'memory/card-matching',
    'problem-solving/tower-of-hanoi', 'focus/shade-finder',
    'focus/moving-target', 'focus/distraction-fighter',
  ];
  try {
    for (const drill of drills) {
      await page.goto(`${base}/drills/cognitive/${drill}/`, { waitUntil: 'domcontentloaded' });
      const start = page.getByRole('button', { name: /^start$/i }).first();
      await start.waitFor({ timeout: 60000 });
      // SSR buttons exist before React attaches their handlers.
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
        /^start$/i.test(button.textContent.trim()) && Object.keys(button).some(key => key.startsWith('__reactProps$'))));
      await start.click();
      await page.waitForTimeout(3300);
      assert.equal(await start.isVisible(), false, `${drill} remained on its start card`);
      assert.equal(errors.length, 0, errors.join('\n'));
      if (drill === 'processing-speed/quick-dodge') {
        const player = page.locator('.qd-player-body');
        await player.waitFor({ state: 'visible' });
        const before = await player.boundingBox();
        await page.mouse.move(300, 220);
        await page.mouse.down();
        await page.mouse.move(320, 220);
        await page.waitForTimeout(60);
        const after = await player.boundingBox();
        assert.ok(after.x > before.x && Math.abs(after.y - before.y) < 2, 'right joystick push must move the player right');
        await page.setViewportSize({ width: 412, height: 915 });
        await page.waitForTimeout(200);
        assert.equal(await page.locator('.qd-stick-on').count(), 0, 'rotation must release stale input');
        await page.mouse.up();
        await page.setViewportSize({ width: 915, height: 412 });
        await page.waitForTimeout(200);
      }
      console.log(`PASS startup: ${drill}`);
    }
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.drill-preview-viewport').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(300);
    const previews = await page.locator('.drill-preview-viewport').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { paused: node.dataset.paused, offscreen: r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth };
    }));
    assert.ok(previews.length > 0);
    assert.ok(previews.filter(p => p.offscreen).every(p => p.paused === 'true'), 'offscreen preview animations must pause');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS preview visibility and runtime errors');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
