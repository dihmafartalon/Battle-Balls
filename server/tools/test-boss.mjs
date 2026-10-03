/* Boss Rally on the real game running headless, exactly as the server runs it:
   health by party size, five player parries to break the guard (his returns
   never count), a knockout resets the guard, every break revives whoever has
   been down longest, the ball's speed is never reset inside a fight, phases
   2 and 3 curve his returns and add telegraphed attacks -- never during a
   recoil or a phase change -- and a team that is all down loses. */
import assert from "assert";
import { SimHost } from "../src/sim.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fight(n, opts) {
  opts = opts || {};
  const out = [];
  const s = new SimHost(m => { m._at = Date.now(); out.push(m); });
  const ids = ["A", "B", "C", "D", "E"].slice(0, n);
  const roster = { t: "roster", host: "srv", leader: "A", count: n, players: ids.map(id => (
    { id, name: id, ready: false, sword: "trainer", skin: "rookie", abil: opts.abil || "dash", babil: opts.babil })) };
  if (opts.cfg) Object.assign(s.g.bossCfg(), opts.cfg);
  s.start({ t: "start", mode: "boss", map: "sky", gm: "boss", q: 0, bots: 0, rf: 0, seed: 11, at: Date.now(), mid: "m-" + n }, roster);
  return { s, out, ids };
}
const F = (s, id) => s.state().fighters.find(f => f.netId === id);
const bossMsgs = out => out.filter(m => m.t === "boss");

// health for 1-4 players
{
  for (const [n, hp] of [[1, 6], [2, 8], [3, 10], [4, 12]]) {
    const { s, out } = fight(n);
    await sleep(60);
    const B = s.g.boss();
    assert.equal(B.max, hp, n + " players: " + hp + " segments");
    assert.equal(s.state().fighters.length, n, "players only: no bots");
    s.stop();
  }
  console.log("health by party size ok");
}

// abilities that sit Boss Rally out are swapped for the pick made for it; a bad pick falls back to Dash
{
  let { s } = fight(1, { abil: "swap", babil: "colossus" });
  assert.equal(F(s, "A").ability, "colossus"); s.stop();
  ({ s } = fight(1, { abil: "swap", babil: "gravity" }));
  assert.equal(F(s, "A").ability, "dash"); s.stop();
  ({ s } = fight(1, { abil: "chrono" }));
  assert.equal(F(s, "A").ability, "chrono", "a compatible ability is kept"); s.stop();
  console.log("ability compatibility ok");
}

/* a driver: each listed player blocks just before the ball reaches them, and
   gets out of the way of his attacks. Others never block. */
function drive(s, out, blockers, dodgers) {
  const pos = {}, plan = {};
  for (const f of s.state().fighters) pos[f.netId] = { x: f.pos.x, z: f.pos.z, y: 0 };
  const send = (id) => s.feed({ t: "state", from: id, x: pos[id].x, z: pos[id].z, y: pos[id].y, r: 0, vx: 0, vz: 0 });
  let seenAtk = 0;
  const iv = setInterval(() => {
    const st = s.state();
    for (const b of st.balls) {
      const tg = b.target;
      if (!b.active || !tg || !tg.netId || !blockers.includes(tg.netId) || !tg.alive) continue;
      const d = Math.hypot(b.pos.x - tg.pos.x, b.pos.y - (tg.y + 1.9), b.pos.z - tg.pos.z);
      if (d / Math.max(1, b.flightSpeed) < 0.12 && !(tg._tp > Date.now() - 400)) { tg._tp = Date.now(); s.feed({ t: "parry", from: tg.netId, c: Date.now(), y: 0 }); }
    }
    // dodge: walk out of a sword circle, jump a sweep
    const atks = bossMsgs(out).filter(m => m.ev && m.ev.k === "atk");
    if (atks.length > seenAtk) {
      const a = atks[atks.length - 1].ev.a; seenAtk = atks.length;
      for (const id of dodgers) {
        const f = F(s, id); if (!f || !f.alive) continue;
        if (a.k === "rain") {
          let tx = f.pos.x, tz = f.pos.z;
          for (const p of a.p) { const dx = tx - p[0], dz = tz - p[1], l = Math.hypot(dx, dz);
            if (l < 7) { const ux = l > 0.1 ? dx / l : 1, uz = l > 0.1 ? dz / l : 0; tx = p[0] + ux * 7.5; tz = p[1] + uz * 7.5; } }
          const c = s.g.get().MODE && Math.hypot(tx, tz) > 24 ? 22 / Math.hypot(tx, tz) : 1; tx *= c; tz = Math.max(2, tz * c);
          plan[id] = { k: "walk", x: tx, z: tz };
        } else plan[id] = { k: "jump", at: Date.now() + (a.t * 1000) - 350, until: Date.now() + a.t * 1000 + 350 };
      }
    }
    for (const id of dodgers) {
      const p = plan[id]; if (!p) continue;
      if (p.k === "walk") { const P = pos[id], dx = p.x - P.x, dz = p.z - P.z, l = Math.hypot(dx, dz), st2 = 0.5;
        if (l < st2) { P.x = p.x; P.z = p.z; delete plan[id]; } else { P.x += dx / l * st2; P.z += dz / l * st2; } }
      else { const now = Date.now(); pos[id].y = now > p.at && now < p.until ? 3 : 0; if (now > p.until) delete plan[id]; }
    }
    for (const id of dodgers) send(id);
  }, 40);
  return () => clearInterval(iv);
}
async function until(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(30); } throw new Error("timed out: " + what); }

