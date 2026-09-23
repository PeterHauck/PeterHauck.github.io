// Two devices, one site. A change made on either shows up on the other when you
// hit ⟳, neither one ever goes backwards, and a delete stays deleted.
// Run with:  node tests/run.mjs        (or node tests/two-devices.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
// A stand-in for the real site: keeps one encrypted tree in memory, and refuses
// a save that was built on a copy older than the one it holds (same as the real
// one), so "neither side goes backwards" is actually being enforced here.
const cloud={payload:'',check:'',savedAt:0,media:new Map()};
const body=(q)=>new Promise(r=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{try{r(JSON.parse(b||'{}'));}catch(e){r({});}})});
const server=http.createServer(async (q,r)=>{const u=new URL(q.url,'http://x');
  const send=(code,o)=>{r.writeHead(code,{'content-type':'application/json'});r.end(JSON.stringify(o));};
  if(u.pathname==='/api/store'){
    if(q.method==='GET'){
      const a=u.searchParams.get('action');
      if(a==='treeInfo') return send(200,{exists:!!cloud.savedAt,savedAt:cloud.savedAt});
      if(a==='getTree') return cloud.savedAt? send(200,{payload:cloud.payload,savedAt:cloud.savedAt,v:1}) : send(404,{});
      if(a==='getMedia'){const id=u.searchParams.get('id'); const m=cloud.media.get(id);
        return m? send(200,{payload:m}) : send(404,{});}
      if(a==='status') return send(200,{githubConnected:true,blobStoreConnected:true,importPasscodeSet:true});
      return send(404,{});
    }
    const j=await body(q);
    if(j.action==='checkPasscode') return j.passcode? send(200,{ok:true}) : send(401,{error:'no'});
    if(j.action==='putMedia'){(j.items||[]).forEach(i=>cloud.media.set(i.id,i.payload)); return send(200,{ok:true});}
    if(j.action==='saveTree'){
      if(cloud.savedAt && (+j.base||0)!==cloud.savedAt) return send(409,{savedAt:cloud.savedAt});
      cloud.payload=j.payload; cloud.check=j.check||''; cloud.savedAt=Date.now();
      return send(200,{savedAt:cloud.savedAt});
    }
    return send(200,{});
  }
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);
  if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const person=(id,first)=>({id,name:first+' Kin',first,last:'Kin',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1900,docs:[]});
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,
  persons:[person('ada','Ada'),person('bob','Bob'),person('cid','Cid')],
  unions:[],links:[],manual:{ada:{x:0,y:0},bob:{x:200,y:0},cid:{x:400,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const errs=[];
// a device: its own browser profile, holding the family password but NOT the
// site passcode — exactly the state a freshly-opened browser is in
const device=async(label)=>{
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  const pg=await ctx.newPage();
  pg.on('pageerror',e=>errs.push(label+': '+e.message));
  pg.on('dialog',async d=>{ await d.accept(); });
  await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
    localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
  await pg.goto(base,{waitUntil:'networkidle'});
  await pg.waitForTimeout(2600);
  return pg;
};
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const names=(pg)=>pg.evaluate(()=>[...document.querySelectorAll('g.person')].map(g=>g.getAttribute('data-id')).sort());
const sync=async(pg)=>{ await pg.evaluate(()=>document.getElementById('tbSync').click()); await pg.waitForTimeout(3000); };

const desk=await device('desktop');
ok('a browser with the family password can save to the site without a second passcode',
   await desk.evaluate(()=>!!localStorage.getItem('familyTree.importPass')));
ok('the desktop starts with all three', (await names(desk)).join(',')==='ada,bob,cid', (await names(desk)).join(','));

const phone=await device('phone');
ok('the phone starts with all three too', (await names(phone)).join(',')==='ada,bob,cid', (await names(phone)).join(','));

// --- delete Bob on the desktop
await desk.click('g.person[data-id="bob"]');
await desk.waitForTimeout(400);
await desk.evaluate(()=>document.getElementById('personEditBtn').click());
await desk.waitForTimeout(400);
await desk.evaluate(()=>document.getElementById('personDelete').click());
await desk.waitForTimeout(3500);
ok('the desktop has deleted Bob', !(await names(desk)).includes('bob'), (await names(desk)).join(','));
ok('…and the change reached the site on its own', await desk.evaluate(()=>+(localStorage.getItem('familyTree.cloudSavedAt')||0)>0));

// --- the phone hits sync
await sync(phone);
ok('hitting sync on the phone removes Bob there too', !(await names(phone)).includes('bob'), (await names(phone)).join(','));
ok('…and keeps everybody else', (await names(phone)).join(',')==='ada,cid', (await names(phone)).join(','));

// --- the phone makes its own change
await phone.click('g.person[data-id="cid"]');
await phone.waitForTimeout(400);
await phone.evaluate(()=>document.getElementById('personEditBtn').click());
await phone.waitForTimeout(400);
await phone.evaluate(()=>{const f=document.getElementById('pFirst'); f.value='Cedric'; f.dispatchEvent(new Event('input',{bubbles:true}));});
await phone.evaluate(()=>document.getElementById('personSubmit').click());
await phone.waitForTimeout(3500);

// --- back on the desktop
await sync(desk);
const deskCid=await desk.evaluate(()=>{const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  const p=st.persons.find(x=>x.id==='cid'); return p? p.first : null;});
ok('the phone\'s rename shows up on the desktop', deskCid==='Cedric', JSON.stringify({deskCid}));
ok('…and Bob does not come back with it', !(await names(desk)).includes('bob'), (await names(desk)).join(','));

// --- and syncing again, both ways, never resurrects him
await sync(phone); await sync(desk); await sync(phone);
ok('Bob stays deleted on the phone however often you sync', !(await names(phone)).includes('bob'), (await names(phone)).join(','));
ok('…and on the desktop', !(await names(desk)).includes('bob'), (await names(desk)).join(','));
const both=[(await names(desk)).join(','),(await names(phone)).join(',')];
ok('both devices end up showing exactly the same people', both[0]===both[1] && both[0]==='ada,cid', JSON.stringify(both));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
