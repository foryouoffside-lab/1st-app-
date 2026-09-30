const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('contexts/PlayerProgressContext.js','utf8');
const start=source.indexOf('  useEffect(() => {');
const end=source.indexOf('  }, [uid]);',start)+'  }, [uid]);'.length;
const reads=[];const windowTarget=new EventTarget();const doc=new EventTarget();doc.visibilityState='visible';
let cleanup,onReady,state,stopped=0;
const ctx=vm.createContext({uid:'account-a', useEffect:effect=>{cleanup=effect();},setState:value=>{state=value;},
 getPlayerLevel:()=>new Promise(resolve=>reads.push(resolve)), getStreak:async()=>({current:3}),getTopScores:async()=>[],
 window:windowTarget,document:doc,startProgressCloudSync:(uid,opts)=>{onReady=opts.onReady;return()=>stopped++;}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const level=n=>({level:n,xp:(n-1)*1000+200,xpInLevel:200,xpToNext:800});
(async()=>{
 vm.runInContext(source.slice(start,end),ctx);
 // Local-first: the device copy is read immediately, no cloud wait.
 assert.equal(reads.length,1);assert.equal(state.progress,null);
 // Empty device (reinstall): keep "Restoring" until the cloud answers.
 reads[0]({level:1,xp:0,xpInLevel:0,xpToNext:1000});await settle();assert.equal(state.status,'loading');assert.equal(state.progress,null);
 onReady(false);reads[1]({level:1,xp:0,xpInLevel:0,xpToNext:1000});await settle();assert.equal(state.status,'unavailable');assert.equal(state.progress,null);
 onReady(true);reads[2](level(12));await settle();assert.equal(state.progress.level,12);assert.equal(state.status,'ready');
 // A finished drill refreshes the card; a stale read never overwrites a newer one.
 windowTarget.dispatchEvent(new Event('sd:progress-changed'));
 windowTarget.dispatchEvent(new Event('sd:progress-restored'));
 reads[4](level(13));await settle();reads[3](level(1));await settle();assert.equal(state.progress.level,13);
 cleanup();assert.equal(stopped,1);
 // Account switch: nothing from account A leaks; B's device data shows at once.
 ctx.uid='account-b';vm.runInContext(source.slice(start,end),ctx);assert.equal(state.progress,null);
 reads[5](level(7));await settle();assert.equal(state.progress.level,7);assert.equal(state.status,'offline');
 onReady(true);reads[6](level(7));await settle();assert.equal(state.status,'ready');cleanup();
 // Cloud unreachable but the device has progress: shown, and it stays shown.
 ctx.uid='offline-account';vm.runInContext(source.slice(start,end),ctx);
 reads[7](level(9));await settle();assert.equal(state.progress.level,9);assert.equal(state.status,'offline');
 onReady(false);reads[8](level(9));await settle();assert.equal(state.progress.level,9);assert.equal(state.status,'offline');
 windowTarget.dispatchEvent(new Event('sd:progress-changed'));reads[9](level(10));await settle();assert.equal(state.progress.level,10);cleanup();
 for(const file of ['app/HomePageClient.js','app/progress/ProgressClient.js']) {
  const consumer=fs.readFileSync(file,'utf8');assert(consumer.includes('usePlayerProgress()'));assert(!consumer.includes('getPlayerLevel()'));
 }
 console.log('PASS local-first snapshot, empty-device wait, failed restore, post-drill refresh without cloud, stale reads and account switch.');
})().catch(error=>{console.error(error);process.exitCode=1;});
