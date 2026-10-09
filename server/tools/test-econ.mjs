import { applyAct, ensure, ultrasOf, newStats, timingAdd, timingPooled, timingVerdict, fakeInputVerdict, watchFlags, limitedOn } from "../src/econ.js";
import { crownFix, ownsSword, tamperVerdict } from "../src/index.js";
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
// ranked, online and Boss Rally matches: a game's claim pays nothing; the room's record (settleMatch) pays, once
{
  const { settleMatch } = await import("../src/econ.js");
  let g = ensure({ rp: 0, econ: { v: 1 } }); g.rp = 15500;
  r = applyAct(g, { k: "match", mode: "ranked1", won: true, rp: 70, coins: 9999, secs: 60 }, { now: oct3 });
  assert.equal(r.res.rp, 0, "a claimed ranked win pays nothing"); assert.ok(r.res.pending, "and is pending until the room's record arrives");
  assert.equal(g.rp, 15500, "RP untouched by the claim");
  const settled = [];
  const one = (sv, t, at) => { const x = settleMatch(sv, t, { now: at, settled, rnd: () => 1 }); if (x.ok && !x.dup) settled.push({ id: t.id, mode: t.mode, at, res: x.res }); return x; };
  r = one(g, { id: "m0", mode: "ranked1", won: true, secs: 60, dfl: 10 }, oct3); assert.equal(r.res.rp, 0, "no RP vs bots at GOD");
  r = one(g, { id: "m1", mode: "god1", won: true, secs: 60, dfl: 10 }, oct3 + 5e6); assert.ok(r.res.rp > 0, "GOD 1v1 against a player pays RP " + JSON.stringify(r.res));
  const rp1 = g.rp;
  r = one(g, { id: "m1", mode: "god1", won: true, secs: 60, dfl: 10 }, oct3 + 6e6); assert.ok(r.dup && g.rp === rp1, "a record pays once");
  r = applyAct(g, { k: "match", mode: "god1", won: true, mt: "m1" }, { now: oct3 + 6e6, settled }); assert.ok(r.res.settled && g.rp === rp1, "asking again shows the result, pays nothing");
  r = applyAct(g, { k: "match", mode: "mp", won: true, mt: "m1" }, { now: oct3 + 6e6, settled }); assert.ok(r.res.pending && g.rp === rp1, "a record of another mode does not match");
  const g2 = ensure({ rp: 500, econ: { v: 1 } });
  r = one(g2, { id: "m2", mode: "mpranked2", won: false, secs: 80 }, oct3 + 8e6); assert.ok(r.res.rp < 0, "the record says lost: " + JSON.stringify(r.res));
  // a fast legitimate win still pays
  const g3 = ensure({ rp: 0, econ: { v: 1 } });
  r = one(g3, { id: "m3", mode: "ranked1", won: true, secs: 4, dfl: 1 }, oct3 + 9e6); assert.ok(r.res.rp >= 40 && g3.rp === r.res.rp, "a 4s ranked win pays: " + JSON.stringify(r.res));
  // coins are the room's count, held to what a match that long can pay
  const g4 = ensure({ econ: { v: 1 } }), c0 = g4.coins;
  r = one(g4, { id: "m4", mode: "mp", won: true, secs: 30, coins: 1e9 }, oct3 + 9e6); assert.ok(g4.coins - c0 < 20000, "in-match coins are capped");
  // modes the room does not run cannot be settled
  r = one(g4, { id: "m5", mode: "classic", won: true, secs: 30 }, oct3 + 9e6); assert.equal(r.ok, false);
  // Boss Rally: quarters of damage and the kill, never twice, held to a daily cap
  const b = ensure({ econ: { v: 1 } }), bc = b.coins;
  r = one(b, { id: "b1", mode: "boss", won: true, secs: 300, boss: { dealt: 6, total: 6, victory: true } }, oct3); assert.equal(b.coins - bc, 4 * 450 + 1500, JSON.stringify(r.res));
  r = one(b, { id: "b1", mode: "boss", won: true, secs: 300, boss: { dealt: 6, total: 6, victory: true } }, oct3); assert.ok(r.dup && b.coins - bc === 3300, "boss pays once");
  const bc2 = b.coins; r = one(b, { id: "b2", mode: "boss", won: false, secs: 8, boss: { dealt: 2, total: 6 } }, oct3 + 1000); assert.equal(b.coins, bc2, "a quick reset farms nothing");
  let paid = 3300;
  for (let i = 0; i < 6; i++) paid += one(b, { id: "bb" + i, mode: "boss", won: true, secs: 300, boss: { dealt: 6, total: 6, victory: true } }, oct3 + 2000 + i).res.coins;
  assert.equal(paid, 12000, "daily cap holds: " + paid);
  assert.equal(one(b, { id: "bnext", mode: "boss", won: true, secs: 300, boss: { dealt: 6, total: 6, victory: true } }, oct3 + 86400000 + 5000).res.coins, 3300, "and lifts a day later");
  console.log("settlement tests passed");
}
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
  assert.equal(s2.rp, 0, "RP is only earned in matches the server ran: a device's count never comes along");
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
// a quick ranked win (Poop bots go down fast) still pays RP
{
  const { settleMatch } = await import("../src/econ.js");
  const s = ensure({ econ: { v: 1 } });
  const r = settleMatch(s, { id: "q1", mode: "ranked1", won: true, secs: 8, dfl: 2 }, { now: Date.now(), settled: [] });
  assert.ok(r.res.rp >= 40, "an 8 second ranked win pays: " + JSON.stringify(r.res)); assert.equal(s.rp, r.res.rp);
  console.log("quick ranked win test passed");
}
// the casino plays for coins and coins never buy yen
{ const s = ensure({ coins: 10000, yen: 1000 }); s.swords = s.swords || {}; s.swords.katana = 1; s.swords.fang=1; s.swords.frost=1;
let r = applyAct(s, { k: "exchange", c2y: 300 }, {}); assert.equal(r.ok, false); assert.equal(s.yen, 1000);
r = applyAct(s, { k: "exchange", y2c: 100 }, {}); assert.ok(r.ok); assert.equal(s.yen, 900); assert.equal(s.coins, 10300);
r = applyAct(s, { k: "slots", bet: 300 }, {}); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.yen, 900); assert.equal(s.coins, 10300 - 300 + r.res.win);
const c0 = s.coins; r = applyAct(s, { k: "sell", tab: "sword", id: "fang" }, {}); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.coins, c0 + 45); assert.equal(s.yen, 900);
const ctx = { bj: {} }; r = applyAct(s, { k: "bj", m: "deal", bet: 600 }, ctx); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.yen, 900);
while (ctx.bj.inHand) applyAct(s, { k: "bj", m: "stand" }, ctx);
const c1 = s.coins; r = applyAct(s, { k: "upgrade", tab: "sword", id: "frost" }, {}); assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.yen, 900); assert.ok(s.coins === c1 - 300 || s.coins === c1, s.coins + " " + c1);
const poor = ensure({ coins: 10, yen: 5000 }); r = applyAct(poor, { k: "slots", bet: 300 }, {}); assert.equal(r.ok, false); assert.equal(poor.yen, 5000);
console.log("currency split tests passed"); }
// the owner counter covers the ULTRAs and the Dev blade, and never Apex
{
  const s = ensure({ coins: 0, yen: 0, rp: 0, swords: { devblade: 1, crown: 1, wendigo: 1, trainer: 1 }, abils: {}, skins: {} });
  const u = ultrasOf(s);
  assert.ok(u.includes("sword:devblade"), "dev blade counted");
  assert.ok(u.includes("sword:wendigo"), "ultras still counted");
  assert.ok(!u.includes("sword:crown"), "apex never counted");
  assert.ok(!u.includes("sword:trainer"), "common blades not counted");
  console.log("owner counter tests passed");
}
// macro checks: timing pooled across matches, scripted input flagged per match
{
  const st = newStats(Date.now());
  // a script: ~15ms spread every match, about 10 timed blocks each
  for (let i = 0; i < 2; i++) timingAdd(st, 10, 120 + i, 15);
  assert.equal(timingVerdict(timingPooled(st).n, timingPooled(st).sd, timingPooled(st).mean), null, "20 blocks: too few to judge");
  timingAdd(st, 10, 121, 14);
  const p = timingPooled(st);
  assert.ok(p.n === 30 && p.sd < 20, "pooled " + JSON.stringify(p));
  assert.ok(timingVerdict(p.n, p.sd, p.mean), "a tight script is flagged");
  const w = watchFlags(st, [], Date.now());
  assert.ok(w.some(f => f.kind === "timing" && f.sev === "flag"), "watch flags it");
  assert.ok(!watchFlags(st, [], Date.now()).some(f => f.kind === "timing"), "only once a day");
  // a person: ~55ms spread, and their average drifts between matches
  const hu = newStats(Date.now());
  for (let i = 0; i < 6; i++) timingAdd(hu, 10, 100 + (i % 3) * 30, 50);
  assert.equal(timingVerdict(timingPooled(hu).n, timingPooled(hu).sd, timingPooled(hu).mean), null, "a person is not flagged");
  // a very consistent person (35ms) is still clear of the line
  const good = newStats(Date.now());
  for (let i = 0; i < 6; i++) timingAdd(good, 10, 110, 35);
  assert.equal(timingVerdict(timingPooled(good).n, timingPooled(good).sd, timingPooled(good).mean), null, "a very steady person is not flagged");
  // only the last 12 matches count
  for (let i = 0; i < 20; i++) timingAdd(good, 5, 100, 40);
  assert.equal(good.tim.length, 12);
  // junk is ignored
  const j = newStats(Date.now()); timingAdd(j, "x", 1, 1); timingAdd(j, 5, NaN, 2); timingAdd(j, 5000, 1, 1);
  assert.equal((j.tim || []).length, 0);
  // fake input
  assert.equal(fakeInputVerdict(2, 1), null);
  assert.ok(fakeInputVerdict(7, 0) && fakeInputVerdict(0, 9) && fakeInputVerdict(5, 5));
  const s2 = ensure({ econ: { v: 1 } }), flags = [];
  applyAct(s2, { k: "match", mode: "classic", won: false, rp: 0, coins: 0, secs: 60, blocks: 10, perfects: 2, fk: 12, gh: 0 }, { now: Date.now(), flags, rnd: () => .5 });
  assert.ok(flags.some(f => f.kind === "fakeinput"), "scripted inputs flagged: " + JSON.stringify(flags));
  console.log("macro check tests passed");
}

