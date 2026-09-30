// Directory: public lobbies and the GOD queue, against an in-memory storage
import { Directory, routeMessage } from "../src/index.js";
import assert from "assert";
const store = new Map();
const storage = { get: async k => store.get(k), put: async (k, v) => { if (typeof k === "object") { for (const x in k) store.set(x, k[x]); } else store.set(k, v); },
  delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) };
const dir = new Directory({ storage, blockConcurrencyWhile: f => f() }, {});
const call = async b => (await dir.handle(b)).json();
// lobbies
await call({ op: "lobby", code: "ABCDE", n: 2, max: 6, host: "Ben", gm: "ffa", map: "sky" });
await call({ op: "lobby", code: "PRIVT", n: 1, max: 6, host: "Sam", priv: true });
await call({ op: "lobby", code: "FULLL", n: 6, max: 6, host: "Max" });
await call({ op: "lobby", code: "PLAYN", n: 3, max: 6, host: "Ann", playing: true });
let l = await call({ op: "lobbies" });
assert.deepEqual(l.lobbies.map(x => x.code), ["ABCDE"], JSON.stringify(l));
await call({ op: "lobby", code: "ABCDE", n: 0 });
l = await call({ op: "lobbies" }); assert.equal(l.lobbies.length, 0);
// the GOD queue
let a = await call({ op: "queue", sub: "alice" }); assert.ok(a.waiting);
let b = await call({ op: "queue", sub: "bob" }); assert.ok(b.match, JSON.stringify(b)); assert.equal(b.host, false);
a = await call({ op: "queue", sub: "alice" }); assert.equal(a.match, b.match); assert.equal(a.host, true);
let c = await call({ op: "queue", sub: "carol" }); assert.ok(c.waiting, "carol waits alone");
await call({ op: "queue", sub: "carol", leave: true });
let d = await call({ op: "queue", sub: "dave" }); assert.ok(d.waiting, "carol left, dave waits");
// the start message passes god1 through
const r = routeMessage({ t: "start", mode: "god1", q: 1, map: "void" }, "h", "h");
assert.equal(r.payload.mode, "god1"); assert.equal(r.payload.q, 1); assert.equal(r.payload.map, "void");
console.log("directory tests passed");
