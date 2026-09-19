// The board has an edge, and a sweep shows you a map of where you are.
// Run with:  node tests/run.mjs        (or node tests/edge-and-map.mjs)
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
// a board shaped like the real one: generations stacked in rows, each row
// running the whole width, so any strip of it you look at is several rows deep
const seed=(cols,rows,sp)=>{const persons=[],manual={};
  for(let i=0;i<cols*rows;i++){const id='p'+i;
    persons.push({id,name:'Person'+i+' Wide',first:'Person'+i,last:'Wide',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1900+i,docs:[]});
    manual[id]={x:(i%cols)*sp, y:Math.floor(i/cols)*250};}
  return {title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions:[],links:[],manual,hidden:{},manualHidden:{},focus:[]};};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const errs=[];
const open=async(s)=>{const pg=await browser.newPage({viewport:{width:390,height:840},isMobile:true,hasTouch:true,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
  pg.on('pageerror',e=>errs.push(e.message));
  await pg.addInitScript((s)=>{localStorage.removeItem('familyTree.lastView');
    localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.v1',JSON.stringify(s));},s);
  await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200); return pg;};
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
let pg=await open(seed(60,6,600));
const tx=()=>pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t); return {x:+m[1],y:+m[2],s:+/scale\(([-\d.]+)\)/.exec(t)[1]};});
// how much empty space is on screen beyond the last person, in board units
const gap=()=>pg.evaluate(()=>{
  const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t), s=+/scale\(([-\d.]+)\)/.exec(t)[1];
  const tx=+m[1], ty=+m[2];
  const xs=[...document.querySelectorAll('g.person')];
  const rects=xs.map(g=>g.getBoundingClientRect());
  const left=Math.min(...rects.map(r=>r.left)), right=Math.max(...rects.map(r=>r.right));
  return {emptyLeft:left/s, emptyRight:(window.innerWidth-right)/s, anyone:xs.length, tx, ty, s};});
// --- dragging keeps hitting an edge
const drag=(dx,dy)=>pg.evaluate(async({dx,dy})=>{const svg=document.getElementById('svg');
  const fire=(t,x,y)=>svg.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:4,isPrimary:true,pointerType:'touch'}));
  let x=195,y=420; fire('pointerdown',x,y);
  for(let i=1;i<=10;i++){ fire('pointermove',195+dx*i/10,420+dy*i/10); await new Promise(r=>setTimeout(r,16)); }
  fire('pointerup',195+dx,420+dy);},{dx,dy});
for(let i=0;i<40;i++){ await drag(340,0); await pg.waitForTimeout(160); }   // shove right, over and over
await pg.waitForTimeout(1600);
const far=await tx();
await drag(340,0); await pg.waitForTimeout(1600);
const further=await tx();
ok('you cannot keep dragging past the edge', Math.abs(further.x-far.x)<4, JSON.stringify({far:Math.round(far.x),further:Math.round(further.x)}));
ok('and somebody is still on the screen at the edge', (await gap()).anyone>0);
const edge=await gap();
// a quarter screen of margin, plus the card's own room round the outermost
// person — about a third of a screen of blank all told, and never more
ok('the blank you can reach past the edge is a third of a screen, no more',
   edge.emptyLeft*edge.s < 390/3 && edge.emptyLeft > 20,
   JSON.stringify({blankScreenPx:Math.round(edge.emptyLeft*edge.s), ofAScreen:390}));
// the same going up
for(let i=0;i<16;i++){ await drag(0,340); await pg.waitForTimeout(160); }
await pg.waitForTimeout(1600);
const up=await tx(); await drag(0,340); await pg.waitForTimeout(1600);
ok('the same edge going up and down', Math.abs((await tx()).y-up.y)<4);
ok('people are still on screen there too', (await gap()).anyone>0);
// --- a small tree just sits in the middle
await pg.close(); pg=await open(seed(3,1,140));
const small=await pg.evaluate(()=>{const rs=[...document.querySelectorAll('g.person')].map(g=>g.getBoundingClientRect());
  const mid=(Math.min(...rs.map(r=>r.left))+Math.max(...rs.map(r=>r.right)))/2;
  return {off:Math.abs(mid-window.innerWidth/2)};});
