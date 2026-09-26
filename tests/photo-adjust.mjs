// Adjusting a picture re-frames the photo that was uploaded, not the square
// that was cut out of it last time — and it opens where you left it.
// Run with:  node tests/run.mjs        (or node tests/photo-adjust.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
// a stand-in for the site's own store: putMedia succeeds, everything else is empty
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(u.pathname==='/api/store'){ if(q.method==='POST'){r.writeHead(200,{'content-type':'application/json'});return r.end('{}');}
    r.writeHead(404); return r.end('{}'); }
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
const persons=[{id:'a',name:'Ada Test',first:'Ada',last:'Test',middle:'',nickname:'',maiden:'',suffix:'',sex:'female',birth:1900,docs:[]}];
const seed={title:'T',version:9,photoMigrated:true,namesSplit:true,persons,unions:[],links:[],manual:{a:{x:0,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
  localStorage.setItem('familyTree.importPass','x');            // a made-up passcode: the stub store takes anything
  localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1200);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
// open Ada's edit form
await pg.click('g.person');
await pg.waitForTimeout(500);
const openForm=async()=>{ await pg.evaluate(()=>{const b=document.getElementById('personEditBtn'); if(b) b.click();});
  await pg.waitForTimeout(600); };
await openForm();
ok('the edit form is open', await pg.evaluate(()=>!document.getElementById('personForm').hidden));
// the photo box now offers a choice rather than a file window
await pg.evaluate(()=>document.getElementById('photoDrop').click());
await pg.waitForTimeout(500);
const chooser=await pg.evaluate(()=>{const m=document.querySelector('.modal-backdrop .picture-add');
  if(!m) return null;
  return {link:!!m.querySelector('.pm-linkrow input'),
          file:[...m.querySelectorAll('button')].some(b=>/choose a file/i.test(b.textContent)),
          hint:(m.querySelector('.hint')||{}).textContent||''};});
ok('clicking the photo box offers a choice, not just a file window', !!chooser, JSON.stringify(chooser));
ok('…with a box for a link', !!chooser && chooser.link, JSON.stringify(chooser));
ok('…and a button for a file', !!chooser && chooser.file, JSON.stringify(chooser));
ok('…and it says you can paste or drop one too', !!chooser && /paste/i.test(chooser.hint), JSON.stringify(chooser&&chooser.hint));
await pg.evaluate(()=>{const m=document.querySelector('.modal-backdrop .picture-add');
  [...m.querySelectorAll('button')].find(b=>/cancel/i.test(b.textContent)).click();});
await pg.waitForTimeout(300);
// hand it a picture that is plainly two halves: red on the left, blue on the right
await pg.evaluate(async ()=>{
  const c=document.createElement('canvas'); c.width=800; c.height=400; const g=c.getContext('2d');
  g.fillStyle='#ff0000'; g.fillRect(0,0,200,400); g.fillStyle='#0000ff'; g.fillRect(200,0,600,400);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));
  const dt=new DataTransfer(); dt.items.add(new File([blob],'t.png',{type:'image/png'}));
  const inp=document.getElementById('photoInput'); inp.files=dt.files;
  inp.dispatchEvent(new Event('change',{bubbles:true}));});
await pg.waitForSelector('.photo-adjust',{timeout:8000});
ok('picking a photo opens the crop editor', true);
// zoom in and drag hard left, so the square that comes out is all red
const frameIn=async()=>{ await pg.evaluate(()=>{const z=document.getElementById('paZoom');
    z.value='2'; z.dispatchEvent(new Event('input',{bubbles:true}));});
  await pg.evaluate(()=>{const st=document.getElementById('paStage');
    const f=(t,x)=>st.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:300,pointerId:2,isPrimary:true}));
    f('pointerdown',100); for(let i=1;i<=8;i++) f('pointermove',100+i*60); f('pointerup',580);});
  await pg.waitForTimeout(200); };
await frameIn();
const inks=()=>pg.evaluate(()=>{const cv=document.getElementById('paCanvas');
  const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
  let red=0, blue=0; for(let i=0;i<d.length;i+=4){ if(d[i]>150&&d[i+2]<100) red++; if(d[i+2]>150&&d[i]<100) blue++; }
  return {red,blue};});
const cropped=await inks();
ok('the crop is sitting on the red half', cropped.red>1000 && cropped.blue===0, JSON.stringify(cropped));
const zWas=await pg.evaluate(()=>+document.getElementById('paZoom').value);
await pg.evaluate(()=>document.getElementById('paOk').click());
await pg.waitForTimeout(400);
await pg.evaluate(()=>document.getElementById('personSubmit').click());
await pg.waitForTimeout(900);
const rec=await pg.evaluate(()=>{const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  const p=st.persons.find(x=>x.id==='a');
  return {hasPhoto:!!(p.photo||p.photoRef), srcRef:!!p.photoSrcRef, frame:p.photoFrame||null};});
ok('the picture is saved', rec.hasPhoto, JSON.stringify({hasPhoto:rec.hasPhoto}));
ok('…with the uncropped original kept beside it', rec.srcRef, JSON.stringify(rec));
ok('…and a note of how it was framed', !!rec.frame && rec.frame.z>1.5 && rec.frame.z<2.5, JSON.stringify(rec.frame));
ok('…stamped with the picture it was framed on', !!rec.frame && !!rec.frame.of, JSON.stringify(rec.frame));
// now Adjust: it must open the ORIGINAL, at the framing we left it
await openForm();
await pg.evaluate(()=>document.getElementById('photoAdjustBtn').click());
await pg.waitForSelector('.photo-adjust',{timeout:8000}); await pg.waitForTimeout(300);
const zNow=await pg.evaluate(()=>+document.getElementById('paZoom').value);
ok('Adjust opens where you left it, not back at the middle', Math.abs(zNow-zWas)<0.2,
   JSON.stringify({leftAt:zWas, openedAt:zNow}));
const onOpen=await inks();
ok('…showing the same framing', onOpen.red>1000 && onOpen.blue===0, JSON.stringify(onOpen));
// zooming back out must reveal the rest of the photo — proof it's the original
await pg.evaluate(()=>{const z=document.getElementById('paZoom'); z.value='1'; z.dispatchEvent(new Event('input',{bubbles:true}));});
await pg.waitForTimeout(250);
const out=await inks();
ok('zooming out shows the whole photo again, not a blown-up crop', out.blue>1000 && out.red>1000,
   JSON.stringify(out));
// and re-framing from the original saves the new frame
await pg.evaluate(()=>document.getElementById('paOk').click());
await pg.waitForTimeout(300);
await pg.evaluate(()=>document.getElementById('personSubmit').click());
await pg.waitForTimeout(900);
const after=await pg.evaluate(()=>{const st=JSON.parse(localStorage.getItem('familyTree.v1'));
  const p=st.persons.find(x=>x.id==='a'); return p.photoFrame||null;});
ok('the new framing is remembered too', !!after && after.z<1.5, JSON.stringify(after));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
