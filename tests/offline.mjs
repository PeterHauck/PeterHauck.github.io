// The tree opens with no signal, and still takes a new version when there is one.
// Run with:  node tests/run.mjs        (or node tests/offline.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
let serveDead=false, hits=[];
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(serveDead){ r.destroy(); return; }                       // "no signal"
  hits.push(u.pathname);
  if(u.pathname==='/api/store'){r.writeHead(q.method==='GET'?404:200);return r.end('{}');}
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const P=(id,n)=>({id,name:n+' Off',first:n,last:'Off',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1950,docs:[]});
const seed={title:'Offline tree',version:9,photoMigrated:true,namesSplit:true,
  persons:[P('a','Ada'),P('b','Bram')],unions:[],links:[],manual:{a:{x:0,y:0},b:{x:300,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const errs=[];
// 127.0.0.1 counts as a secure origin, so the worker is allowed to register
const ctx=await browser.newContext({viewport:{width:390,height:840},isMobile:true,hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'});
const pg=await ctx.newPage(); pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200);
ok('the tree opens normally', (await pg.evaluate(()=>document.querySelectorAll('g.person').length))===2);
await pg.waitForFunction(()=>navigator.serviceWorker.controller!=null,{timeout:20000}).catch(()=>{});
ok('a worker takes over to keep a copy', await pg.evaluate(()=>!!navigator.serviceWorker.controller));
await pg.waitForTimeout(1500);
const kept=await pg.evaluate(async()=>{const ks=await caches.keys(); if(!ks.length) return [];
  const c=await caches.open(ks[0]); return (await c.keys()).map(r=>new URL(r.url).pathname);});
ok('…the page, its script and its styles are kept', ['/index.html','/app.js','/styles.css'].every(f=>kept.some(k=>k.endsWith(f))), JSON.stringify(kept));
ok('…and nothing from the family data goes into it', !kept.some(k=>k.includes('/api/')), JSON.stringify(kept.filter(k=>k.includes('api'))));
/* ---- now pull the plug ---- */
serveDead=true;
await pg.reload({waitUntil:'domcontentloaded'});
await pg.waitForTimeout(2500);
ok('with no signal at all, it still opens', (await pg.evaluate(()=>document.querySelectorAll('g.person').length))===2,
   await pg.evaluate(()=>document.querySelectorAll('g.person').length));
ok('…with the family still in it', (await pg.evaluate(()=>document.getElementById('treeTitle').textContent))==='Offline tree',
   await pg.evaluate(()=>document.getElementById('treeTitle').textContent));
/* ---- signal back: a new version is taken ---- */
serveDead=false;
hits=[];
await pg.reload({waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
ok('with a signal it asks the site again, so new versions land', hits.some(h=>h.endsWith('app.js')), JSON.stringify(hits.slice(0,6)));
/* ---- the escape hatch ---- */
await pg.goto(base+'?nosw=1',{waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
ok('?nosw=1 turns it off again', (await pg.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length))===0);
ok('…and clears what it kept', (await pg.evaluate(async()=>(await caches.keys()).length))===0);
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
