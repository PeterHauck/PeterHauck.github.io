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
    P({id:'e',name:'Ed Hokenstad',first:'Ed',last:'Hokenstad',sex:'male'}),
    P({id:'a',name:'Alice Hokenstad',first:'Alice',last:'Hokenstad',sex:'female'}),
    P({id:'v',name:'Verlyn E. (Taylor) Boyd',first:'Verlyn',middle:'E',last:'Boyd',maiden:'Taylor',sex:'female',birth:1930}),
  ],
  unions:[],links:[],manual:{k:{x:0,y:0},j:{x:200,y:0},g:{x:400,y:0},b:{x:600,y:0},e:{x:800,y:0},a:{x:1000,y:0},v:{x:1200,y:0}},hidden:{},manualHidden:{},focus:[]};
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
  '0 @I7@ INDI','1 NAME Alice May /Hokenstad/','2 GIVN Alice May','2 SURN Hokenstad','1 SEX F','1 BIRT','2 DATE 1931',
  // a married woman, filed the other program's way: under her maiden name
  '0 @I8@ INDI','1 NAME Verlyn Elaine /Taylor/','2 GIVN Verlyn Elaine','2 SURN Taylor','1 SEX F','1 BIRT','2 DATE 1930',
  // a family joining the two new people
  '0 @F1@ FAM','1 HUSB @I6@','1 WIFE @I5@','1 MARR','2 DATE 14 JUN 1925','2 PLAC Sioux Falls, South Dakota','1 CHIL @I1@','1 CHIL @I7@',
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
ok('the app starts with seven people', (await state()).persons.length===7, (await state()).persons.length);
await pg.evaluate(()=>{const m=document.getElementById('tbMenu'); if(m) m.click();});
await pg.waitForTimeout(500);
await pg.setInputFiles('#gedcomInput', tmp);
await pg.waitForSelector('.ged-review',{timeout:15000}); await pg.waitForTimeout(700);
ok('it opens a review instead of just doing it', true);
ok('nothing has changed yet', (await state()).persons.length===7, (await state()).persons.length);
ok('nobody is chosen until you choose them', await pg.evaluate(()=>/^0 to bring in/.test(document.querySelector('.ged-tally').textContent)),
   await pg.evaluate(()=>document.querySelector('.ged-tally').textContent));
ok('…and it says so on the button', await pg.evaluate(()=>{
  const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>x.classList.contains('primary'));
  return b.disabled && /nothing chosen/i.test(b.textContent);}));
ok('…with a switch to have the obvious ones chosen for you', await pg.evaluate(()=>{
  const c=document.querySelector('.ged-start input'); if(!c||!c.checked) return false;
  c.click(); const t=document.querySelector('.ged-tally').textContent;
  const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>x.classList.contains('primary'));
  const on=/^5 to bring in/.test(t) && !b.disabled;
  c.click(); return on && /^0 to bring in/.test(document.querySelector('.ged-tally').textContent);}));
// take the certain ones as a batch, the way you would
await pg.evaluate(()=>{const s=[...document.querySelectorAll('.ged-sec')].find(x=>/Matched for certain/.test(x.querySelector('h3').textContent));
  [...s.querySelectorAll('.ged-bulk button')].find(x=>/accept all/i.test(x.textContent)).click();});
await pg.waitForTimeout(300);
const sections=await pg.evaluate(()=>[...document.querySelectorAll('.ged-sec h3')].map(h=>h.textContent));
ok('it groups them by how sure it is', /New people \(2\)/.test(sections.join('|')) && /Same person\? \(3\)/.test(sections.join('|')),
   JSON.stringify(sections));
const groupOf=(name)=>pg.evaluate((n)=>{const secs=[...document.querySelectorAll('.ged-sec')];
  for(const s of secs){ if([...s.querySelectorAll('.ged-pname')].some(x=>x.textContent.includes(n)))
    return s.querySelector('h3').textContent; } return null;},name);
ok('Conrad is matched to Konrad, not treated as new', /Matched for certain/.test(await groupOf('Conrad')||''), await groupOf('Conrad'));
ok('Jeffery is matched to Jeffrey', /Matched for certain/.test(await groupOf('Jeffery')||''), await groupOf('Jeffery'));

// --- ticking a few and going through them one after another
const likelySec=()=>pg.evaluate(()=>{const s=[...document.querySelectorAll('.ged-sec')]
  .find(x=>/Same person/.test(x.querySelector('h3').textContent));
  return s?[...s.querySelectorAll('.ged-pname')].map(x=>x.textContent):null;});
