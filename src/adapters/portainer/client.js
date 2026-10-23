export class PortainerError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
export function fail(code, message, extra) { throw new PortainerError(code, message, extra); }
export function result(value, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] };
}
export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_arguments', `${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function string(value, name, max = 500, min = 0) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) fail('invalid_arguments', `Invalid ${name}.`);
  return value;
}
export function resourceId(value) {
  string(value, 'resource id', 2000, 1);
  if (value === '.' || value === '..') fail('invalid_arguments', 'Invalid resource id.');
  return encodeURIComponent(value);
}
export function assertEnvironment(client, id) {
  client.check(); integer(id, 'environmentId', 1, Number.MAX_SAFE_INTEGER);
  if (client.context().environmentId == null) fail('no_environment', 'Select a Docker environment in Portainer first.');
  if (id !== client.context().environmentId) fail('environment_mismatch', 'environmentId must match the selected Docker environment.');
}
function contextAt(window) {
  const url = new URL(window.location.href);
  const route = /^#!\/([1-9]\d*)\/docker(?:\/|$)/.exec(url.hash);
  const id = route ? Number(route[1]) : null;
  const container = /^#!\/[1-9]\d*\/docker\/containers\/([^/?]+)/.exec(url.hash);
  let containerId = null;
  try { if (container) containerId = decodeURIComponent(container[1]); } catch { /* Invalid route is not a selected container. */ }
  return { origin: url.origin, environmentId: Number.isSafeInteger(id) ? id : null, containerId };
}
export function createPortainerClient({ window, signal: lifecycleSignal, fetch = window.fetch.bind(window), requestTimeoutMs = 15000 }) {
  const selected = contextAt(window);
  function check(signal) {
    if (signal?.aborted || lifecycleSignal?.aborted) fail('cancelled', 'The tool call was cancelled.');
    const current = contextAt(window);
    if (current.origin !== selected.origin || current.environmentId !== selected.environmentId) fail('environment_changed', 'The selected Portainer environment changed. Call tools in the current page.');
  }
  async function request(path, { method = 'GET', body, signal, responseType = 'json', maxBytes = 4194304 } = {}) {
    check(signal);
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('#') || path.includes('\\')) fail('invalid_arguments', 'Use an origin-relative /api/ request path.');
    const url = new URL(path, selected.origin);
    if (url.origin !== selected.origin || url.pathname !== path.split('?')[0] || url.pathname.split('/').some(segment => { try { return ['.', '..'].includes(decodeURIComponent(segment)); } catch { return true; } })) fail('invalid_arguments', 'Invalid API path.');
    integer(maxBytes, 'maxBytes', 1, 4194304);
    if (!['json', 'bytes', 'text'].includes(responseType)) fail('invalid_arguments', 'Invalid responseType.');
    const deadline = new AbortController();
    const combined = AbortSignal.any([lifecycleSignal, signal, deadline.signal].filter(Boolean));
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(new PortainerError(deadline.signal.aborted ? 'request_timeout' : 'cancelled', deadline.signal.aborted ? 'The Portainer request timed out.' : 'The tool call was cancelled.'));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    const bounded = promise => Promise.race([promise, aborted]);
    const timer = setTimeout(() => deadline.abort(), requestTimeoutMs);
    let reader;
    try {
      const response = await bounded(fetch(url.href, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: responseType === 'json' ? 'application/json' : '*/*', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, signal: combined }));
      reader = response.body?.getReader();
      check(signal);
      if (response.status === 401 || response.status === 403) fail('access_required', 'Complete normal Portainer login or request access through the site, then retry.', { status: response.status });
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header !== null && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
        fail('rate_limited', 'Portainer rate-limited this request.', Number.isFinite(seconds) ? { retryAfterSeconds: Math.max(0, seconds) } : {});
      }
      if (response.status === 404) fail('not_found', 'The requested Portainer resource was not found.');
      if (!response.ok) fail('http_error', `Portainer returned HTTP ${response.status}.`, { status: response.status });
      const chunks = []; let size = 0; let truncated = false;
      if (reader) while (true) {
        const { done, value } = await bounded(reader.read());
        check(signal);
        if (done) break;
        const room = maxBytes - size;
        if (value.length > room) {
          if (responseType !== 'bytes') fail('response_too_large', 'The Portainer response exceeded its byte limit.');
          chunks.push(value.subarray(0, room)); size += room; truncated = true; break;
        }
        chunks.push(value); size += value.length;
        if (responseType === 'bytes' && size === maxBytes) { truncated = true; break; }
      }
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      check(signal);
      if (responseType === 'bytes') return { bytes, truncated };
      const text = new TextDecoder().decode(bytes);
      if (responseType === 'text') return text;
      try { return JSON.parse(text); } catch { fail('invalid_response', 'Portainer did not return valid JSON.'); }
    } catch (error) {
      check(signal);
      if (error instanceof PortainerError) throw error;
      if (deadline.signal.aborted) fail('request_timeout', 'The Portainer request timed out.');
      fail('network_error', 'The Portainer request failed.');
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', abort);
      if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  return { context: () => contextAt(window), check, request };
}