// a solo fight from the first serve to the win (short health, so all three phases come quickly)
{
  const { s, out } = fight(1, { cfg: { hp: [3, 4, 5, 6], atkGap: [2.5, 3.5] } });
  const stop = drive(s, out, ["A"], ["A"]);
  // track the speed through the fight: it may only ever climb
  let lastM = 0, drops = 0, m0 = null;
  const iv = setInterval(() => { const b = s.state().balls[0]; if (b && b.active) { if (b.mult < lastM - 1e-6) drops++; lastM = b.mult; if (m0 === null) m0 = b.mult; } }, 20);
  await until(() => out.some(m => m.t === "roundover"), 150000, "the solo fight to end");
  stop(); clearInterval(iv);
  const bm = bossMsgs(out), evs = bm.map(m => m.ev).filter(Boolean);
  const ro = out.find(m => m.t === "roundover");
  assert.equal(ro.tm, 0, "the players' side won");
  assert.deepEqual(s.g.bossInfo(), { dealt: 3, total: 3, victory: true });
  // five player parries per break, counted 1..5, his returns never counting
  const gd = bm.filter(m => m.ev && m.ev.k === "gd").map(m => m.gd);
  assert.deepEqual(gd.slice(0, 5), [1, 2, 3, 4, 5], "the guard counts player parries: " + gd.slice(0, 8));
  assert.equal(evs.filter(e => e.k === "brk").length, 3, "three guard breaks for three segments");
  const rets = evs.filter(e => e.k === "ret");
  assert.ok(rets.length >= 12, "he returns the ball between parries: " + rets.length);
  // phases: the curve starts in phase 2, attacks only in phase 3
  const phs = evs.filter(e => e.k === "ph").map(e => e.p);
  assert.deepEqual(phs, [2, 3]);
  const idx = k => bm.findIndex(m => m.ev && m.ev.k === "ph" && m.ev.p === k);
  assert.ok(bm.slice(0, idx(2)).every(m => !(m.ev && m.ev.k === "ret" && m.ev.c)), "no curves in phase 1");
  assert.ok(bm.slice(idx(2)).some(m => m.ev && m.ev.k === "ret" && m.ev.c), "curves from phase 2");
  assert.ok(bm.slice(0, idx(3)).every(m => !(m.ev && m.ev.k === "atk")), "no attacks before phase 3");
  assert.equal(drops, 0, "the ball's speed never went down in the fight");
  assert.ok(lastM > m0 + 0.5, "and it climbed: " + m0 + " -> " + lastM);
  // nothing attacks during a recoil or a phase change, and every attack gives time to react
  const cfg = s.g.bossCfg();
  for (const m of bm) if (m.ev && m.ev.k === "brk") {
    const phased = bm.some(x => x.ev && x.ev.k === "ph" && Math.abs(x._at - m._at) < 30);
    const busy = (cfg.breakT + (phased ? cfg.phaseT : 0)) * 1000;
    assert.ok(!bm.some(x => x.ev && x.ev.k === "atk" && x._at > m._at && x._at < m._at + busy - 60), "no attack inside a recoil");
  }
  const atks = bm.filter(m => m.ev && m.ev.k === "atk"), lands = bm.filter(m => m.ev && m.ev.k === "land");
  assert.ok(atks.length >= 1, "phase 3 attacks");
  for (let i = 0; i < lands.length; i++) assert.ok(lands[i]._at - atks[i]._at >= 1650, "warned at least 1.65s ahead: " + (lands[i]._at - atks[i]._at));
  assert.ok(!bm.some(m => m.ev && m.ev.k === "ko"), "the dodging player was never caught");
  console.log("solo fight ok: guard breaks 3, returns", rets.length, "attacks", evs.filter(e => e.k === "atk").length, "speed", m0.toFixed(2), "->", lastM.toFixed(2));
  s.stop();
}

// two players: B never blocks. A knockout resets the guard; the next break revives B
{
  const { s, out } = fight(2, { cfg: { hp: [3, 4, 5, 6] } });
  const stop = drive(s, out, ["A"], ["A", "B"]);
  await until(() => bossMsgs(out).some(m => m.ev && m.ev.k === "ko" && m.ev.w === "B"), 60000, "B to go down");
  const ko = bossMsgs(out).find(m => m.ev && m.ev.k === "ko");
  assert.equal(ko.gd, 0, "a knockout resets the guard");
  assert.equal(F(s, "B").alive, false);
  await until(() => bossMsgs(out).some(m => m.ev && m.ev.k === "brk" && m.ev.rv), 90000, "a guard break with a revive");
  const brk = bossMsgs(out).find(m => m.ev && m.ev.k === "brk" && m.ev.rv);
  assert.equal(brk.ev.rv[0], "B", "the break revives B");
  assert.equal(F(s, "B").alive, true, "B is back up");
  stop(); s.stop();
  console.log("knockout, guard reset and revive ok");
}

// nobody blocks: everybody goes down and the fight is lost
{
  const { s, out } = fight(2);
  await until(() => out.some(m => m.t === "roundover"), 30000, "the fight to be lost");
  const ro = out.find(m => m.t === "roundover");
  assert.equal(ro.tm, -1, "nobody won");
  assert.equal(s.g.bossInfo().victory, false);
  assert.ok(!bossMsgs(out).some(m => m.ev && m.ev.k === "gd"), "no parries, no guard");
  s.stop();
  console.log("team wipe loses ok");
}
console.log("boss rally tests passed");
process.exit(0);
