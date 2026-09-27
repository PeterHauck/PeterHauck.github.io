// Trimming a photo in somebody's gallery: pull a box round the part you want.
// Run with:  node tests/run.mjs        (or node tests/photo-trim.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(u.pathname==='/api/store'){ if(q.method==='POST'){r.writeHead(200,{'content-type':'application/json'});return r.end('{}');}
    r.writeHead(404); return r.end('{}'); }
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const persons=[{id:'a',name:'Ada Test',first:'Ada',last:'Test',middle:'',nickname:'',maiden:'',suffix:'',sex:'female',birth:1900,docs:[]}];
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions:[],links:[],manual:{a:{x:0,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:1280,height:950}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
pg.on('dialog',async d=>{ await d.accept(); });
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
  localStorage.setItem('familyTree.importPass','x');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
await pg.click('g.person'); await pg.waitForTimeout(500);
// put a photo in her gallery: a wide picture, red down the left third, blue the rest
await pg.evaluate(async ()=>{
  const c=document.createElement('canvas'); c.width=600; c.height=300; const g=c.getContext('2d');
  g.fillStyle='#ff0000'; g.fillRect(0,0,200,300); g.fillStyle='#0000ff'; g.fillRect(200,0,400,300);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));
  const dt=new DataTransfer(); dt.items.add(new File([blob],'g.png',{type:'image/png'}));
  const box=document.getElementById('galleryBox');
  const inp=box.querySelector('input[type=file]') || document.querySelector('#galleryBox input[type=file]');
  if(inp){ inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); return 'input'; }
  return 'none';});
await pg.waitForTimeout(1800);
const shots=async()=>pg.evaluate(()=>document.querySelectorAll('.gal-cell').length);
ok('the photo is in her gallery', (await shots())>0, await shots());
ok('every gallery photo offers a trim', await pg.evaluate(()=>!!document.querySelector('.gal-cell .gal-cut')));
// the size of the picture before trimming
const sizeOf=()=>pg.evaluate(async ()=>{
  const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  const g=(st.persons[0].gallery||[])[0]; if(!g) return null;
  const src=g.data || await new Promise(r=>{const q=indexedDB.open('familyTreeMedia');q.onsuccess=()=>r(null);q.onerror=()=>r(null);});
  return {hasRef:!!g.ref, hasSrc:!!g.srcRef, trim:g.trim||null};});
ok('…and no trim recorded yet', !(await sizeOf()).trim, JSON.stringify(await sizeOf()));
// open the trimmer and pull the box onto the red third
await pg.evaluate(()=>document.querySelector('.gal-cell .gal-cut').click());
await pg.waitForSelector('.photo-crop',{timeout:8000}); await pg.waitForTimeout(400);
const stage=await pg.evaluate(()=>{const s=document.getElementById('pcStage');
  const r=s.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};});
ok('the trimmer shows the whole photo, wider than it is tall', stage.w>stage.h, JSON.stringify(stage));
// drag the south-east corner left, so only the red third is inside the box
const dragTo=async(sel,x,y)=>{ const h=await pg.evaluate((sel)=>{const e=document.querySelector(sel);
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};},sel);
  await pg.mouse.move(h.x,h.y); await pg.mouse.down();
  await pg.mouse.move(x,y,{steps:10}); await pg.mouse.up(); await pg.waitForTimeout(200); };
await pg.evaluate(()=>{const b=document.getElementById('pcAll'); b.click();});   // start from the whole photo
await pg.waitForTimeout(200);
await dragTo('.pc-rect i[data-h="se"]', stage.x+stage.w*0.33, stage.y+stage.h);
const rect=await pg.evaluate(()=>{const r=document.getElementById('pcRect').getBoundingClientRect();
  const s=document.getElementById('pcStage').getBoundingClientRect();
  return {w:Math.round(r.width/s.width*100), h:Math.round(r.height/s.height*100)};});
ok('pulling a corner narrows the box', rect.w<45 && rect.w>18, JSON.stringify(rect));
await pg.evaluate(()=>document.getElementById('pcOk').click());
await pg.waitForTimeout(2000);
const after=await sizeOf();
ok('the trim is remembered', !!after.trim && after.trim.w<0.45, JSON.stringify(after.trim));
ok('…and the untrimmed photo is kept behind it', after.hasSrc, JSON.stringify(after));
// what's left should be red, with no blue in it
const colours=await pg.evaluate(async ()=>{
  const img=document.querySelector('.gal-cell img');
  const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
  c.getContext('2d').drawImage(img,0,0);
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let red=0,blue=0; for(let i=0;i<d.length;i+=4){ if(d[i]>150&&d[i+2]<100) red++; if(d[i+2]>150&&d[i]<100) blue++; }
  return {red,blue,w:c.width,h:c.height};});
ok('most of the photo has been trimmed away', colours.w < 600*0.45 && colours.w > 60,
   JSON.stringify({wasWide:600, nowWide:colours.w}));
ok('…and what is left is the part inside the box', colours.blue < colours.red/8 && colours.red>100,
   JSON.stringify(colours));
ok('…at its full height, since the box was not shortened', colours.h===300, JSON.stringify(colours));
// trimming again works from the original, so it can be widened back out
await pg.evaluate(()=>document.querySelector('.gal-cell .gal-cut').click());
await pg.waitForSelector('.photo-crop',{timeout:8000}); await pg.waitForTimeout(500);
const again=await pg.evaluate(()=>{const s=document.getElementById('pcStage').getBoundingClientRect();
  const r=document.getElementById('pcRect').getBoundingClientRect();
  return {stageRatio:+(s.width/s.height).toFixed(2), boxPct:Math.round(r.width/s.width*100)};});
ok('trimming again starts from the whole original, not the trim', again.stageRatio>1.5, JSON.stringify(again));
ok('…with the box where you left it', again.boxPct<45, JSON.stringify(again));
await pg.evaluate(()=>{const b=document.querySelector('.photo-crop [data-cancel]'); b.click();});
await pg.waitForTimeout(300);
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
