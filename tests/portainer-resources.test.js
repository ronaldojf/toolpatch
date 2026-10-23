import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortainerClient, PortainerError, assertEnvironment, result } from '../src/adapters/portainer/client.js';
import { createResourceOperations } from '../src/adapters/portainer/resources.js';

const base = '/api/endpoints/7/docker';
const secret = 'FORBIDDEN_SECRET_VALUE';
const c = { Id: 'container-full-id', Names: ['/app'], Image: 'image:latest', ImageID: 'sha256:image-full-id', State: 'running', Status: 'Up', Labels: { 'com.docker.compose.project': 'external', private: secret }, Mounts: [{ Type: 'volume', Name: 'data', Destination: '/data', RW: true }], NetworkSettings: { Networks: { bridge: { NetworkID: 'network-full-id', IPAddress: '172.1.0.2' } } }, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }], Command: secret };
const inspected = { ...c, Image: 'sha256:image-full-id', Name: '/app', Config: { Image: 'image:latest', Tty: false, User: '1000', WorkingDir: '/app', Env: ['PASSWORD=' + secret, 'MODE=prod'], Labels: c.Labels, Cmd: [secret], ExposedPorts: { '80/tcp': {} } }, State: { Status: 'running', Running: true, ExitCode: 0, Health: { Status: 'healthy', Log: [{ Output: secret }] } }, HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Memory: 512, LogConfig: { Type: 'json-file', Config: { password: secret } } } };
function setup(routes, options = {}) {
  const window = { location: { href: 'https://portainer.attq/#!/7/docker/containers/container-full-id' } };
  const calls = [];
  const fetch = async (input, init) => {
    const url = new URL(input, window.location.href);
    calls.push({ url, init });
    const handler = routes[url.pathname + url.search] ?? routes[url.pathname];
    assert.ok(handler !== undefined, `Unexpected request: ${url.pathname}${url.search}`);
    return typeof handler === 'function' ? handler(init, url) : Response.json(handler);
  };
  const client = createPortainerClient({ window, fetch, ...options });
  return { window, calls, client, ops: createResourceOperations(client) };
}
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof PortainerError && error.code === code);
const args = kind => ({ kind, environmentId: 7 });
const noSecrets = value => assert.ok(!JSON.stringify(value).includes(secret), JSON.stringify(value));
function frame(stream, bytes) {
  bytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const out = new Uint8Array(8 + bytes.length); out[0] = stream; new DataView(out.buffer).setUint32(4, bytes.length); out.set(bytes, 8); return out;
}
function join(...parts) { const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of parts) { out.set(b, at); at += b.length; } return out; }

test('context returns safe selected endpoint and route without credentials', async () => {
  const { ops, calls, client } = setup({ '/api/endpoints/7': { Id: 7, Name: 'Synthetic', Type: 1, Status: 1, URL: secret, TLSConfig: { TLSCACertPath: secret }, AzureCredentials: { ClientSecret: secret } } });
  const value = await ops.getContext({});
  assert.equal(value.environmentId, 7); assert.equal(value.containerId, 'container-full-id'); assert.equal(value.endpoint.name, 'Synthetic'); noSecrets(value);
  assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(client.context().origin, 'https://portainer.attq'); assert.equal(result(value).content[0].type, 'text');
});

for (const [kind, path, data, id] of [
  ['containers', '/containers/json?all=true', [c], c.Id],
  ['images', '/images/json?all=true', [{ Id: 'sha256:image-full-id', RepoTags: ['image:latest'], Size: 123, Labels: { private: secret } }], 'sha256:image-full-id'],
  ['networks', '/networks', [{ Id: 'network-full-id', Name: 'bridge', Driver: 'bridge', Options: { token: secret } }], 'network-full-id'],
  ['volumes', '/volumes', { Volumes: [{ Name: 'data', Driver: 'local', Options: { password: secret } }], Warnings: null }, 'data'],
  ['stacks', null, [{ Id: 12, Name: 'managed', EndpointId: 7, Env: [{ name: 'PASSWORD', value: secret }], GitConfig: { Authentication: secret } }], '12'],
]) test(`list ${kind} uses documented envelope and returns safe exact identity`, async () => {
  const route = kind === 'stacks' ? '/api/stacks' : base + path;
  const { ops } = setup({ [route]: data });
  const value = await ops.listResources(args(kind));
  assert.equal(value.resources[0].id, id); assert.equal(value.total, 1); assert.equal(value.hasMore, false); noSecrets(value);
});

