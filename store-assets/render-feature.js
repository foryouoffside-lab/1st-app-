const { chromium } = require('playwright');
const { pathToFileURL } = require('url');
const path = require('path');
(async () => {
  const src = process.argv[2], out = process.argv[3];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.resolve(src)).href);
  await page.waitForTimeout(600);
  // omitBackground stays false — Play rejects a feature graphic with alpha.
  await page.screenshot({ path: out, type: 'png', omitBackground: false });
  await browser.close();
  console.log('rendered', out);
})();