// ---- Dev2: BOTH needs both; unreleased items have no worth and cannot be had ----
{
  assert.equal(ownsSword({ swords: { dev2sniper: 1 } }, "dev2both"), true, "Dev2 owned: BOTH");
  assert.equal(ownsSword({ swords: { dev2sniper: 1 } }, "dev2karambit"), true, "Dev2 owned: the karambit");
  assert.equal(ownsSword({ swords: {} }, "dev2both"), false, "BOTH needs Dev2");
  assert.equal(ownsSword({ swords: {} }, "dev2karambit"), false, "the karambit needs Dev2");
  assert.equal(ownsSword({ swords: { dev2karambit: 1 } }, "dev2both"), false, "an old karambit alone is not Dev2");
  const t = tamperVerdict([[["swords", "dev2sniper"], "=", 1]]);
  assert.ok(t && t.sev === "ban", "a save that gives itself an unreleased blade is a ban");
  const s = ensure({ coins: 0, swords: { dev2sniper: 1 }, eqSword: "trainer" });
  const r = applyAct(s, { k: "sell", tab: "sword", id: "dev2sniper" }, { now: Date.now() });
  assert.equal(r.ok, false, "unreleased cannot be sold");
  for (let d = 1; d <= 60; d++) {
    const day = new Date(Date.UTC(2026, 10, d)).toISOString().slice(0, 10);
    for (const x of limitedOn(day)) assert.ok(!String(x[1]).startsWith("dev2"), "never on the Limited stall: " + day);
  }
  console.log("dev2 tests passed");
}

