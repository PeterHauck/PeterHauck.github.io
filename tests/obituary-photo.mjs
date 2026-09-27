// An obituary is a record, not a face — and a record is shown in proportion.
// Run with:  node tests/run.mjs        (or node tests/obituary-photo.mjs)
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
// a 1x3 "newspaper clipping": much taller than it is wide, like a real column
const clipping=(()=>{ // a tiny PNG made by hand would be fiddly; build it in the browser instead
  return null; })();
const persons=[{id:'a',name:'Ada Test',first:'Ada',last:'Test',middle:'',nickname:'',maiden:'',suffix:'',sex:'female',birth:1900,docs:[]}];
const seed={title:'T',version:9,namesSplit:true,persons,unions:[],links:[],manual:{a:{x:0,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const errs=[];
const open=async()=>{
  const ctx=await browser.newContext({viewport:{width:1280,height:950}});
  const pg=await ctx.newPage();
  pg.on('pageerror',e=>errs.push(e.message));
  await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
    localStorage.setItem('familyTree.importPass','x');localStorage.setItem('familyTree.v1',JSON.stringify(s));},s2());
  await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
  return pg;
};
// the seed, with a tall obituary clipping already attached and NO picture —
// exactly the state the old code turned into a face on the next load
let tallPng=null;
{
  const ctx=await browser.newContext(); const pg0=await ctx.newPage();
  tallPng=await pg0.evaluate(async ()=>{
    const c=document.createElement('canvas'); c.width=200; c.height=600;
    const g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,200,600);
    g.fillStyle='#000'; for(let y=20;y<580;y+=18) g.fillRect(10,y,180,9);
    return c.toDataURL('image/png');});
  await ctx.close();
}
const s2=()=>({...seed, persons:[{...persons[0],
  docs:[{id:'d1',title:"Ada's Obituary",docType:'obituary',kind:'image',content:tallPng,capturedAt:'2026-09-27',text:'Ada Test, 96, died…'}]}]});
const pg=await open();
ok('she has an obituary attached', await pg.evaluate(()=>{const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  return (st.persons[0].docs||[]).length===1;}));
await pg.waitForTimeout(2500);   // long enough for anything on-load to have run
const face=await pg.evaluate(()=>{const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  const p=st.persons[0]; return {photo:!!p.photo, ref:!!p.photoRef};});
ok('the obituary has NOT become her picture', !face.photo && !face.ref, JSON.stringify(face));
ok('…and the tree draws her without one', await pg.evaluate(()=>{
  const g=document.querySelector('g.person'); return !g.querySelector('image');}));
// --- the record viewer shows the clipping in proportion
await pg.click('g.person'); await pg.waitForTimeout(600);
const opened=await pg.evaluate(()=>{const b=[...document.querySelectorAll('[data-view], .doc-list button')]
  .find(x=>/view/i.test(x.textContent||'') || x.hasAttribute('data-view'));
  if(b){ b.click(); return true; } return false;});
ok('her obituary can be opened', opened);
await pg.waitForSelector('.doc-view img',{timeout:8000}); await pg.waitForTimeout(600);
const shape=await pg.evaluate(()=>{const im=document.querySelector('.doc-view img');
  const r=im.getBoundingClientRect();
  return {shown:+(r.width/r.height).toFixed(3), real:+(im.naturalWidth/im.naturalHeight).toFixed(3),
          w:Math.round(r.width), h:Math.round(r.height)};});
ok('the clipping is shown in its own proportions, not squashed',
   Math.abs(shape.shown-shape.real)<0.02, JSON.stringify(shape));
ok('…and it fits on the screen', shape.h <= 950*0.62, JSON.stringify(shape));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
