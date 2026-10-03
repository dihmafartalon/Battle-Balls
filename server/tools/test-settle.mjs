/* Match settlement, end to end through the Room and the Vault (in memory):
   a room's record survives failed and timed-out writes, is retried by alarm,
   pays exactly once even when the answer to a successful write is lost, and a
   result that has not arrived yet reads as pending -- never as a loss. */
import assert from "assert";
import { Room, Vault } from "../src/index.js";
import { memState, memNamespace } from "./mockdo.mjs";

let mode = "ok";                // ok | throw | lose
const calls = [];
const env = {};
env.VAULT = memNamespace(n => new Vault(memState(), env), (n, body) => {
  if (body.op !== "settle") return null;
  calls.push(mode);
  return mode === "ok" ? null : mode;
});
env.DIR = memNamespace(() => ({ fetch: async () => new Response(JSON.stringify({ ok: true, off: [] })) }));

async function vault(sub, body) {
  const r = await env.VAULT.get(env.VAULT.idFromName("g:" + sub)).fetch("https://vault/", { method: "POST", body: JSON.stringify(Object.assign({ sub }, body)) });
  return { status: r.status, j: await r.json() };
}
// two signed-in accounts with sessions
const tok = {};
for (const sub of ["alice", "bob"]) {
  const r = await vault(sub, { op: "login" });
  tok[sub] = r.j.token.split(".")[1];
  await vault(sub, { op: "act", secret: tok[sub], acts: [] });     // marks the economy as the server's
}
const coinsOf = async sub => (await vault(sub, { op: "load", secret: tok[sub] })).j.save.coins | 0;
const rpOf = async sub => (await vault(sub, { op: "load", secret: tok[sub] })).j.save.rp | 0;

function room() {
  const st = memState();
  const r = new Room(st, env);
  r.sim = { state: () => ({ fighters: [
    { netId: "A", team: 0, deflects: 9, perfects: 3, kos: 1, runC: 120, tBlocks: 9, tPerfects: 3 },
    { netId: "B", team: 1, deflects: 4, perfects: 0, kos: 0, runC: 20, tBlocks: 4, tPerfects: 0 }] }), g: {} };
  r.broadcast = () => {}; r.announce = () => {};
  return r;
}

// 1. a clean settlement pays both players once
{
  const r = room();
  r.match = { id: "match-1", at: Date.now() - 90000, mode: "god1", players: [{ id: "A", sub: "alice" }, { id: "B", sub: "bob" }] };
  const a0 = await rpOf("alice"), b0 = await rpOf("bob");
  await r.matchOver({ t: "roundover", w: "A", tm: -1 });
  assert.ok(await rpOf("alice") > a0, "the winner gains RP");
  assert.ok(await rpOf("bob") <= b0, "the loser does not");
  assert.equal((await r.ctx.storage.list({ prefix: "settle:" })).size, 0, "nothing left waiting");
  const res = await vault("alice", { op: "matchres", secret: tok.alice, mid: "match-1" });
  assert.ok(res.j.res && res.j.res.won === true, "alice can read her result: " + JSON.stringify(res.j.res));
  console.log("clean settlement ok");
}
// 2. the account is unreachable: the record waits, then lands on retry -- once
{
  const r = room();
  mode = "throw";
  r.match = { id: "match-2", at: Date.now() - 60000, mode: "mp", players: [{ id: "A", sub: "alice" }] };
  const c0 = await coinsOf("alice");
  await r.matchOver({ t: "roundover", w: "A", tm: -1 });
  assert.equal((await r.ctx.storage.list({ prefix: "settle:" })).size, 1, "kept while the account cannot be reached");
  assert.ok(r.ctx.storage.alarmAt, "and an alarm is set to try again");
  const pend = await vault("alice", { op: "matchres", secret: tok.alice, mid: "match-2" });
  assert.ok(pend.j.pending && !pend.j.res, "the player sees it as pending, not as a loss");
  assert.equal(await coinsOf("alice"), c0, "nothing paid yet");
  // the answer to a successful write is lost: the account paid, the room did not hear
  mode = "lose";
  for (const [k, v] of await r.ctx.storage.list({ prefix: "settle:" })) { v.next = 0; await r.ctx.storage.put(k, v); }
  await r.alarm();
  const c1 = await coinsOf("alice");
  assert.ok(c1 > c0, "paid on the retry");
  assert.equal((await r.ctx.storage.list({ prefix: "settle:" })).size, 1, "the room still thinks it is waiting");
  // the room sends it again: the account answers with the first result and pays nothing more
  mode = "ok";
  for (const [k, v] of await r.ctx.storage.list({ prefix: "settle:" })) { v.next = 0; await r.ctx.storage.put(k, v); }
  await r.alarm();
  assert.equal(await coinsOf("alice"), c1, "a resend never pays twice");
  assert.equal((await r.ctx.storage.list({ prefix: "settle:" })).size, 0, "and is then forgotten");
  console.log("retry and idempotent settlement ok");
}
// 3. a restart: a new Room object on the same storage finds the record and delivers it
{
  const r = room();
  mode = "throw";
  r.match = { id: "match-3", at: Date.now() - 45000, mode: "mp", players: [{ id: "A", sub: "alice" }] };
  await r.matchOver({ t: "roundover", w: "A", tm: -1 });
  const st = r.ctx;
  const again = new Room(st, env);
  mode = "ok";
  for (const [k, v] of await st.storage.list({ prefix: "settle:" })) { v.next = 0; await st.storage.put(k, v); }
  const c0 = await coinsOf("alice");
  await again.alarm();
  assert.ok(await coinsOf("alice") > c0, "delivered after the restart");
  assert.equal((await st.storage.list({ prefix: "settle:" })).size, 0);
  console.log("restart delivery ok");
}
// 4. a forged claim from a player's game: nothing paid, ever
{
  const c0 = await coinsOf("bob"), r0 = await rpOf("bob");
  const r = await vault("bob", { op: "act", secret: tok.bob, acts: [{ id: "forge1", k: "match", mode: "ranked1", won: true, rp: 70, coins: 5000, secs: 1 }] });
  assert.ok(r.j.res[0].res.pending, "a claim is only ever pending");
  // a claim naming a match bob played shows his real result (a loss), and pays nothing
  const r1 = await vault("bob", { op: "act", secret: tok.bob, acts: [{ id: "forge3", k: "match", mode: "god1", won: true, mt: "match-1" }] });
  assert.ok(r1.j.res[0].res.settled && r1.j.res[0].res.won === false, "his own record, not his claim: " + JSON.stringify(r1.j.res[0]));
  // a claim naming another account's settled match pays nothing either
  const r2 = await vault("bob", { op: "act", secret: tok.bob, acts: [{ id: "forge2", k: "match", mode: "mp", won: true, mt: "match-2" }] });
  assert.equal(await rpOf("bob"), r0, "RP untouched"); assert.equal(await coinsOf("bob"), c0, "coins untouched");
  // a player cannot reach the settle op through /cloud
  const { handleCloud } = await import("../src/index.js");
  const req = new Request("https://x/cloud", { method: "POST", body: JSON.stringify({ token: "bob." + tok.bob, op: "settle", ticket: { id: "x", mode: "mp", won: true, coins: 99999 } }) });
  const out = await handleCloud(req, env, "/cloud");
  assert.equal(out.status, 400, "settle is not a player's op");
  assert.ok(r2.j.res[0].res.pending);
  console.log("forged claims pay nothing ok");
}
console.log("settlement path tests passed");
