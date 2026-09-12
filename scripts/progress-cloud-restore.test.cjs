const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync('lib/progressCloud.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
const data=new Map();const timers=new Map();let id=0,reads=0,ready=[],events=0,resolveAuth;
const authReady=new Promise(resolve=>resolveAuth=resolve);
const windowTarget=new EventTarget();windowTarget.addEventListener('sd:progress-restored',()=>events++);
const docTarget=new EventTarget();docTarget.visibilityState='visible';
const ctx=vm.createContext({window:windowTarget,document:docTarget,Event,console,
 initFirebase:()=>({db:{},auth:{authStateReady:()=>authReady}}),doc:()=>({}),
 getDoc:async()=>{reads++;if(reads===1)throw Error('temporary offline');return {exists:()=>true,data:()=>({xp:12400,scores:{},streak:null,weekly:null})};},
 setDoc:async()=>{},deleteDoc:async()=>{},serverTimestamp:()=>0,reconcileDrillBests:async()=>{},
 Storage:{getJSON:async(k,d)=>data.has(k)?data.get(k):d,setJSON:async(k,v)=>data.set(k,v),set:async(k,v)=>data.set(k,v)},
 setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key),
});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 vm.runInContext(source,ctx);
 const stop=ctx.startProgressCloudSync('account',{onReady:ok=>ready.push(ok)});
 await settle();assert.equal(reads,0,'must await real auth before protected read');
 resolveAuth();await settle();assert.deepEqual(ready,[false]);assert(timers.size>0);
 windowTarget.dispatchEvent(new Event('online'));await settle();await settle();
 assert.equal(data.get('sd_xp'),12400);assert.deepEqual(ready,[false,true]);assert.equal(events,1);
 assert.equal(timers.size,0);stop();
 const stopAgain=ctx.startProgressCloudSync('account',{onReady:ok=>ready.push(ok)});
 await settle();await settle();assert.equal(events,2,'unchanged restore still announces readiness');
 stopAgain();const count=reads;windowTarget.dispatchEvent(new Event('online'));await settle();assert.equal(reads,count);
 console.log('PASS actual cloud restore: auth readiness, offline retry, persisted XP before notification, unchanged restore and cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