ok('the likely matches each have a tick box', await pg.evaluate(()=>{const s=[...document.querySelectorAll('.ged-sec')]
  .find(x=>/Same person/.test(x.querySelector('h3').textContent));
  return s.querySelectorAll('input.ged-pick').length===3;}),
  await pg.evaluate(()=>{const s=[...document.querySelectorAll('.ged-sec')]
    .find(x=>/Same person/.test(x.querySelector('h3').textContent)); return s.querySelectorAll('input.ged-pick').length;}));
ok('nothing is offered until you tick somebody', await pg.evaluate(()=>document.querySelector('.ged-batch').hidden));
await pg.evaluate(()=>{const s=[...document.querySelectorAll('.ged-sec')]
  .find(x=>/Same person/.test(x.querySelector('h3').textContent));
  [...s.querySelectorAll('input.ged-pick')].slice(0,2).forEach(c=>c.click());});
await pg.waitForTimeout(300);
ok('ticking people offers to work through them', await pg.evaluate(()=>{
  const b=document.querySelector('.ged-batch');
  return !b.hidden && /2 picked/.test(b.textContent) && /go through them/i.test(b.textContent);}),
  await pg.evaluate(()=>document.querySelector('.ged-batch').textContent));
const picked=(await likelySec()).slice(0,2);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-batch button')].find(x=>/go through them/i.test(x.textContent)); b.click();});
await pg.waitForSelector('.ged-person',{timeout:8000}); await pg.waitForTimeout(400);
ok('…which opens the first of them with their place in the run', await pg.evaluate(()=>{
  const m=document.querySelector('.ged-person');
  return {who:m.querySelector('.gp-name').textContent, step:(m.querySelector('.gp-step')||{}).textContent};})
  .then(r=>r.who===picked[0] && r.step==='1 of 2'),
  JSON.stringify(await pg.evaluate(()=>({who:document.querySelector('.gp-name').textContent,
    step:(document.querySelector('.gp-step')||{}).textContent}))));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(600);
ok('…deciding moves straight on to the next', await pg.evaluate(()=>{
  const m=document.querySelector('.ged-person'); if(!m) return null;
  return {who:m.querySelector('.gp-name').textContent, step:(m.querySelector('.gp-step')||{}).textContent};})
  .then(r=>!!r && r.who===picked[1] && r.step==='2 of 2'),
  JSON.stringify(await pg.evaluate(()=>document.querySelector('.ged-person')?
    {who:document.querySelector('.gp-name').textContent,step:(document.querySelector('.gp-step')||{}).textContent}:null)));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/ignore/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(600);
ok('…and the run ends back at the list', await pg.evaluate(()=>!document.querySelector('.ged-person') && !!document.querySelector('.ged-review')));
// three certain matches were already taken in a batch above, so one more
ok('…with both of them settled', /4 to bring in · 1 ignored/.test(await pg.evaluate(()=>document.querySelector('.ged-tally').textContent)),
   await pg.evaluate(()=>document.querySelector('.ged-tally').textContent));
ok('…and the ticks cleared', await pg.evaluate(()=>document.querySelector('.ged-batch').hidden
   && ![...document.querySelectorAll('input.ged-pick')].some(c=>c.checked)));
// put them back to undecided so the rest of the test reads as it did
await pg.evaluate(()=>{const s=[...document.querySelectorAll('.ged-sec')]
  .find(x=>/Same person/.test(x.querySelector('h3').textContent));
  [...s.querySelectorAll('input.ged-pick')].slice(0,2).forEach(c=>c.click());});
await pg.waitForTimeout(200);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-batch button')].find(x=>/^ignore$/i.test(x.textContent.trim())); b.click();});
await pg.waitForTimeout(300);

// --- the per-person card, the way Ancestry shows one
const openRow=async(name)=>{ await pg.evaluate((n)=>{const r=[...document.querySelectorAll('.ged-prow')]
    .find(x=>x.querySelector('.ged-pname').textContent.includes(n)); if(r) r.click();},name);
  await pg.waitForSelector('.ged-person',{timeout:8000}); await pg.waitForTimeout(400); };
