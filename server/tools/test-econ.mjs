import { applyAct, ensure } from "../src/econ.js";
import { crownFix } from "../src/index.js";
import assert from "assert";
const oct3 = Date.UTC(2026, 9, 3, 18), sep30 = Date.UTC(2026, 8, 30, 18), oct9 = Date.UTC(2026, 9, 9, 18);
let s = ensure({ coins: 0, yen: 5000, rp: 12000, swords: { oak: 1 }, abils: {}, skins: {} });
assert.equal(s.rp, 0, "season reset rp"); assert.equal(s.s0rp, 12000); assert.equal(s.season, 1);
assert.ok(s.swords.oak, "kept s0 reward");
// wendigo shrine
let r = applyAct(s, { k: "event", shop: "wendigo" }, { now: sep30 }); assert.equal(r.ok, false);
r = applyAct(s, { k: "event", shop: "wendigo" }, { now: oct3 }); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.yen, 3000); assert.ok(s.swords.wendigo); assert.equal(s.eqSword, "wendigo");
r = applyAct(s, { k: "event", shop: "wendigo" }, { now: oct3 }); assert.equal(r.ok, false);
let s2 = ensure({ yen: 5000 }); r = applyAct(s2, { k: "event", shop: "wendigo" }, { now: oct9 }); assert.equal(r.ok, false, "closed after week");
// rodriga
r = applyAct(s, { k: "rodriga" }, { now: oct3 }); assert.equal(r.ok, false, "needs token");
s.tokens = 1; r = applyAct(s, { k: "rodriga" }, { now: oct3 }); assert.ok(r.ok, JSON.stringify(r)); assert.ok(s.swords.pbfetus); assert.equal(s.tokens, 0);
// login
r = applyAct(s, { k: "login", day: "2026-10-03" }, { now: oct3 }); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.login.n, 1); assert.equal(s.coins, 250);
r = applyAct(s, { k: "login", day: "2026-10-03" }, { now: oct3 }); assert.equal(r.ok, false, "twice a day");
for (let d = 4; d <= 12; d++) { r = applyAct(s, { k: "login", day: "2026-10-" + String(d).padStart(2, "0") }, { now: Date.UTC(2026, 9, d, 18) }); assert.ok(r.ok, d + JSON.stringify(r)); }
assert.equal(s.login.n, 10); assert.equal(s.freeSpinsL, 1, "day 10 legendary spin");
r = applyAct(s, { k: "login", day: "2026-09-30" }, { now: sep30 }); assert.equal(r.ok, false, "not before start");
// free legendary spin
const coins0 = s.coins;
r = applyAct(s, { k: "chest", tab: "skin", grade: "legendary", n: 1, free: true }, { now: oct3, rnd: Math.random });
assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.freeSpinsL, 0); assert.ok(s.coins >= coins0);
r = applyAct(s, { k: "chest", tab: "skin", grade: "legendary", n: 1, free: true }, { now: oct3 }); assert.equal(r.ok, false);
// no blackcat / events in chests
for (let i = 0; i < 400; i++) { const t = ensure({ coins: 1e6 }); const rr = applyAct(t, { k: "chest", tab: "skin", grade: "normal", n: 10 }, { now: oct3, rnd: Math.random });
  for (const w of rr.res.won) assert.ok(!["blackcat", "ascended"].includes(w.id), w.id); }
