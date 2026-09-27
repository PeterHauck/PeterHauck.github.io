// What you delete stays deleted — even though the copy on the site still has it.
// Run with:  node tests/run.mjs   (or node tests/deleted-stays-deleted.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const cloud={payload:'',savedAt:0,media:new Map()};
const body=(q)=>new Promise(r=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{try{r(JSON.parse(b||'{}'));}catch(e){r({});}})});
const server=http.createServer(async (q,r)=>{const u=new URL(q.url,'http://x');
  const send=(c,o)=>{r.writeHead(c,{'content-type':'application/json'});r.end(JSON.stringify(o));};
  if(u.pathname==='/api/store'){
    if(q.method==='GET'){
      const a=u.searchParams.get('action');
      if(a==='treeInfo') return send(200,{exists:!!cloud.savedAt,savedAt:cloud.savedAt});
      if(a==='getTree') return cloud.savedAt? send(200,{payload:cloud.payload,savedAt:cloud.savedAt,v:1}) : send(404,{});
      if(a==='getMedia'){const m=cloud.media.get(u.searchParams.get('id')); return m? send(200,{payload:m}) : send(404,{});}
      return send(404,{});
    }
    const j=await body(q);
    if(j.action==='checkPasscode') return send(200,{ok:true});
    if(j.action==='putMedia'){(j.items||[]).forEach(i=>cloud.media.set(i.id,i.payload)); return send(200,{ok:true});}
    if(j.action==='saveTree'){
      if(cloud.savedAt && (+j.base||0)!==cloud.savedAt) return send(409,{savedAt:cloud.savedAt});
      cloud.payload=j.payload; cloud.savedAt=Date.now(); return send(200,{savedAt:cloud.savedAt});
    }
    return send(200,{});
  }
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);
  if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const TINY='data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const seed={title:'T',version:9,namesSplit:true,
  persons:[{id:'v',name:'Valentine Hauck',first:'Valentine',last:'Hauck',middle:'',nickname:'',maiden:'',suffix:'',sex:'male',birth:1900,photo:TINY,docs:[]}],
  unions:[],links:[],manual:{v:{x:0,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const errs=[]; const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const device=async(label)=>{
  const ctx=await browser.newContext({viewport:{width:1280,height:950}});
  const pg=await ctx.newPage();
  pg.on('pageerror',e=>errs.push(label+': '+e.message));
  pg.on('dialog',async d=>{ await d.accept(); });
  await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
    localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
  await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(2600);
  return pg;
};
// count what's on screen: a storage mirror can fall behind, the panel can't
const shots=(pg)=>pg.evaluate(()=>document.querySelectorAll('.gal-cell').length);
const hasFace=(pg)=>pg.evaluate(()=>!!document.querySelector('.pv-photo img'));
const sync=async(pg)=>{ await pg.evaluate(()=>document.getElementById('tbSync').click()); await pg.waitForTimeout(3000); };
// Syncing twice is not cheating: a change has to reach the site before the
// other device can see it, and under load that can take a moment longer than
// one round trip. What's being tested is that it ARRIVES, not how fast.
const syncUntil=async(pg,want,tries)=>{ for(let i=0;i<(tries||4);i++){ await sync(pg); if(await want()) return true; } return false; };
const desk=await device('desktop');
// the same photo, three times over, the way a slip of the finger puts it there
await desk.click('g.person'); await desk.waitForTimeout(600);
await desk.evaluate(async ()=>{
  const c=document.createElement('canvas'); c.width=300; c.height=300;
  const g=c.getContext('2d'); g.fillStyle='#c33'; g.fillRect(0,0,300,300);
  const shots=[];
  for (let i=0;i<3;i++){ g.fillStyle='#fff'; g.fillRect(10*i,10,20,20);
    shots.push(await new Promise(r=>c.toBlob(r,'image/png'))); }
  const dt=new DataTransfer(); shots.forEach((b,i)=>dt.items.add(new File([b],'p'+i+'.png',{type:'image/png'})));
  const inp=document.querySelector('#galleryBox input[type=file]');
  inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}));});
await desk.waitForTimeout(4000);
ok('three photos are in his gallery', (await shots(desk))===3, await shots(desk));
await sync(desk);
ok('…and they have reached the site', await desk.evaluate(()=>+(localStorage.getItem('familyTree.cloudSavedAt')||0)>0));
// The other device pulls them down and then pushes a change of its own, so the
// copy on the site is AHEAD of the desktop and still holding all three photos.
// That is the situation where a deletion used to be undone.
const phone=await device('phone');
await sync(phone);
await phone.click('g.person'); await phone.waitForTimeout(800);
ok('the other device has all three too', (await shots(phone))===3, await shots(phone));
await phone.evaluate(()=>document.getElementById('personEditBtn').click());
await phone.waitForTimeout(500);
await phone.evaluate(()=>{const f=document.getElementById('pNick'); f.value='Val'; f.dispatchEvent(new Event('input',{bubbles:true}));});
await phone.evaluate(()=>document.getElementById('personSubmit').click());
await phone.waitForTimeout(3500);
await sync(phone);
// now delete one on the desktop, which is holding an older copy
await desk.evaluate(()=>document.querySelector('.gal-cell .gal-del').click());
await desk.waitForTimeout(2500);
ok('deleting one leaves two', (await shots(desk))===2, await shots(desk));
await sync(desk);
ok('…and syncing with a site copy that still has it does not bring it back',
   (await shots(desk))===2, await shots(desk));
await sync(desk); await sync(desk);
ok('…however many times you sync', (await shots(desk))===2, await shots(desk));
await syncUntil(phone, async()=>(await shots(phone))===2);
ok('the other device ends up with two as well', (await shots(phone))===2, await shots(phone));
// …and when that device makes another change and pushes, the deleted photo
// must not ride back up with it. This is the loop as reported: delete, and it
// returns with "Updated to the latest from your site".
await phone.evaluate(()=>document.getElementById('personEditBtn').click());
await phone.waitForTimeout(500);
await phone.evaluate(()=>{const f=document.getElementById('pNick'); f.value='Sonny'; f.dispatchEvent(new Event('input',{bubbles:true}));});
await phone.evaluate(()=>document.getElementById('personSubmit').click());
await phone.waitForTimeout(3500);
await sync(phone); await sync(desk); await sync(desk);
ok('…and it does not ride back up when they push again', (await shots(desk))===2, await shots(desk));
// and the same for a tree picture: taking one off must stick too
await desk.click('g.person'); await desk.waitForTimeout(600);
ok('he has a tree picture to start with', await hasFace(desk));
await desk.evaluate(()=>{const av=document.querySelector('.pv-photo'); if(av) av.click();});
await desk.waitForTimeout(800);
const removed=await desk.evaluate(()=>{
  const b=[...document.querySelectorAll('.photo-menu button')].find(x=>/remove this picture/i.test(x.textContent||''));
  if(b){ b.click(); return true; } return false;});
ok('his picture can be removed', removed);
await desk.waitForTimeout(2500);
const gone=async()=>!(await hasFace(desk));
ok('removing it takes it off', await gone());
await sync(desk); await sync(desk);
ok('…and it stays off however often you sync', await gone());
await syncUntil(phone, async()=>{ await phone.click('g.person').catch(()=>{}); await phone.waitForTimeout(400); return !(await hasFace(phone)); });
ok('…and the other device loses it too', !(await hasFace(phone)));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
