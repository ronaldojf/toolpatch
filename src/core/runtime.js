const RUNTIME = Symbol.for('toolpatch.runtime');

export async function startToolpatch(window, adapters) {
  window[RUNTIME]?.();
  let stopped = false;
  let suspended = false;
  let current = null;
  let timer;
  let queue = Promise.resolve();
  const modelContext = window.document.modelContext ?? window.navigator.modelContext;

  function deactivate() {
    if (!current) return;
    current.controller.abort();
    // Compatibility with earlier navigator.modelContext implementations.
    if (typeof modelContext?.unregisterTool === 'function') {
      for (const name of current.names) {
        try { modelContext.unregisterTool(name); } catch { /* Already removed via registration signal. */ }
      }
    }
    current = null;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    deactivate();
    window.clearInterval(timer);
    window.removeEventListener('popstate', refresh);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    if (window[RUNTIME] === stop) delete window[RUNTIME];
  }
  window[RUNTIME] = stop;

  function refresh() {
    if (stopped || suspended) return queue;
    const url = new URL(window.location.href);
    const adapter = adapters.find(candidate => candidate.matchesURL(url));
    if (!adapter) { deactivate(); return queue; }
    const key = `${adapter.id}:${adapter.pageKey?.(window) ?? url.href}`;
    if (current?.key === key) return queue;
    deactivate();
    const state = { key, controller: new AbortController(), names: [] };
    current = state;
    queue = queue.then(async () => {
      if (state.controller.signal.aborted) return;
      try {
        const tools = adapter.createTools({ window, signal: state.controller.signal });
        for (const tool of tools) {
          if (state.controller.signal.aborted) break;
          await modelContext.registerTool(tool, { signal: state.controller.signal });
          state.names.push(tool.name);
          // Older API registrations may complete after a route was replaced.
          if (state.controller.signal.aborted && typeof modelContext.unregisterTool === 'function') modelContext.unregisterTool(tool.name);
        }
      } catch {
        if (current === state) deactivate();
        window.console.warn('[Toolpatch] Could not register WebMCP tools. Check Browser support and page permissions.');
      }
    });
    return queue;
  }
  function hide() { suspended = true; deactivate(); }
  function show() { suspended = false; refresh(); }

  if (!adapters.some(adapter => adapter.matchesURL(new URL(window.location.href)))) return stop;
  if (typeof modelContext?.registerTool !== 'function') {
    window.console.warn('[Toolpatch] Native WebMCP is unavailable in this browser. No tools registered.');
    return stop;
  }
  window.addEventListener('popstate', refresh);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  // pushState does not emit popstate. Poll identity without wrapping site methods.
  // Every call also checks mailbox identity before returning any data.
  timer = window.setInterval(refresh, 1000);
  await refresh();
  return stop;
}
