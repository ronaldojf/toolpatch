import test from 'node:test';
import assert from 'node:assert/strict';
import { startToolpatch } from '../src/core/runtime.js';
import { ursaAdapter } from '../src/adapters/ursa.js';

function fixture(url='https://tuamaeaquelaursa.com/first') {
  const registry=new Map(), warnings=[];
  const window=new EventTarget();window.location=new URL(url);
  window.console={warn:m=>warnings.push(m)};
  window.navigator={};
  window.document={modelContext:{async registerTool(tool,{signal}){
    if(registry.has(tool.name)) throw new Error('Duplicate tool');
    registry.set(tool.name,tool);
    signal.addEventListener('abort',()=>registry.delete(tool.name),{once:true});
  }}};
  window.fetch=async()=>Response.json({messages:[]});
  window.setInterval=fn=>{window.tick=fn;return 1;}; window.clearInterval=()=>{window.tick=null;};
  return {window,registry,warnings};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const payload=r=>JSON.parse(r.content[0].text);

test('registers only matching adapters, and stop removes its own tools',async()=>{
  const s=fixture();const stop=await startToolpatch(s.window,[ursaAdapter]);
  assert.equal(s.registry.size,4);
  assert.equal(payload(await s.registry.get('toolpatch_ursa_get_mailbox').execute({})).mailbox.name,'first');
  stop();assert.equal(s.registry.size,0);assert.equal(s.window.tick,null);
  const other=fixture('https://example.com/first');await startToolpatch(other.window,[ursaAdapter]);assert.equal(other.registry.size,0);
});

test('SPA navigation and BFCache restore register the current mailbox without duplicates',async()=>{
  const s=fixture();const stop=await startToolpatch(s.window,[ursaAdapter]);
  const previous=s.registry.get('toolpatch_ursa_get_mailbox');
  s.window.location=new URL('https://tuamaeaquelaursa.com/second');
  s.window.tick();await flush();assert.equal(s.registry.size,4);
  assert.equal(payload(await s.registry.get('toolpatch_ursa_get_mailbox').execute({})).mailbox.name,'second');
  assert.equal(payload(await previous.execute({})).error.code,'cancelled');
  const current=s.registry.get('toolpatch_ursa_get_mailbox');
  s.window.location=new URL('https://tuamaeaquelaursa.com/second/key');s.window.tick();await flush();
  assert.equal(s.registry.get('toolpatch_ursa_get_mailbox'),current);
  s.window.dispatchEvent(new Event('pagehide'));assert.equal(s.registry.size,0);
  s.window.dispatchEvent(new Event('pageshow'));await flush();assert.equal(s.registry.size,4);
  stop();
});

test('reinjection and rapid navigation leave one current tool set and cancel old waits',async()=>{
  const s=fixture();let signal;
  s.window.fetch=async(_url,options)=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const oldStop=await startToolpatch(s.window,[ursaAdapter]);
  const pending=s.registry.get('toolpatch_ursa_wait_for_message').execute({timeoutSeconds:10});
  const stop=await startToolpatch(s.window,[ursaAdapter]);
  assert.equal(signal.aborted,true);assert.equal(payload(await pending).error.code,'cancelled');
  oldStop();assert.equal(s.registry.size,4);
  s.window.location=new URL('https://tuamaeaquelaursa.com/second');s.window.tick();
  s.window.location=new URL('https://tuamaeaquelaursa.com/third');s.window.tick();await flush();
  assert.equal(s.registry.size,4);
  assert.equal(payload(await s.registry.get('toolpatch_ursa_get_mailbox').execute({})).mailbox.name,'third');stop();
});

test('missing API is observable and failed registrations roll back partial tools',async()=>{
  const s=fixture();delete s.window.document.modelContext;
  const stop=await startToolpatch(s.window,[ursaAdapter]);assert.equal(s.warnings.length,1);assert.equal(s.registry.size,0);stop();
  let count=0;
  const t=fixture();const register=t.window.document.modelContext.registerTool;
  t.window.document.modelContext.registerTool=async(...args)=>{if(++count===2)throw new Error('denied');return register(...args);};
  const stop2=await startToolpatch(t.window,[ursaAdapter]);assert.equal(t.registry.size,0);assert.equal(t.warnings.length,1);stop2();
});
