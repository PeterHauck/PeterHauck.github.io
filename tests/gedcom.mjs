// The GEDCOM export: names, dates, families and obituary text — and nothing else.
// Run with:  node tests/run.mjs        (or node tests/gedcom.mjs)
const { chromium } = await import('playwright').catch(() =>
  import(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/index.mjs'));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','family-tree');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
  if(u.pathname==='/api/store'){r.writeHead(q.method==='GET'?404:200);return r.end('{}');}
  let f=u.pathname;if(f==='/')f='/index.html';const fp=path.join(ROOT,f.split('?')[0]);if(!fs.existsSync(fp)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':types[path.extname(fp)]||'text/plain'});r.end(fs.readFileSync(fp));});
await new Promise(x=>server.listen(0,x)); const base=`http://127.0.0.1:${server.address().port}/`;
// a small family with everything the exporter has to think about
const P=(o)=>Object.assign({middle:'',nickname:'',maiden:'',suffix:'',docs:[]},o);
const seed={title:'Test Tree',version:9,namesSplit:true,
  persons:[
    P({id:'d',name:'Darrel E. Boyd',first:'Darrel',middle:'E',last:'Boyd',sex:'male',birth:1928,birthDate:'1928-04-02',death:1990,deathDate:'1990-07-11',deceased:true,
       notes:'PRIVATE: do not share this anywhere',causeOfDeath:'Lung Cancer',
       military:{branch:'Army Reserves',rank:'Private',notes:'Fort Riley'},
       docs:[{id:'o1',title:'Obituary',docType:'obituary',kind:'text',content:'Darrel E. Boyd, 62, of Sioux Falls, died Wednesday.\n\nHe was a carpenter.'}]}),
    P({id:'v',name:'Verlyn Elaine (Taylor) Boyd',first:'Verlyn',middle:'Elaine',last:'Nelson',maiden:'Taylor',priorNames:['Boyd'],sex:'female',birth:1930,birthDate:'1930-06',color:'#ff8800'}),
    P({id:'k',name:'Kay Boyd',first:'Kay',last:'Boyd',sex:'female',birth:1955,birthDate:'1955-01-09'}),
    P({id:'a',name:'Adopted Al',first:'Al',last:'Boyd',sex:'male',birth:1960}),
    P({id:'n',name:'Roy Nelson',first:'Roy',last:'Nelson',sex:'male',deceased:true,causeOfDeath:'Heart failure'}),
    P({id:'s',name:'Sam Quiet',first:'Sam',last:'Quiet',sex:'male',birth:1940,death:1979,deathDate:'1979-02-14',deceased:true,
       causeOfDeath:'Suicide'}),
    P({id:'t',name:'Tom Quiet',first:'Tom',last:'Quiet',sex:'male',birth:1942,death:1980,deathDate:'1980-03-01',deceased:true,
       causeOfDeath:'Took his own life after a long illness'}),
  ],
  unions:[{id:'u1',a:'d',b:'v',status:'married',marriage:'1949-09-23'},
          {id:'u2',a:'v',b:'n',status:'divorced',divorce:'2001-03-04'}],
  links:[{id:'l1',union:'u1',child:'k',type:'bio'},{id:'l2',union:'u1',child:'a',type:'adopted'}],
  manual:{d:{x:0,y:0},v:{x:180,y:0},k:{x:0,y:250},a:{x:180,y:250},n:{x:400,y:0},s:{x:600,y:0},t:{x:780,y:0}},hidden:{},manualHidden:{},focus:[]};
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const pg=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.addInitScript((s)=>{localStorage.setItem('familyTree.familyPass','D');
  localStorage.setItem('familyTree.v1',JSON.stringify(s));},seed);
await pg.goto(base,{waitUntil:'networkidle'}); await pg.waitForTimeout(1500);
const ok=(n,c,x)=>console.log(n+':',c?'PASS':'FAIL',x===undefined?'':x);
const dl=pg.waitForEvent('download',{timeout:20000});
await pg.evaluate(()=>{const m=document.getElementById('tbMenu'); if(m) m.click();});
await pg.waitForTimeout(500);
await pg.evaluate(()=>document.getElementById('gedcomBtn').click());
const d=await dl;
ok('it downloads a .ged file', /\.ged$/.test(d.suggestedFilename()), d.suggestedFilename());
const tmp=path.join(os.tmpdir(),'t-'+Date.now()+'.ged');
await d.saveAs(tmp);
const raw=fs.readFileSync(tmp,'utf8'); fs.unlinkSync(tmp);
const lines=raw.split('\r\n').filter(Boolean);
// structure
ok('it starts with a header and ends with a trailer', lines[0]==='0 HEAD' && lines[lines.length-1]==='0 TRLR');
ok('it says which GEDCOM it is', raw.includes('2 VERS 5.5.1') && raw.includes('1 CHAR UTF-8'));
let jump=null, prev=-1, ids=new Set(), fams=new Set(), ptr=[];
lines.forEach((l,i)=>{const m=/^(\d+) (?:(@[^@]+@) )?([A-Z][A-Z0-9_]*)(?: (.*))?$/.exec(l);
  if(!m){ jump=jump||('unreadable line '+(i+1)); return; }
  const lvl=+m[1]; if(lvl>prev+1) jump=jump||('level jump at line '+(i+1)); prev=lvl;
  if(m[2]) (m[3]==='INDI'?ids:fams).add(m[2]);
  if(/^@[^@]+@$/.test(m[4]||'')) ptr.push(m[4]);});
ok('every line is well formed', !jump, jump||'');
ok('everybody is in it', ids.size===7, ids.size);
ok('both families are in it', fams.size===2, fams.size);
ok('every reference points at something real', ptr.every(x=>ids.has(x)||fams.has(x)));
// names
ok('a woman is recorded under her maiden name', /1 NAME Verlyn Elaine \/Taylor\//.test(raw));
ok('…with each married name kept as well',
   /1 NAME Verlyn Elaine \/Boyd\/[\s\S]*?2 TYPE married/.test(raw) && /1 NAME Verlyn Elaine \/Nelson\/[\s\S]*?2 TYPE married/.test(raw));
ok('a man keeps the one surname', (raw.match(/1 NAME Darrel E \/Boyd\//g)||[]).length===1);
// dates
ok('a full date is written the GEDCOM way', raw.includes('2 DATE 2 APR 1928'));
ok('a month and year stays a month and year', raw.includes('2 DATE JUN 1930'));
ok('a year on its own stays a year', raw.includes('2 DATE 1960') || /1 BIRT\r?\n2 DATE 1960/.test(raw));
ok('somebody known to have died with no date is still marked as died', raw.includes('1 DEAT Y'));
ok('a marriage carries its date', /1 MARR\r\n2 DATE 23 SEP 1949/.test(raw));
ok('a divorce carries its date', /1 DIV\r\n2 DATE 4 MAR 2001/.test(raw));
ok('an adopted child is marked as adopted', raw.includes('2 PEDI adopted'));
// what it must and must not contain
ok('the obituary text is there', raw.includes('Darrel E. Boyd, 62, of Sioux Falls') && raw.includes('He was a carpenter'));
ok('…and its paragraphs are kept', /1 NOTE Darrel E\. Boyd[\s\S]*?1 CONT/.test(raw));
ok('a cause of death is recorded against the death', /1 DEAT\r\n2 DATE 11 JUL 1990\r\n2 CAUS Lung Cancer/.test(raw));
ok('…even when only the year of death is known', /1 DEAT Y\r\n2 CAUS Heart failure/.test(raw));
ok('military service is a fact of its own', /1 EVEN Private, Army Reserves\r\n2 TYPE Military Service/.test(raw));
ok('…with what was written about it kept', /2 TYPE Military Service\r\n2 NOTE Fort Riley/.test(raw));
ok('a suicide is NOT given as a cause', !/Suicide/i.test(raw), (raw.match(/.*[Ss]uicide.*/)||[''])[0]);
ok('…nor one described in words', !raw.includes('Took his own life'));
ok('…but the death itself is still recorded', raw.includes('2 DATE 14 FEB 1979') && raw.includes('2 DATE 1 MAR 1980'));
ok('…and those people are still in the file', /1 NAME Sam \/Quiet\//.test(raw) && /1 NAME Tom \/Quiet\//.test(raw));
ok('private notes are NOT there', !raw.includes('PRIVATE: do not share'));
ok('colours are not there', !raw.includes('#ff8800'));
ok('no page errors', errs.length===0, JSON.stringify(errs.slice(0,3)));
await browser.close(); server.close(); console.log('DONE'); process.exit(0);
