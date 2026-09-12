const assert=require('node:assert/strict');const {chromium}=require('@playwright/test');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:915,height:412}});
 await context.route(/https?:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto('http://127.0.0.1:3210/drills/cognitive/processing-speed/quick-dodge/',{waitUntil:'domcontentloaded'});
  const start=page.getByRole('button',{name:/^start$/i}).first();await start.waitFor({timeout:90000});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>/^start$/i.test(b.textContent.trim())&&Object.keys(b).some(k=>k.startsWith('__reactProps$'))));
  await start.click();const player=page.locator('.qd-player-body');await player.waitFor({state:'visible',timeout:15000});
  await page.getByText('Get Ready',{exact:true}).waitFor({state:'hidden',timeout:15000});
  const position=async()=>{const b=await player.boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2};};
  await page.mouse.move(250,230);await page.mouse.down();await page.waitForTimeout(30);
  const first=await position();
  const base=await page.locator('.qd-stick').evaluate(el=>el.style.transform);
  await page.mouse.move(280,230);await page.waitForTimeout(100);const moved=await position();
  assert(moved.x>first.x && Math.abs(moved.y-first.y)<1);
  await page.waitForTimeout(100);const held=await position();assert(held.x>moved.x);
  assert.equal(await page.locator('.qd-stick').evaluate(el=>el.style.transform),base);
  await page.mouse.move(250,230);await page.waitForTimeout(30);const neutral=await position();
  await page.waitForTimeout(150);const stopped=await position();assert(Math.abs(stopped.x-neutral.x)<0.2);
  // Reach the top wall, then steer both ways while still pushing upward.
  await page.mouse.move(250,195);await page.waitForTimeout(750);const atTop=await position();
  await page.mouse.move(270,195);await page.waitForTimeout(120);const alongRight=await position();
  assert(alongRight.x>atTop.x+2 && Math.abs(alongRight.y-atTop.y)<1,'top wall must permit rightward steering');
  await page.mouse.move(230,195);await page.waitForTimeout(120);const alongLeft=await position();
  assert(alongLeft.x<alongRight.x-2 && Math.abs(alongLeft.y-atTop.y)<1,'top wall must permit leftward steering');
  await page.mouse.move(800,350);await page.waitForTimeout(40);
  assert.equal(await page.locator('.qd-stick').evaluate(el=>el.style.transform),base,'base must never follow long drags');
  const inside=await page.locator('.qd-stick').evaluate(el=>{
   const matrix=new DOMMatrix(el.querySelector('.qd-stick-knob').style.transform);
   return Math.hypot(matrix.m41,matrix.m42)<=parseFloat(el.style.getPropertyValue('--qd-stick-r'))*0.58+0.1;
  });assert(inside,'knob must stay inside ring');
  await page.mouse.up();assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS rendered fixed-base joystick, bounded knob, held movement, neutral stop and both directions along top border.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
