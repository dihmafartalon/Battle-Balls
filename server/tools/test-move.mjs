/* The server's movement check, on the real game running headless (sim.js):
   ordinary movement passes untouched, lag spikes and abilities are allowed
   for, and impossible reports are cut back -- with a correction to that
   player only, and a flag (never a ban) after a run of them. */
import assert from "assert";
import { SimHost } from "../src/sim.js";
const out = [];
const s = new SimHost(m => out.push(m));
const roster = { t: "roster", host: "srv", leader: "A", count: 2, players: [
  { id: "A", name: "A", ready: false, sword: "trainer", skin: "rookie", abil: "dash" },
  { id: "B", name: "B", ready: false, sword: "trainer", skin: "rookie", abil: "dash" }] };
s.start({ t: "start", mode: "mp", map: "sky", gm: "ffa", q: 0, bots: 0, rf: 0, seed: 7, at: Date.now() }, roster);
const g = s.g, A = () => s.state().fighters.find(f => f.netId === "A");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let x = A().pos.x, z = A().pos.z;
const send = (o) => s.feed(Object.assign({ t: "state", from: "A", r: 0, vx: 0, vz: 0, y: 0 }, o));
const corrs = () => out.filter(m => m.t === "corr" && m.to === "A");
// nobody parries in this test: keep the ball parked so it never takes a player out
const park = setInterval(() => { for (const b of s.state().balls) { b.active = false; b.respawn = 99; b.target = null; } }, 20);
// wait out the countdown
await sleep(3300);
// 1. ordinary movement: sprinting at full speed, 20 times a second, with jitter
let t = 0;
for (let i = 0; i < 40; i++) { const step = 14.5 * 1.34 * 0.05 * (0.8 + Math.random() * 0.4); x -= step * 0.6; z += step * 0.4; send({ x, z }); await sleep(45 + Math.random() * 15); }
assert.equal(corrs().length, 0, "ordinary sprinting is never corrected");
const tgt = A().netTarget; assert.ok(Math.abs(tgt.x - x) < 0.01 && Math.abs(tgt.z - z) < 0.01, "accepted exactly");
// 2. a lag spike: nothing for 1.5s, then where they really are now
await sleep(1500); x += 22; send({ x, z });
assert.equal(corrs().length, 0, "a lag spike is allowed for");
// 3. a double jump's height is fine; 40 units up is not
send({ x, z, y: 8.2 }); await sleep(50);
assert.equal(corrs().length, 0, "a double jump is fine");
send({ x, z, y: 40 }); await sleep(50);
assert.equal(corrs().length, 1, "flying is corrected"); assert.ok(A().netTarget.y <= 9.6, "and held to a jump's height");
send({ x, z, y: 0 }); await sleep(500);
// 4. a teleport across the arena with no ability: cut back, and that player told
const before = corrs().length;
send({ x: x - 30, z: z - 10 }); await sleep(50);
assert.equal(corrs().length, before + 1, "a teleport is corrected");
const c = corrs()[corrs().length - 1];
const moved = Math.hypot(c.x - x, c.z - z); assert.ok(moved > 5 && moved < 20 && moved < Math.hypot(30, 10), "to the furthest legal point, not the claimed one: " + moved.toFixed(1));
x = c.x; z = c.z; send({ x, z }); await sleep(500);
// 5. not a number: dropped, nothing moves
const keep = Object.assign({}, A().netTarget);
send({ x: NaN, z }); send({ x: Infinity, z }); send({ x: "1e9", z }); await sleep(50);
assert.ok(Math.abs(A().netTarget.x - keep.x) < 0.01, "non-numbers are dropped");
// 6. outside the arena: held at the edge
const b2 = corrs().length; send({ x: 300, z: 0 }); await sleep(50);
assert.ok(Math.hypot(A().netTarget.x, A().netTarget.z) <= 34, "held inside the arena");
assert.ok(corrs().length > b2, "and corrected");
const cc = corrs()[corrs().length - 1]; x = cc.x; z = cc.z; send({ x, z }); await sleep(600);
// 7. an ability (Dash) opens a grace window: a burst that would be impossible on foot is fine
const b3 = corrs().length;
s.feed({ t: "ability", from: "A", a: "dash", y: 0 }); await sleep(30);
x = x * 0.2; z = z * 0.2; send({ x, z }); await sleep(50);
assert.equal(corrs().length, b3, "movement right after an ability is allowed: " + JSON.stringify(corrs().slice(b3)));
// 8. one bad report flags nothing; a run of them is one flag (never a ban)
assert.equal(out.filter(m => m.t === "mvflag").length, 0, "no flag for the odd bad report");
await sleep(2800);
for (let i = 0; i < 8; i++) { send({ x: x + (i % 2 ? 40 : -40), z }); await sleep(60); }
const fl = out.filter(m => m.t === "mvflag");
assert.equal(fl.length, 1, "a run of impossible moves is flagged once: " + fl.length);
assert.equal(fl[0].who, "A");
clearInterval(park);
s.stop();
console.log("movement validation tests passed");
process.exit(0);