ok('a tree smaller than the screen sits in the middle', small.off<40, JSON.stringify(small));
for(let i=0;i<6;i++){ await drag(300,0); await pg.waitForTimeout(240); }
await pg.waitForTimeout(1400);
const shoved=await pg.evaluate(()=>{const rs=[...document.querySelectorAll('g.person')].map(g=>g.getBoundingClientRect());
  return {left:Math.min(...rs.map(r=>r.left)), right:Math.max(...rs.map(r=>r.right)), w:window.innerWidth};});
ok('…and can never be shoved off the screen', shoved.right>shoved.w*0.35 && shoved.left<shoved.w*0.65,
   JSON.stringify({left:Math.round(shoved.left),right:Math.round(shoved.right),screen:shoved.w}));
// --- the top and bottom edge follow the tree's depth where you are
// a ribbon: six generations deep down the middle, and at the left-hand end
// just two, sitting in the middle rows — like a branch with no elders on it
const ribbon=()=>{const persons=[],manual={};let i=0;
  for(let c=0;c<60;c++){ const lo=c<20?2:0, hi=c<20?4:6;
    for(let r=lo;r<hi;r++){ const id='p'+(i++);
      persons.push({id,name:'Person'+id+' Wide',first:'Person'+id,last:'Wide',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1900,docs:[]});
      manual[id]={x:c*600, y:r*250}; } }
  return {title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions:[],links:[],manual,hidden:{},manualHidden:{},focus:[]};};
await pg.close(); pg=await open(ribbon());
// how far up can you climb from here, and is anybody still there when you do?
const climb=async()=>{ for(let i=0;i<14;i++){ await drag(0,340); await pg.waitForTimeout(150); }
  await pg.waitForTimeout(1400);
  return pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
    const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t);
    const rs=[...document.querySelectorAll('g.person')].map(g=>g.getBoundingClientRect())
      .filter(r=>r.right>0&&r.left<window.innerWidth&&r.bottom>0&&r.top<window.innerHeight);
    return {ty:+m[2], onScreen:rs.length};}); };
for(let i=0;i<40;i++){ await drag(340,0); await pg.waitForTimeout(140); }  // out to the shallow left-hand end
await pg.waitForTimeout(1200);
const shallow=await climb();
ok('at the shallow end of the tree, somebody is still on screen at the top',
   shallow.onScreen>0, JSON.stringify(shallow));
for(let i=0;i<26;i++){ await drag(-340,0); await pg.waitForTimeout(140); }  // back to the deep middle
await pg.waitForTimeout(1200);
const deep=await climb();
ok('…and over the deep part there is further to climb', deep.ty > shallow.ty+200,
   JSON.stringify({shallowTop:Math.round(shallow.ty), deepTop:Math.round(deep.ty)}));
ok('…with people on screen there too', deep.onScreen>0, JSON.stringify(deep));

// --- zooming right out keeps the tree on screen rather than flinging it off
await pg.close(); pg=await open(seed(60,6,600));
for(let i=0;i<8;i++){ await pg.evaluate(()=>document.getElementById('tbZoomOut').click()); await pg.waitForTimeout(150); }
await pg.waitForTimeout(900);
const wide=await pg.evaluate(()=>{const rs=[...document.querySelectorAll('g.person')].map(g=>g.getBoundingClientRect());
  return {drawn:rs.length, onScreen:rs.filter(r=>r.right>0&&r.left<window.innerWidth&&r.bottom>0&&r.top<window.innerHeight).length};});
ok('zooming out leaves people on the screen', wide.onScreen>0, JSON.stringify(wide));
// zooming shouldn't teleport you: the spot in the middle of the screen stays put
const middleOf=()=>pg.evaluate(()=>{const t=document.getElementById('viewport').getAttribute('transform');
  const m=/translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(t), s=+/scale\(([-\d.]+)\)/.exec(t)[1];
  return {x:(window.innerWidth/2-(+m[1]))/s, y:(window.innerHeight/2-(+m[2]))/s, s};});
