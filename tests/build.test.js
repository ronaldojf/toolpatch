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
    assert.match(header,/@updateURL\s+https:\/\/raw\.githubusercontent\.com\/ronaldojf\/toolpatch\/main\/dist\/toolpatch\.user\.js/);
    assert.match(header,/@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/ronaldojf\/toolpatch\/main\/dist\/toolpatch\.user\.js/);
    assert.doesNotMatch(header,/@(?:require|connect)/);
    assert.doesNotMatch(header,/<all_urls>/);
    for(const [url,wanted] of [['https://example.test/',0],['https://tuamaeaquelaursa.com/bundle-test',4]]) {
      const registry=new Map();
      const window=new EventTarget();window.location=new URL(url);window.console=console;window.navigator={};
      window.document={modelContext:{registerTool(tool,{signal}){
        registry.set(tool.name,tool);signal.addEventListener('abort',()=>registry.delete(tool.name),{once:true});
      }}};
      window.fetch=async()=>Response.json({messages:[]});
      window.setInterval=()=>{if(wanted===0)throw new Error('off-target timer');return 1;};window.clearInterval=()=>{};
      vm.runInNewContext(source,{window,URL,Symbol,AbortController,AbortSignal,setTimeout,clearTimeout});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(registry.size,wanted);
      if(wanted) {
        const result=JSON.parse((await registry.get('toolpatch_ursa_get_mailbox').execute({})).content[0].text);
        assert.equal(result.mailbox.address,'bundle-test@tuamaeaquelaursa.com');
      }
      window[Symbol.for('toolpatch.runtime')]();assert.equal(registry.size,0);
    }
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


test('explicit local-only build omits update metadata',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'toolpatch-local-'));
  try {
    const output=join(dir,'toolpatch.user.js');await buildUserscript({output,updateBase:null});
    const source=await readFile(output,'utf8');assert.doesNotMatch(source.slice(0,source.indexOf('// ==/UserScript==')),/@(?:updateURL|downloadURL)/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
