import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortainerClient, PortainerError } from '../src/adapters/portainer/client.js';
import { createExecOperations } from '../src/adapters/portainer/exec.js';

const base = '/api/endpoints/7/docker';
const args = { environmentId: 7, containerId: 'synthetic/container', command: ['/bin/sh', '-c', 'printf synthetic'] };
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof PortainerError && error.code === code);
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(t, { socket, create, inspect, requestTimeoutMs = 1000, autoOpen = true, constructorError = false } = {}) {
  const window = { location: { href: 'https://portainer.attq/#!/7/docker/containers/synthetic' } };
  const lifecycle = new AbortController();
  const calls = [], sockets = [], states = new Map();
  let next = 0;
  class Socket extends EventTarget {
    constructor(url) {
      super(); if (constructorError) throw new Error('constructor failed');
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      this.id = new URL(url).searchParams.get('id');
      if (autoOpen) queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); socket?.(this, states); } });
    }
    send(input) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(input); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    error() { this.dispatchEvent(new Event('error')); this.close(); }
  }
  const fetch = async (url, init) => {
    const path = new URL(url).pathname; calls.push({ url, path, init });
    if (path === base + '/containers/synthetic%2Fcontainer/exec') {
      if (create) return create(init);
      const Id = 'ab' + (++next).toString(16); states.set(Id, { ID: Id, Running: true, ExitCode: null }); return Response.json({ Id }, { status: 201 });
    }
    const match = new RegExp('^' + base + '/exec/([a-f0-9]+)/json$').exec(path);
    assert.ok(match, 'Unexpected HTTP path: ' + path);
    return inspect ? inspect(match[1], states) : Response.json(states.get(match[1]));
  };
  const client = createPortainerClient({ window, signal: lifecycle.signal, fetch, requestTimeoutMs });
  const ops = createExecOperations({ window, client, signal: lifecycle.signal, WebSocket: Socket });
  t.after(() => ops.dispose());
  return { window, lifecycle, calls, sockets, states, ops };
}

test('creates exact argv/options through session HTTP and raw cookie WebSocket, returns real exit/output', async t => {
  const { ops, calls, sockets } = setup(t, { socket(ws, states) { ws.message('synthetic\r\n'); states.set(ws.id, { Running: false, ExitCode: 7 }); ws.close(); } });
  const value = await ops.execContainer({ ...args, user: '1000:1000', workingDir: '/tmp', waitMs: 100 });
  assert.deepEqual(JSON.parse(calls[0].init.body), { AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: args.command, User: '1000:1000', WorkingDir: '/tmp' });
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(sockets[0].url, 'wss://portainer.attq/api/websocket/exec?id=ab1&endpointId=7');
  assert.equal(value.status, 'finished'); assert.equal(value.exitCode, 7); assert.equal(value.output, 'synthetic\r\n'); assert.equal(value.stream, 'merged');
  assert.equal(value.processMayContinue, false); assert.deepEqual(value.command, args.command);
});

test('running wait timeout retains session and does not claim termination or retry execution', async t => {
  const { ops, calls, sockets } = setup(t);
  const value = await ops.execContainer({ ...args, waitMs: 10 });
  assert.equal(value.status, 'running'); assert.equal(value.exitCode, undefined); assert.equal(value.timedOut, true); assert.equal(value.processMayContinue, true);
  assert.equal(sockets[0].readyState, 1); assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  const closed = await ops.closeExec({ sessionId: value.sessionId });
  assert.equal(closed.processMayContinue, true); assert.equal(sockets[0].readyState, 3);
  await rejects(ops.readExec({ sessionId: value.sessionId }), 'session_not_found');
});

test('interactive input sends exactly supplied newline and controls and further reads return output', async t => {
  const { ops, sockets } = setup(t);
  const first = await ops.execContainer({ ...args, interactive: true, waitMs: 0 });
  await ops.writeExec({ sessionId: first.sessionId, input: 'echo synthetic\n\u0003' });
  assert.deepEqual(sockets[0].sent, ['echo synthetic\n\u0003']);
  const pending = ops.readExec({ sessionId: first.sessionId, cursor: first.cursor, waitMs: 100 });
  setTimeout(() => sockets[0].message('more'), 5);
  const value = await pending; assert.equal(value.output, 'more'); assert.equal(value.cursor, 4);
});

