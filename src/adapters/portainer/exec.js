import { PortainerError, assertEnvironment, fail, integer, resourceId, string } from './client.js';

const BUFFER_BYTES = 256 * 1024;
const IDLE_MS = 10 * 60 * 1000;
const CONNECT_MS = 15000;
const encoder = new TextEncoder();

export function createExecOperations({ window, client, signal: lifecycleSignal, WebSocket = window.WebSocket }) {
  const sessions = new Map();
  let reservations = 0;
  let disposed = false;

  function notify(session) { for (const wake of session.waiters) wake(); }
  function disconnect(session) {
    clearTimeout(session.connectTimer);
    session.connected = false;
    session.disconnected = true;
    session.transportVersion++;
    if (session.socket && session.socket.readyState < 2) session.socket.close();
    notify(session);
  }
  function remove(session, reason) {
    clearTimeout(session.idleTimer);
    session.removed = reason;
    sessions.delete(session.sessionId);
    disconnect(session);
  }
  function dispose() {
    disposed = true;
    for (const session of sessions.values()) remove(session, 'cancelled');
    lifecycleSignal?.removeEventListener('abort', dispose);
  }
  function check(signal) {
    try { client.check(signal); }
    catch (error) {
      if (error.code === 'environment_changed' || lifecycleSignal?.aborted) dispose();
      throw error;
    }
    if (disposed) fail('cancelled', 'The console adapter is no longer active.');
  }
  function touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => remove(session, 'session_expired'), IDLE_MS);
    session.idleTimer.unref?.();
  }
  function getSession(args, signal) {
    check(signal);
    string(args.sessionId, 'sessionId', 200, 1);
    const session = sessions.get(args.sessionId);
    if (!session) fail('session_not_found', 'Unknown, closed or expired console session. Sessions expire after ten minutes without tool activity.');
    touch(session);
    return session;
  }
  function checkSession(session, signal) {
    check(signal);
    if (session.removed) fail(session.removed, 'The console session is no longer retained.');
  }
  function withSession(error, session) {
    if (error.code === 'environment_changed' || lifecycleSignal?.aborted) dispose();
    if (!session) return error;
    if (!(error instanceof PortainerError)) error = new PortainerError('console_error', 'The console operation failed.');
    Object.assign(error, { sessionId: session.sessionId, processMayContinue: session.status !== 'finished' });
    return error;
  }
  function append(session, text) {
    const bytes = encoder.encode(text);
    if (!bytes.length) return;
    const size = Math.min(BUFFER_BYTES, session.bytes.length + bytes.length);
    const joined = new Uint8Array(size);
    if (bytes.length >= size) joined.set(bytes.subarray(bytes.length - size));
    else {
      joined.set(session.bytes.subarray(Math.max(0, session.bytes.length - (size - bytes.length))));
      joined.set(bytes, size - bytes.length);
    }
    session.end += bytes.length;
    let skip = 0;
    while (skip < joined.length && (joined[skip] & 0xc0) === 0x80) skip++;
    session.bytes = joined.subarray(skip);
    session.oldest = session.end - session.bytes.length;
    notify(session);
  }
  function open(session) {
    if (typeof WebSocket !== 'function') fail('websocket_unavailable', 'This browser does not provide WebSocket.');
    const url = new URL('/api/websocket/exec', client.context().origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('id', session.execId);
    url.searchParams.set('endpointId', session.environmentId);
    const socket = session.socket = new WebSocket(url.href);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      try { checkSession(session); }
      catch { disconnect(session); return; }
      clearTimeout(session.connectTimer);
      session.connected = true;
      session.transportVersion++;
      notify(session);
    });
    socket.addEventListener('message', event => {
      try {
        checkSession(session);
        const data = typeof event.data === 'string' ? encoder.encode(event.data) : event.data;
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) fail('socket_protocol_error', 'The console returned an unsupported WebSocket message.');
        append(session, session.decoder.decode(data, { stream: true }));
      } catch (error) {
        if (!disposed && !session.removed) session.transportError = error instanceof PortainerError ? error.code : 'socket_protocol_error';
        disconnect(session);
      }
    });
    socket.addEventListener('error', () => {
      session.transportError = 'socket_error';
      disconnect(session);
    });
    socket.addEventListener('close', () => {
      append(session, session.decoder.decode());
      clearTimeout(session.connectTimer);
      session.connected = false;
      session.disconnected = true;
      session.transportVersion++;
      notify(session);
    });
    session.connectTimer = setTimeout(() => {
      session.transportError = 'socket_timeout';
      disconnect(session);
    }, CONNECT_MS);
    session.connectTimer.unref?.();
  }
  async function inspect(session, signal) {
    checkSession(session, signal);
    const value = await client.request(`/api/endpoints/${session.environmentId}/docker/exec/${resourceId(session.execId)}/json`, { signal });
    checkSession(session, signal);
    if (!value || typeof value.Running !== 'boolean' || (value.ExitCode !== null && !Number.isSafeInteger(value.ExitCode))) fail('invalid_response', 'Portainer returned an invalid exec status.');
    // Docker exposes a null exit code before execution; a disconnected socket alone proves nothing.
    session.status = value.Running ? 'running' : value.ExitCode === null ? 'unknown' : 'finished';
    session.exitCode = session.status === 'finished' ? value.ExitCode : undefined;
  }
  function pause(session, ms, signal) {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      session.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
      if (signal?.aborted || session.removed) wake();
    });
  }
  async function wait(session, { waitMs, cursor, untilExit }, signal) {
    const deadline = Date.now() + waitMs;
    while (true) {
      const transportVersion = session.transportVersion;
      await inspect(session, signal);
      // An open/close during the HTTP round trip can make its pre-transition status obsolete.
      if (transportVersion !== session.transportVersion) continue;
      if (untilExit && session.transportError) fail(session.transportError, 'The console transport failed; the process may still be running.');
      if (session.status === 'finished' || (!untilExit && session.end > cursor) || session.disconnected) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return waitMs > 0;
      await pause(session, Math.min(100, remaining), signal);
      checkSession(session, signal);
    }
  }
  function snapshot(session, cursor, maxChars, timedOut = false) {
    if (cursor > session.end) fail('invalid_arguments', 'cursor is beyond the current console output.');
    const at = Math.max(cursor, session.oldest);
    const relative = at - session.oldest;
    if (relative < session.bytes.length && (session.bytes[relative] & 0xc0) === 0x80) fail('invalid_arguments', 'cursor must be a UTF8 character boundary returned by this tool.');
    const text = new TextDecoder().decode(session.bytes.subarray(relative));
    let output = '', count = 0;
    for (const char of text) { if (count++ === maxChars) break; output += char; }
    const next = at + encoder.encode(output).length;
    return {
      sessionId: session.sessionId, environmentId: session.environmentId, containerId: session.containerId,
      command: session.command, interactive: session.interactive, stream: 'merged', status: session.status,
      ...(session.status === 'finished' ? { exitCode: session.exitCode } : {}),
      connected: session.connected, output, cursor: next, oldestCursor: session.oldest,
      outputLost: cursor < session.oldest, truncated: cursor < session.oldest || next < session.end,
      timedOut, processMayContinue: session.status !== 'finished', idleTimeoutMs: IDLE_MS,
      ...(session.transportError ? { transportError: session.transportError } : {}),
    };
  }
  async function execContainer(args, signal) {
    check(signal); assertEnvironment(client, args.environmentId);
    const containerId = resourceId(args.containerId);
    if (!Array.isArray(args.command) || !args.command.length || args.command.length > 1000) fail('invalid_arguments', 'command must be a nonempty argv array with at most 1000 items.');
    for (const arg of args.command) string(arg, 'command argument', 32768);
    if (!args.command[0].length || args.command.reduce((size, arg) => size + arg.length, 0) > 32768) fail('invalid_arguments', 'command must have a nonempty executable and at most 32768 characters.');
    const interactive = args.interactive ?? false;
    if (typeof interactive !== 'boolean') fail('invalid_arguments', 'interactive must be a boolean.');
    const waitMs = integer(args.waitMs ?? 1000, 'waitMs', 0, 10000);
    if (args.user !== undefined) string(args.user, 'user', 2000);
    if (args.workingDir !== undefined) string(args.workingDir, 'workingDir', 2000);
    if (sessions.size + reservations >= 4) fail('session_limit', 'Close an existing session before creating another; at most four sessions are retained.');
    if (typeof WebSocket !== 'function') fail('websocket_unavailable', 'This browser does not provide WebSocket.');
    reservations++;
    let reserved = true;
    let session;
    try {
      const created = await client.request(`/api/endpoints/${args.environmentId}/docker/containers/${containerId}/exec`, {
        method: 'POST', signal,
        body: { AttachStdin: interactive, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: args.command,
          ...(args.user !== undefined ? { User: args.user } : {}), ...(args.workingDir !== undefined ? { WorkingDir: args.workingDir } : {}) },
      });
      check(signal);
      if (!created || typeof created.Id !== 'string' || !/^[a-f\d]{1,200}$/i.test(created.Id)) fail('invalid_response', 'Portainer did not return a valid exec identifier.');
      session = {
        sessionId: globalThis.crypto.randomUUID(), execId: created.Id, environmentId: args.environmentId,
        containerId: args.containerId, command: [...args.command], interactive,
        bytes: new Uint8Array(), end: 0, oldest: 0, decoder: new TextDecoder(), waiters: new Set(),
        status: 'unknown', connected: false, disconnected: false,
        transportVersion: 0,
      };
      sessions.set(session.sessionId, session);
      reservations--; reserved = false;
      touch(session);
      try { open(session); }
      catch (error) {
        session.transportError = error instanceof PortainerError ? error.code : 'socket_error';
        disconnect(session);
        fail(session.transportError, 'The console connection could not be established; execution status is unknown.');
      }
      const timedOut = await wait(session, { waitMs, cursor: 0, untilExit: true }, signal);
      checkSession(session, signal);
      touch(session);
      return snapshot(session, 0, 10000, timedOut);
    } catch (error) { throw withSession(error, session); }
    finally { if (reserved) reservations--; }
  }
  async function readExec(args, signal) {
    const session = getSession(args, signal);
    const cursor = integer(args.cursor ?? 0, 'cursor', 0, Number.MAX_SAFE_INTEGER);
    const maxChars = integer(args.maxChars ?? 10000, 'maxChars', 1, 50000);
    const waitMs = integer(args.waitMs ?? 0, 'waitMs', 0, 10000);
    try {
      snapshot(session, cursor, maxChars);
      const timedOut = await wait(session, { waitMs, cursor, untilExit: false }, signal);
      checkSession(session, signal); touch(session);
      return snapshot(session, cursor, maxChars, timedOut);
    } catch (error) { throw withSession(error, session); }
  }
  async function writeExec(args, signal) {
    const session = getSession(args, signal);
    if (typeof args.input !== 'string' || args.input.length > 65536) fail('invalid_arguments', 'input must be text with at most 65536 characters.');
    if (!session.interactive) fail('not_interactive', 'This session was created without stdin.');
    if (!session.connected || session.socket.readyState !== 1) fail('socket_closed', 'The console is not connected; the process may still be running.');
    try { session.socket.send(args.input); }
    catch { throw withSession(new PortainerError('socket_error', 'Sending console input failed; do not automatically resend it.'), session); }
    checkSession(session, signal);
    return { sessionId: session.sessionId, sentBytes: encoder.encode(args.input).length, processMayContinue: session.status !== 'finished' };
  }
  async function closeExec(args, signal) {
    const session = getSession(args, signal);
    try {
      await inspect(session, signal);
      const value = snapshot(session, session.end, 1);
      return { ...value, connected: false, closed: true };
    } catch (error) { throw Object.assign(withSession(error, session), { closed: true }); }
    finally { remove(session, 'session_not_found'); }
  }
  lifecycleSignal?.addEventListener('abort', dispose, { once: true });
  if (lifecycleSignal?.aborted) dispose();
  return { execContainer, readExec, writeExec, closeExec, dispose };
}