await openRow('Barbara');
const card=await pg.evaluate(()=>{const m=document.querySelector('.ged-person');
  return {heads:[...m.querySelectorAll('.gp-th')].map(h=>h.textContent),
    rows:[...m.querySelectorAll('.gp-cell.them')].map(c=>c.textContent.replace(/\s+/g,' ').trim()),
    mine:[...m.querySelectorAll('.gp-cell.mine')].map(c=>c.textContent.replace(/\s+/g,' ').trim()),
    diffs:[...m.querySelectorAll('.gp-diff')].length,
    buttons:[...m.querySelectorAll('.gp-foot button')].map(b=>b.textContent)};});
ok('the card shows both trees side by side', card.heads.join('|')==='In the file|In your tree', JSON.stringify(card.heads));
ok('…with the file on one side and yours on the other', /1895/.test(card.rows.join(' ')) && /1894/.test(card.mine.join(' ')),
   JSON.stringify({file:card.rows,mine:card.mine}));
ok('…and marks what differs', card.diffs>=1, card.diffs);
ok('…and offers Ignore, Later and Accept', card.buttons.join('|')==='Ignore|Later|Accept', JSON.stringify(card.buttons));
ok('a year that disagrees is NOT ticked', await pg.evaluate(()=>{
  const row=[...document.querySelectorAll('.gp-cell.them')].find(c=>/^Born/.test(c.textContent.trim())&&/Different/.test(c.textContent));
  const box=row&&row.querySelector('input'); return !!box && !box.checked;}));
const nameRow=()=>pg.evaluate(()=>{
  const c=[...document.querySelectorAll('.gp-cell.them')].find(x=>/^Name/.test(x.textContent.trim()));
  return c&&{text:c.textContent.replace(/\s+/g,' ').trim(), tick:!!c.querySelector('input'),
             ticked:!!(c.querySelector('input')&&c.querySelector('input').checked)};});
const bn=await nameRow();
ok('her name written the file\'s shorter way is not called a disagreement', /written shorter/i.test(bn.text), JSON.stringify(bn));
ok('…and it is not offered as something to take', bn.tick===false, JSON.stringify(bn));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);

// --- a name that really is different: offered, never assumed
await openRow('Verlyn');
const vn=await nameRow();
ok('a name the file spells differently IS offered', vn.tick===true, JSON.stringify(vn));
ok('…but is never ticked for you', vn.ticked===false, JSON.stringify(vn));
await pg.evaluate(()=>{const c=[...document.querySelectorAll('.gp-cell.them')].find(x=>/^Name/.test(x.textContent.trim()));
  const i=c.querySelector('input'); i.click();});
await pg.waitForTimeout(200);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);

// --- the fold-out: comb through a whole household from one card
await openRow('Ruth');
const rels=await pg.evaluate(()=>[...document.querySelectorAll('.ged-person .gp-relbox')].map(b=>({
  name:b.querySelector('.gp-relname').textContent,
  role:b.querySelector('.gp-relrole').textContent.replace(/\s+/g,' ').trim(),
  count:(b.querySelector('.gp-relcount')||{}).textContent||null,
  opener:!!b.querySelector('.gp-relopen')})));
ok('the card lists the family the file puts her in', rels.length>=3, JSON.stringify(rels.map(r=>r.name)));
ok('…each one with a way to open it', rels.every(r=>r.opener), JSON.stringify(rels));
const alice=rels.find(r=>/Alice/.test(r.name));
ok('…and a count of what that person could bring', alice&&alice.count==='2', JSON.stringify(alice));
ok('nothing is expanded to begin with', await pg.evaluate(()=>!document.querySelector('.gp-relpanel')));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-relbox')].find(x=>/Alice/.test(x.textContent));
  b.querySelector('.gp-relopen').click();});
await pg.waitForTimeout(400);
const panel=await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-relbox')].find(x=>/Alice/.test(x.textContent));
  const pn=b.querySelector('.gp-relpanel'); if(!pn) return null;
  return {heads:[...pn.querySelectorAll('.gp-th')].map(h=>h.textContent),
    file:[...pn.querySelectorAll('.gp-cell.them')].map(c=>c.textContent.replace(/\s+/g,' ').trim()),
    mine:[...pn.querySelectorAll('.gp-cell.mine')].map(c=>c.textContent.replace(/\s+/g,' ').trim()),
    ticks:pn.querySelectorAll('input.gp-take').length,
    pills:[...pn.querySelectorAll('.gp-relfoot button')].map(x=>x.textContent)};});
ok('opening a relative shows the same side-by-side', panel && panel.heads.join('|')==='In the file|In your tree', JSON.stringify(panel&&panel.heads));
ok('…with her details from the file and from your tree', panel && /Alice May/.test(panel.file.join(' ')) && /Alice Hokenstad/.test(panel.mine.join(' ')),
   JSON.stringify(panel&&{f:panel.file,m:panel.mine}));
