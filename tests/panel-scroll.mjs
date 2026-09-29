// The panels that float over the tree scroll on their own, and their bottoms
// stay on the screen however tall the toolbar is.
// Run with:  node tests/run.mjs        (or node tests/panel-scroll.mjs)
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
// enough people that the list is far longer than the panel
const persons=[],manual={};
for(let i=0;i<364;i++){ const id='p'+i;
  persons.push({id,name:'Person'+String(i).padStart(3,'0')+' Kin',first:'Person'+String(i).padStart(3,'0'),last:'Kin',
    middle:'',nickname:'',maiden:'',suffix:'',sex:i%2?'female':'male',birth:1900+(i%80),docs:[]});
  manual[id]={x:(i%40)*180,y:Math.floor(i/40)*250}; }
const seed={title:'T',version:9,namesSplit:true,persons,unions:[],links:[],manual,hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const errs=[];
// a narrow-ish window, so the toolbar wraps onto two rows as it does in life
const pg=await browser.newPage({viewport:{width:820,height:900}});
pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.removeItem('familyTree.lastView');
  localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1800);
await pg.evaluate(()=>document.getElementById('tbMenu').click());
await pg.waitForTimeout(700);
ok('the list of people opens', await pg.evaluate(()=>{const m=document.getElementById('peopleMenu'); return !!m && !m.hidden;}));
const box=await pg.evaluate(()=>{const m=document.getElementById('peopleMenu');
  const r=m.getBoundingClientRect();
  const tb=document.getElementById('toolbar').getBoundingClientRect();
  return {top:Math.round(r.top), bottom:Math.round(r.bottom), h:window.innerHeight, tbRows:Math.round(tb.height)};});
ok('the toolbar is more than one row tall here', box.tbRows>90, JSON.stringify(box));
ok('the panel fits on the screen', box.bottom <= box.h, JSON.stringify(box));
ok('…including the buttons along its bottom', await pg.evaluate(()=>{
  const b=document.querySelector('#peopleMenu .pm-actions'); if(!b) return false;
  const r=b.getBoundingClientRect(); return r.bottom<=window.innerHeight+1 && r.top>=0;}));
// scrolling the list must scroll the list, not zoom the tree
const zoom=()=>pg.evaluate(()=>+document.getElementById('zoomLabel').textContent.replace('%',''));
const listTop=()=>pg.evaluate(()=>{const l=document.querySelector('#peopleMenu .people-list'); return l? Math.round(l.scrollTop) : -1;});
ok('the list is longer than the space for it', await pg.evaluate(()=>{const l=document.querySelector('#peopleMenu .people-list');
  return l.scrollHeight > l.clientHeight + 40;}));
const zoomBefore=await zoom();
const spot=await pg.evaluate(()=>{const l=document.querySelector('#peopleMenu .people-list');
  const r=l.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};});
await pg.mouse.move(spot.x,spot.y);
for(let i=0;i<5;i++){ await pg.mouse.wheel(0,220); await pg.waitForTimeout(120); }
await pg.waitForTimeout(400);
ok('scrolling over the list scrolls the list', (await listTop())>200, await listTop());
ok('…and does not zoom the tree', (await zoom())===zoomBefore, JSON.stringify({before:zoomBefore, after:await zoom()}));
ok('…so you can reach the end of it', await pg.evaluate(()=>{const l=document.querySelector('#peopleMenu .people-list');
  l.scrollTop=l.scrollHeight; return l.scrollTop+l.clientHeight >= l.scrollHeight-2;}));
// over the board itself, the wheel still zooms
const onBoard=await pg.evaluate(()=>{const s=document.getElementById('stage').getBoundingClientRect();
  return {x:Math.round(s.right-80), y:Math.round(s.bottom-120)};});
await pg.mouse.move(onBoard.x,onBoard.y);
await pg.mouse.wheel(0,-240); await pg.waitForTimeout(400);
ok('the wheel still zooms over the board', (await zoom())>zoomBefore, JSON.stringify({before:zoomBefore, after:await zoom()}));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
