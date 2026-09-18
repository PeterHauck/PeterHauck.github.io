// Press and hold a bare patch of board on a phone, then steer with the thumb.
// Run with:  node tests/run.mjs        (or node tests/mobile-sweep.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(u.pathname==='/api/store'){r.writeHead(q.method==='GET'?404:200);return r.end('{}');}
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const persons=[],manual={};
for(let i=0;i<30;i++){ const id='p'+i;
  persons.push({id,name:'Person'+i+' Wide',first:'Person'+i,last:'Wide',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1900+i,docs:[]});
  manual[id]={x:i*900,y:(i%3)*250}; }
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions:[],links:[],manual,hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:390,height:840},isMobile:true,hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const tx=()=>pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t); return {x:+m[1],y:+m[2]};});
const touch=(type,x,y,id)=>pg.evaluate(({type,x,y,id})=>{
  const svg=document.getElementById('svg');
  const ev=new PointerEvent(type,{bubbles:true,clientX:x,clientY:y,pointerId:id||5,isPrimary:true,pointerType:'touch'});
  svg.dispatchEvent(ev);},{type,x,y,id});
const marked=()=>pg.evaluate(()=>!!document.getElementById('sweepMark'));

/* ---- hold, then steer ---- */
await touch('pointerdown',200,500);
await pg.waitForTimeout(150);
ok('a moment in, it is still just a press', !(await marked()));
await pg.waitForTimeout(400);
ok('held still, the thumb becomes a sweep', await marked());
const start=await tx();
await touch('pointermove',260,500);        // 60px to the right of where it landed
await pg.waitForTimeout(700);
const rightish=await tx();
// the thumb points the way you want to go: push it right and you travel right
// across the tree, for as long as it's held there
ok('pushing the thumb right travels right across the tree', (start.x-rightish.x)>200, JSON.stringify({moved:Math.round(start.x-rightish.x)}));
ok('…and it keeps going while the thumb is held there', await (async()=>{
  const a=await tx(); await pg.waitForTimeout(400); const b=await tx(); return (a.x-b.x)>100;})());
// further out = faster
const slowFrom=await tx();
await touch('pointermove',215,500);        // just 15px out: barely moving
await pg.waitForTimeout(500);
const slowTo=await tx();
const nearSpeed=Math.abs(slowTo.x-slowFrom.x);
await touch('pointermove',340,500);        // 140px out: a good clip
const fastFrom=await tx();
await pg.waitForTimeout(500);
const fastTo=await tx();
const farSpeed=Math.abs(fastTo.x-fastFrom.x);
ok('a little further out scrolls faster', farSpeed > nearSpeed*3, JSON.stringify({near:Math.round(nearSpeed),far:Math.round(farSpeed)}));
ok('a thumb barely off centre barely moves', nearSpeed<220, JSON.stringify({near:Math.round(nearSpeed)}));
// up and down as well
const upFrom=await tx();
await touch('pointermove',200,380);
await pg.waitForTimeout(500);
const upTo=await tx();
ok('pushing it up travels up the tree', (upTo.y-upFrom.y)>200, JSON.stringify({moved:Math.round(upTo.y-upFrom.y)}));
// lifting stops it
await touch('pointerup',200,380);
await pg.waitForTimeout(120);
const liftA=await tx(); await pg.waitForTimeout(500); const liftB=await tx();
ok('lifting the thumb stops it', Math.abs(liftA.x-liftB.x)<1 && Math.abs(liftA.y-liftB.y)<1, JSON.stringify({liftA,liftB}));
ok('…and the mark goes away', !(await marked()));
/* ---- moving straight away is an ordinary drag ---- */
const dragFrom=await tx();
await touch('pointerdown',200,500,7);
await pg.waitForTimeout(60);
await touch('pointermove',150,500,7);
await pg.waitForTimeout(500);
ok('a thumb that moves at once never starts a sweep', !(await marked()));
const dragTo=await tx();
ok('…it just drags, one for one', Math.abs((dragFrom.x-dragTo.x)-50)<12, JSON.stringify({moved:Math.round(dragFrom.x-dragTo.x)}));
await touch('pointerup',150,500,7);
await pg.waitForTimeout(400);
/* ---- holding a PERSON is not a sweep ---- */
await pg.evaluate(()=>{const g=document.querySelector('g.person');const r=g.querySelector('.shape').getBoundingClientRect();
  g.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,pointerId:8,isPrimary:true,pointerType:'touch'}));});
await pg.waitForTimeout(600);
ok('holding somebody does not start a sweep', !(await marked()));
await touch('pointerup',200,500,8);
await pg.waitForTimeout(400);
/* ---- a mouse press-and-hold is left alone (the computer has its own menu) ---- */
await pg.evaluate(()=>{const svg=document.getElementById('svg');
  svg.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:200,clientY:600,pointerId:11,isPrimary:true,pointerType:'mouse'}));});
await pg.waitForTimeout(600);
ok('a held mouse button never sweeps', !(await marked()));
await pg.evaluate(()=>{const svg=document.getElementById('svg');
  svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:200,clientY:600,pointerId:11,isPrimary:true,pointerType:'mouse'}));});
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