test('noninteractive and disconnected sessions reject writes without sending', async t => {
  const { ops, sockets } = setup(t);
  const value = await ops.execContainer({ ...args, waitMs: 0 });
  await rejects(ops.writeExec({ sessionId: value.sessionId, input: 'x' }), 'not_interactive');
  const interactive = await ops.execContainer({ ...args, interactive: true, waitMs: 0 }); sockets[1].close();
  await rejects(ops.writeExec({ sessionId: interactive.sessionId, input: 'x' }), 'socket_closed');
  assert.deepEqual(sockets[0].sent, []); assert.deepEqual(sockets[1].sent, []);
});

test('delayed completion returns inspected exit code and does not treat prestart null as finished', async t => {
  const { ops } = setup(t, { socket(ws, states) { states.set(ws.id, { Running: false, ExitCode: null }); setTimeout(() => { states.set(ws.id, { Running: false, ExitCode: 0 }); ws.close(); }, 10); } });
  const value = await ops.execContainer({ ...args, waitMs: 100 }); assert.equal(value.status, 'finished'); assert.equal(value.exitCode, 0);
});

test('prestart null exit code remains unknown', async t => {
  const { ops } = setup(t, { socket(ws, states) { states.set(ws.id, { Running: false, ExitCode: null }); } });
  const value = await ops.execContainer({ ...args, waitMs: 0 }); assert.equal(value.status, 'unknown'); assert.equal(value.exitCode, undefined); assert.equal(value.processMayContinue, true);
});

test('byte cursors decode binary UTF8 boundaries and paginate Unicode without replacement characters', async t => {
  const { ops, sockets } = setup(t);
  const first = await ops.execContainer({ ...args, waitMs: 0 });
  sockets[0].message(new Uint8Array([65, 0xf0, 0x9f]).buffer); sockets[0].message(new Uint8Array([0x98, 0x80, 66]).buffer);
  const page = await ops.readExec({ sessionId: first.sessionId, cursor: 0, maxChars: 2 });
  assert.equal(page.output, 'A😀'); assert.equal(page.cursor, 5); assert.equal(page.truncated, true);
  const next = await ops.readExec({ sessionId: first.sessionId, cursor: page.cursor }); assert.equal(next.output, 'B'); assert.equal(next.cursor, 6);
  await rejects(ops.readExec({ sessionId: first.sessionId, cursor: 2 }), 'invalid_arguments');
});

test('256KiB retained output exposes oldest byte and loss after rollover', async t => {
  const { ops, sockets } = setup(t);
  const first = await ops.execContainer({ ...args, waitMs: 0 }); sockets[0].message('x'.repeat(262144) + 'TAIL');
  const value = await ops.readExec({ sessionId: first.sessionId, cursor: 0, maxChars: 50000 });
  assert.equal(value.oldestCursor, 4); assert.equal(value.outputLost, true); assert.equal(value.output.length, 50000); assert.equal(value.cursor, 50004);
  const tail = await ops.readExec({ sessionId: first.sessionId, cursor: 262144 }); assert.equal(tail.output, 'TAIL');
});

test('socket errors explicitly retain uncertain process identity for inspection without reexecution', async t => {
  const { ops, calls } = setup(t, { socket(ws) { ws.error(); } });
  let failed; try { await ops.execContainer({ ...args, waitMs: 100 }); } catch (error) { failed = error; }
  assert.equal(failed?.code, 'socket_error'); assert.equal(failed.processMayContinue, true); assert.ok(failed.sessionId);
  const value = await ops.readExec({ sessionId: failed.sessionId }); assert.equal(value.status, 'running'); assert.equal(value.connected, false); assert.equal(value.transportError, 'socket_error');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
});

test('creation failures are explicit and never construct a socket or retry', async t => {
  const { ops, sockets, calls } = setup(t, { create: () => new Response('denied', { status: 403 }) });
  await rejects(ops.execContainer(args), 'access_required'); assert.equal(sockets.length, 0); assert.equal(calls.length, 1);
});

test('malformed create response cannot start a socket', async t => {
  const { ops, sockets } = setup(t, { create: () => Response.json({ Id: 'not hex' }) });
  await rejects(ops.execContainer(args), 'invalid_response'); assert.equal(sockets.length, 0);
});

