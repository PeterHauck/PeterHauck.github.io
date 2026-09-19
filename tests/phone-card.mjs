// The profile card on a phone: opens where you left off, drag it down to put
// it away, step sideways through the family.
// Run with:  node tests/run.mjs        (or node tests/phone-card.mjs)
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
const P=(id,n,sex)=>({id,name:n+' Kin',first:n,last:'Kin',middle:'',nickname:'',maiden:'',suffix:'',sex:sex||'unknown',birth:1950,docs:[]});
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,
  persons:[P('dad','Dad','male'),P('mum','Mum','female'),P('kid','Kid'),P('sis','Sis','female'),P('wife','Wife','female')],
  unions:[{id:'u1',a:'dad',b:'mum',status:'married'},{id:'u2',a:'kid',b:'wife',status:'married'}],
  links:[{id:'l1',union:'u1',child:'kid'},{id:'l2',union:'u1',child:'sis'}],
  manual:{dad:{x:0,y:0},mum:{x:200,y:0},kid:{x:0,y:250},sis:{x:300,y:250},wife:{x:-200,y:250}},
  hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const phone={viewport:{width:390,height:840},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'};
const errs=[];
const ctx=await browser.newContext(phone);        // one context, so storage survives a reload
const pg=await ctx.newPage(); pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1000);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const openCard=async(id)=>{ await pg.evaluate((i)=>{const svg=document.getElementById('svg');
  const g=[...document.querySelectorAll('g.person')].find(x=>x.getAttribute('data-id')===i);
  const r=g.querySelector('.shape').getBoundingClientRect(); const cx=r.x+r.width/2, cy=r.y+r.height/2;
  g.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:cx,clientY:cy,pointerId:2,isPrimary:true,pointerType:'touch'}));
  svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:cx,clientY:cy,pointerId:2,isPrimary:true,pointerType:'touch'}));},id);
  await pg.waitForTimeout(500); };
const who=()=>pg.evaluate(()=>{const h=document.querySelector('.pcard-head h2');return h?h.textContent:null;});
const swipe=(dx,dy)=>pg.evaluate(async({dx,dy})=>{
  const card=document.querySelector('.pcard');
  const send=(t,x,y)=>card.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:6,isPrimary:true,pointerType:'touch'}));
  const x0=195, y0=300;
  send('pointerdown',x0,y0);
  for(let i=1;i<=6;i++){ send('pointermove',x0+dx*i/6,y0+dy*i/6); await new Promise(r=>setTimeout(r,16)); }
  send('pointerup',x0+dx,y0+dy);
  await new Promise(r=>setTimeout(r,350));},{dx,dy});
/* ---- stepping through the family ---- */
await openCard('kid');
ok('tapping somebody opens their card', (await who())==='Kid Kin', await who());
ok('the card offers the people either side', await pg.evaluate(()=>document.querySelectorAll('.pcard-kinbtn').length)===2,
   await pg.evaluate(()=>[...document.querySelectorAll('.pcard-kinbtn')].map(b=>b.textContent).join(' | ')));
const chips=await pg.evaluate(()=>[...document.querySelectorAll('.pcard-kinbtn')].map(b=>b.textContent));
ok('…and names them', /Sis|Dad|Mum|Wife/.test(chips.join(' ')), JSON.stringify(chips));
ok('…two different people, not the same one twice', chips[0].replace('‹ ','')!==chips[1].replace(' ›',''), JSON.stringify(chips));
await swipe(-120,0);
const after=await who();
ok('swiping sideways moves to one of their family', after && after!=='Kid Kin', after);
await swipe(120,0);
ok('swiping back returns', (await who())==='Kid Kin', await who());
await pg.evaluate(()=>document.querySelector('.pcard-kinbtn').click()); await pg.waitForTimeout(500);
ok('the chips walk the family too', (await who())!=='Kid Kin', await who());
/* ---- drag the card down to put it away ---- */
await pg.evaluate(()=>{const b=document.getElementById('profileCardBack'); if(b) b.remove();});
await openCard('kid');
await swipe(0,140);
ok('dragging the card down puts it away', !(await pg.evaluate(()=>!!document.getElementById('profileCardBack'))));
await openCard('kid');
await swipe(0,40);
ok('…but a small drag leaves it be', await pg.evaluate(()=>!!document.getElementById('profileCardBack')));
ok('…and it sits back where it was', await pg.evaluate(()=>{const c=document.querySelector('.pcard');return !c.style.transform;}),
   await pg.evaluate(()=>document.querySelector('.pcard').style.transform));
await pg.evaluate(()=>{const b=document.getElementById('profileCardBack'); if(b) b.remove();});
/* ---- it opens where you left off ---- */
await pg.evaluate(()=>{const svg=document.getElementById('svg');
  const send=(t,x,y)=>svg.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:9,isPrimary:true,pointerType:'touch'}));
  send('pointerdown',300,400); send('pointermove',120,300); send('pointerup',120,300);});
await pg.waitForTimeout(1200);
const before=await pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t);return {x:Math.round(+m[1]),y:Math.round(+m[2]),s:+/scale\(([-\d.]+)\)/.exec(t)[1]};});
await pg.reload({waitUntil:'networkidle'}); await pg.waitForTimeout(1600);
const back=await pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t);return {x:Math.round(+m[1]),y:Math.round(+m[2]),s:+/scale\(([-\d.]+)\)/.exec(t)[1]};});
ok('coming back opens where you left off', Math.abs(back.x-before.x)<2 && Math.abs(back.y-before.y)<2 && Math.abs(back.s-before.s)<0.01,
   JSON.stringify({before,back}));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
