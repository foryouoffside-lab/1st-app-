// Rasterise the Flint mark into every Android/Play size. Playwright is the
// rasterizer (sharp's SVG path mis-renders some gradients on this machine).
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '../..');
const res = path.join(root, 'android/app/src/main/res');
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const jobs = [];
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dens)) {
  jobs.push({ svg: 'flint-foreground.svg', size: 108 * k, out: `${res}/mipmap-${d}/ic_launcher_foreground.png`, alpha: true });
  jobs.push({ svg: 'flint-tile.svg', size: 48 * k, out: `${res}/mipmap-${d}/ic_launcher.png`, alpha: true });
  jobs.push({ svg: 'flint-icon.svg', size: 48 * k, out: `${res}/mipmap-${d}/ic_launcher_round.png`, alpha: true, round: true });
}
jobs.push({ svg: 'flint-icon.svg', size: 512, out: path.join(__dirname, 'play-icon-512.png'), alpha: true });
jobs.push({ svg: 'flint-tile.svg', size: 512, out: path.join(root, 'public/icons/icon-512x512.png'), alpha: true });
jobs.push({ svg: 'flint-tile.svg', size: 192, out: path.join(root, 'public/icons/icon-192x192.png'), alpha: true });
(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  for (const j of jobs) {
    const p = await b.newPage({ viewport: { width: Math.round(j.size), height: Math.round(j.size) } });
    const clip = j.round ? 'border-radius:50%;overflow:hidden;' : '';
    await p.setContent(`<html><body style="margin:0;background:transparent"><div style="width:100vw;height:100vh;${clip}">${read(j.svg).replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
    await p.screenshot({ path: j.out, omitBackground: j.alpha });
    await p.close(); console.log('wrote', path.relative(root, j.out), j.size);
  }
  await b.close();
})();