const wasAt=await middleOf();
for(let i=0;i<10;i++){ await pg.evaluate(()=>document.getElementById('tbZoomIn').click()); await pg.waitForTimeout(120); }
await pg.waitForTimeout(900);
const nowAt=await middleOf();
ok('and zooming back in stays over the same part of the tree', Math.abs(nowAt.x-wasAt.x)<400 && Math.abs(nowAt.y-wasAt.y)<1400,
   JSON.stringify({was:{x:Math.round(wasAt.x),y:Math.round(wasAt.y)},now:{x:Math.round(nowAt.x),y:Math.round(nowAt.y)}}));

// --- the mini map
await pg.close(); pg=await open(seed(60,6,600));
const hold=(x,y)=>pg.evaluate(({x,y})=>{const svg=document.getElementById('svg');
  svg.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y,pointerId:7,isPrimary:true,pointerType:'touch'}));},{x,y});
const move=(x,y)=>pg.evaluate(({x,y})=>{const svg=document.getElementById('svg');
  svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:x,clientY:y,pointerId:7,isPrimary:true,pointerType:'touch'}));},{x,y});
const lift=(x,y)=>pg.evaluate(({x,y})=>{const svg=document.getElementById('svg');
  svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x,clientY:y,pointerId:7,isPrimary:true,pointerType:'touch'}));},{x,y});
ok('no map before you hold', !(await pg.evaluate(()=>!!document.getElementById('sweepMap'))));
await hold(195,600); await pg.waitForTimeout(600);
const map=await pg.evaluate(()=>{const el=document.getElementById('sweepMap'); if(!el) return null;
  const c=el.querySelector('canvas'), r=el.getBoundingClientRect();
  const g=c.getContext('2d'); const d=g.getImageData(0,0,c.width,c.height).data;
  let ink=0; for(let i=3;i<d.length;i+=4) if(d[i]>20) ink++;
  return {w:r.width,h:r.height,onScreen:r.top>=0&&r.bottom<=window.innerHeight,ink,
          now:!!el.querySelector('.sweep-map-now')};});
ok('holding brings up a mini map', !!map, JSON.stringify(map));
ok('…that is small and fully on screen', map && map.w<=170 && map.h<=170 && map.onScreen, JSON.stringify(map&&{w:map.w,h:map.h,onScreen:map.onScreen}));
ok('…with the people drawn in it', map && map.ink>40, JSON.stringify(map&&{inkedPixels:map.ink}));
const boxAt=()=>pg.evaluate(()=>{const n=document.querySelector('#sweepMap .sweep-map-now');
  const x=document.querySelector('#sweepMap .sweep-map-next');
  if(!n) return null;
  return {now:{x:parseFloat(n.style.left),y:parseFloat(n.style.top),w:parseFloat(n.style.width)},
          nextShown:!!x && x.style.display!=='none',
          next:x&&x.style.display!=='none'?{x:parseFloat(x.style.left)}:null};});
const at0=await boxAt();
ok('a box marks where you are now', at0 && Number.isFinite(at0.now.x) && at0.now.w>0, JSON.stringify(at0));
ok('and nothing is marked ahead while the thumb is still', at0 && !at0.nextShown, JSON.stringify(at0));
await move(265,600); await pg.waitForTimeout(120);
const at1=await boxAt();
ok('sliding the thumb marks where you are heading', at1 && at1.nextShown, JSON.stringify(at1));
ok('…ahead of you, in the direction you are going', at1 && at1.next.x>at1.now.x+1, JSON.stringify(at1));
await pg.waitForTimeout(700);
const at2=await boxAt();
ok('…and the "you are here" box travels that way', at2 && at2.now.x>at0.now.x+1,
   JSON.stringify({was:at0&&at0.now.x,now:at2&&at2.now.x}));
await pg.waitForTimeout(2500);
const at3=await boxAt();
ok('the box stops at the edge of the map, not past it',
   at3 && at3.now.x>=-1 && at3.now.x+at3.now.w<=(map.w-8)+2, JSON.stringify(at3&&{x:at3.now.x,right:at3.now.x+at3.now.w,map:map.w-8}));
await lift(265,600); await pg.waitForTimeout(300);
ok('lifting your thumb takes the map away', !(await pg.evaluate(()=>!!document.getElementById('sweepMap'))));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
