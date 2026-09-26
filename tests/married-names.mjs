// A woman who married more than once carries more than one married name.
// Run with:  node tests/run.mjs        (or node tests/married-names.mjs)
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
// Verlyn, widowed, about to remarry
const persons=[
  {id:'v',name:'Verlyn Elaine (Taylor) Boyd',first:'Verlyn',middle:'Elaine',last:'Boyd',maiden:'Taylor',nickname:'',suffix:'',sex:'female',birth:1930,docs:[]},
  {id:'d',name:'Darrel E. Boyd',first:'Darrel',middle:'E',last:'Boyd',maiden:'',nickname:'',suffix:'',sex:'male',birth:1928,death:1990,deceased:true,docs:[]},
  {id:'n',name:'Roy Nelson',first:'Roy',middle:'',last:'Nelson',maiden:'',nickname:'',suffix:'',sex:'male',birth:1929,docs:[]}];
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,persons,
  unions:[{id:'u1',a:'d',b:'v',status:'married'}],links:[],
  manual:{v:{x:200,y:0},d:{x:0,y:0},n:{x:600,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
let pg=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
let asked=[]; let answer=true;
pg.on('dialog',async d=>{ asked.push(d.message()); if(answer) await d.accept(); else await d.dismiss(); });
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
  localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const shown=(id)=>pg.evaluate((id)=>{const g=[...document.querySelectorAll('g.person')].find(x=>x.getAttribute('data-id')===id);
  return g? [...g.querySelectorAll('text')].map(t=>t.textContent).join(' ') : null;},id);
const rec=(id)=>pg.evaluate((id)=>{const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  const p=st.persons.find(x=>x.id===id); return p? {name:p.name,last:p.last,prior:p.priorNames||[]} : null;},id);
ok('she starts as her first married name', (await shown('v')).includes('Boyd') && !(await shown('v')).includes('Nelson'),
   await shown('v'));
// --- the form offers a place for earlier married names, for women only
await pg.click('g.person[data-id="v"]'); await pg.waitForTimeout(400);
await pg.evaluate(()=>document.getElementById('personEditBtn').click()); await pg.waitForTimeout(400);
ok('her form has a box for earlier married names', await pg.evaluate(()=>{const f=document.getElementById('priorField');
  return !!f && !f.hidden;}));
await pg.evaluate(()=>{const i=document.getElementById('pPrior'); i.value='Boyd'; i.dispatchEvent(new Event('input',{bubbles:true}));
  const l=document.getElementById('pLast'); l.value='Nelson'; l.dispatchEvent(new Event('input',{bubbles:true}));});
await pg.waitForTimeout(300);
ok('…and says back the whole name as it will read',
   (await pg.evaluate(()=>document.getElementById('pPriorEcho').textContent))==='Verlyn Elaine (Taylor) Boyd Nelson',
   await pg.evaluate(()=>document.getElementById('pPriorEcho').textContent));
await pg.evaluate(()=>document.getElementById('personSubmit').click());
await pg.waitForTimeout(900);
ok('saving keeps both married names, in order', (await rec('v')).name==='Verlyn Elaine (Taylor) Boyd Nelson', JSON.stringify(await rec('v')));
ok('…and the tree shows them', (await shown('v')).includes('Boyd') && (await shown('v')).includes('Nelson'), await shown('v'));
ok('…with the current surname still the one on its own', (await rec('v')).last==='Nelson', JSON.stringify(await rec('v')));
// --- a man's form has no such box
await pg.click('g.person[data-id="n"]'); await pg.waitForTimeout(400);
await pg.evaluate(()=>document.getElementById('personEditBtn').click()); await pg.waitForTimeout(400);
ok('a man has no earlier-married-names box', await pg.evaluate(()=>document.getElementById('priorField').hidden));
await pg.evaluate(()=>document.getElementById('personCancel').click()); await pg.waitForTimeout(300);
// --- a fresh device, where she is still just Mrs Boyd: the app should offer
//     the second married name itself when the new husband is linked
await pg.close();
const ctx2=await browser.newContext({viewport:{width:1280,height:900}});
pg=await ctx2.newPage();
pg.on('pageerror',e=>errs.push(e.message));
pg.on('dialog',async d=>{ asked.push(d.message()); if(answer) await d.accept(); else await d.dismiss(); });
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
  localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
asked=[]; answer=true;
ok('she starts over as just Boyd', (await rec('v')).last==='Boyd', JSON.stringify(await rec('v')));
await pg.click('g.person[data-id="v"]'); await pg.waitForTimeout(500);
const linked=await pg.evaluate(()=>{
  const b=[...document.querySelectorAll('.rel-addbar button')].find(x=>/partner/i.test(x.textContent||''));
  if(b){ b.click(); return true; } return false;});
ok('her profile offers ＋ Partner', linked);
await pg.waitForTimeout(700);
await pg.evaluate(()=>{const sel=document.getElementById('ppWho'); sel.value='n'; sel.dispatchEvent(new Event('change',{bubbles:true}));});
await pg.waitForTimeout(200);
await pg.evaluate(()=>{const b=document.querySelector('.modal-backdrop [data-ok]'); if(b) b.click();});
await pg.waitForTimeout(1600);
ok('linking a second husband asks about her married name', asked.some(m=>/also known as Nelson/i.test(m)),
   JSON.stringify(asked.slice(0,2)));
ok('…and saying yes gives her both names', (await rec('v')).name==='Verlyn Elaine (Taylor) Boyd Nelson', JSON.stringify(await rec('v')));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
