// Bringing a GEDCOM in from a phone. The side panel is desktop-only, so the
// way in has to be the ☰ sheet — and the whole review has to work at 390px.
// Run with:  node tests/run.mjs        (or node tests/gedcom-phone.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(u.pathname==='/api/store'){ if(q.method==='POST'){r.writeHead(200,{'content-type':'application/json'});return r.end('{}');}
    r.writeHead(404); return r.end('{}'); }
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const P=(o)=>Object.assign({middle:'',nickname:'',maiden:'',suffix:'',docs:[]},o);
const seed={title:'T',version:9,namesSplit:true,
  persons:[P({id:'w',name:'Walter Lind',first:'Walter',last:'Lind',sex:'male',birth:1901})],
  unions:[],links:[],manual:{w:{x:0,y:0}},hidden:{},manualHidden:{},focus:[]};
const ged=['0 HEAD','1 GEDC','2 VERS 5.5.1','2 FORM LINEAGE-LINKED','1 CHAR UTF-8',
  '0 @I1@ INDI','1 NAME Walter /Lind/','2 GIVN Walter','2 SURN Lind','1 SEX M','1 BIRT','2 DATE 1901','2 PLAC Rock County, Minnesota',
  '0 @I2@ INDI','1 NAME Esther /Lind/','2 GIVN Esther','2 SURN Lind','1 SEX F','1 BIRT','2 DATE 1904',
  '0 @F1@ FAM','1 HUSB @I1@','1 WIFE @I2@',
  '0 TRLR'].join('\r\n')+'\r\n';
const tmp=path.join(os.tmpdir(),'phone-'+Date.now()+'.ged'); fs.writeFileSync(tmp,ged);
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
  localStorage.setItem('familyTree.importPass','x');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const state=()=>pg.evaluate(async ()=>{
  const idb=await new Promise(res=>{const q=indexedDB.open('familyTreeDB');
    q.onsuccess=()=>{const db=q.result; if(!db.objectStoreNames.contains('kv')) return res(null);
      const t=db.transaction('kv','readonly').objectStore('kv').get('tree.v1');
      t.onsuccess=()=>res(t.result||null); t.onerror=()=>res(null);}; q.onerror=()=>res(null);});
  return idb || JSON.parse(localStorage.getItem('familyTree.v1')||'{}');});

ok('the side panel really is out of reach on a phone', await pg.evaluate(()=>{
  const b=document.getElementById('gedcomInBtn'); return !!b && !b.offsetParent;}));
// the ☰ that IS on screen
await pg.evaluate(()=>document.getElementById('tbViews').click());
await pg.waitForSelector('.vsheet',{timeout:8000}); await pg.waitForTimeout(400);
const rows=await pg.evaluate(()=>[...document.querySelectorAll('.vsheet .vs-row')].map(b=>b.textContent));
ok('the ☰ sheet offers to bring a GEDCOM in', rows.some(x=>/bring in a gedcom/i.test(x)), JSON.stringify(rows));
ok('…and to send one out', rows.some(x=>/export for ancestry/i.test(x)), JSON.stringify(rows));
// a file picker inside something the phone stylesheet hides is a picker you
// can't be sure will open — it lives at the top level now
const pickerHome=()=>pg.evaluate(()=>{const i=document.getElementById('gedcomInput');
  if(!i) return null; let n=i.parentElement, buried=null;
  while(n && n!==document.body){ if(getComputedStyle(n).display==='none') buried='#'+(n.id||n.className); n=n.parentElement; }
  return {parent:i.parentElement.tagName, buried};});
ok('the file picker is not buried in something phones hide', await pickerHome().then(r=>r && !r.buried), JSON.stringify(await pickerHome()));
// the sheet closes and hands over to the picker; drive the picker directly
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.vsheet .vs-row')].find(x=>/bring in a gedcom/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);
ok('…and the sheet gets out of the way', await pg.evaluate(()=>!document.querySelector('.vsheet')));
await pg.setInputFiles('#gedcomInput', tmp);
await pg.waitForSelector('.ged-review',{timeout:15000}); await pg.waitForTimeout(700);
ok('the review opens on a phone', true);
const fits=(sel)=>pg.evaluate((s)=>{const m=document.querySelector(s); if(!m) return null;
  const r=m.getBoundingClientRect(); return {w:Math.round(r.width), screen:innerWidth, over:document.documentElement.scrollWidth>innerWidth+1};},sel);
let f=await fits('.ged-review');
ok('…without running off the side', f && f.w<=f.screen && !f.over, JSON.stringify(f));
ok('…and with the pick boxes big enough to hit', await pg.evaluate(()=>{
  const c=document.querySelector('input.ged-pick'); if(!c) return null;
  const r=c.getBoundingClientRect(); return r.width>=12 && r.height>=12;}));
await pg.evaluate(()=>{const r=[...document.querySelectorAll('.ged-prow')].find(x=>/Walter/.test(x.textContent)); r.click();});
await pg.waitForSelector('.ged-person',{timeout:8000}); await pg.waitForTimeout(500);
f=await fits('.ged-person');
ok('a person card fits the screen too', f && f.w<=f.screen && !f.over, JSON.stringify(f));
ok('…with its buttons reachable', await pg.evaluate(()=>{
  const b=document.querySelector('.ged-person .gp-foot'); const r=b.getBoundingClientRect();
  return r.top>=0 && r.bottom<=innerHeight+1;}),
  await pg.evaluate(()=>{const r=document.querySelector('.ged-person .gp-foot').getBoundingClientRect();
    return JSON.stringify({top:Math.round(r.top),bottom:Math.round(r.bottom),h:innerHeight});}));
await pg.evaluate(()=>{const b=document.querySelector('.ged-person .gp-editbtn'); b.click();});
await pg.waitForSelector('.gp-edit',{timeout:8000}); await pg.waitForTimeout(400);
f=await fits('.gp-edit');
ok('the editor fits as well', f && f.w<=f.screen && !f.over, JSON.stringify(f));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-edit .btn-row button')].find(x=>/cancel/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(200);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>/bring these in/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(2500);
const after=await state();
ok('and a phone can actually bring somebody in', after.persons.length===1
   && /Rock County/.test((after.persons[0]||{}).birthPlace||''),
   JSON.stringify(after.persons.map(p=>({n:p.name,b:p.birthPlace}))));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
fs.unlinkSync(tmp);
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
