import test from 'node:test';
import assert from 'node:assert/strict';
import { ursaAdapter } from '../src/adapters/ursa.js';

const email = {key:'m1',from:'sender@example.test',subject:'Verification',created_at:'2026-10-21T12:00:00Z',bodyPlain:'Code: 123456',bodyHtml:'<p>Code: 123456</p>',spamScore:0};
function setup({url='https://tuamaeaquelaursa.com/test-box', fetch: fetcher, ...overrides}={}) {
  const window = { location: new URL(url) };
  const controller = new AbortController();
  const calls=[];
  const fetch = async (url, options) => {
    calls.push({url,options});
    return fetcher ? fetcher(url,options) : Response.json({messages:[email]});
  };
  const tools=ursaAdapter.createTools({window, signal:controller.signal, fetch, ...overrides});
  const call = async (name, args={}, context={}) => {
    const result=await tools.find(t=>t.name===`toolpatch_ursa_${name}`).execute(args,context);
    return {...JSON.parse(result.content[0].text), isError:result.isError===true};
  };
  return {window,controller,tools,call,calls};
}

test('only mailbox paths on the exact supported host select a mailbox', async()=>{
  for(const path of ['/', '/admin', '/privacy', '/terms.html','/a/b/c','/%ZZ']) {
    assert.equal((await setup({url:`https://tuamaeaquelaursa.com${path}`}).call('get_mailbox')).selected,false,path);
  }
  assert.equal(ursaAdapter.matchesURL(new URL('https://tuamaeaquelaursa.com.evil.test/a')),false);
  assert.deepEqual((await setup().call('get_mailbox')).mailbox,{name:'test-box',address:'test-box@tuamaeaquelaursa.com'});
});

test('lists real API envelopes without exposing message bodies',async()=>{
  const s=setup(); const result=await s.call('list_messages');
  assert.equal(result.isError,false);
  assert.deepEqual(result.messages,[{key:'m1',from:'sender@example.test',subject:'Verification',createdAt:'2026-10-21T12:00:00.000Z'}]);
  assert.equal(s.calls[0].url,'https://tuamaeaquelaursa.com/api/mailboxes/test-box/messages');
  assert.equal(s.calls[0].options.credentials,'same-origin');
  assert.equal(result.hasMore,false);
  assert.equal(s.tools.find(t=>t.name.endsWith('read_message')).annotations.untrustedContentHint,true);
});

test('reads by exact key, clips body and reports missing keys', async()=>{
  const s=setup({fetch:async()=>Response.json({messages:[{...email,bodyPlain:'x'.repeat(40000)}]})});
  const result=await s.call('read_message',{key:'m1'});
  assert.equal(result.message.body.length,20000);
  assert.equal(result.message.truncated,true);
  assert.equal((await s.call('read_message',{key:'absent'})).error.code,'message_not_found');
});

test('never hides access errors or malformed responses as an empty mailbox',async()=>{
  for(const [status,code] of [[401,'access_required'],[403,'access_required'],[500,'http_error']]) {
    const s=setup({fetch:async()=>Response.json({error:'private_mailbox_forbidden'},{status})});
    const r=await s.call('list_messages');assert.equal(r.isError,true);assert.equal(r.error.code,code);
  }
  for(const data of [{}, {messages:[{key:'x'}]}]) {
    assert.equal((await setup({fetch:async()=>Response.json(data)}).call('list_messages')).error.code,'invalid_response');
  }
  assert.deepEqual((await setup({fetch:async()=>Response.json({messages:[]})}).call('list_messages')).messages,[]);
});

test('refuses stale results when mailbox changes during a request',async()=>{
  let s;
  s=setup({fetch:async()=>{s.window.location=new URL('https://tuamaeaquelaursa.com/another');return Response.json({messages:[email]});}});
  const r=await s.call('list_messages');assert.equal(r.isError,true);assert.equal(r.error.code,'mailbox_changed');
});

test('bounds list output and validates caller input',async()=>{
  const s=setup({fetch:async()=>Response.json({messages:Array.from({length:120},(_,i)=>({...email,key:`m${i}`,subject:'s'.repeat(1000)}))})});
  const r=await s.call('list_messages',{limit:2});
  assert.equal(r.messages.length,2);assert.equal(r.hasMore,true);assert.equal(r.messages[0].subject.length,500);
  assert.equal((await s.call('list_messages',{limit:0})).error.code,'invalid_arguments');
  assert.equal((await s.call('read_message',{key:''})).error.code,'invalid_arguments');
});

test('wait filters messages, observes deadline and honors rate-limit delays',async()=>{
  let time=0, attempts=0;const delays=[];
  const s=setup({now:()=>time,sleep:async ms=>{delays.push(ms);time+=ms;},fetch:async()=>{
    attempts++; if(attempts===1)return Response.json({error:'rate_limited'},{status:429,headers:{'Retry-After':'8'}});
    return Response.json({messages:[email]});
  }});
  const r=await s.call('wait_for_message',{timeoutSeconds:10,subject:'verif',from:'EXAMPLE.TEST'});
  assert.equal(r.status,'found');assert.equal(r.message.key,'m1');assert.deepEqual(delays,[8000]);
  time=0;attempts=0;
  const timeout=await s.call('wait_for_message',{timeoutSeconds:3});
  assert.equal(timeout.status,'timeout');assert.equal(attempts,1);assert.equal(time,3000);
});

test('reports rate limiting on a one-shot call without retrying',async()=>{
  const s=setup({fetch:async()=>Response.json({error:'rate_limited'},{status:429,headers:{'Retry-After':'30'}})});
  const r=await s.call('list_messages');assert.equal(r.error.code,'rate_limited');assert.equal(r.error.retryAfterSeconds,30);assert.equal(s.calls.length,1);
});

test('cancels active requests and bounds even a stalled network response',async()=>{
  const fetch=async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const s=setup({fetch,requestTimeoutMs:10});
  assert.equal((await s.call('list_messages')).error.code,'request_timeout');
  const call=s.call('wait_for_message',{timeoutSeconds:1});
  s.controller.abort();assert.equal((await call).error.code,'cancelled');
});

test('short Retry-After never accelerates polling below five seconds',async()=>{
  let time=0;const requests=[];
  const s=setup({now:()=>time,sleep:async ms=>{time+=ms;},fetch:async()=>{
    requests.push(time);return Response.json({error:'rate_limited'},{status:429,headers:{'Retry-After':'1'}});
  }});
  assert.equal((await s.call('wait_for_message',{timeoutSeconds:12})).status,'timeout');
  assert.deepEqual(requests,[0,5000,10000]);
});

test('aborting a stalled HTTP body stays a request timeout and a wait deadline',async()=>{
  const {createServer}=await import('node:http');
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();res.write('{"messages":');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  try {
    const s=setup({requestTimeoutMs:150,fetch:(_url,options)=>fetch(url,options)});
    assert.equal((await s.call('list_messages')).error.code,'request_timeout');
    const w=setup({requestTimeoutMs:2000,fetch:(_url,options)=>fetch(url,options)});
    assert.equal((await w.call('wait_for_message',{timeoutSeconds:1})).status,'timeout');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('normalizes server dates so padding cannot bypass output bounds',async()=>{
  const s=setup({fetch:async()=>Response.json({messages:[{...email,created_at:'Wed, 21 Oct 2026 12:00:00 GMT'+' '.repeat(1000000)}]})});
  const r=await s.call('list_messages');
  assert.ok(JSON.stringify(r).length<2000);
  assert.equal(r.messages[0].createdAt,'2026-10-21T12:00:00.000Z');
});
