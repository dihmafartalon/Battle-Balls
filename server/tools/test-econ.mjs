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
s.tokens = 1; r = applyAct(s, { k: "rodriga" }, { now: oct3 }); assert.ok(r.ok, JSON.stringify(r)); assert.ok(s.swords.rodbroom); assert.equal(s.tokens, 0);
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
r = applyAct(g, { k: "match", mode: "god1", won: true, rp: 40, coins: 10, secs: 60 }, { now: oct3 + 5e6 }); assert.equal(r.res.rp, 40, "GOD 1v1 against a player pays RP");
// crown
const sv = { swords: { crown: 1 }, eqSword: "crown" }; assert.ok(crownFix(sv, "a", "b")); assert.ok(!sv.swords.crown); assert.equal(sv.eqSword, "trainer");
assert.ok(crownFix(sv, "b", "b")); assert.ok(sv.swords.crown); assert.ok(!crownFix(sv, "b", "b"));
console.log("server tests passed");
