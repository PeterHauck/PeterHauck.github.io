// Moving about on a phone: a flick throws the board, and Find jumps to anybody.
// Run with:  node tests/run.mjs        (or node tests/mobile-nav.mjs)
// Playwright from wherever it lives: the project's own copy, or one installed
// globally (point PLAYWRIGHT_MODULE at it if it is somewhere unusual).
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
// the site being tested: the family-tree folder next door, unless told otherwise
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(u.pathname==='/api/store'){r.writeHead(q.method==='GET'?404:200);return r.end('{}');}
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
// a board shaped like the real one: generations stacked in rows, each row
// running the whole width, so any strip of it you look at is several rows deep
const COLS=60, ROWS=6, SP=600;
const persons=[],manual={};
for(let i=0;i<COLS*ROWS;i++){ const id='p'+i;
  persons.push({id,name:'Person'+i+' Wide',first:'Person'+i,last:'Wide',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1900+i,docs:[]});
  manual[id]={x:(i%COLS)*SP, y:Math.floor(i/COLS)*250}; }
persons.push({id:'zoe',name:'Zoe Faraway',first:'Zoe',last:'Faraway',middle:'',nickname:'',maiden:'',suffix:'',sex:'female',birth:1980,docs:[]});
manual['zoe']={x:COLS*SP+SP,y:0};
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions:[],links:[],manual,hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:390,height:840},isMobile:true,hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const tx=()=>pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t); return {x:+m[1],y:+m[2],s:+/scale\(([-\d.]+)\)/.exec(t)[1]};});
// a flick: a short, quick swipe
const flick=(px,ms)=>pg.evaluate(async({px,ms})=>{
  const svg=document.getElementById('svg');
  const steps=6, dt=ms/steps;
  const fire=(t,x,y)=>svg.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:4,isPrimary:true,pointerType:'touch'}));
  let x=300; const y=500;
  fire('pointerdown',x,y);
  for(let i=1;i<=steps;i++){ x=300-(px*i/steps); fire('pointermove',x,y); await new Promise(r=>setTimeout(r,dt)); }
  fire('pointerup',x,y);
},{px,ms});
// --- a flick carries on after the finger lifts
const before=await tx();
await flick(200,80);                 // 200px in ~80ms — a quick flick
const justAfter=await tx();
await pg.waitForTimeout(900);
const settled=await tx();
ok('the swipe itself moves the board', Math.abs(justAfter.x-before.x)>150, JSON.stringify({before,justAfter}));
ok('and it keeps travelling after the finger lifts', (before.x-settled.x) > (before.x-justAfter.x)+120,
   JSON.stringify({swipe:before.x-justAfter.x, total:before.x-settled.x}));
ok('a small flick covers much more ground than the finger did', (before.x-settled.x) > 400,
   JSON.stringify({fingerMoved:200, boardMoved:Math.round(before.x-settled.x)}));
await pg.waitForTimeout(1400);   // the throw eases out over about a second and a half
ok('…and it comes to a stop', await (async()=>{const a=await tx(); await pg.waitForTimeout(500); const b=await tx(); return Math.abs(a.x-b.x)<0.5;})());
// --- a slow drag lands where you put it
const slowBefore=await tx();
await flick(120,700);                // same sort of distance, taken slowly
await pg.waitForTimeout(700);
const slowAfter=await tx();
ok('a slow drag stops where the finger stops', Math.abs((slowBefore.x-slowAfter.x)-120)<40,
   JSON.stringify({moved:Math.round(slowBefore.x-slowAfter.x)}));
// --- touching the board stops a throw dead
await flick(220,80);
await pg.waitForTimeout(60);
// touch it and read where it stopped in the same breath — a throw at full
// speed covers ground while a separate measurement is being fetched
const mid=await pg.evaluate(()=>{const svg=document.getElementById('svg');
  svg.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:200,clientY:400,pointerId:9,isPrimary:true,pointerType:'touch'}));
  svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:200,clientY:400,pointerId:9,isPrimary:true,pointerType:'touch'}));
  const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t); return {x:+m[1],y:+m[2]};});
await pg.waitForTimeout(500);
const stopped=await tx();
ok('a finger on the board stops the throw', Math.abs(stopped.x-mid.x)<2, JSON.stringify({mid:Math.round(mid.x),stopped:Math.round(stopped.x)}));
// --- find someone and jump to them
ok('the phone has a Find button', await pg.evaluate(()=>{const b=document.getElementById('tbFind');
  return !!b && getComputedStyle(b).display!=='none';}));
await pg.evaluate(()=>document.getElementById('tbFind').click());
await pg.waitForTimeout(400);
ok('it opens a sheet with everyone in it', await pg.evaluate(()=>document.querySelectorAll('#findSheetBack .find-row').length>10),
   await pg.evaluate(()=>document.querySelectorAll('#findSheetBack .find-row').length));
await pg.evaluate(()=>{const b=document.querySelector('.find-box'); b.value='zoe'; b.dispatchEvent(new Event('input',{bubbles:true}));});
await pg.waitForTimeout(300);
ok('typing narrows it to the one you want', await pg.evaluate(()=>{
  const rows=[...document.querySelectorAll('.find-row .find-name')].map(n=>n.textContent);
  return rows.length===1 && /Zoe/.test(rows[0]);}), await pg.evaluate(()=>[...document.querySelectorAll('.find-row .find-name')].map(n=>n.textContent).join('|')));
await pg.evaluate(()=>document.querySelector('.find-row').click());
await pg.waitForTimeout(600);
ok('tapping a name closes the sheet', !(await pg.evaluate(()=>!!document.getElementById('findSheetBack'))));
const land=await pg.evaluate(()=>{
  const g=[...document.querySelectorAll('g.person')].find(x=>x.getAttribute('data-id')==='zoe');
  const r=g.getBoundingClientRect();
  return {onScreen:r.x>-50&&r.x<window.innerWidth+50&&r.y>-50&&r.y<window.innerHeight+50,
          middle:Math.abs((r.x+r.width/2)-window.innerWidth/2)<120, ringed:g.getAttribute('class').includes('selected')};});
ok('…and lands them in the middle of the screen', land.onScreen && land.middle, JSON.stringify(land));
ok('…with a ring round them', land.ringed, JSON.stringify(land));
ok('…at a size you can read', (await tx()).s>=0.75, JSON.stringify(await tx()));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
