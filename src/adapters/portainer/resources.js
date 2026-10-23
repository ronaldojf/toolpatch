import { fail, integer, string, resourceId, assertEnvironment } from './client.js';

const kinds = ['containers', 'images', 'networks', 'stacks', 'volumes'];
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_response', 'Portainer returned an invalid resource.');
  return value;
}
function kind(value) { if (!kinds.includes(value)) fail('invalid_arguments', 'Unsupported resource kind.'); return value; }
function identity(type, value) {
  object(value);
  const id = type === 'volumes' ? value.Name : value.Id;
  if (type === 'stacks' ? !Number.isSafeInteger(id) || id < 1 : typeof id !== 'string' || !id) fail('invalid_response', 'Portainer resource is missing its identity.');
  return String(id);
}
function summary(type, value) {
  const id = identity(type, value);
  if (type === 'containers') return { id, names: value.Names ?? (value.Name ? [value.Name] : []), image: value.Config?.Image ?? value.Image, imageId: value.ImageID ?? (value.Config ? value.Image : undefined), state: typeof value.State === 'string' ? value.State : value.State?.Status, status: value.Status, created: value.Created };
  if (type === 'images') return { id, tags: value.RepoTags ?? [], digests: value.RepoDigests ?? [], size: value.Size, created: value.Created, architecture: value.Architecture, os: value.Os };
  if (type === 'networks') return { id, name: value.Name, driver: value.Driver, scope: value.Scope, internal: value.Internal, attachable: value.Attachable };
  if (type === 'volumes') return { id, name: value.Name, driver: value.Driver, scope: value.Scope, created: value.CreatedAt };
  return { id, name: value.Name, type: value.Type, status: value.Status, environmentId: value.EndpointId, created: value.CreationDate, updated: value.UpdateDate };
}
function environment(env) {
  if (env == null) return { names: [], values: '[REDACTED]' };
  if (!Array.isArray(env)) fail('invalid_response', 'Invalid environment variable list.');
  return { names: env.map(entry => typeof entry === 'string' ? entry.split('=', 1)[0] : string(entry?.name, 'environment variable name', 2000)), values: '[REDACTED]' };
}
function project(value) { return value.Labels?.['com.docker.compose.project'] ?? value.Labels?.['com.docker.stack.namespace'] ?? value.Config?.Labels?.['com.docker.compose.project'] ?? value.Config?.Labels?.['com.docker.stack.namespace']; }
function configuration(type, value) {
  if (type === 'containers') {
    const publishedPorts = Object.entries(value.NetworkSettings?.Ports ?? {}).flatMap(([port, bindings]) => {
      const [containerPort, protocol] = port.split('/');
      return (bindings ?? []).map(binding => ({ containerPort, protocol, hostAddress: binding.HostIp, hostPort: binding.HostPort }));
    });
    return { image: value.Config?.Image, user: value.Config?.User, workingDir: value.Config?.WorkingDir, tty: value.Config?.Tty, environment: environment(value.Config?.Env), exposedPorts: Object.keys(value.Config?.ExposedPorts ?? {}), publishedPorts, restartPolicy: value.HostConfig?.RestartPolicy?.Name, memoryBytes: value.HostConfig?.Memory, nanoCpus: value.HostConfig?.NanoCpus, logDriver: value.HostConfig?.LogConfig?.Type, omitted: ['command', 'labels', 'driverOptions', 'healthLog'] };
  }
  if (type === 'images') return { user: value.Config?.User, workingDir: value.Config?.WorkingDir, environment: environment(value.Config?.Env), exposedPorts: Object.keys(value.Config?.ExposedPorts ?? {}), omitted: ['command', 'labels', 'layers'] };
  if (type === 'networks') return { driver: value.Driver, internal: value.Internal, attachable: value.Attachable, enableIPv6: value.EnableIPv6, subnets: (value.IPAM?.Config ?? []).map(item => ({ subnet: item.Subnet, gateway: item.Gateway, ipRange: item.IPRange })), omitted: ['labels', 'driverOptions', 'ipamOptions'] };
  if (type === 'volumes') return { driver: value.Driver, scope: value.Scope, omitted: ['labels', 'driverOptions', 'status', 'mountpoint'] };
  return { environment: environment(value.Env), entryPoint: value.EntryPoint, omitted: ['composeContent', 'gitConfiguration', 'webhook', 'envValues'] };
}
function redact(text) {
  return text.replace(/\b(authorization\s*[=:]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, '$1[REDACTED]').replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b(\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^\s@/]+@/gi, '$1[REDACTED]@');
}
function decodeLogs(bytes, tty, selectedStream, truncated) {
  if (tty) return new TextDecoder().decode(bytes);
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  let output = ''; let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 8) { if (truncated) break; fail('invalid_response', 'Incomplete Docker log frame header.'); }
    const stream = bytes[at];
    if (![1, 2].includes(stream) || bytes[at + 1] || bytes[at + 2] || bytes[at + 3]) fail('invalid_response', 'Invalid Docker log frame header.');
    const length = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0);
    at += 8;
    const end = at + length;
    if (end > bytes.length && !truncated) fail('invalid_response', 'Incomplete Docker log frame payload.');
    if (selectedStream === 'both' || selectedStream === (stream === 1 ? 'stdout' : 'stderr')) output += decoders[stream].decode(bytes.subarray(at, Math.min(end, bytes.length)), { stream: true });
    at = end;
  }
  if (selectedStream !== 'stderr') output += decoders[1].decode();
  if (selectedStream !== 'stdout') output += decoders[2].decode();
  return output;
}
export function createResourceOperations(client) {
  const docker = id => `/api/endpoints/${id}/docker`;
  function checkArgs(args, signal) { objectArgs(args); client.check(signal); }
  function objectArgs(args) { if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_arguments', 'Provide an arguments object.'); }
  async function list(type, id, signal) {
    const paths = { containers: '/containers/json?all=true', images: '/images/json?all=true', networks: '/networks', volumes: '/volumes' };
    const data = await client.request(type === 'stacks' ? '/api/stacks' : docker(id) + paths[type], { signal });
    let rows = data;
    if (type === 'volumes') {
      object(data);
      if (!Object.hasOwn(data, 'Volumes')) fail('invalid_response', 'Missing Docker volume list.');
      rows = data.Volumes === null ? [] : data.Volumes;
    }
    if (!Array.isArray(rows)) fail('invalid_response', 'Portainer returned an invalid resource list.');
    rows.forEach(row => identity(type, row));
    if (type === 'stacks') rows = rows.filter(row => row.EndpointId === id);
    return rows;
  }
  async function getContext(args = {}, signal) {
    checkArgs(args, signal);
    const context = client.context();
    if (context.environmentId == null) return { ...context, selected: false };
    const endpoint = object(await client.request(`/api/endpoints/${context.environmentId}?excludeSnapshot=true`, { signal }));
    if (endpoint.Id !== context.environmentId) fail('invalid_response', 'Portainer returned the wrong environment.');
    client.check(signal);
    return { ...client.context(), selected: true, endpoint: { id: endpoint.Id, name: endpoint.Name, type: endpoint.Type, status: endpoint.Status } };
  }
  async function listResources(args, signal) {
    checkArgs(args, signal); const type = kind(args.kind); assertEnvironment(client, args.environmentId);
    const { limit = 20, offset = 0, query = '', state } = args;
    integer(limit, 'limit', 1, 100); integer(offset, 'offset', 0, Number.MAX_SAFE_INTEGER); string(query, 'query', 500);
    if (state !== undefined && (type !== 'containers' || !['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'].includes(state))) fail('invalid_arguments', 'state is only valid for containers and must be a Docker container state.');
    const rows = (await list(type, args.environmentId, signal)).map(row => summary(type, row)).filter(row => (!state || row.state === state) && (!query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase())));
    client.check(signal);
    return { environmentId: args.environmentId, kind: type, resources: rows.slice(offset, offset + limit), total: rows.length, offset, limit, hasMore: offset + limit < rows.length };
  }
  async function inspectResource(args, signal) {
    checkArgs(args, signal); const type = kind(args.kind); assertEnvironment(client, args.environmentId);
    const id = resourceId(args.id); const sections = args.sections ?? ['summary', 'relationships'];
    if (!Array.isArray(sections) || !sections.length || sections.some(section => !['summary', 'configuration', 'relationships'].includes(section))) fail('invalid_arguments', 'Select summary, configuration or relationships.');
    if (type === 'stacks' && !/^[1-9]\d*$/.test(args.id)) fail('invalid_arguments', 'A Portainer stack requires a numeric id.');
    const suffix = type === 'containers' || type === 'images' ? '/json' : '';
    const value = object(await client.request(type === 'stacks' ? `/api/stacks/${id}` : `${docker(args.environmentId)}/${type}/${id}${suffix}`, { signal }));
    identity(type, value);
    if (type === 'stacks' && value.EndpointId !== args.environmentId) fail('environment_mismatch', 'This stack belongs to another environment.');
    const out = { environmentId: args.environmentId, kind: type, id: identity(type, value) };
    if (sections.includes('summary')) out.summary = summary(type, value);
    if (sections.includes('configuration')) out.configuration = configuration(type, value);
    if (sections.includes('relationships')) {
      if (type === 'containers') out.relationships = { imageId: value.Image, composeProject: project(value), networks: Object.entries(value.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({ name, id: network.NetworkID, ipAddress: network.IPAddress })), volumes: (value.Mounts ?? []).map(mount => ({ type: mount.Type, name: mount.Name, destination: mount.Destination, readWrite: mount.RW })) };
      else if (type === 'networks') out.relationships = { composeProject: project(value), containers: Object.entries(value.Containers ?? {}).map(([id, container]) => ({ id, name: container.Name, ipv4Address: container.IPv4Address, ipv6Address: container.IPv6Address })) };
      else if (type === 'images' || type === 'volumes') {
        const containers = await list('containers', args.environmentId, signal);
        out.relationships = { ...(type === 'volumes' ? { composeProject: project(value) } : {}), containers: containers.filter(container => type === 'images' ? container.ImageID === value.Id : container.Mounts?.some(mount => mount.Type === 'volume' && mount.Name === value.Name)).map(container => summary('containers', container)) };
      } else {
        const containers = await list('containers', args.environmentId, signal);
        const networks = await list('networks', args.environmentId, signal);
        const volumes = await list('volumes', args.environmentId, signal);
        out.relationships = { containers: containers.filter(row => project(row) === value.Name).map(row => summary('containers', row)), networks: networks.filter(row => project(row) === value.Name).map(row => summary('networks', row)), volumes: volumes.filter(row => project(row) === value.Name).map(row => summary('volumes', row)), coverage: 'Resources with observed Compose project or Swarm stack labels; Portainer stacks do not enumerate all Compose projects.' };
      }
    }
    client.check(signal); return out;
  }
  async function readLogs(args, signal) {
    checkArgs(args, signal); assertEnvironment(client, args.environmentId); const id = resourceId(args.containerId);
    const { tail = 100, stream = 'both', search = '', maxChars = 10000 } = args;
    integer(tail, 'tail', 1, 1000); integer(maxChars, 'maxChars', 1, 50000); string(search, 'search', 500);
    if (!['stdout', 'stderr', 'both'].includes(stream)) fail('invalid_arguments', 'stream must be stdout, stderr or both.');
    const params = new URLSearchParams({ follow: 'false', stdout: String(stream !== 'stderr'), stderr: String(stream !== 'stdout'), timestamps: 'true', tail: String(tail) });
    const times = {};
    for (const key of ['since', 'until']) if (args[key] !== undefined) {
      const value = string(args[key], key, 100, 1);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid_arguments', `${key} must be an ISO timestamp with timezone.`);
      times[key] = Math.floor(Date.parse(value) / 1000); params.set(key, String(times[key]));
    }
    if (times.since !== undefined && times.until !== undefined && times.since > times.until) fail('invalid_arguments', 'since must not be later than until.');
    const container = object(await client.request(`${docker(args.environmentId)}/containers/${id}/json`, { signal }));
    if (typeof container.Config?.Tty !== 'boolean') fail('invalid_response', 'Container inspect did not specify Docker log Tty encoding.');
    if (container.Config.Tty) { params.set('stdout', 'true'); params.set('stderr', 'true'); }
    const { bytes, truncated: bytesTruncated } = await client.request(`${docker(args.environmentId)}/containers/${id}/logs?${params}`, { signal, responseType: 'bytes', maxBytes: 1048576 });
    let output = redact(decodeLogs(bytes, container.Config.Tty, stream, bytesTruncated));
    if (search) output = output.split('\n').filter(line => line.includes(search)).join('\n');
    const chars = Array.from(output); client.check(signal);
    return { environmentId: args.environmentId, containerId: args.containerId, stream: container.Config.Tty ? 'merged' : stream, output: chars.slice(0, maxChars).join(''), truncated: bytesTruncated || chars.length > maxChars, bytesTruncated, filterCoverage: 'retrieved_tail', tail, redaction: 'best_effort' };
  }
  return { getContext, listResources, inspectResource, readLogs };
}