test('list filters before local pagination and preserves exact IDs', async () => {
  const { ops } = setup({ [base + '/containers/json']: [c, { ...c, Id: 'second-full-id', Names: ['/app2'] }, { ...c, Id: 'other-full-id', Names: ['/other'] }] });
  const value = await ops.listResources({ ...args('containers'), query: 'app', limit: 1, offset: 1, state: 'running' });
  assert.equal(value.total, 2); assert.equal(value.resources[0].id, 'second-full-id'); assert.equal(value.hasMore, false);
});

test('container details omit secrets and derive Compose relationships without managed stacks', async () => {
  const { ops } = setup({ [base + '/containers/container-full-id/json']: inspected });
  const value = await ops.inspectResource({ ...args('containers'), id: c.Id, sections: ['summary', 'configuration', 'relationships'] });
  assert.deepEqual(value.configuration.environment, { names: ['PASSWORD', 'MODE'], values: '[REDACTED]' });
  assert.equal(value.relationships.composeProject, 'external'); assert.equal(value.relationships.imageId, 'sha256:image-full-id');
  assert.equal(value.relationships.volumes[0].name, 'data'); assert.equal(value.relationships.networks[0].id, 'network-full-id'); noSecrets(value);
});

for (const [kind, id, path, data] of [
  ['images', 'repository/image:tag', '/images/repository%2Fimage%3Atag/json', { Id: 'sha256:image-full-id', RepoTags: ['repository/image:tag'], Config: { Env: ['TOKEN=' + secret], Cmd: [secret], User: '1000' }, RootFS: { Layers: [secret] } }],
  ['networks', 'network-full-id', '/networks/network-full-id', { Id: 'network-full-id', Name: 'bridge', Containers: { 'container-full-id': { Name: 'app', IPv4Address: '172.1.0.2/24' } }, Options: { secret }, IPAM: { Options: { secret } } }],
  ['volumes', 'data/name', '/volumes/data%2Fname', { Name: 'data/name', Driver: 'local', Options: { secret }, Labels: { private: secret }, Status: { token: secret } }],
]) test(`inspect ${kind} encodes exact segment and projects selected sections`, async () => {
  const { ops } = setup({ [base + path]: data, [base + '/containers/json']: [c] });
  const value = await ops.inspectResource({ ...args(kind), id, sections: ['summary', 'configuration', 'relationships'] });
  assert.ok(value.summary); assert.ok(value.relationships); noSecrets(value);
});

test('stack inspection checks environment and associates observed Compose resources', async () => {
  const { ops } = setup({ '/api/stacks/12': { Id: 12, Name: 'external', EndpointId: 7, Env: [{ name: 'TOKEN', value: secret }], GitConfig: { secret } }, [base + '/containers/json']: [c], [base + '/networks']: [{ Id: 'net', Name: 'project', Labels: { 'com.docker.compose.project': 'external' } }], [base + '/volumes']: { Volumes: [{ Name: 'project_data', Labels: { 'com.docker.compose.project': 'external' }, Options: { secret } }] } });
  const value = await ops.inspectResource({ ...args('stacks'), id: '12', sections: ['summary', 'configuration', 'relationships'] });
  assert.equal(value.relationships.containers[0].id, c.Id); assert.equal(value.relationships.networks[0].id, 'net'); assert.equal(value.relationships.volumes[0].id, 'project_data'); noSecrets(value);
  const cross = setup({ '/api/stacks/12': { Id: 12, Name: 'other', EndpointId: 8 } });
  await rejects(cross.ops.inspectResource({ ...args('stacks'), id: '12' }), 'environment_mismatch');
});

test('malformed API shapes fail explicitly; documented null volumes mean empty', async () => {
  for (const [kind, route, bad] of [['containers', '/containers/json', {}], ['volumes', '/volumes', {}], ['networks', '/networks', [null]], ['images', '/images/json', [{ Name: 'missing identity' }]]]) {
    const { ops } = setup({ [base + route]: bad }); await rejects(ops.listResources(args(kind)), 'invalid_response');
  }
  const { ops } = setup({ [base + '/volumes']: { Volumes: null, Warnings: null } }); assert.deepEqual((await ops.listResources(args('volumes'))).resources, []);
});

test('invalid runtime arguments fail before HTTP requests', async () => {
  const { ops, calls, client } = setup({});
  for (const a of [{ ...args('containers'), environmentId: '7' }, { ...args('containers'), environmentId: 8 }, { ...args('unknown') }, { ...args('containers'), limit: 0 }, { ...args('containers'), offset: -1 }, { ...args('images'), state: 'running' }, { ...args('containers'), query: 3 }]) await assert.rejects(ops.listResources(a), PortainerError);
  for (const id of ['', '..', '.', 'a\0b']) await rejects(ops.inspectResource({ ...args('volumes'), id }), 'invalid_arguments');
  await rejects(ops.inspectResource({ ...args('containers'), id: c.Id, sections: ['raw'] }), 'invalid_arguments');
  await assert.rejects(async () => assertEnvironment(client, 8), PortainerError); assert.equal(calls.length, 0);
});