ok('…her own ticks', panel && panel.ticks===2, panel&&panel.ticks);
ok('…and what to do with her', panel && panel.pills.join('|')==='Bring in|Skip|Later', JSON.stringify(panel&&panel.pills));
ok('she is not spoken for yet', await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-relbox')].find(x=>/Alice/.test(x.textContent));
  return ![...b.querySelectorAll('.gp-relfoot button')].some(x=>x.classList.contains('primary'));}));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-relbox')].find(x=>/Alice/.test(x.textContent));
  const c=[...b.querySelectorAll('.gp-relpanel .gp-cell.them')].find(x=>/^Name/.test(x.textContent.trim()));
  c.querySelector('input').click();});
await pg.waitForTimeout(400);
ok('ticking one of her details marks her to be brought in', await pg.evaluate(()=>{
  const b=[...document.querySelectorAll('.gp-relbox')].find(x=>/Alice/.test(x.textContent));
  const on=[...b.querySelectorAll('.gp-relfoot button')].find(x=>x.classList.contains('primary'));
  return !!on && /bring in/i.test(on.textContent);}));
ok('…and the fold stays open while you work', await pg.evaluate(()=>{
  const b=[...document.querySelectorAll('.gp-relbox')].find(x=>/Alice/.test(x.textContent));
  const c=[...b.querySelectorAll('.gp-relpanel .gp-cell.them')].find(x=>/^Name/.test(x.textContent.trim()));
  return !!c && c.querySelector('input').checked;}));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);

// --- fixing what the file says before any of it lands
await openRow('Ruth');
ok('a card offers to edit what comes in', await pg.evaluate(()=>!!document.querySelector('.ged-person .gp-editbtn')));
await pg.evaluate(()=>document.querySelector('.ged-person .gp-editbtn').click());
await pg.waitForSelector('.gp-edit',{timeout:8000}); await pg.waitForTimeout(400);
const form=await pg.evaluate(()=>({
  labels:[...document.querySelectorAll('.gp-edit label.field span')].map(x=>x.textContent),
  preview:document.querySelector('.gp-preview').textContent,
  values:[...document.querySelectorAll('.gp-edit label.field')].map(l=>[l.querySelector('span').textContent,(l.querySelector('input')||{}).value])}));
ok('…with a box for each part of the name', ['First name','Middle name','Nickname','Maiden name','Earlier married names','Last name','Suffix'].every(x=>form.labels.includes(x)),
   JSON.stringify(form.labels));
ok('…and for the dates and places too', ['Born','Died (if applicable)','Born in','Died in'].every(x=>form.labels.includes(x)), JSON.stringify(form.labels));
ok('…filled in from the file', (form.values.find(v=>v[0]==='First name')||[])[1]==='Ruth'
   && (form.values.find(v=>v[0]==='Last name')||[])[1]==='Hokenstad', JSON.stringify(form.values));
ok('…and a date box you can read', (form.values.find(v=>v[0]==='Born')||[])[1]==='July 3, 1900', JSON.stringify(form.values.find(v=>v[0]==='Born')));
// move the surname into the maiden box, give her the married one, fix a date
const setField=(label,value)=>pg.evaluate(([l,v])=>{const f=[...document.querySelectorAll('.gp-edit label.field')]
  .find(x=>x.querySelector('span').textContent===l); const i=f.querySelector('input');
  i.value=v; i.dispatchEvent(new Event('input',{bubbles:true}));},[label,value]);
await setField('Maiden name','Hokenstad');
await setField('Last name','Boyd');
await setField('Middle name','Octavia');
await pg.waitForTimeout(200);
ok('the name reads back as you type it', await pg.evaluate(()=>document.querySelector('.gp-preview').textContent)==='Ruth Octavia (Hokenstad) Boyd',
   await pg.evaluate(()=>document.querySelector('.gp-preview').textContent));
await setField('Born','nonsense');
await pg.waitForTimeout(200);
ok('a date it cannot read says so', await pg.evaluate(()=>/can't read/i.test(document.querySelector('.gp-badbox').textContent)));
ok('…and will not be used', await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-edit .btn-row button')].find(x=>/use these/i.test(x.textContent));
  b.click(); return !!document.querySelector('.gp-edit');}));
