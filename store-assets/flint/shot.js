const { chromium } = require('playwright');
const { pathToFileURL } = require('url'); const path = require('path');
(async () => {
  const [src, out, w, h, dpr] = process.argv.slice(2);
  const b = await chromium.launch({ channel: 'msedge' });
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(dpr||1) });
  await p.goto(pathToFileURL(path.resolve(src)).href); await p.waitForTimeout(900);
  await p.screenshot({ path: out, type: 'png' }); await b.close(); console.log('ok', out);
})();