for (const [status, code] of [[401, 'access_required'], [403, 'access_required'], [404, 'not_found'], [429, 'rate_limited'], [500, 'http_error']]) test(`HTTP ${status} stays explicit and does not expose server body`, async () => {
  const { client } = setup({ '/api/test': () => new Response(secret, { status, headers: { 'Retry-After': '23' } }) });
  await assert.rejects(client.request('/api/test'), error => { noSecrets(error); assert.equal(error.code, code); if (status === 429) assert.equal(error.retryAfterSeconds, 23); return true; });
});

test('invalid JSON, failed fetch, unsafe paths and oversized JSON have structured errors', async () => {
  const { client } = setup({ '/api/bad': () => new Response('<html>login</html>'), '/api/network': () => { throw new TypeError('secret network text'); }, '/api/large': { value: 'long' } });
  await rejects(client.request('/api/bad'), 'invalid_response'); await rejects(client.request('/api/network'), 'network_error'); await rejects(client.request('/api/large', { maxBytes: 2 }), 'response_too_large');
  for (const path of ['https://evil.test/api/x', '//evil.test/api/x', '/other', '/api/../logout', '/api/%2e%2e/logout', '/api/test#x']) await rejects(client.request(path), 'invalid_arguments');
});

test('same-environment navigation is allowed; selected environment or origin changes reject stale response', async () => {
  const { window, client } = setup({ '/api/test': async () => { window.location.href = 'https://portainer.attq/#!/8/docker/containers'; return Response.json({ secret }); } });
  await rejects(client.request('/api/test'), 'environment_changed');
  const same = setup({ '/api/test': async () => { same.window.location.href = 'https://portainer.attq/#!/7/docker/images'; return Response.json({ ok: true }); } }); assert.deepEqual(await same.client.request('/api/test'), { ok: true });
  same.window.location.href = 'https://other.test/#!/7/docker'; assert.throws(() => same.client.check(), PortainerError);
});

test('cancellation and deadline cover stalled body even when fetch ignores signal', async () => {
  const stalled = () => new Response(new ReadableStream({ start() {} }));
  const { client } = setup({ '/api/test': stalled }, { requestTimeoutMs: 15 });
  await rejects(client.request('/api/test'), 'request_timeout');
  const controller = new AbortController(); const other = setup({ '/api/test': stalled });
  const pending = other.client.request('/api/test', { signal: controller.signal }); setTimeout(() => controller.abort(), 5); await rejects(pending, 'cancelled');
  const lifecycle = new AbortController(); const last = setup({ '/api/test': stalled }, { signal: lifecycle.signal }); const waiting = last.client.request('/api/test'); lifecycle.abort(); await rejects(waiting, 'cancelled');
});

test('multiplexed logs retain UTF8 across frame/chunk boundaries and select streams', async () => {
  const euro = new TextEncoder().encode('€'); const bytes = join(frame(1, euro.subarray(0, 1)), frame(2, 'warning\n'), frame(1, euro.subarray(1)), frame(1, '\npassword=' + secret + '\n'));
  const { ops, calls } = setup({ [base + '/containers/container-full-id/json']: inspected, [base + '/containers/container-full-id/logs']: () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } })) });
  const value = await ops.readLogs({ environmentId: 7, containerId: c.Id, stream: 'stdout', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', tail: 7 });
  assert.ok(value.output.includes('€')); assert.ok(!value.output.includes('warning')); noSecrets(value); assert.equal(value.truncated, false); assert.equal(value.stream, 'stdout');
  const url = calls.at(-1).url; assert.equal(url.searchParams.get('follow'), 'false'); assert.equal(url.searchParams.get('since'), '1790812800'); assert.equal(url.searchParams.get('tail'), '7');
});

test('raw TTY logs report merged output, bounded search coverage and output truncation', async () => {
  const { ops } = setup({ [base + '/containers/container-full-id/json']: { ...inspected, Config: { Tty: true } }, [base + '/containers/container-full-id/logs']: () => new Response('first\nmatch éééé\nlast\n') });
  const value = await ops.readLogs({ environmentId: 7, containerId: c.Id, search: 'match', maxChars: 8 });
  assert.equal(value.output, 'match éé'); assert.equal(value.truncated, true); assert.equal(value.stream, 'merged'); assert.equal(value.filterCoverage, 'retrieved_tail');
});