await setField('Born','July 3, 1900');
await setField('Died in','Sioux Falls, South Dakota');
await pg.waitForTimeout(200);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-edit .btn-row button')].find(x=>/use these/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(500);
ok('the card then shows your version, not the file\'s', await pg.evaluate(()=>
  document.querySelector('.ged-person .gp-name').textContent==='Ruth Octavia (Hokenstad) Boyd'),
  await pg.evaluate(()=>document.querySelector('.ged-person .gp-name').textContent));
ok('…and says where it departs from the file', await pg.evaluate(()=>{
  const t=[...document.querySelectorAll('.ged-person .gp-diff.edited')].map(x=>x.textContent);
  return t.some(x=>/file says Ruth Octavia Hokenstad/.test(x));}),
  await pg.evaluate(()=>[...document.querySelectorAll('.ged-person .gp-diff.edited')].map(x=>x.textContent).join(' | ')));
ok('…under a heading that admits it is no longer just the file', await pg.evaluate(()=>
  document.querySelector('.ged-person .gp-th.them').textContent==='Coming in'));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);
ok('the list shows her corrected name', await pg.evaluate(()=>
  [...document.querySelectorAll('.ged-pname')].some(x=>x.textContent==='Ruth Octavia (Hokenstad) Boyd')));

// editing somebody already in the tree ticks the change so it is not lost
await openRow('Gail');
await pg.evaluate(()=>document.querySelector('.ged-person .gp-editbtn').click());
await pg.waitForSelector('.gp-edit',{timeout:8000}); await pg.waitForTimeout(300);
await setField('Middle name','Arleen');
await setField('Born','6/14/1946');
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-edit .btn-row button')].find(x=>/use these/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(500);
ok('correcting a matched person ticks the correction', await pg.evaluate(()=>{
  const c=[...document.querySelectorAll('.ged-person .gp-cell.them')].find(x=>/^Name/.test(x.textContent.trim()));
  const i=c&&c.querySelector('input'); return !!i && i.checked;}));
ok('…and it can be put back to the file\'s version', await pg.evaluate(()=>{
  document.querySelector('.ged-person .gp-editbtn').click(); return true;}) &&
  await pg.waitForSelector('.gp-edit',{timeout:8000}).then(()=>pg.evaluate(()=>
    [...document.querySelectorAll('.gp-edit .btn-row button')].some(x=>/back to the file/i.test(x.textContent)))));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-edit .btn-row button')].find(x=>/cancel/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(200);
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);

// --- telling it somebody "new" is really somebody you already have
await openRow('Edmond');
ok('a new person offers to be linked to somebody already here',
   await pg.evaluate(()=>!!document.querySelector('.gp-link')));
await pg.evaluate(()=>document.querySelector('.gp-link').click());
await pg.waitForSelector('.gp-pick',{timeout:8000}); await pg.waitForTimeout(400);
ok('…which opens a search of your tree', await pg.evaluate(()=>!!document.querySelector('.gp-search')));
await pg.evaluate(()=>{const i=document.querySelector('.gp-search'); i.value='Ed Hok'; i.dispatchEvent(new Event('input',{bubbles:true}));});
await pg.waitForTimeout(400);
const picks=await pg.evaluate(()=>[...document.querySelectorAll('.gp-pickname')].map(x=>x.textContent));
ok('…that narrows as you type', picks.length===1 && /Ed Hokenstad/.test(picks[0]), JSON.stringify(picks));
await pg.evaluate(()=>document.querySelector('.gp-pickrow').click());
await pg.waitForTimeout(600);
ok('picking somebody turns the card into a comparison with them',
   await pg.evaluate(()=>{const m=document.querySelector('.ged-person');
     return !m.querySelector('.gp-link') && /Ed Hokenstad/.test([...m.querySelectorAll('.gp-cell.mine')].map(c=>c.textContent).join(' '));}));
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.gp-foot button')].find(x=>/accept/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);
ok('…and it moves out of the new list', await pg.evaluate(()=>{
  const s=[...document.querySelectorAll('.ged-sec h3')].map(h=>h.textContent).join('|');
  return /New people \(1\)/.test(s) && /Linked by you \(1\)/.test(s);}),
  await pg.evaluate(()=>[...document.querySelectorAll('.ged-sec h3')].map(h=>h.textContent).join(' | ')));

