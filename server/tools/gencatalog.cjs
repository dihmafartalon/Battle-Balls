#!/usr/bin/env node
/* Regenerates server/src/catalog.js from the game file, so the server's
   prices, rarities, cooldowns, ranks, pass and shop drops are always the
   game's own numbers.

     node server/tools/gencatalog.cjs            (from the repo root)

   It lifts the data tables straight out of site/index.html (plain `var X=...;`
   statements) and evaluates only those, so nothing else in the game runs. */
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const GAME = path.join(ROOT, "site", "index.html");
const OUT = path.join(ROOT, "server", "src", "catalog.js");
const src = fs.readFileSync(GAME, "utf8");

// the text of `var NAME=...;` up to the semicolon that closes it at depth 0
function grab(name) {
  const at = src.search(new RegExp("\\nvar " + name + "="));
  if (at < 0) throw new Error("not found in the game: var " + name);
  let i = src.indexOf("=", at) + 1, depth = 0, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    else if (c === ";" && depth === 0) break;
    else if (c === "," && depth === 0) break;      // `var A=1,B=2;`
  }
  return src.slice(at + 1, i) + ";";
}
const NAMES = ["SWORDS", "ABILITIES", "SKINS", "RANKS", "MODES", "PASS", "PASS_TIERS", "RARITY", "RARORDER",
  "RARITY_ORDER", "LIMITED_DROPS", "LIM_MARKUP", "CHEST_GRADES", "SYMS", "UPCHAIN", "UPODDS", "UPFEE", "YEN_RATE",
  "SELL", "RODRIGA", "LOGIN_CAL", "EVENT_SHOPS", "SEASON", "PACKS", "TAUNTS"];
const ctx = { Date, Math };
vm.createContext(ctx);
for (const n of NAMES) {
  let code;
  try { code = grab(n); } catch (e) { if (["RODRIGA", "LOGIN_CAL", "EVENT_SHOPS", "SEASON"].includes(n)) continue; throw e; }
  vm.runInContext(code, ctx);
}
const G = ctx;

function byRarityDesc(list) {
  const RO = G.RARITY_ORDER;
  return list.slice().sort((a, b) => {
    const ra = a.ultra ? -1 : (a.rank || a.code) ? 0 : (RO[a.rarity] === undefined ? 5 : RO[a.rarity]);
    const rb = b.ultra ? -1 : (b.rank || b.code) ? 0 : (RO[b.rarity] === undefined ? 5 : RO[b.rarity]);
    if (ra !== rb) return ra - rb;
    const pa = a.price < 0 ? 1e9 : (a.price || 0), pb = b.price < 0 ? 1e9 : (b.price || 0);
    if (pa !== pb) return pb - pa;
    return (a.name || "").localeCompare(b.name || "");
  });
}
function itemValue(it) {
  if (!it || it.rank || it.rarity === "rank" || it.ultra || it.pass || it.event || it.rarity === "unreleased") return 0;
  if (typeof it.yen === "number") return it.yen;
  return G.SELL[it.rarity || "common"] || 15;
}
function entry(it, tab) {
  const e = { id: it.id, n: it.name, r: it.rarity || (it.rank ? "rank" : "common"), v: itemValue(it) };
  if (it.code) e.code = 1;
  if (it.ultra) e.ultra = 1;
  if (it.pass) e.pass = it.pass;
  if (it.rank) e.rank = it.rank;
  if (it.free) e.free = 1;
  if (it.off) e.off = 1;                   // switched off for now: never from a chest
  if (it.event) e.event = it.event;        // only from its own shop, event or token: never chests or the Limited shelf
  if (it.season !== undefined) e.season = it.season;
  if (tab === "abil") { e.cd = it.cd; if (it.passive) e.passive = 1; }
  return e;
}
const TAB = { sword: [G.SWORDS, 450, "trainer"], abil: [G.ABILITIES, 550, "dash"], skin: [G.SKINS, 350, "rookie"] };
const items = {};
for (const t of Object.keys(TAB)) {
  const [list, cost, starter] = TAB[t];
  items[t] = { cost, starter, list: byRarityDesc(list).map(it => entry(it, t)) };
}
const rarity = {}; for (const k of Object.keys(G.RARITY)) rarity[k] = G.RARITY[k].w;
const modes = {};
for (const m of G.MODES) modes[m.id] = { mult: m.mult, rp: m.rp, ranked: m.ranked ? 1 : 0, teams: m.teams ? 1 : 0, bots: m.bots, ...(m.pvp ? { pvp: 1 } : {}) };
// the online modes are not in MODES; they stay as they were
modes.mp = { mult: 3.2, rp: 0, ranked: 0, teams: 0, bots: 0 };
modes.mpranked2 = { mult: 1.6, rp: 1, ranked: 1, teams: 1, bots: 2 };
// GOD: ranked 1v1 against another player, from the GOD queue
modes.god1 = { mult: 1.8, rp: 1, ranked: 1, teams: 0, bots: 0, pvp: 1 };
if (G.MODES_NET_EXTRA) Object.assign(modes, G.MODES_NET_EXTRA);

const CAT = {
  v: 1, items, rarity, rarorder: G.RARORDER, grades: G.CHEST_GRADES,
  refund: { common: .25, rare: .4, epic: .6, legendary: .8, mythic: 1.2 },
  lim: { markup: G.LIM_MARKUP, drops: G.LIMITED_DROPS.map(d => ({ from: d.from, to: d.to, items: d.items })) },
  up: { chain: G.UPCHAIN, odds: G.UPODDS, fee: G.UPFEE },
  syms: G.SYMS.map(s => ({ w: s.w, pay: s.pay, pair: s.pairPay })),
  pass: { id: G.PASS.id, end: G.PASS.end, max: G.PASS.max, xpPer: G.PASS.xpPer, xpGame: G.PASS.xpGame, xpWin: G.PASS.xpWin,
    yenPer: G.PASS.yenPer, tiers: G.PASS_TIERS },
  ranks: G.RANKS.map(r => ({ rp: r.rp, rewards: r.rewards || (r.reward ? [r.reward] : []), ...(r.pvp ? { pvp: 1 } : {}), ...(r.id ? { id: r.id } : {}) })),
  yenRate: G.YEN_RATE,
  modes
};
if (G.RODRIGA) CAT.rodriga = G.RODRIGA;
if (G.LOGIN_CAL) CAT.login = G.LOGIN_CAL;
if (G.EVENT_SHOPS) CAT.events = G.EVENT_SHOPS;
// every emote; base ones everyone has and are never stored
if (G.TAUNTS) CAT.emotes = G.TAUNTS.map(t => ({ id: t.id, n: t.txt, r: t.rarity || "common", ...(t.pack ? {} : { base: 1 }) }));
if (G.PACKS) { CAT.packs = {}; for (const k in G.PACKS) CAT.packs[k] = { yen: G.PACKS[k].yen, items: G.PACKS[k].items, from: G.PACKS[k].from, to: G.PACKS[k].to }; }
if (G.SEASON) CAT.season = G.SEASON;

fs.writeFileSync(OUT, "// GENERATED by server/tools/gencatalog.cjs from the game file. Do not edit by hand.\n" +
  "export const CAT=" + JSON.stringify(CAT) + ";\n");
console.log("wrote", path.relative(ROOT, OUT), "-",
  Object.keys(items).map(t => items[t].list.length + " " + t).join(", "));