// ---- the pass, levels 51-100: dearer levels, dearer yen, emotes, no yen tier over 100 ----
{
  const { CAT } = await import("../src/catalog.js");
  const P = CAT.pass, oct10 = Date.UTC(2026, 9, 10, 18);
  assert.equal(P.max, 100); assert.equal(P.tiers.length, 100);
  assert.equal(P.xpAt[50], 5000, "the first fifty are unchanged");
  assert.equal(P.xpAt[51] - P.xpAt[50], 150); assert.equal(P.xpAt[100] - P.xpAt[99], 346);
  for (let lv = 2; lv <= 100; lv++) assert.ok(P.xpAt[lv] - P.xpAt[lv - 1] >= P.xpAt[lv - 1] - P.xpAt[lv - 2] || lv === 2, "costs never go down: " + lv);
  assert.ok(P.tiers.every(t => !t.y || t.y <= 100), "no level pays over 100 yen");
  // an old save at level 50 keeps its level and goes on from there
  let s = ensure({ yen: 10000, pass: { id: P.id, xp: 5000, got: 50 } });
  let r = applyAct(s, { k: "passbuy" }, { now: oct10 });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.res.cost, 350); assert.equal(s.yen, 9650); assert.deepEqual(r.res.got, [51]);
  // a level bought with progress into it keeps that progress and moves exactly one level
  s = ensure({ yen: 10000, pass: { id: P.id, xp: P.xpAt[54] + 100, got: 54 } });
  r = applyAct(s, { k: "passbuy" }, { now: oct10 });
  assert.deepEqual(r.res.got, [55]); assert.equal(s.pass.xp, P.xpAt[55] + 100); assert.ok(s.emotes.boo, "level 55 is the BOO! emote");
  // below 50 the price is the old one
  s = ensure({ yen: 1000, pass: { id: P.id, xp: 300, got: 3 } });
  r = applyAct(s, { k: "passbuy" }, { now: oct10 }); assert.equal(r.res.cost, 200); assert.deepEqual(r.res.got, [4]);
  // to the top: the skins, blades and every emote, and nothing past 100
  s = ensure({ yen: 1e6, pass: { id: P.id, xp: 5000, got: 50 }, econ: { v: 1 } });
  for (let i = 0; i < 50; i++) { r = applyAct(s, { k: "passbuy" }, { now: oct10 }); assert.ok(r.ok, i + JSON.stringify(r)); }
  assert.equal(s.pass.got, 100); assert.equal(s.pass.xp, P.xpAt[100]);
  for (const id of ["boo", "zombie", "cauldron", "witching"]) assert.ok(s.emotes[id], "emote " + id);
  for (const id of ["patchwork", "werewolf", "mummy", "count"]) assert.ok(s.skins[id], "skin " + id);
  for (const id of ["tesla", "silvermoon", "bonesaw", "wick"]) assert.ok(s.swords[id], "sword " + id);
  r = applyAct(s, { k: "passbuy" }, { now: oct10 }); assert.equal(r.ok, false, "nothing past 100");
  // match XP stops at the top too
  const xp0 = s.pass.xp; applyAct(s, { k: "match", mode: "classic", won: true, rp: 0, coins: 10, secs: 60 }, { now: oct10 + 5e6 });
  assert.equal(s.pass.xp, xp0);
  // pass items stay out of chests, the Limited stall and selling
  for (let i = 0; i < 300; i++) { const t = ensure({ coins: 1e6 }); for (const tab of ["skin", "sword"]) { const rr = applyAct(t, { k: "chest", tab, grade: "normal", n: 10 }, { now: oct10, rnd: Math.random });
    for (const w of rr.res.won) assert.ok(!["patchwork", "werewolf", "mummy", "count", "tesla", "silvermoon", "bonesaw", "wick"].includes(w.id), w.id); } }
  r = applyAct(s, { k: "sell", tab: "skin", id: "mummy" }, { now: oct10 }); assert.equal(r.ok, false, "a pass skin cannot be sold");
  console.log("pass 51-100 tests passed");
}