// the likely matches need a look before they count — take them in a batch
await pg.evaluate(()=>{const secs=[...document.querySelectorAll('.ged-sec')];
  const s=secs.find(x=>/Same person/.test(x.querySelector('h3').textContent));
  const b=[...s.querySelectorAll('.ged-bulk button')].find(x=>/accept all/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(400);
// take it
await pg.evaluate(()=>{const b=[...document.querySelectorAll('.ged-review .btn-row button')].find(x=>/bring these in/i.test(x.textContent)); b.click();});
await pg.waitForTimeout(2500);
const after=await state();
const by=(n)=>after.persons.find(p=>new RegExp(n,'i').test(p.name||''));
ok('only the one still-new person was added', after.persons.length===8, after.persons.length);
ok('…and nobody was duplicated', after.persons.filter(p=>/hauck/i.test(p.name)).length===2,
   after.persons.filter(p=>/hauck/i.test(p.name)).map(p=>p.name).join(', '));
ok('Konrad keeps his spelling', !!by('Konrad') && !by('Conrad'), (by('Konrad')||{}).name);
ok('…and gains the birth place the file had', (by('Konrad')||{}).birthPlace==='Odessa, Ukraine, Russia', (by('Konrad')||{}).birthPlace);
ok('Jeffrey gains the full birth date', (by('Jeffrey')||{}).birthDate==='1955-03-12', (by('Jeffrey')||{}).birthDate);
ok('Gail gains the year she was missing', (by('Gail')||{}).birth===1946, (by('Gail')||{}).birth);
ok('…and Edmond was not added as a second person', after.persons.filter(p=>/edmond/i.test(p.name)).length===0,
   after.persons.map(p=>p.name).join(', '));
ok('Barbara keeps HER year, not the file\'s', (by('Barbara')||{}).birth===1894, (by('Barbara')||{}).birth);
ok('a new woman is not given the same surname twice', !/\(Hokenstad\) Hokenstad/.test((by('Ruth')||{}).name||''), (by('Ruth')||{}).name);
ok('a person edited before import comes in the way you wrote her', (by('Ruth')||{}).name==='Ruth Octavia (Hokenstad) Boyd', (by('Ruth')||{}).name);
ok('…with the name split into the boxes you put it in',
   (by('Ruth')||{}).maiden==='Hokenstad' && (by('Ruth')||{}).last==='Boyd' && (by('Ruth')||{}).middle==='Octavia',
   JSON.stringify(by('Ruth')&&{m:by('Ruth').maiden,l:by('Ruth').last,mi:by('Ruth').middle}));
ok('…and a place you typed yourself', /Sioux Falls/.test((by('Ruth')||{}).deathPlace||''), (by('Ruth')||{}).deathPlace);
ok('a correction to somebody already here is kept', (by('Gail')||{}).middle==='Arleen', (by('Gail')||{}).middle);
ok('…including a date you sharpened yourself', (by('Gail')||{}).birthDate==='1946-06-14', (by('Gail')||{}).birthDate);
ok('a new person brought her dates and place with her',
   (by('Ruth')||{}).birthDate==='1900-07-03' && /Sioux Falls/.test((by('Ruth')||{}).birthPlace||''), JSON.stringify(by('Ruth')&&{b:by('Ruth').birthDate,p:by('Ruth').birthPlace}));
const ruth=by('Ruth'), ed=by('Ed Hokenstad');   // Edmond was linked to Ed, so the couple is Ruth + Ed
const u=(after.unions||[]).find(x=>[x.a,x.b].includes(ruth&&ruth.id)&&[x.a,x.b].includes(ed&&ed.id));
ok('the family in the file is recorded as a couple', !!u, JSON.stringify(u||null));
ok('…with its marriage date and place', !!u && u.marriage==='1925-06-14' && /Sioux Falls/.test(u.marriagePlace||''), JSON.stringify(u&&{m:u.marriage,p:u.marriagePlace}));
ok('…and their child linked to them', !!u && (after.links||[]).some(l=>l.union===u.id && l.child===(by('Konrad')||{}).id));
ok('the married woman keeps the surname she goes by', /Boyd/.test((by('Verlyn')||{}).name||''), (by('Verlyn')||{}).name);
ok('…and the file\'s surname becomes her maiden name, not a replacement',
   (by('Verlyn')||{}).name==='Verlyn Elaine (Taylor) Boyd', (by('Verlyn')||{}).name);
ok('a detail ticked inside a fold-out is brought in', (by('Alice')||{}).name==='Alice May Hokenstad', (by('Alice')||{}).name);
ok('…along with what was already ticked for her', (by('Alice')||{}).birth===1931, (by('Alice')||{}).birth);
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
fs.unlinkSync(tmp);
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