test('logs cap body at 1 MiB and report byte truncation; malformed frames fail', async () => {
  let canceled = false;
  const { ops } = setup({ [base + '/containers/container-full-id/json']: { ...inspected, Config: { Tty: true } }, [base + '/containers/container-full-id/logs']: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577).fill(120)); }, cancel() { canceled = true; } })) });
  const value = await ops.readLogs({ environmentId: 7, containerId: c.Id }); assert.equal(value.truncated, true); assert.equal(value.bytesTruncated, true); assert.equal(value.output.length, 10000); assert.equal(canceled, true);
  const bad = setup({ [base + '/containers/container-full-id/json']: inspected, [base + '/containers/container-full-id/logs']: () => new Response(new Uint8Array([1, 0, 0])) });
  await rejects(bad.ops.readLogs({ environmentId: 7, containerId: c.Id }), 'invalid_response');
});

test('logs reject invalid ranges and missing Tty instead of guessing encoding', async () => {
  const { ops, calls } = setup({});
  for (const extra of [{ tail: 0 }, { maxChars: 50001 }, { stream: 'all' }, { search: 'x'.repeat(501) }, { since: 'yesterday' }, { since: '2026-10-02T00:00:00Z', until: '2026-10-01T00:00:00Z' }]) await rejects(ops.readLogs({ environmentId: 7, containerId: c.Id, ...extra }), 'invalid_arguments');
  assert.equal(calls.length, 0);
  const bad = setup({ [base + '/containers/container-full-id/json']: { Id: c.Id, Config: {} } }); await rejects(bad.ops.readLogs({ environmentId: 7, containerId: c.Id }), 'invalid_response');
});


test('log redaction covers authorization bearer tokens and URL credentials without orphaning secrets', async () => {
  const { ops } = setup({ [base + '/containers/container-full-id/json']: { ...inspected, Config: { Tty: true } }, [base + '/containers/container-full-id/logs']: () => new Response('Authorization: Bearer ' + secret + '\nhttps://user:' + secret + '@example.test/\nTOKEN="' + secret + '"\n') });
  const value = await ops.readLogs({ environmentId: 7, containerId: c.Id });
  noSecrets(value); assert.ok(value.output.includes('[REDACTED]'));
});

test('navigation during body consumption rejects stale data and fetch itself has a deadline', async () => {
  const fixture = setup({ '/api/body': () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); setTimeout(() => { fixture.window.location.href = 'https://portainer.attq/#!/8/docker'; controller.enqueue(new TextEncoder().encode('true}')); controller.close(); }, 5); } })) });
  await rejects(fixture.client.request('/api/body'), 'environment_changed');
  const stalled = setup({ '/api/stall': () => new Promise(() => {}) }, { requestTimeoutMs: 10 });
  await rejects(stalled.client.request('/api/stall'), 'request_timeout');
});


test('stack listing includes selected Swarm stacks and filters other endpoints before count and pagination', async () => {
  const { ops } = setup({ '/api/stacks': [{ Id: 10, Name: 'other', EndpointId: 8, Type: 2 }, { Id: 12, Name: 'selected-compose', EndpointId: 7, Type: 2 }, { Id: 13, Name: 'selected-swarm', EndpointId: 7, Type: 1, SwarmId: 'synthetic-swarm' }] });
  const value = await ops.listResources({ ...args('stacks'), limit: 1, offset: 1 });
  assert.equal(value.total, 2); assert.equal(value.resources[0].id, '13'); assert.equal(value.resources[0].name, 'selected-swarm'); assert.equal(value.hasMore, false);
});

test('HTTP failures cancel their response body without reading or exposing it', async () => {
  let canceled = false;
  const { client } = setup({ '/api/test': () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('secret')); }, cancel() { canceled = true; } }), { status: 403 }) });
  await rejects(client.request('/api/test'), 'access_required'); assert.equal(canceled, true);
});

test('byte cap cancels an exactly full stalled body without waiting for another chunk', async () => {
  let canceled = false;
  const { client } = setup({ '/api/logs': () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([97, 98, 99])); }, cancel() { canceled = true; } })) }, { requestTimeoutMs: 15 });
  const value = await client.request('/api/logs', { responseType: 'bytes', maxBytes: 3 });
  assert.deepEqual([...value.bytes], [97, 98, 99]); assert.equal(value.truncated, true); assert.equal(canceled, true);
});

test('safe endpoint context excludes bulk Docker snapshots at the HTTP boundary', async () => {
  const { ops, calls } = setup({ '/api/endpoints/7': { Id: 7, Name: 'Synthetic', Type: 1, Status: 1 } });
  await ops.getContext({}); assert.equal(calls[0].url.searchParams.get('excludeSnapshot'), 'true');
});
