import test from 'node:test';
import assert from 'node:assert/strict';
import { portainerAdapter } from '../src/adapters/portainer.js';
import { adapters } from '../src/adapters/index.js';

const payload = value => JSON.parse(value.content[0].text);
const prefix = 'toolpatch_portainer_';
function setup(t, { fetch, socketError = false } = {}) {
  const lifecycle = new AbortController(), calls = [], sockets = [];
  let next = 0;
  const window = { location: new URL('https://portainer.attq/#!/7/docker/containers/synthetic') };
  class Socket extends EventTarget {
    constructor() {
      super(); this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.dispatchEvent(new Event('open'));
        if (socketError) this.dispatchEvent(new Event('error'));
      });
    }
    send(text) { this.sent.push(text); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  window.WebSocket = Socket;
  window.fetch = async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, init });
    if (fetch) return fetch(path, init);
    if (path === '/api/endpoints/7') return Response.json({ Id: 7, Name: 'Synthetic', Type: 1, Status: 1 });
    if (path.endsWith('/containers/json')) return Response.json([{ Id: 'synthetic', Names: ['/fixture'], State: 'running' }]);
    if (path.endsWith('/containers/synthetic/json')) return Response.json({ Id: 'synthetic', Config: { Tty: true } });
    if (path.endsWith('/containers/synthetic/logs')) return new Response('synthetic log');
    if (path.endsWith('/containers/synthetic/exec')) return Response.json({ Id: 'ab' + (++next).toString(16) });
    if (/\/exec\/ab\d+\/json$/.test(path)) return Response.json({ Running: true, ExitCode: null });
    throw new Error('Unexpected private request');
  };
  const tools = portainerAdapter.createTools({ window, signal: lifecycle.signal });
  const call = async (name, args, context) => payload(await tools.find(tool => tool.name === prefix + name).execute(args, context));
  t.after(() => lifecycle.abort());
  return { window, lifecycle, calls, sockets, tools, call };
}

test('catalog selects exact HTTPS host and keys Docker environments rather than containers', () => {
  assert.ok(adapters.includes(portainerAdapter));
  for (const url of ['https://portainer.attq/', 'https://portainer.attq/#!/7/docker', 'https://portainer.attq/#!/7/kubernetes', 'https://portainer.attq/#!/auth']) assert.equal(portainerAdapter.matchesURL(new URL(url)), true);
  for (const url of ['http://portainer.attq/', 'https://evil.portainer.attq/', 'https://portainer.attq.evil/']) assert.equal(portainerAdapter.matchesURL(new URL(url)), false);
  const key = href => portainerAdapter.pageKey({ location: new URL(href) });
  assert.equal(key('https://portainer.attq/#!/7/docker/containers/a'), key('https://portainer.attq/#!/7/docker/containers/b/console'));
  assert.notEqual(key('https://portainer.attq/#!/7/docker'), key('https://portainer.attq/#!/8/docker'));
  assert.equal(key('https://portainer.attq/#!/auth'), key('https://portainer.attq/#!/7/kubernetes'));
});

test('exposes eight native schemas with required target/session arguments and truthful hints', t => {
  const { tools } = setup(t);
  assert.deepEqual(tools.map(tool => tool.name), ['get_context','list_resources','inspect_resource','read_logs','exec_container','read_exec','write_exec','close_exec'].map(name => prefix + name));
  const required = [[], ['environmentId','kind'], ['environmentId','kind','id'], ['environmentId','containerId'], ['environmentId','containerId','command'], ['sessionId'], ['sessionId','input'], ['sessionId']];
  tools.forEach((tool, i) => {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required ?? [], required[i]);
    assert.equal(tool.annotations.untrustedContentHint, true);
    assert.equal(tool.annotations.readOnlyHint, [0,1,2,3,5].includes(i));
    assert.match(tool.description, /untrusted/i);
  });
  assert.equal(tools[4].inputSchema.properties.command.minItems, 1);
  assert.equal(tools[4].inputSchema.properties.command.maxItems, 1000);
  assert.equal(tools[5].inputSchema.properties.maxChars.maximum, 50000);
});

test('resource wrappers return one native JSON envelope and use authenticated HTTP', async t => {
  const { call, calls } = setup(t);
  assert.equal((await call('get_context', {})).endpoint.name, 'Synthetic');
  assert.equal((await call('list_resources', { environmentId: 7, kind: 'containers' })).resources[0].id, 'synthetic');
  assert.equal((await call('inspect_resource', { environmentId: 7, kind: 'containers', id: 'synthetic', sections: ['summary'] })).summary.id, 'synthetic');
  assert.equal((await call('read_logs', { environmentId: 7, containerId: 'synthetic' })).output, 'synthetic log');
  assert.ok(calls.every(({ init }) => init.credentials === 'same-origin'));
});

test('unsupported routes report no selected environment without requesting data', async t => {
  const { window, lifecycle } = setup(t); lifecycle.abort();
  window.location = new URL('https://portainer.attq/#!/auth');
  let requests = 0; window.fetch = async () => { requests++; throw new Error('must not fetch'); };
  const controller = new AbortController(); t.after(() => controller.abort());
  const tools = portainerAdapter.createTools({ window, signal: controller.signal });
  assert.equal(payload(await tools[0].execute({})).selected, false);
  assert.equal(payload(await tools[1].execute({ environmentId: 7, kind: 'containers' })).error.code, 'no_environment');
  assert.equal(requests, 0);
});

