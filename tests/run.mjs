// Runs every test file next to this one and prints a one-line verdict each.
//   node tests/run.mjs
// Each test is a standalone script: it serves ../family-tree over http, drives
// it with a real browser, and prints "<what it checked>: PASS|FAIL". Nothing
// here talks to the live site, and every password in a test is a made-up one.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.mjs') && f !== 'run.mjs').sort();
let failed = 0;

for (const f of files) {
  const out = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(here, f)], { encoding: 'utf8' });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (buf += d));
    p.on('close', () => res(buf));
  });
  const fails = out.split('\n').filter((l) => /: FAIL\b/.test(l));
  const passes = out.split('\n').filter((l) => /: PASS\b/.test(l)).length;
  if (fails.length || !out.includes('DONE')) {
    failed++;
    console.log('FAIL  ' + f + '  (' + passes + ' passed)');
    fails.slice(0, 8).forEach((l) => console.log('        ' + l.trim()));
    if (!out.includes('DONE')) console.log('        ' + out.trim().split('\n').slice(-3).join(' / '));
  } else {
    console.log('ok    ' + f + '  (' + passes + ' checks)');
  }
}
console.log(failed ? failed + ' of ' + files.length + ' files failed' : 'all ' + files.length + ' files passed');
process.exit(failed ? 1 : 0);
