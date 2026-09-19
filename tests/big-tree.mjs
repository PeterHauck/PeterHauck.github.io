// A big tree only puts the part near the screen into the page — and still
// behaves as if the whole thing were there.
// Run with:  node tests/run.mjs        (or node tests/big-tree.mjs)
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
// 200 couples strung out across a very wide board, each with a child
const persons=[],unions=[],links=[],manual={};
for(let i=0;i<200;i++){
  const a='a'+i,b='b'+i,c='c'+i;
  persons.push({id:a,name:'Dad'+i+' Long',first:'Dad'+i,last:'Long',middle:'',nickname:'',maiden:'',suffix:'',sex:'male',birth:1900,docs:[]});
  persons.push({id:b,name:'Mum'+i+' Long',first:'Mum'+i,last:'Long',middle:'',nickname:'',maiden:'',suffix:'',sex:'female',birth:1902,docs:[]});
  persons.push({id:c,name:'Kid'+i+' Long',first:'Kid'+i,last:'Long',middle:'',nickname:'',maiden:'',suffix:'',sex:'unknown',birth:1930,docs:[]});
  unions.push({id:'u'+i,a,b,status:'married'});
  links.push({id:'l'+i,union:'u'+i,child:c});
  manual[a]={x:i*600,y:0}; manual[b]={x:i*600+200,y:0}; manual[c]={x:i*600+100,y:250};
}
const big={title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions,links,manual,hidden:{},manualHidden:{},focus:[]};
const small=JSON.parse(JSON.stringify(big));
small.persons=small.persons.slice(0,24); small.unions=small.unions.slice(0,8); small.links=small.links.slice(0,8);
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const open=async(seed,mobile)=>{
  const pg=await browser.newPage(mobile
    ? {viewport:{width:390,height:840},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'}
    : {viewport:{width:1400,height:900}});
  pg.on('pageerror',e=>errs.push((mobile?'phone: ':'computer: ')+e.message));
  await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');localStorage.setItem('familyTree.importPass','p');localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
  await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
  return pg;
};
const errs=[];
const drawnIds=(pg)=>pg.evaluate(()=>[...document.querySelectorAll('g.person')].map(g=>g.getAttribute('data-id')));
const onScreen=(pg)=>pg.evaluate(()=>{let n=0;document.querySelectorAll('g.person').forEach(g=>{const r=g.getBoundingClientRect();
  if(r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight)n++;});return n;});

/* ---- a big tree draws only its neighbourhood ---- */
let pg=await open(big,true);
const drawn1=await drawnIds(pg);
ok('a big tree is not drawn whole', drawn1.length<120, drawn1.length+' of 600 drawn');
ok('…but what you can see is there', (await onScreen(pg))>0, await onScreen(pg));
ok('…and everybody is still IN the tree', await pg.evaluate(()=>JSON.parse(localStorage.getItem('familyTree.v1')).persons.length)===600);
/* ---- moving somewhere else draws that part ---- */
await pg.evaluate(()=>{const b=[...document.querySelectorAll('#peopleList li')];});
await pg.evaluate(()=>document.getElementById('tbFind').click()); await pg.waitForTimeout(300);
await pg.evaluate(()=>{const b=document.querySelector('.find-box'); b.value='Kid150'; b.dispatchEvent(new Event('input',{bubbles:true}));});
await pg.waitForTimeout(300);
await pg.evaluate(()=>document.querySelector('.find-row').click());
await pg.waitForTimeout(800);
const drawn2=await drawnIds(pg);
ok('jumping somewhere else draws that stretch', drawn2.includes('c150'), JSON.stringify(drawn2.slice(0,3))+' …'+drawn2.length);
ok('…and drops the stretch you left', !drawn2.includes('c0'), drawn2.length+' drawn');
ok('their lines come with them', await pg.evaluate(()=>!!document.querySelector('g.union[data-union="u150"]')));
/* ---- panning a long way brings the next stretch in by itself ---- */
const far=await pg.evaluate(async()=>{
  const svg=document.getElementById('svg');
  const send=(t,x,y)=>svg.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:4,isPrimary:true,pointerType:'touch'}));
  send('pointerdown',300,400); for(let i=1;i<=8;i++) send('pointermove',300-i*120,400); send('pointerup',-660,400);
  await new Promise(r=>setTimeout(r,1400));
  return [...document.querySelectorAll('g.person')].map(g=>g.getAttribute('data-id'));});
ok('panning brings the next stretch in', far.some(id=>!drawn2.includes(id)), far.length+' drawn, '+far.filter(id=>!drawn2.includes(id)).length+' of them new');
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await pg.close();
/* ---- a phone draws no editing handles at all ---- */
pg=await open(big,true);
ok('a phone gets no ＋ handles', await pg.evaluate(()=>document.querySelectorAll('.add-plus').length)===0,
   await pg.evaluate(()=>document.querySelectorAll('.add-plus').length));
const phoneEls=await pg.evaluate(()=>document.getElementsByTagName('*').length);
await pg.close();
/* ---- the computer keeps them ---- */
pg=await open(big,false);
ok('the computer still has its handles', await pg.evaluate(()=>document.querySelectorAll('.add-plus').length)>0,
   await pg.evaluate(()=>document.querySelectorAll('.add-plus').length));
ok('…and the computer culls a big tree too', (await drawnIds(pg)).length<200, (await drawnIds(pg)).length+' of 600 drawn');
await pg.close();
/* ---- a small tree is drawn whole, exactly as before ---- */
pg=await open(small,false);
ok('a small tree is drawn whole', (await drawnIds(pg)).length===24, (await drawnIds(pg)).length+' of 24 drawn');
await pg.close();
console.log('phone page elements with a 600-person tree:', phoneEls);
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
