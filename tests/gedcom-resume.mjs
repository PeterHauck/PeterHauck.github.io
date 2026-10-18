// Bringing a big file in a few people at a time: what you don't choose is
// left alone, and the same file picked up later remembers where you got to.
// Run with:  node tests/run.mjs        (or node tests/gedcom-resume.mjs)
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
  persons:[P({id:'me',name:'Peter Hauck',first:'Peter',last:'Hauck',sex:'male',birth:1980})],
  unions:[],links:[],manual:{me:{x:0,y:0}},hidden:{},manualHidden:{},focus:[]};
// four strangers and the family that ties them together
const ged=['0 HEAD','1 GEDC','2 VERS 5.5.1','2 FORM LINEAGE-LINKED','1 CHAR UTF-8',
  '0 @I1@ INDI','1 NAME Oscar /Fenn/','2 GIVN Oscar','2 SURN Fenn','1 SEX M','1 BIRT','2 DATE 1890',
  '0 @I2@ INDI','1 NAME Hilda /Rask/','2 GIVN Hilda','2 SURN Rask','1 SEX F','1 BIRT','2 DATE 1893',
  '0 @I3@ INDI','1 NAME Nils /Fenn/','2 GIVN Nils','2 SURN Fenn','1 SEX M','1 BIRT','2 DATE 1920',
  '0 @I4@ INDI','1 NAME Greta /Fenn/','2 GIVN Greta','2 SURN Fenn','1 SEX F','1 BIRT','2 DATE 1922',
  '0 @F1@ FAM','1 HUSB @I1@','1 WIFE @I2@','1 MARR','2 DATE 1919','1 CHIL @I3@','1 CHIL @I4@',
  '0 TRLR'].join('\r\n')+'\r\n';
const tmp=path.join(os.tmpdir(),'resume-'+Date.now()+'.ged'); fs.writeFileSync(tmp,ged);
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:1280,height:950}});
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
const openFile=async()=>{ await pg.evaluate(()=>{const m=document.getElementById('tbMenu'); if(m) m.click();});
  await pg.waitForTimeout(400);
  await pg.setInputFiles('#gedcomInput', tmp);
  await pg.waitForSelector('.ged-review',{timeout:15000}); await pg.waitForTimeout(700); };
const openRow=async(name)=>{ await pg.evaluate((n)=>{const r=[...document.querySelectorAll('.ged-prow')]
    .find(x=>x.querySelector('.ged-pname').textContent.includes(n)); if(r) r.click();},name);
  await pg.waitForSelector('.ged-person',{timeout:8000}); await pg.waitForTimeout(400); };
const decide=async(word)=>{ await pg.evaluate((w)=>{const b=[...document.querySelectorAll('.gp-foot button')]
    .find(x=>new RegExp(w,'i').test(x.textContent)); b.click();},word); await pg.waitForTimeout(400); };
const tally=()=>pg.evaluate(()=>document.querySelector('.ged-tally').textContent);

// --- first go: take one person, park another, leave the rest alone
await openFile();
ok('the file opens with nobody chosen', /^0 to bring in/.test(await tally()), await tally());
await openRow('Oscar'); await decide('accept');
await openRow('Hilda'); await decide('later');
ok('one chosen, one parked, two untouched', /^1 to bring in · 0 ignored · 1 left for later · 2 not looked at/.test(await tally()), await tally());
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>/bring these in/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(2500);
let after=await state();
ok('only that one person came in', after.persons.length===2, after.persons.map(p=>p.name).join(', '));
ok('…and it was the one chosen', after.persons.some(p=>/Oscar/.test(p.name)) && !after.persons.some(p=>/Hilda|Nils|Greta/.test(p.name)),
   after.persons.map(p=>p.name).join(', '));

// --- come back to it in a whole new session
await pg.reload({waitUntil:'networkidle'}); await pg.waitForTimeout(1800);
await openFile();
ok('the same file says where you got to', await pg.evaluate(()=>!!document.querySelector('.ged-resume')),
   await pg.evaluate(()=>(document.querySelector('.ged-resume')||{}).textContent||'(nothing)'));
ok('…the one already brought in is set aside', await pg.evaluate(()=>{
  const s=[...document.querySelectorAll('.ged-sec')].find(x=>/Already brought in/.test(x.querySelector('h3').textContent));
  return !!s && /Oscar/.test(s.textContent);}),
  await pg.evaluate(()=>[...document.querySelectorAll('.ged-sec h3')].map(h=>h.textContent).join(' | ')));
ok('…and cannot be brought in twice', await pg.evaluate(()=>{
  const r=[...document.querySelectorAll('.ged-prow')].find(x=>/Oscar/.test(x.textContent));
  return !!r && r.disabled;}));
ok('…the one you parked is still parked', /1 left for later/.test(await tally()), await tally());
ok('…and nothing is queued up behind your back', /^0 to bring in/.test(await tally()), await tally());

// --- second go: take the rest, and the family joins up across both visits
await pg.evaluate(()=>{[...document.querySelectorAll('.ged-sec')].forEach(s=>{
  if(/Already brought in/.test(s.querySelector('h3').textContent)) return;
  const b=[...s.querySelectorAll('.ged-bulk button')].find(x=>/accept all/i.test(x.textContent)); if(b) b.click();});});
await pg.waitForTimeout(400);
ok('the rest can be taken now', /^3 to bring in/.test(await tally()), await tally());
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>/bring these in/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(2500);
after=await state();
ok('everybody is in now', after.persons.length===5, after.persons.map(p=>p.name).join(', '));
ok('…and nobody came in twice', after.persons.filter(p=>/Oscar/.test(p.name)).length===1,
   after.persons.filter(p=>/Oscar/.test(p.name)).map(p=>p.name).join(', '));
const id=(n)=>(after.persons.find(p=>new RegExp(n).test(p.name))||{}).id;
const u=(after.unions||[]).find(x=>[x.a,x.b].includes(id('Oscar'))&&[x.a,x.b].includes(id('Hilda')));
ok('a couple split across two visits is still a couple', !!u, JSON.stringify(u||null));
ok('…with their children under them', !!u && ['Nils','Greta'].every(n=>(after.links||[]).some(l=>l.union===u.id&&l.child===id(n))),
   JSON.stringify((after.links||[]).filter(l=>u&&l.union===u.id).map(l=>l.child)));

// --- starting the sorting over
await openFile();
ok('a file you have sorted offers to start over', await pg.evaluate(()=>
  [...document.querySelectorAll('.ged-resume button')].some(b=>/start over/i.test(b.textContent))));
pg.once('dialog',d=>d.accept());
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-resume button')].find(x=>/start over/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(600);
ok('…which forgets the sorting but not the tree', !/already brought in/i.test(await tally()) && (await state()).persons.length===5,
   await tally());
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
fs.unlinkSync(tmp);
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
