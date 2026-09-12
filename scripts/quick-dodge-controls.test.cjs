const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/drills/cognitive/processing-speed/quick-dodge/QuickDodgeClient.js','utf8');
const s={active:true,pointerId:1,radius:40,baseX:200,baseY:200,curX:200,curY:200,vx:0,vy:0,fieldX:0,fieldY:0};
const e={containerW:800,containerH:400,player:{x:50,y:50}};
const ctx=vm.createContext({stickRef:{current:s},engine:{current:e},useCallback:f=>f,PLAYER_MAX_SPEED:Number(source.match(/const PLAYER_MAX_SPEED = ([\d.]+)/)[1]),STICK_TRAVEL_FRAC:0.58});
for(const name of ['movePlayer','handlePointerMove','handlePointerUp']) {
 const a=source.indexOf(`  const ${name} = useCallback(`),b=source.indexOf('  }, []);',a)+10;
 vm.runInContext(source.slice(a,b).replace(`const ${name}`,`globalThis.${name}`),ctx);
}
const move=(x,y,id=1)=>ctx.handlePointerMove({pointerId:id,clientX:200+x,clientY:200+y});
const reset=()=>{Object.assign(s,{active:true,pointerId:1,curX:200,curY:200,vx:0,vy:0});Object.assign(e.player,{x:50,y:50});};
for(const [dx,dy] of [[40,0],[-40,0],[0,40],[0,-40],[40,40],[-40,-40],[40,-40],[-40,40]]) {
 reset();move(dx,dy);ctx.movePlayer(0.1);
 assert.equal(Math.sign(e.player.x-50),Math.sign(dx));assert.equal(Math.sign(e.player.y-50),Math.sign(dy));
 assert(Math.abs(Math.hypot((e.player.x-50)*8,(e.player.y-50)*4)-ctx.PLAYER_MAX_SPEED*0.4)<1e-8);
 assert.equal(s.baseX,200);assert.equal(s.baseY,200);
}
reset();move(900,600);assert(Math.hypot(s.curX-200,s.curY-200)<=23.20001);assert.equal(s.baseX,200);assert.equal(s.baseY,200);
move(0,0);ctx.movePlayer(1);assert.equal(e.player.x,50);assert.equal(e.player.y,50);
move(0.5,0.5);ctx.movePlayer(0.01);assert(e.player.x>50 && e.player.y>50);
reset();
move(20,0);ctx.movePlayer(0.1);assert(e.player.x>50&&e.player.x<50+ctx.PLAYER_MAX_SPEED*0.05);
ctx.handlePointerUp({pointerId:1});const stopped=e.player.x;ctx.movePlayer(1);assert.equal(e.player.x,stopped);
// Outward diagonal input must retain its tangential component on every wall.
for(const [x,y,dx,dy,axis] of [
 [97,50,40,20,'y'],[97,50,40,-20,'y'],[3,50,-40,20,'y'],[3,50,-40,-20,'y'],
 [50,97,20,40,'x'],[50,97,-20,40,'x'],[50,3,20,-40,'x'],[50,3,-20,-40,'x'],
]) {
 reset();e.player.x=x;e.player.y=y;move(dx,dy);ctx.movePlayer(0.1);
 const before=axis==='x'?x:y, direction=axis==='x'?dx:dy;
 assert.equal(Math.sign(e.player[axis]-before),Math.sign(direction),'wall must preserve movement along its edge');
 assert.equal(axis==='x'?e.player.y:e.player.x,axis==='x'?y:x);
 assert.equal(s.baseX,200);assert.equal(s.baseY,200);
 move(-dx,-dy);ctx.movePlayer(0.1);assert(e.player.x>3&&e.player.x<97&&e.player.y>3&&e.player.y<97);
}
// At corners, blocking the outward axis must not block escape on the other.
for(const x of [3,97]) for(const y of [3,97]) {
 reset();e.player.x=x;e.player.y=y;
 move(x===3?-40:40,y===3?20:-20);ctx.movePlayer(0.1);
 assert.equal(e.player.x,x);assert(e.player.y>3&&e.player.y<97);
 move(x===3?20:-20,y===3?-40:40);ctx.movePlayer(0.1);
 assert(e.player.x>3&&e.player.x<97);
}
// Tangential distance survives crossing a wall, independent of frame rate.
const positions=[];
for(const hz of [30,60,120]) {
 reset();e.player.x=96;move(40,20);
 for(let i=0;i<hz/2;i++)ctx.movePlayer(1/hz);
 positions.push({...e.player});
}
for(const p of positions) {assert.equal(p.x,97);assert(Math.abs(p.y-positions[0].y)<1e-8);}
// Linear speed from the very first subpixel of knob travel, in all directions.
for(const fraction of [0.001,0.1,0.25,0.5,0.75,1]) {
 for(let degrees=0;degrees<360;degrees++) {
  reset();const angle=degrees*Math.PI/180,travel=s.radius*0.58;
  move(Math.cos(angle)*travel*fraction,Math.sin(angle)*travel*fraction);
  assert(Math.abs(e.player.vx-Math.cos(angle)*fraction)<1e-12);
  assert(Math.abs(e.player.vy-Math.sin(angle)*fraction)<1e-12);
  ctx.movePlayer(1/120);
  const distance=Math.hypot((e.player.x-50)*8,(e.player.y-50)*4);
  assert(Math.abs(distance-ctx.PLAYER_MAX_SPEED*4/120*fraction)<1e-9);
 }
}
// Reversals and speed changes update velocity on the input event, before a frame.
reset();move(20,0);assert(e.player.vx>0);move(-20,0);assert(e.player.vx<0 && e.player.vy===0);
move(0,10);assert(e.player.vx===0 && e.player.vy>0);
move(0,0);assert.equal(e.player.vx,0);assert.equal(e.player.vy,0);
move(20,0);ctx.handlePointerUp({pointerId:1});assert.equal(e.player.vx,0);assert.equal(e.player.vy,0);
reset();move(40,0,2);assert.equal(s.curX,200);
console.log('PASS fixed base, bounded knob, 8 directions, faster capped speed, proportional control, neutral/release, wall sliding in both directions, corner escape, 360-degree linear precision and input-time reversals.');

