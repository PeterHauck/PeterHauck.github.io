// Bringing a GEDCOM in: match what matches, show the rest, change nothing
// until it's been ticked.
// Run with:  node tests/run.mjs        (or node tests/gedcom-import.mjs)
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
// what the app already holds
const seed={title:'T',version:9,namesSplit:true,
  persons:[
    P({id:'k',name:'Konrad Hauck',first:'Konrad',last:'Hauck',sex:'male',birth:1864}),
    P({id:'j',name:'Jeffrey W. Nelson',first:'Jeffrey',middle:'W',last:'Nelson',sex:'male',birth:1955}),
    P({id:'g',name:'Gail Arlene Harris',first:'Gail',middle:'Arlene',last:'Harris',sex:'female'}),
    P({id:'b',name:'Barbara (Kaiser) Hauck',first:'Barbara',last:'Hauck',maiden:'Kaiser',sex:'female',birth:1894}),
  ],
  unions:[],links:[],manual:{k:{x:0,y:0},j:{x:200,y:0},g:{x:400,y:0},b:{x:600,y:0}},hidden:{},manualHidden:{},focus:[]};
// what the other program hands back
const ged=['0 HEAD','1 GEDC','2 VERS 5.5.1','2 FORM LINEAGE-LINKED','1 CHAR UTF-8',
  // same man, spelled the other way, with a place the app hasn't got
  '0 @I1@ INDI','1 NAME Conrad /Hauck/','2 GIVN Conrad','2 SURN Hauck','1 SEX M',
  '1 BIRT','2 DATE 1864','2 PLAC Odessa, Ukraine, Russia',
  // same man, spelled the other way again
  '0 @I2@ INDI','1 NAME Jeffery Wylum /Nelson/','2 GIVN Jeffery Wylum','2 SURN Nelson','1 SEX M','1 BIRT','2 DATE 12 MAR 1955',
  // already here, no dates either side — a likely match, not a certain one
  '0 @I3@ INDI','1 NAME Gail Arlene /Harris/','2 GIVN Gail Arlene','2 SURN Harris','1 SEX F','1 BIRT','2 DATE 1946',
  // already here, but the years disagree
  '0 @I4@ INDI','1 NAME Barbara /Kaiser/','2 GIVN Barbara','2 SURN Kaiser','1 SEX F','1 BIRT','2 DATE 1895',
  // nobody here by that name
  '0 @I5@ INDI','1 NAME Ruth Octavia /Hokenstad/','2 GIVN Ruth Octavia','2 SURN Hokenstad','1 SEX F',
  '1 BIRT','2 DATE 3 JUL 1900','2 PLAC Sioux Falls, Minnehaha, South Dakota, USA','1 DEAT','2 DATE 1961',
  '0 @I6@ INDI','1 NAME Edmond Theo /Hokenstad/','2 GIVN Edmond Theo','2 SURN Hokenstad','1 SEX M','1 BIRT','2 DATE 1901',
  // a family joining the two new people
  '0 @F1@ FAM','1 HUSB @I6@','1 WIFE @I5@','1 MARR','2 DATE 14 JUN 1925','2 PLAC Sioux Falls, South Dakota','1 CHIL @I1@',
  '0 TRLR'].join('\r\n')+'\r\n';
const tmp=path.join(os.tmpdir(),'in-'+Date.now()+'.ged'); fs.writeFileSync(tmp,ged);
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
ok('the app starts with four people', (await state()).persons.length===4, (await state()).persons.length);
await pg.evaluate(()=>{const m=document.getElementById('tbMenu'); if(m) m.click();});
await pg.waitForTimeout(500);
await pg.setInputFiles('#gedcomInput', tmp);
await pg.waitForSelector('.ged-review',{timeout:15000}); await pg.waitForTimeout(700);
ok('it opens a review instead of just doing it', true);
ok('nothing has changed yet', (await state()).persons.length===4, (await state()).persons.length);
const sections=await pg.evaluate(()=>[...document.querySelectorAll('.ged-sec h3')].map(h=>h.textContent));
ok('it offers the two people who are new', /People to add \(2\)/.test(sections.join('|')), JSON.stringify(sections));
ok('…and the details it can fill in', /Details to fill in/.test(sections.join('|')), JSON.stringify(sections));
ok('…and asks about the year that disagrees', /Disagreements \(1\)/.test(sections.join('|')), JSON.stringify(sections));
const rowText=await pg.evaluate(()=>[...document.querySelectorAll('.ged-row')].map(r=>r.textContent.replace(/\s+/g,' ').trim()));
ok('Conrad is matched to Konrad, not offered as new', !rowText.some(t=>/^Conrad Hauck/.test(t)), JSON.stringify(rowText.slice(0,6)));
ok('Jeffery is matched to Jeffrey', !rowText.some(t=>/^Jeffery Wylum Nelson b/.test(t)));
ok('the disagreement is NOT ticked by default', await pg.evaluate(()=>{
  const secs=[...document.querySelectorAll('.ged-sec')];
  const d=secs.find(s=>/Disagreements/.test(s.querySelector('h3').textContent));
  return [...d.querySelectorAll('input')].every(i=>!i.checked);}));
// take it
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>/bring these in/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(2500);
const after=await state();
const by=(n)=>after.persons.find(p=>new RegExp(n,'i').test(p.name||''));
ok('the two new people are in', after.persons.length===6, after.persons.length);
ok('…and nobody was duplicated', after.persons.filter(p=>/hauck/i.test(p.name)).length===2,
   after.persons.filter(p=>/hauck/i.test(p.name)).map(p=>p.name).join(', '));
ok('Konrad keeps his spelling', !!by('Konrad') && !by('Conrad'), (by('Konrad')||{}).name);
ok('…and gains the birth place the file had', (by('Konrad')||{}).birthPlace==='Odessa, Ukraine, Russia', (by('Konrad')||{}).birthPlace);
ok('Jeffrey gains the full birth date', (by('Jeffrey')||{}).birthDate==='1955-03-12', (by('Jeffrey')||{}).birthDate);
ok('Gail gains the year she was missing', (by('Gail')||{}).birth===1946, (by('Gail')||{}).birth);
ok('Barbara keeps HER year, not the file\'s', (by('Barbara')||{}).birth===1894, (by('Barbara')||{}).birth);
ok('a new person brought her dates and place with her',
   (by('Ruth')||{}).birthDate==='1900-07-03' && /Sioux Falls/.test((by('Ruth')||{}).birthPlace||''), JSON.stringify(by('Ruth')&&{b:by('Ruth').birthDate,p:by('Ruth').birthPlace}));
const ruth=by('Ruth'), ed=by('Edmond');
const u=(after.unions||[]).find(x=>[x.a,x.b].includes(ruth&&ruth.id)&&[x.a,x.b].includes(ed&&ed.id));
ok('the family in the file is recorded as a couple', !!u, JSON.stringify(u||null));
ok('…with its marriage date and place', !!u && u.marriage==='1925-06-14' && /Sioux Falls/.test(u.marriagePlace||''), JSON.stringify(u&&{m:u.marriage,p:u.marriagePlace}));
ok('…and their child linked to them', !!u && (after.links||[]).some(l=>l.union===u.id && l.child===(by('Konrad')||{}).id));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
fs.unlinkSync(tmp);
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