test('inspect failure preserves session and uncertainty instead of fabricating exit', async t => {
  let failing = true;
  const { ops } = setup(t, { inspect: (id, states) => failing ? new Response('server secret', { status: 500 }) : Response.json(states.get(id)) });
  let failed; try { await ops.execContainer({ ...args, waitMs: 0 }); } catch (error) { failed = error; }
  assert.equal(failed?.code, 'http_error'); assert.ok(failed.sessionId); assert.equal(failed.processMayContinue, true); assert.ok(!failed.message.includes('secret'));
  failing = false; const value = await ops.readExec({ sessionId: failed.sessionId }); assert.equal(value.status, 'running'); assert.equal(value.exitCode, undefined);
});

test('disconnect alone never proves exit and close after verified completion reports false', async t => {
  const { ops, sockets, states } = setup(t);
  const first = await ops.execContainer({ ...args, waitMs: 0 }); sockets[0].close();
  const value = await ops.readExec({ sessionId: first.sessionId }); assert.equal(value.status, 'running'); assert.equal(value.processMayContinue, true);
  states.set(sockets[0].id, { Running: false, ExitCode: 9 });
  const closed = await ops.closeExec({ sessionId: first.sessionId }); assert.equal(closed.status, 'finished'); assert.equal(closed.exitCode, 9); assert.equal(closed.processMayContinue, false);
});

test('unknown sessions and invalid runtime arguments fail before HTTP side effects', async t => {
  const { ops, calls } = setup(t);
  await rejects(ops.readExec({ sessionId: 'missing' }), 'session_not_found');
  for (const bad of [{ command: [] }, { command: 'sh' }, { interactive: 'true' }, { waitMs: 10001 }, { user: 3 }, { workingDir: '\0' }, { environmentId: 8 }]) {
    await rejects(ops.execContainer({ ...args, ...bad }), bad.environmentId ? 'environment_mismatch' : 'invalid_arguments');
  }
  assert.equal(calls.length, 0);
});

test('four sessions include concurrent pending creations and closing frees capacity', async t => {
  const { ops, calls } = setup(t);
  const values = await Promise.all(Array.from({ length: 4 }, () => ops.execContainer({ ...args, waitMs: 0 })));
  await rejects(ops.execContainer({ ...args, waitMs: 0 }), 'session_limit'); assert.equal(calls.filter(c => c.init.method === 'POST').length, 4);
  await ops.closeExec({ sessionId: values[0].sessionId }); assert.ok((await ops.execContainer({ ...args, waitMs: 0 })).sessionId);
});

test('ten minutes without tool activity expires sessions and disconnects sockets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ops, sockets } = setup(t); const value = await ops.execContainer({ ...args, waitMs: 0 });
  t.mock.timers.tick(600001);
  assert.equal(sockets[0].readyState, 3); await rejects(ops.readExec({ sessionId: value.sessionId }), 'session_not_found');
  assert.ok((await ops.execContainer({ ...args, waitMs: 0 })).sessionId);
});

test('environment changes close all owned sockets and reject stale results', async t => {
  const { ops, window, sockets } = setup(t); const value = await ops.execContainer({ ...args, waitMs: 0 });
  window.location.href = 'https://portainer.attq/#!/8/docker/containers/other';
  await rejects(ops.readExec({ sessionId: value.sessionId }), 'environment_changed'); assert.equal(sockets[0].readyState, 3);
});

test('same-environment route change preserves console sessions', async t => {
  const { ops, window } = setup(t); const value = await ops.execContainer({ ...args, waitMs: 0 });
  window.location.href = 'https://portainer.attq/#!/7/docker/images'; assert.equal((await ops.readExec({ sessionId: value.sessionId })).status, 'running');
});

test('lifecycle cancellation disconnects and cancels pending wait', async t => {
  const { ops, lifecycle, sockets } = setup(t); const value = await ops.execContainer({ ...args, waitMs: 0 });
  const pending = ops.readExec({ sessionId: value.sessionId, waitMs: 10000 }); lifecycle.abort(); await rejects(pending, 'cancelled'); assert.equal(sockets[0].readyState, 3);
});

