/* In-memory stand-ins for Cloudflare's Durable Object storage and bindings,
   so the Room, Vault and social objects can be driven from plain Node tests. */
export function memStorage() {
  const m = new Map();
  let alarm = null;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    _m: m,
    async get(k) {
      if (Array.isArray(k)) { const out = new Map(); for (const x of k) if (m.has(x)) out.set(x, clone(m.get(x))); return out; }
      return clone(m.get(k));
    },
    async put(k, v) {
      if (typeof k === "object" && k !== null) { for (const x in k) m.set(x, clone(k[x])); return; }
      m.set(k, clone(v));
    },
    async delete(k) { if (Array.isArray(k)) { let n = 0; for (const x of k) if (m.delete(x)) n++; return n; } return m.delete(k); },
    async list(o) {
      o = o || {};
      const p = o.prefix || "", out = new Map();
      let keys = [...m.keys()].sort().filter(k => k.startsWith(p) && (o.start === undefined || k >= o.start) && (o.end === undefined || k < o.end));
      if (o.reverse) keys.reverse();
      if (o.limit) keys = keys.slice(0, o.limit);
      for (const k of keys) out.set(k, clone(m.get(k)));
      return out;
    },
    async setAlarm(t) { alarm = t; },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; },
    get alarmAt() { return alarm; }
  };
}
export function memState() {
  const storage = memStorage();
  let q = Promise.resolve();
  return {
    storage,
    // one at a time, like the real thing
    blockConcurrencyWhile(fn) { const p = q.then(fn); q = p.catch(() => {}); return p; },
    waitUntil() {},
    socks: [],
    getWebSockets() { return this.socks.slice(); },
    acceptWebSocket(ws) { this.socks.push(ws); }
  };
}
/* A namespace of objects of one class: get(idFromName(x)).fetch(url, init).
   `faults(name, body)` may return "throw" (the call fails before reaching the
   object) or "lose" (the object handles it, then the answer is lost). */
export function memNamespace(make, faults) {
  const objs = new Map();
  const ns = {
    objs,
    idFromName(n) { return { name: n }; },
    get(id) {
      const n = id.name;
      if (!objs.has(n)) objs.set(n, make(n));
      const o = objs.get(n);
      return {
        async fetch(url, init) {
          const body = init && init.body ? JSON.parse(init.body) : {};
          const f = faults ? faults(n, body) : null;
          if (f === "throw") throw new Error("network");
          const req = new Request(typeof url === "string" ? url : "https://x/", { method: (init && init.method) || "POST", body: init && init.body, headers: init && init.headers });
          const res = await o.fetch(req);
          if (f === "lose") throw new Error("lost answer");
          return res;
        }
      };
    }
  };
  return ns;
}