// limited: black cat on the launch shelf
let s3 = ensure({ yen: 2000 }); r = applyAct(s3, { k: "limited", tab: "skin", id: "blackcat", day: "2026-10-03" }, { now: oct3 }); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s3.yen, 2000 - 850);
// token roll
let tok = 0; for (let i = 0; i < 50; i++) { const t = ensure({ econ: { v: 1 } }); const rr = applyAct(t, { k: "match", mode: "classic", won: true, rp: 0, coins: 10, secs: 60 }, { now: oct3 + i * 1e6, rnd: () => 0 }); if (rr.res.token) tok++; }
assert.equal(tok, 50, "rnd 0 always pays a token");
// GOD: pvp only
let g = ensure({ rp: 0, econ: { v: 1 } }); g.rp = 15500; r = applyAct(g, { k: "match", mode: "ranked1", won: true, rp: 40, coins: 10, secs: 60 }, { now: oct3 }); assert.equal(r.res.rp, 0, "no RP vs bots at GOD");
// online matches pay from the room's ticket, never from the claim
const tickets = [{ id: "m1", mode: "god1", won: true, secs: 60, at: oct3 }];
r = applyAct(g, { k: "match", mode: "god1", won: true, rp: 40, coins: 10, secs: 60, mt: "m1" }, { now: oct3 + 5e6, tickets }); assert.equal(r.res.rp, 40, "GOD 1v1 against a player pays RP");
r = applyAct(g, { k: "match", mode: "god1", won: true, rp: 40, coins: 10, secs: 60, mt: "m1" }, { now: oct3 + 6e6, tickets }); assert.ok(r.res.rp < 0 && r.res.won === false, "a ticket pays once: " + JSON.stringify(r.res));
r = applyAct(g, { k: "match", mode: "mp", won: true, rp: 0, coins: 10, secs: 60 }, { now: oct3 + 7e6, tickets }); assert.equal(r.res.won, false, "no ticket, no win");
const lost = [{ id: "m2", mode: "mpranked2", won: false, secs: 80, at: oct3 }];
const g2 = ensure({ rp: 500, econ: { v: 1 } }); r = applyAct(g2, { k: "match", mode: "mpranked2", won: true, rp: 40, coins: 10, secs: 80, mt: "m2" }, { now: oct3 + 8e6, tickets: lost }); assert.ok(r.res.rp < 0, "the ticket says lost: " + JSON.stringify(r.res));
// crown
const sv = { swords: { crown: 1 }, eqSword: "crown" }; assert.ok(crownFix(sv, "a", "b")); assert.ok(!sv.swords.crown); assert.equal(sv.eqSword, "trainer");
assert.ok(crownFix(sv, "b", "b")); assert.ok(sv.swords.crown); assert.ok(!crownFix(sv, "b", "b"));
console.log("server tests passed");
// a new season: an old device's RP does not come back through the one-time import
{
  const { importEcon } = await import("../src/econ.js");
  const fl = [];
  const s = importEcon({}, { coins: 10, rp: 4000 }, Date.now(), fl);
  assert.equal(s.rp, 0, "last season's RP stays behind");
  const s2 = importEcon({}, { coins: 10, rp: 300, season: 1 }, Date.now(), fl);
  assert.equal(s2.rp, 300, "this season's RP comes along");
  console.log("season import tests passed");
}
// rank rewards a game unlocked from last season's RP go; earned ones stay
{
  const { rankClean } = await import("../src/econ.js");
  const s = ensure({ rp: 0, season: 1, econ: { v: 1 }, swords: { divineright: 1, s1meat: 1, meatcleaver: 1, trainer: 1 }, skins: { ascended: 1 }, abils: { divine: 1, jordan: 1 }, eqSword: "divineright", eqSkin: "ascended" });
  assert.ok(!s.swords.divineright && !s.swords.s1meat && !s.skins.ascended && !s.abils.divine, "GOD and Season 1 rewards above the rank go: " + JSON.stringify(s.swords));
  assert.ok(s.swords.meatcleaver && s.abils.jordan, "last season's rewards stay");
  assert.equal(s.eqSword, "trainer"); assert.equal(s.eqSkin, "rookie");
  assert.equal(rankClean(s), false, "once per account");
  const g = ensure({ rp: 15500, season: 1, econ: { v: 1 }, swords: { divineright: 1 }, skins: { ascended: 1 } });
  assert.ok(g.swords.divineright && g.skins.ascended, "a real GOD keeps them");
  console.log("rank clean tests passed");
}
// launch day (Sep 30): the new gear is on Gnorman's shelf and PB Fetus is at Rodriga's
{
  const sep30 = Date.UTC(2026, 8, 30, 18);
  const s = ensure({ yen: 5000, tokens: 1, econ: { v: 1 } });
  let r = applyAct(s, { k: "limited", tab: "sword", id: "ricky9", day: "2026-09-30" }, { now: sep30 }); assert.ok(r.ok, JSON.stringify(r));
  r = applyAct(s, { k: "limited", tab: "abil", id: "grey", day: "2026-09-30" }, { now: sep30 }); assert.ok(r.ok, JSON.stringify(r));
  r = applyAct(s, { k: "rodriga" }, { now: sep30 }); assert.ok(r.ok && s.swords.pbfetus, JSON.stringify(r));
  console.log("launch day tests passed");
}