// ---- the After Hours Pack: Oct 15-22 (Pacific), 1800 yen, four items, once ----
{
  const { CAT } = await import("../src/catalog.js");
  const P = CAT.packs.afterhours, R = CAT.packs.rap;
  assert.equal(P.yen, 1800); assert.equal(P.from, R.to, "opens the moment the Rap Pack closes");
  assert.equal(new Date(P.from).toISOString(), "2026-10-15T07:00:00.000Z");
  assert.equal(new Date(P.to).toISOString(), "2026-10-22T07:00:00.000Z");
  const mid = P.from + 3 * 864e5;
  let s = ensure({ yen: 5000, econ: { v: 1 } });
  let r = applyAct(s, { k: "pack", pack: "afterhours" }, { now: P.from - 1 });
  assert.equal(r.ok, false, "not before it opens"); assert.equal(s.yen, 5000);
  r = applyAct(s, { k: "pack", pack: "afterhours" }, { now: mid });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(s.yen, 3200);
  assert.ok(s.skins.dreddy && s.skins.fluffles && s.swords.nightshift && s.emotes.sysfail, "all four");
  r = applyAct(s, { k: "pack", pack: "afterhours" }, { now: mid });
  assert.equal(r.ok, false, "never twice"); assert.equal(s.yen, 3200);
  r = applyAct(s, { k: "pack", pack: "afterhours" }, { now: P.to });
  assert.equal(r.ok, false, "gone when it closes");
  assert.ok(s.skins.dreddy && s.emotes.sysfail, "and kept after");
  // the Rap Pack is still the Rap Pack, and still closes on time
  let s2 = ensure({ yen: 5000, econ: { v: 1 } });
  r = applyAct(s2, { k: "pack", pack: "rap" }, { now: mid }); assert.equal(r.ok, false, "rap is over by then");
  r = applyAct(s2, { k: "pack", pack: "rap" }, { now: R.from + 864e5 }); assert.ok(r.ok, JSON.stringify(r));
  assert.ok(!s2.skins.dreddy, "the rap pack gives none of it");
  // not enough yen: nothing taken, nothing given
  let s3 = ensure({ yen: 1799, econ: { v: 1 } });
  r = applyAct(s3, { k: "pack", pack: "afterhours" }, { now: mid }); assert.equal(r.ok, false); assert.equal(s3.yen, 1799); assert.ok(!s3.skins.dreddy);
  // never in a chest
  for (let i = 0; i < 300; i++) { const t = ensure({ coins: 1e6 }); for (const tab of ["skin", "sword"]) { const rr = applyAct(t, { k: "chest", tab, grade: "normal", n: 10 }, { now: mid, rnd: Math.random });
    for (const w of rr.res.won) assert.ok(!["dreddy", "fluffles", "nightshift"].includes(w.id), w.id); } }
  // the emote is not one everybody has
  assert.ok(!CAT.emotes.find(e => e.id === "sysfail").base);
  console.log("after hours pack tests passed");
}
