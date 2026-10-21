import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildUserscript } from '../scripts/build.mjs';

test('build produces a standalone script whose own runtime stays off unsupported sites',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'toolpatch-build-'));
  try {
    const output=join(dir,'toolpatch.user.js');await buildUserscript({output});
    const source=await readFile(output,'utf8');
    const header=source.slice(0,source.indexOf('// ==/UserScript=='));
    assert.match(header,/\/\/ @match\s+https:\/\/tuamaeaquelaursa\.com\/\*/);
    assert.doesNotMatch(header,/@(?:updateURL|downloadURL|require|connect)/);
    assert.doesNotMatch(header,/<all_urls>/);
    const window=new EventTarget();window.location=new URL('https://example.test/');window.console=console;window.document={};window.navigator={};
    window.setInterval=()=>{throw new Error('off-target timer');};window.clearInterval=()=>{};
    vm.runInNewContext(source,{window,URL,Symbol,AbortController,AbortSignal,setTimeout,clearTimeout});
    await new Promise(resolve=>setImmediate(resolve));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('release metadata requires HTTPS and uses explicit base, rejecting credentials/query/hash',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'toolpatch-release-'));const output=join(dir,'toolpatch.user.js');
  try {
    for(const base of ['http://example.test/', 'https://u:p@example.test/', 'https://example.test/?token=x', 'https://example.test/#hash']) {
      await assert.rejects(buildUserscript({output,updateBase:base}),/update base/i);
    }
    await buildUserscript({output,updateBase:'https://example.test/toolpatch/'});
    const source=await readFile(output,'utf8');
    assert.match(source,/@updateURL\s+https:\/\/example.test\/toolpatch\/toolpatch.user.js/);
    assert.match(source,/@downloadURL\s+https:\/\/example.test\/toolpatch\/toolpatch.user.js/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
