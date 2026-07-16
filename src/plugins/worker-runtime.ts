/** Injected into every plugin Worker. Builds the `conduit` SDK, loads the plugin's
 *  main.js from a blob module, and routes messages. Untrusted plugin code runs here
 *  with no DOM, no window IPC — only postMessage to the host. */
export const WORKER_BOOTSTRAP = /* js */ `
let plugin = null;
let ridSeq = 1;
const pending = new Map();          // rid -> {resolve,reject}
const eventHandlers = new Map();    // event -> Set<fn>
const commandHandlers = new Map();  // commandId -> fn

function request(method, params) {
  const rid = ridSeq++;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    self.postMessage({ type: "request", rid, method, params });
  });
}

const conduit = {
  hooks: {
    on(event, fn) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      eventHandlers.get(event).add(fn);
    },
  },
  commands: {
    register(id, fn) { commandHandlers.set(id, fn); return request("commands.register", { id }); },
    unregister(id) { commandHandlers.delete(id); return request("commands.unregister", { id }); },
  },
  notify(title, body) { return request("notify", { title, body }); },
  clipboard: { write(text) { return request("clipboard.write", { text }); } },
  net: { fetch(url, init) { return request("net.fetch", { url, init }); } },
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      const blob = new Blob([m.source], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      URL.revokeObjectURL(url);
      const Ctor = mod.default;
      plugin = typeof Ctor === "function" ? new Ctor() : Ctor;
      if (plugin && typeof plugin.onload === "function") await plugin.onload(conduit);
      self.postMessage({ type: "ready" });
    } else if (m.type === "event") {
      const hs = eventHandlers.get(m.event);
      if (hs) for (const fn of hs) { try { await fn(m.payload); } catch (err) { self.postMessage({ type: "error", message: String(err) }); } }
    } else if (m.type === "response") {
      const p = pending.get(m.rid);
      if (p) { pending.delete(m.rid); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
    } else if (m.type === "unload") {
      if (plugin && typeof plugin.onunload === "function") await plugin.onunload();
    } else if (m.type === "ping") {
      self.postMessage({ type: "pong" });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.stack || err) });
  }
};
`;