test('rejects unknown own arguments, inherited schema names, missing targets and invalid values before HTTP', async t => {
  const { tools, calls } = setup(t);
  for (const args of [null, [], 'bad', { constructor: 'bad' }, { toString: 'bad' }, { unknown: true }]) {
    const value = await tools[0].execute(args); assert.equal(value.isError, true); assert.equal(payload(value).error.code, 'invalid_arguments');
  }
  for (const [index, args] of [[1, {}], [1,{ environmentId: 7, kind: 'bogus' }], [4,{ environmentId: 7, containerId: 'synthetic', command: [] }], [6,{ sessionId: 'missing' }]]) {
    assert.equal(payload(await tools[index].execute(args)).error.code, 'invalid_arguments');
  }
  assert.equal(calls.length, 0);
});

test('preserves safe HTTP and rate limit details without exposing private response bodies or exceptions', async t => {
  for (const [status, extra] of [[403, { status: 403 }], [429, { retryAfterSeconds: 9 }], [500, { status: 500 }]]) {
    const { call } = setup(t, { fetch: async () => new Response('PRIVATE_TOKEN', { status, headers: { 'retry-after': '9' } }) });
    const value = await call('get_context', {});
    for (const [key, expected] of Object.entries(extra)) assert.equal(value.error[key], expected);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TOKEN/);
  }
  const { call } = setup(t, { fetch: async () => { throw new Error('PRIVATE_TOKEN'); } });
  const value = await call('get_context', {}); assert.equal(value.error.code, 'network_error'); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TOKEN/);
});

test('console wrappers share retained sessions and send exact interactive input across same-environment routes', async t => {
  const { call, sockets, window } = setup(t);
  const started = await call('exec_container', { environmentId: 7, containerId: 'synthetic', command: ['cat'], interactive: true, waitMs: 0 });
  window.location = new URL('https://portainer.attq/#!/7/docker/images');
  assert.equal((await call('write_exec', { sessionId: started.sessionId, input: 'fixture\n\u0003' })).sentBytes, 9);
  assert.deepEqual(sockets[0].sent, ['fixture\n\u0003']);
  assert.equal((await call('read_exec', { sessionId: started.sessionId })).status, 'running');
  const closed = await call('close_exec', { sessionId: started.sessionId });
  assert.equal(closed.closed, true); assert.equal(closed.processMayContinue, true); assert.equal(sockets[0].readyState, 3);
  assert.equal((await call('read_exec', { sessionId: started.sessionId })).error.code, 'session_not_found');
});

test('console errors retain session uncertainty and close failure reports closed state', async t => {
  const { call } = setup(t, { socketError: true });
  const value = await call('exec_container', { environmentId: 7, containerId: 'synthetic', command: ['true'], waitMs: 100 });
  assert.equal(value.error.code, 'socket_error'); assert.equal(value.error.processMayContinue, true); assert.ok(value.error.sessionId);
  let inspectFails = false;
  const second = setup(t, { fetch: async path => path.endsWith('/exec') ? Response.json({ Id: 'abc' }) : inspectFails ? new Response('PRIVATE', { status: 403 }) : Response.json({ Running: true, ExitCode: null }) });
  const started = await second.call('exec_container', { environmentId: 7, containerId: 'synthetic', command: ['true'], waitMs: 0 });
  inspectFails = true;
  const closed = await second.call('close_exec', { sessionId: started.sessionId });
  assert.equal(closed.error.closed, true); assert.equal(closed.error.sessionId, started.sessionId); assert.equal(closed.error.processMayContinue, true); assert.equal(closed.error.status, 403);
});

test('cancellation after stdin was sent preserves its session and process uncertainty', async t => {
  const { call, sockets } = setup(t);
  const started = await call('exec_container', { environmentId: 7, containerId: 'synthetic', command: ['cat'], interactive: true, waitMs: 0 });
  const action = new AbortController();
  const pending = call('write_exec', { sessionId: started.sessionId, input: 'fixture\n' }, { signal: action.signal });
  action.abort();
  const value = await pending;
  assert.deepEqual(sockets[0].sent, ['fixture\n']);
  assert.equal(value.error.code, 'cancelled'); assert.equal(value.error.sessionId, started.sessionId); assert.equal(value.error.processMayContinue, true);
});

test('action cancellation returns structured error while lifecycle abort disposes sockets', async t => {
  const { call, lifecycle, sockets } = setup(t);
  const started = await call('exec_container', { environmentId: 7, containerId: 'synthetic', command: ['cat'], interactive: true, waitMs: 0 });
  const action = new AbortController();
  const pending = call('read_exec', { sessionId: started.sessionId, waitMs: 10000 }, { signal: action.signal });
  action.abort(new Error('PRIVATE_TOKEN'));
  const value = await pending; assert.equal(value.error.code, 'cancelled'); assert.equal(value.error.sessionId, started.sessionId); assert.equal(value.error.processMayContinue, true);
  assert.equal(sockets[0].readyState, 1);
  lifecycle.abort(); assert.equal(sockets[0].readyState, 3);
  assert.equal((await call('get_context', {})).error.code, 'cancelled');
});
