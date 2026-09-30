// Build the Play Store phone screenshots (1080x1920) from real device
// captures in ./shots. Each slide: headline + sub-line over the Flint
// "Field" background, with the real screen in a phone-shaped frame.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const out = path.join(__dirname, 'screenshots'); fs.mkdirSync(out, { recursive: true });
// Crop: drop the status bar (top 108px) and the OS side-handle (16px each side).
const CROP = { x: 16, y: 108, w: 1048, h: 2292 };
const slides = [
  { f: '01-daily-habit', img: 'home-flint.png', h: ['Sharpen up', 'in minutes'], sub: 'A short daily session of focus & reaction drills' },
  { f: '02-find-it-fast', img: 'cg-board2.png', h: ['Find it.', 'Fast.'], sub: 'Tap the numbers in order before the clock runs out' },
  { f: '03-dont-read-react', img: 'df-play.png', h: ["Don't read it.", 'React.'], sub: 'Tap the ink colour, not the word' },
  { f: '04-three-a-day', img: 'daily.png', h: ['Three drills', 'a day'], sub: 'A guided session, a weekly goal and badges to earn' },
  { f: '05-level-up', img: 'progress.png', h: ['Watch your', 'level climb'], sub: 'XP, rank badges and your skill profile' },
  { f: '06-duel', duel: true, h: ['Duel live.', 'Climb the ranks.'], sub: 'Real-time 1v1 duels against real players' },
];
const css = `
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1920px;overflow:hidden;background:#06060b;font-family:Inter,sans-serif;color:#fff;position:relative}
.field{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.06) 1.4px,transparent 1.5px);background-size:30px 30px;-webkit-mask-image:linear-gradient(#000 0,#000 30%,transparent 70%)}
.glow{position:absolute;left:50%;top:880px;width:1300px;height:1300px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(124,58,237,.34),transparent 60%)}
.spark{position:absolute;left:50%;top:210px;width:520px;height:260px;transform:translateX(-50%);background:radial-gradient(ellipse,rgba(251,191,36,.10),transparent 65%)}
.head{position:absolute;top:92px;left:0;right:0;text-align:center}
.h{font-family:Anton,sans-serif;font-size:104px;line-height:1.02;letter-spacing:.01em;text-transform:uppercase;display:inline-block;position:relative;padding:8px 34px 4px}
.h:before,.h:after{content:"";position:absolute;width:40px;height:40px;border:8px solid #8b5cf6}
.h:before{left:0;top:0;border-right:0;border-bottom:0}.h:after{right:0;bottom:0;border-left:0;border-top:0}
.h .l2{color:#fbbf24}
.sub{margin-top:26px;font-size:36px;font-weight:500;color:#b9b6d3;padding:0 90px}
.phone{position:absolute;left:50%;top:520px;transform:translateX(-50%);width:640px;height:1400px;border-radius:64px;overflow:hidden;
 border:3px solid #2e2b48;box-shadow:0 0 0 12px #0d0c16,0 0 0 14px #25223a,0 40px 120px rgba(0,0,0,.7),0 0 140px rgba(124,58,237,.28);background:#050508}
.phone .scr{position:absolute;left:0;top:0;width:640px;height:${Math.round(640*CROP.h/CROP.w)}px;background-size:cover}
.card{position:absolute;left:50%;transform:translateX(-50%);width:900px;border-radius:40px;overflow:hidden;border:3px solid #2e2b48;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 120px rgba(124,58,237,.25);background:#050508}
.card div{width:900px;background-repeat:no-repeat}
`;
function crop(img, y0, y1) {
  // background-image window onto the raw 1080x2400 capture
  const scale = 900 / CROP.w;
  return `background-image:url(shots/${img});background-size:${1080*scale}px ${2400*scale}px;background-position:${-CROP.x*scale}px ${-y0*scale}px;height:${Math.round((y1-y0)*scale)}px`;
}
(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  for (const s of slides) {
    let body;
    if (s.duel) {
      body = `<div class="card" style="top:610px"><div style="${crop('ranks.png', 108, 812)}"></div></div>
              <div class="card" style="top:1390px"><div style="${crop('arena.png', 575, 935)}"></div></div>`;
    } else {
      const sc = 640 / CROP.w;
      body = `<div class="phone"><div class="scr" style="background-image:url(shots/${s.img});background-size:${1080*sc}px ${2400*sc}px;background-position:${-CROP.x*sc}px ${-CROP.y*sc}px"></div></div>`;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@500;600;700&display=block" rel="stylesheet">
<style>${css}</style></head><body><div class="glow"></div><div class="field"></div><div class="spark"></div>
<div class="head"><div class="h">${s.h[0]}<br><span class="l2">${s.h[1]}</span></div><div class="sub">${s.sub}</div></div>${body}</body></html>`;
    const file = path.join(__dirname, `_slide.html`); fs.writeFileSync(file, html);
    const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
    await p.goto(require('url').pathToFileURL(file).href); await p.waitForTimeout(1200);
    await p.screenshot({ path: path.join(out, s.f + '.png') }); await p.close(); console.log('slide', s.f);
  }
  await b.close(); fs.unlinkSync(path.join(__dirname, '_slide.html'));
})();