test('action cancellation rejects waiting but retains uncertain started session', async t => {
  const { ops, sockets } = setup(t); const action = new AbortController();
  const pending = ops.execContainer({ ...args, waitMs: 10000 }, action.signal); await turn(); action.abort();
  let failed; try { await pending; } catch (error) { failed = error; }
  assert.equal(failed?.code, 'cancelled'); assert.ok(failed.sessionId); assert.equal(failed.processMayContinue, true); assert.equal(sockets[0].readyState, 1);
  assert.equal((await ops.readExec({ sessionId: failed.sessionId })).status, 'running');
});

test('sessions waiting for completion count once toward capacity', async t => {
  const { ops } = setup(t);
  const first = ops.execContainer({ ...args, waitMs: 30 }); await turn();
  const second = await ops.execContainer({ ...args, waitMs: 0 });
  const third = await ops.execContainer({ ...args, waitMs: 0 });
  const fourth = await ops.execContainer({ ...args, waitMs: 0 });
  assert.ok(second.sessionId && third.sessionId && fourth.sessionId); await first;
  await rejects(ops.execContainer({ ...args, waitMs: 0 }), 'session_limit');
});

test('stalled connection disconnects at its deadline and exposes uncertainty', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ops, sockets } = setup(t, { autoOpen: false });
  const first = await ops.execContainer({ ...args, waitMs: 0 }); assert.equal(first.connected, false);
  t.mock.timers.tick(15000); assert.equal(sockets[0].readyState, 3);
  const value = await ops.readExec({ sessionId: first.sessionId }); assert.equal(value.transportError, 'socket_timeout'); assert.equal(value.processMayContinue, true);
});

test('constructor failure is explicit and carries the retained exec session', async t => {
  const { ops, calls } = setup(t, { constructorError: true });
  let failed; try { await ops.execContainer({ ...args, waitMs: 0 }); } catch (error) { failed = error; }
  assert.equal(failed?.code, 'socket_error'); assert.ok(failed.sessionId); assert.equal(failed.processMayContinue, true);
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
});

test('environment changing during inspect rejects pending output and disconnects', async t => {
  let release, block = false;
  const { ops, sockets, window } = setup(t, { inspect: async (id, states) => {
    if (block) await new Promise(resolve => { release = resolve; }); return Response.json(states.get(id));
  } });
  const first = await ops.execContainer({ ...args, waitMs: 0 }); block = true;
  const pending = ops.readExec({ sessionId: first.sessionId }); await turn();
  sockets[0].message('PRIVATE SYNTHETIC OLD ENV'); window.location.href = 'https://portainer.attq/#!/8/docker/containers/other'; release();
  await rejects(pending, 'environment_changed'); assert.equal(sockets[0].readyState, 3);
});

test('failed close inspection still releases socket and capacity with truthful uncertainty', async t => {
  let failing = false;
  const { ops, sockets } = setup(t, { inspect: (id, states) => failing ? new Response('', { status: 503 }) : Response.json(states.get(id)) });
  const first = await ops.execContainer({ ...args, waitMs: 0 }); failing = true;
  await assert.rejects(ops.closeExec({ sessionId: first.sessionId }), error => error.code === 'http_error' && error.closed && error.processMayContinue);
  assert.equal(sockets[0].readyState, 3); await rejects(ops.readExec({ sessionId: first.sessionId }), 'session_not_found');
});

test('malformed inspect status fails explicitly rather than inventing an exit code', async t => {
  const { ops } = setup(t, { inspect: () => Response.json({ Running: false, ExitCode: '0' }) });
  await rejects(ops.execContainer({ ...args, waitMs: 0 }), 'invalid_response');
});

test('buffer rollover skips partial UTF8 characters and preserves returned cursor boundaries', async t => {
  const { ops, sockets } = setup(t); const first = await ops.execContainer({ ...args, waitMs: 0 });
  sockets[0].message('😀' + 'x'.repeat(262143));
  const value = await ops.readExec({ sessionId: first.sessionId, cursor: 0, maxChars: 1 });
  assert.equal(value.oldestCursor, 4); assert.equal(value.output, 'x'); assert.equal(value.cursor, 5); assert.equal(value.outputLost, true);
});
