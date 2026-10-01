/* ---------- The economy, on the server ----------
   Coins, yen, RP, what you own, the pass and free spins belong to the server.
   A game cannot write them; it asks for something to happen ("open a chest",
   "sell this", "the match ended") and the rules below -- the game's own rules,
   ported, with the game's own numbers from catalog.js -- decide what that is
   worth. Every roll of the dice happens here.
   Each act returns {ok, res} or {ok:false, why}; `flags` it pushes are for the
   anticheat: {kind, sev:"flag"|"ban", detail}. */
import { CAT } from "./catalog.js";

export const ECON_KEYS = ["coins", "yen", "rp", "swords", "abils", "skins", "pass", "freeSpins", "redeemed", "casino", "econ",
  "freeSpinsL", "tokens", "login", "season", "s0rp", "emotes"];
const BAG = { sword: "swords", abil: "abils", skin: "skins" };
const EQ = { sword: "eqSword", abil: "eqAbil", skin: "eqSkin" };
const TABS = ["sword", "abil", "skin"];
const BY = {};
for (const t of TABS) { BY[t] = {}; for (const it of CAT.items[t].list) BY[t][it.id] = it; }
export function itemOf(tab, id) { return (BY[tab] && Object.prototype.hasOwnProperty.call(BY[tab], id)) ? BY[tab][id] : null; }
// a whole number inside [lo, hi], or null: an amount out of range is refused, never nudged into range
const int = (v, lo, hi) => (typeof v === "number" && isFinite(v) && Math.floor(v) >= lo && Math.floor(v) <= hi) ? Math.floor(v) : null;

/* ---- the shape of a save's economy ---- */
/* Taken out of the game: its price back in coins, once (it is gone after). */
export const RETIRED = { abil: { flicker: 7200, endless: 8600 } };
export function retire(s) {
  let changed = false;
  for (const id in RETIRED.abil) if (s.abils && s.abils[id]) {
    delete s.abils[id]; s.coins = (typeof s.coins === "number" && isFinite(s.coins) ? s.coins : 0) + RETIRED.abil[id];
    if (s.eqAbil === id) s.eqAbil = "dash";
    changed = true;
  }
  return changed;
}
/* A new season: everybody's RP starts again from nothing. What was earned on
   the old ladder is kept (rank rewards are never taken back), and the old
   total is remembered as s0rp. */
export function seasonReset(s) {
  const S = CAT.season;
  if (!S || s.season === S.id) return false;
  if (typeof s.season !== "number" || s.season < S.id) {
    s.s0rp = Math.max(typeof s.s0rp === "number" ? s.s0rp : 0, typeof s.rp === "number" && isFinite(s.rp) ? s.rp : 0);
    s.rp = 0;
  }
  s.season = S.id;
  return true;
}
/* A game that still saw last season's RP (before the room server reset the
   stored account) could unlock Season 1 and GOD rank rewards on its own
   screen. This server never granted them, but to be sure: once per account,
   any Season 1 or GOD rank reward above the rank the account has really
   reached this season is taken away, and taken off if it is being worn. */
export function rankClean(s) {
  if (!s || !s.econ || typeof s.econ !== "object" || s.econ.rc1) return false;
  const reach = rankIndex(typeof s.rp === "number" ? s.rp : 0), gone = [];
  for (let i = reach + 1; i < CAT.ranks.length; i++) for (const w of CAT.ranks[i].rewards) {
    const tab = w.kind === "sword" ? "sword" : w.kind === "abil" ? "abil" : "skin", it = itemOf(tab, w.id);
    if (!it || !(it.season === 1 || it.rank === "god")) continue;       // last season's rewards were earned: they stay
    if (s[BAG[tab]] && s[BAG[tab]][w.id]) { delete s[BAG[tab]][w.id]; gone.push(w.id); }
    if (s[EQ[tab]] === w.id) s[EQ[tab]] = CAT.items[tab].starter;
  }
  s.econ.rc1 = 1;
  if (gone.length) s.econ.rcGone = gone;
  return true;
}
export function ensure(s) {
  retire(s);
  for (const k of ["coins", "yen", "rp", "freeSpins", "freeSpinsL", "tokens", "s0rp"]) if (typeof s[k] !== "number" || !isFinite(s[k]) || s[k] < 0) s[k] = 0;
  if (!s.login || typeof s.login !== "object" || Array.isArray(s.login)) s.login = { id: "", n: 0, last: "" };
  seasonReset(s);
  for (const t of TABS) if (!s[BAG[t]] || typeof s[BAG[t]] !== "object" || Array.isArray(s[BAG[t]])) s[BAG[t]] = {};
  rankClean(s);
  for (const t of TABS) if (!s[BAG[t]] || typeof s[BAG[t]] !== "object" || Array.isArray(s[BAG[t]])) s[BAG[t]] = {};
  if (!s.redeemed || typeof s.redeemed !== "object") s.redeemed = {};
  if (!s.emotes || typeof s.emotes !== "object" || Array.isArray(s.emotes)) s.emotes = {};
  if (!s.casino || typeof s.casino !== "object") s.casino = { hands: 0, bjWins: 0, spins: 0, upgrades: 0 };
  // the starters and anything free: everyone has them
  for (const t of TABS) {
    s[BAG[t]][CAT.items[t].starter] = 1;
    for (const it of CAT.items[t].list) if (it.free) s[BAG[t]][it.id] = 1;
  }
  passState(s);
  rankGrant(s);
  return s;
}
function own(s, tab, id) { return !!s[BAG[tab]][id]; }
function give(s, tab, id) { s[BAG[tab]][id] = 1; }

/* ---- ranks ---- */
export function rankIndex(rp) { let i = 0; CAT.ranks.forEach((r, k) => { if (rp >= r.rp) i = k; }); return i; }
export function rankGrant(s) {
  const got = [];
  for (let i = 0; i <= rankIndex(s.rp); i++)
    for (const w of CAT.ranks[i].rewards) { const tab = w.kind === "sword" ? "sword" : w.kind === "abil" ? "abil" : "skin";
      if (!own(s, tab, w.id)) { give(s, tab, w.id); got.push(w.id); } }
  return got;
}

/* ---- the pass ---- */
const P = CAT.pass;
function passLive(now) { return now < P.end; }
function passState(s) {
  if (!s.pass || typeof s.pass !== "object" || s.pass.id !== P.id) s.pass = { id: P.id, xp: 0, got: 0 };
  if (typeof s.pass.xp !== "number" || !isFinite(s.pass.xp) || s.pass.xp < 0) s.pass.xp = 0;
  if (typeof s.pass.got !== "number" || !isFinite(s.pass.got) || s.pass.got < 0) s.pass.got = 0;
  const lv = passLevel(s);
  if (s.pass.got > lv) s.pass.got = lv;
  return s.pass;
}
function passLevel(s) { return Math.min(P.max, Math.floor(s.pass.xp / P.xpPer)); }
function passGive(s, lv) {
  const t = P.tiers[lv - 1]; if (!t) return;
  if (t.c) s.coins += t.c;
  else if (t.y) s.yen += t.y;
  else if (t.s) s.freeSpins += t.s;
  else { if (t.skin) give(s, "skin", t.skin); if (t.sword) give(s, "sword", t.sword); if (t.abil) give(s, "abil", t.abil); }
}
function passAddXp(s, n) {
  passState(s);
  s.pass.xp = Math.min(P.max * P.xpPer, s.pass.xp + n);
  const got = [];
  while (s.pass.got < passLevel(s)) { s.pass.got++; passGive(s, s.pass.got); got.push(s.pass.got); }
  return got;
}

/* ---- chests ---- */
const RO = CAT.rarorder;
function gradeAllows(g, r) { const m = (CAT.grades[g] || CAT.grades.normal).min; return RO.indexOf(r) <= RO.indexOf(m); }
/* Abilities switched off from the admin page: never from a chest while off.
   The Vault sets this from the directory before each act. */
export const ABIL_OFF = new Set();
export function setAbilOff(list) { ABIL_OFF.clear(); for (const id of (Array.isArray(list) ? list : [])) ABIL_OFF.add(String(id)); }
export function chestPool(tab) {
  const d = CAT.items[tab];
  return d.list.filter(it => !(it.rank || it.r === "rank" || it.ultra || it.pass || it.id === d.starter || it.free || it.event || it.off ||
    (tab === "abil" && ABIL_OFF.has(it.id)) ||
    !(CAT.rarity[it.r] > 0)));
}
function chestTiers(tab, grade) {
  const pool = chestPool(tab).filter(it => gradeAllows(grade, it.r)), tiers = {}, keys = [];
  let total = 0;
  for (const it of pool) { if (!tiers[it.r]) { tiers[it.r] = []; keys.push(it.r); total += CAT.rarity[it.r] || 0; } tiers[it.r].push(it); }
  return { tiers, keys, total, pool };
}
export function rollItem(tab, grade, rnd) {
  const t = chestTiers(tab, grade);
  if (!t.pool.length) return null;
  const roll = rnd() * t.total; let acc = 0;
  for (const k of t.keys) { acc += CAT.rarity[k]; if (roll <= acc) { const l = t.tiers[k]; return l[Math.floor(rnd() * l.length)]; } }
  const last = t.tiers[t.keys[t.keys.length - 1]];
  return last[Math.floor(rnd() * last.length)];
}

/* ---- the limited shelf ---- */
function limEligible(it) { return !it.rank && !it.code && !it.pass && it.r !== "rank" && !it.free && !it.event && it.v > 0; }
function limPrice(it) { return Math.ceil(it.v * CAT.lim.markup / 50) * 50; }
export function limitedOn(day) {
  for (const dr of CAT.lim.drops) if (day >= dr.from && day < dr.to) return dr.items;
  let seed = 0; for (let i = 0; i < day.length; i++) seed = (seed * 31 + day.charCodeAt(i)) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) / 16777216; };
  const out = [];
  for (const tab of TABS) {
    const list = CAT.items[tab].list.filter(limEligible);
    const top = list.filter(x => x.r === "mythic" || x.r === "legendary"), mid = list.filter(x => x.r === "epic" || x.r === "rare");
    if (top.length) out.push([tab, top[Math.floor(rnd() * top.length)].id]);
    if (mid.length) out.push([tab, mid[Math.floor(rnd() * mid.length)].id]);
  }
  return out;
}
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

/* ---- blackjack ---- */
const RANKC = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function newShoe(rnd) {
  const d = [];
  for (let k = 0; k < 6; k++) for (let su = 0; su < 4; su++) for (let r = 0; r < 13; r++) d.push([r, su]);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function cardVal(c) { const r = RANKC[c[0]]; return r === "A" ? 11 : (r === "K" || r === "Q" || r === "J" || r === "10") ? 10 : parseInt(r, 10); }
export function handValue(cards) {
  let tot = 0, aces = 0;
  for (const c of cards) { tot += cardVal(c); if (c[0] === 0) aces++; }
  while (tot > 21 && aces > 0) { tot -= 10; aces--; }
  return tot;
}
const isBJ = c => c.length === 2 && handValue(c) === 21;
function draw(bj, rnd) { if (!bj.shoe || bj.shoe.length < 20) bj.shoe = newShoe(rnd); return bj.shoe.pop(); }
function bjView(bj, extra) {
  // the dealer's second card stays secret while the hand is live
  return Object.assign({ you: bj.you, dealer: bj.inHand ? [bj.dealer[0], null] : bj.dealer, inHand: !!bj.inHand,
    stake: bj.stake, doubled: !!bj.doubled }, extra || {});
}
function bjSettle(s, bj, result, mul) {
  bj.inHand = false;
  const stake = bj.stake * (bj.doubled ? 2 : 1), gain = Math.round(stake * mul);
  if (gain > 0) s.yen += gain;
  s.casino.hands = (s.casino.hands | 0) + 1;
  if (mul > 0) s.casino.bjWins = (s.casino.bjWins | 0) + 1;
  return bjView(bj, { result, mul, gain, stakeAll: stake, yv: handValue(bj.you), dv: handValue(bj.dealer) });
}
function bjStand(s, bj, rnd) {
  while (handValue(bj.dealer) < 17) bj.dealer.push(draw(bj, rnd));
  const d = handValue(bj.dealer), y = handValue(bj.you);
  if (d > 21) return bjSettle(s, bj, "DEALER BUSTS", 2);
  if (d > y) return bjSettle(s, bj, "DEALER WINS", -1);
  if (d < y) return bjSettle(s, bj, "YOU WIN", 2);
  return bjSettle(s, bj, "PUSH", 1);
}

/* ---- slots ---- */
function rollSym(rnd) {
  let tot = 0; for (const x of CAT.syms) tot += x.w;
  const r = rnd() * tot; let acc = 0;
  for (let i = 0; i < CAT.syms.length; i++) { acc += CAT.syms[i].w; if (r <= acc) return i; }
  return 0;
}
function slotMul(a, b, c) {
  const S = CAT.syms;
  if (a === b && b === c) return S[a].pay;
  const pair = a === b ? a : b === c ? b : a === c ? a : -1;
  return pair >= 0 ? (S[pair].pair || 0) : 0;
}

/* ---- match rewards: still reported by the game until matches are refereed here ----
   Bounded by time. Every account has a bank of match-seconds that fills at the
   speed of the clock (up to a few hours' worth, for matches queued offline).
   A match is paid out of it, so however matches are claimed -- one at a time,
   five to a request, as fast as allowed -- no more time can be paid for than
   has passed. The fixed part of a match (its base and win bonus) needs a match
   long enough to be one. */
export const MATCH = { base: 300, perSec: 15, win: 300, maxSecs: 1800, bankMax: 5400, fullSecs: 30, minCharge: 10,
  rpWin: 60, rpLose: -40, rpMinSecs: 0, passMinSecs: 30, passMatchesPerHour: 20 };
// most a match of `secs` can pay. A win carries its bonus however quick it was
// (every match draws at least minCharge from the bank, so quick "wins" are bounded)
export function matchCap(mode, secs, won) {
  const m = CAT.modes[mode] || { mult: 1 }, full = secs >= MATCH.fullSecs;
  return Math.round((MATCH.perSec * secs + (full ? MATCH.base : 0)) * Math.max(1, m.mult)) + (full || won ? MATCH.win : 0);
}
/* Auto-parry: how often the block lands inside the last 0.08s. Very good
   players land a fair share; a script lands almost all of them, match after
   match, at any speed. Only a large sample counts. */
export const PARRY = { minBlocks: 20, flagRate: 0.8, banRate: 0.95, banMinBlocks: 25 };
export function parryVerdict(blocks, perfects) {
  if (!(blocks >= PARRY.minBlocks)) return null;
  const rate = perfects / blocks;
  if (rate >= PARRY.banRate && blocks >= PARRY.banMinBlocks) return { sev: "ban", rate };
  if (rate >= PARRY.flagRate) return { sev: "flag", rate };
  return null;
}

/* ---- codes ---- */
export function codeReward(s, reward, rnd) {
  if (reward === "all") {
    for (const t of TABS) for (const it of CAT.items[t].list) if (!it.ultra && !it.pass) give(s, t, it.id);
    s.rp = Math.max(s.rp, CAT.ranks[CAT.ranks.length - 1].rp);
    s.coins += 250000; s.yen += 28000;
    return "Everything unlocked, Omega rank, +250,000 coins and 28,000 yen. Go wild.";
  }
  if (reward === "threeblades") {
    const pool = chestPool("sword").filter(w => !own(s, "sword", w.id)), got = [];
    for (let i = 0; i < 3 && pool.length; i++) { const w = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; give(s, "sword", w.id); got.push(w.id); }
    return got.length ? { unlocked: got } : "You already own every blade.";
  }
  if (reward === "coins5000") { s.coins += 5000; return "+5,000 coins."; }
  if (reward === "stdslash") { give(s, "abil", "stdslash"); s.eqAbil = "stdslash"; return "Santi's STD Slash unlocked, and equipped."; }
  if (reward === "bloodrift") { give(s, "abil", "bloodrift"); return "BLOOD RIFT unlocked. ULTRA. One use per game: look at a player and cast it."; }
  if (reward === "cruz") { give(s, "abil", "cruz"); s.eqAbil = "cruz"; return "Spirit of Cruz unlocked, and equipped."; }
  if (reward === "wendigo") { give(s, "sword", "wendigo"); s.eqSword = "wendigo"; return "WENDIGO KATANA unlocked, and equipped. UNRELEASED."; }
  return null;
}

/* ---- one act ---- */
// the modes only ever played online, where the room server decides the result
export const NET_MODES = { mp: 1, mpranked2: 1, god1: 1 };
export function applyAct(s, a, ctx) {
  const rnd = ctx.rnd || Math.random, now = ctx.now || Date.now(), flags = ctx.flags || (ctx.flags = []);
  ensure(s);
  if (!a || typeof a !== "object" || typeof a.k !== "string") return { ok: false, why: "bad request" };
  const tab = TABS.includes(a.tab) ? a.tab : null;

  if (a.k === "chest") {
    if (!tab) return { ok: false, why: "bad tab" };
    const grade = CAT.grades[a.grade] ? a.grade : "normal", n = Math.min(10, int(a.n, 1, 1000) || 1), free = !!a.free;
    let unit = grade !== "normal" ? CAT.grades[grade].cost : CAT.items[tab].cost;
    // a free spin is one normal chest; a free LEGENDARY+ spin (the login calendar) is one legendary+ chest
    if (free) {
      const okN = grade === "normal" && s.freeSpins > 0, okL = grade === "legendary" && s.freeSpinsL > 0;
      if (n !== 1 || !(okN || okL)) return { ok: false, why: "No free spins." };
      unit = 0;
    }
    if (s.coins < unit * n) return { ok: false, why: "Not enough coins." };
    if (!chestTiers(tab, grade).pool.length) return { ok: false, why: "Nothing in that chest." };
    if (free) { if (grade === "legendary") s.freeSpinsL--; else s.freeSpins--; }
    s.coins -= unit * n;
    const won = []; let best = null;
    for (let i = 0; i < n; i++) {
      const it = rollItem(tab, grade, rnd), w = { id: it.id, dupe: own(s, tab, it.id) };
      if (w.dupe) { w.refund = Math.round(CAT.items[tab].cost * (CAT.refund[it.r] || .25)); s.coins += w.refund; }
      else { give(s, tab, it.id); if (!best || RO.indexOf(it.r) < RO.indexOf(best.r)) best = it; }
      won.push(w);
    }
    if (best) s[EQ[tab]] = best.id;
    return { ok: true, res: { won } };
  }

  if (a.k === "limited") {
    const it = tab && itemOf(tab, a.id), day = typeof a.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.day) ? a.day : null;
    // the shelf turns at the player's own midnight: any day within one of the server's
    if (!day || Math.abs(Date.parse(day) - Date.parse(utcDay(now))) > 36 * 3600 * 1000) return { ok: false, why: "That is not on the shelf any more." };
    if (!it || !limEligible(it) || !limitedOn(day).some(p => p[0] === tab && p[1] === it.id)) return { ok: false, why: "That is not on the shelf any more." };
    if (own(s, tab, it.id)) return { ok: false, why: "You already own that." };
    const cost = limPrice(it);
    if (s.yen < cost) return { ok: false, why: "Not enough yen." };
    s.yen -= cost; give(s, tab, it.id); s[EQ[tab]] = it.id;
    return { ok: true, res: { cost } };
  }

  /* ---- the event stalls: one item, for yen, between two dates (the Wendigo shrine) ---- */
  if (a.k === "event") {
    const E = CAT.events && typeof a.shop === "string" && Object.prototype.hasOwnProperty.call(CAT.events, a.shop) ? CAT.events[a.shop] : null;
    if (!E || now < E.from || now >= E.to) return { ok: false, why: "That stall is closed." };
    const it = itemOf(E.tab, E.id);
    if (!it) return { ok: false, why: "That stall is closed." };
    if (own(s, E.tab, it.id)) return { ok: false, why: "You already own that." };
    if (s.yen < E.yen) return { ok: false, why: "Not enough yen." };
    s.yen -= E.yen; give(s, E.tab, it.id); s[EQ[E.tab]] = it.id;
    return { ok: true, res: { cost: E.yen } };
  }
  /* ---- packs: everything in it, for one price, while you are missing any of it ---- */
  if (a.k === "pack") {
    const P = CAT.packs && typeof a.pack === "string" && Object.prototype.hasOwnProperty.call(CAT.packs, a.pack) ? CAT.packs[a.pack] : null;
    if (!P || (P.from && now < P.from) || (P.to && now >= P.to)) return { ok: false, why: "That pack is not for sale." };
    const has = ([t, id]) => t === "emote" ? !!s.emotes[id] : own(s, t, id);
    if (P.items.every(has)) return { ok: false, why: "You already own everything in it." };
    if (s.yen < P.yen) return { ok: false, why: "Not enough yen." };
    s.yen -= P.yen;
    for (const [t, id] of P.items) { if (t === "emote") s.emotes[id] = 1; else if (itemOf(t, id)) give(s, t, id); }
    return { ok: true, res: { cost: P.yen } };
  }
  /* ---- Rodriga: a Rodriga token buys this month's item ---- */
  if (a.k === "rodriga") {
    const R = CAT.rodriga, m = R && R.months[monthKey(now)];
    if (!m) return { ok: false, why: "Rodriga has nothing for sale this month." };
    const it = itemOf(m.tab, m.id);
    if (!it) return { ok: false, why: "Rodriga has nothing for sale this month." };
    if (own(s, m.tab, it.id)) return { ok: false, why: "You already own that." };
    if (!(s.tokens >= 1)) return { ok: false, why: "You need a Rodriga token." };
    s.tokens -= 1; give(s, m.tab, it.id); s[EQ[m.tab]] = it.id;
    return { ok: true, res: { id: it.id } };
  }
  /* ---- the login calendar: one day's reward per day, in order, while it runs ---- */
  if (a.k === "login") {
    const L = CAT.login;
    if (!L || now < L.from || now >= L.to) return { ok: false, why: "The calendar is not running." };
    const day = typeof a.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.day) ? a.day : null;
    // the player's own date, within a day and a half of the server's
    if (!day || Math.abs(Date.parse(day) - Date.parse(utcDay(now))) > 36 * 3600 * 1000) return { ok: false, why: "Check your clock." };
    const lg = s.login;
    if (lg.id !== L.id) { lg.id = L.id; lg.n = 0; lg.last = ""; }
    if (lg.last === day) return { ok: false, why: "Already claimed today." };
    if (lg.last && day < lg.last) return { ok: false, why: "Already claimed today." };
    if (lg.n >= L.rewards.length) return { ok: false, why: "All thirty days claimed." };
    const r = L.rewards[lg.n];
    lg.n++; lg.last = day;
    if (r.c) s.coins += r.c;
    if (r.y) s.yen += r.y;
    if (r.s) s.freeSpins += r.s;
    if (r.L) s.freeSpinsL += r.L;
    return { ok: true, res: { n: lg.n, r } };
  }

  // selling and upgrading: never a starter, a free item, a rank reward, an ULTRA, a pass item, or what you have on
  const tradable = (t, it) => it && own(s, t, it.id) && !(it.id === CAT.items[t].starter || it.free || it.rank || it.r === "rank" || it.ultra || it.pass) && s[EQ[t]] !== it.id;
  if (a.k === "sell") {
    const it = tab && itemOf(tab, a.id);
    if (!tradable(tab, it)) return { ok: false, why: "That cannot be sold." };
    delete s[BAG[tab]][it.id]; s.yen += it.v;
    return { ok: true, res: { yen: it.v } };
  }
  if (a.k === "upgrade") {
    const it = tab && itemOf(tab, a.id), U = CAT.up;
    if (!tradable(tab, it) || U.chain.indexOf(it.r) < 0 || it.r === "mythic") return { ok: false, why: "That cannot be upgraded." };
    const fee = U.fee[it.r];
    if (s.yen < fee) return { ok: false, why: "Not enough yen." };
    s.yen -= fee; delete s[BAG[tab]][it.id];
    s.casino.upgrades = (s.casino.upgrades | 0) + 1;
    if (rnd() < U.odds[it.r]) {
      const nextR = U.chain[U.chain.indexOf(it.r) + 1];
      const tier = chestPool(tab).filter(x => x.r === nextR), fresh = tier.filter(x => !own(s, tab, x.id)), pool = fresh.length ? fresh : tier;
      const won = pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
      if (won) { give(s, tab, won.id); return { ok: true, res: { won: won.id, r: nextR } }; }
      give(s, tab, it.id); s.yen += fee;
      return { ok: true, res: { returned: true } };
    }
    return { ok: true, res: { lost: true } };
  }

  if (a.k === "exchange") {
    const c2y = int(a.c2y, 1, 1e8), y2c = int(a.y2c, 1, 1e8);
    if (c2y) { if (s.coins < c2y) return { ok: false, why: "Not enough coins." };
      const y = Math.floor(c2y / CAT.yenRate); s.coins -= y * CAT.yenRate; s.yen += y; return { ok: true, res: { yen: y } }; }
    if (y2c) { if (s.yen < y2c) return { ok: false, why: "Not enough yen." };
      s.yen -= y2c; s.coins += y2c * CAT.yenRate; return { ok: true, res: { coins: y2c * CAT.yenRate } }; }
    return { ok: false, why: "bad amount" };
  }

  if (a.k === "slots") {
    const bet = int(a.bet, 10, 5000);
    if (!bet) return { ok: false, why: "bad bet" };
    if (s.yen < bet) return { ok: false, why: "Not enough yen." };
    s.yen -= bet;
    const r = [rollSym(rnd), rollSym(rnd), rollSym(rnd)], mul = slotMul(r[0], r[1], r[2]), win = Math.round(bet * mul);
    s.yen += win; s.casino.spins = (s.casino.spins | 0) + 1;
    return { ok: true, res: { syms: r, mul, win, bet } };
  }

  if (a.k === "bj") {
    const bj = ctx.bj;
    if (a.m === "deal") {
      if (bj.inHand) return { ok: true, res: bjView(bj) };        // a hand is already out: show it again
      const bet = int(a.bet, 10, 5000);
      if (!bet) return { ok: false, why: "bad bet" };
      if (s.yen < bet) return { ok: false, why: "Not enough yen." };
      s.yen -= bet; bj.stake = bet; bj.you = []; bj.dealer = []; bj.doubled = false; bj.inHand = true;
      bj.you.push(draw(bj, rnd)); bj.dealer.push(draw(bj, rnd)); bj.you.push(draw(bj, rnd)); bj.dealer.push(draw(bj, rnd));
      if (isBJ(bj.you)) return { ok: true, res: isBJ(bj.dealer) ? bjSettle(s, bj, "PUSH", 1) : bjSettle(s, bj, "BLACKJACK", 2.75) };
      if (isBJ(bj.dealer)) return { ok: true, res: bjSettle(s, bj, "DEALER BLACKJACK", -1) };
      return { ok: true, res: bjView(bj) };
    }
    if (!bj.inHand) return { ok: false, why: "No hand in play." };
    if (a.m === "hit") {
      bj.you.push(draw(bj, rnd));
      return { ok: true, res: handValue(bj.you) > 21 ? bjSettle(s, bj, "BUST", -1) : bjView(bj) };
    }
    if (a.m === "stand") return { ok: true, res: bjStand(s, bj, rnd) };
    if (a.m === "double") {
      if (bj.you.length !== 2 || bj.doubled) return { ok: false, why: "You can only double on two cards." };
      if (s.yen < bj.stake) return { ok: false, why: "Not enough yen to double." };
      s.yen -= bj.stake; bj.doubled = true; bj.you.push(draw(bj, rnd));
      return { ok: true, res: handValue(bj.you) > 21 ? bjSettle(s, bj, "BUST", -1) : bjStand(s, bj, rnd) };
    }
    return { ok: false, why: "bad move" };
  }

  if (a.k === "passbuy") {
    if (!passLive(now)) return { ok: false, why: "The pass has ended." };
    if (passLevel(s) >= P.max) return { ok: false, why: "Already at the top level." };
    if (s.yen < P.yenPer) return { ok: false, why: "Not enough yen." };
    s.yen -= P.yenPer;
    return { ok: true, res: { got: passAddXp(s, P.xpPer) } };
  }

  if (a.k === "match") {
    const mode = typeof a.mode === "string" ? a.mode.slice(0, 16) : "", m = CAT.modes[mode] || { mult: 1, ranked: 0 };
    const e = s.econ;
    /* An online match is run by the room server, which wrote down who won
       (a ticket) before anyone was told. Pay that, not what the game says;
       no ticket means no win, and each ticket pays once. */
    let won = !!a.won, secsIn = Number(a.secs) || 0, tk = null;
    if (NET_MODES[mode]) {
      tk = (ctx.tickets || []).find(t => t && t.id === a.mt && !t.used && t.mode === mode) || null;
      if (tk) { tk.used = true; won = !!tk.won; secsIn = tk.secs; }
      else won = false;
      a = Object.assign({}, a, { won });
    }
    // fill the bank for the time that has passed, then pay this match out of it
    if (typeof e.bank !== "number" || !isFinite(e.bank)) { e.bank = MATCH.maxSecs; e.bankAt = now; }
    e.bank = Math.min(MATCH.bankMax, e.bank + Math.max(0, now - (e.bankAt || now)) / 1000);
    e.bankAt = now;
    const own = Math.max(0, Math.min(MATCH.maxSecs, secsIn));
    // a match costs at least minCharge seconds of bank, however short it says it was
    const got = Math.min(Math.max(own, MATCH.minCharge), e.bank);
    e.bank -= got;
    const secs = Math.min(own, got), real = got >= MATCH.minCharge;
    const claimed = Math.max(0, Math.floor(Number(a.coins) || 0));
    // judged against the match's OWN length: an honest match is never punished for a low bank
    const capOwn = matchCap(mode, own, !!a.won), coins = Math.min(claimed, real ? matchCap(mode, secs, !!a.won) : matchCap(mode, secs, false));
    if (claimed > capOwn * 3 + 2000) flags.push({ kind: "coins", sev: "ban", detail: "claimed " + claimed + " coins from a " + Math.round(own) + "s " + mode + " match (most possible " + capOwn + ")" });
    else if (claimed > capOwn) flags.push({ kind: "coins", sev: "flag", detail: "claimed " + claimed + " coins, capped at " + capOwn + " (" + Math.round(own) + "s " + mode + ")" });
    s.coins += coins;
    let rp = 0;
    if (m.ranked) {
      rp = Math.max(MATCH.rpLose, Math.min(MATCH.rpWin, Math.round(Number(a.rp) || 0)));
      // the server's ticket says who won: a win cannot cost RP, and a loss always does
      if (NET_MODES[mode]) rp = won ? Math.max(1, rp) : Math.min(rp, Math.round(MATCH.rpLose / 2));
      if (rp > 0 && secs < MATCH.rpMinSecs) rp = 0;                 // no ranked win in a few seconds
      // GOD is played against people only: at that rank, a match against bots moves nothing
      const cur = CAT.ranks[rankIndex(s.rp)];
      if (cur && cur.pvp && !m.pvp) rp = 0;
    }
    const before = rankIndex(s.rp);
    s.rp = Math.max(0, s.rp + rp);
    const ranked = rankIndex(s.rp) > before ? rankGrant(s) : [];
    let pass = null;
    e.pm = (e.pm || []).filter(t => now - t < 3600 * 1000);
    if (passLive(now) && secs >= MATCH.passMinSecs && passLevel(s) < P.max && e.pm.length < MATCH.passMatchesPerHour) {
      e.pm.push(now);
      pass = passAddXp(s, a.won ? P.xpWin : P.xpGame);
    }
    // one in ten million: a Rodriga token, in any match that really was a match
    let token = false;
    if (CAT.rodriga && real && rnd() < CAT.rodriga.chance) { s.tokens = (s.tokens | 0) + 1; token = true; }
    // the blocks this game timed for itself
    const v = parryVerdict(int(a.blocks, 0, 100000), int(a.perfects, 0, 100000));
    if (v) flags.push({ kind: "autoparry", sev: v.sev, detail: Math.round(v.rate * 100) + "% perfect over " + a.blocks + " blocks (" + mode + ")" });
    return { ok: true, res: { coins, rp, ranked, pass, token, won, ...(tk ? { tk: 1 } : {}) } };
  }

  return { ok: false, why: "unknown act" };
}

/* A save's first taste of the server economy. An account that already had
   progress here keeps it; a brand-new account may bring this device's
   progress along once. What cannot be earned anywhere does not come with it,
   and a big arrival is flagged for a look. */
export const IMPORT = { coins: 400000, yen: 40000, rp: 6000 };
export function importEcon(s, from, now, flags) {
  const had = (s.coins | 0) > 0 || (s.yen | 0) > 0 || (s.rp | 0) > 0 ||
    TABS.some(t => s[BAG[t]] && Object.keys(s[BAG[t]]).some(id => { const it = itemOf(t, id); return it && id !== CAT.items[t].starter && !it.free; }));
  s.econ = { v: 1, at: now };
  if (had || !from || typeof from !== "object") return ensure(s);
  const num = (v, hi) => Math.max(0, Math.min(hi, Math.floor(Number(v) || 0)));
  s.coins = num(from.coins, IMPORT.coins); s.yen = num(from.yen, IMPORT.yen);
  // RP only comes along from this season: a device still holding last season's does not bring it back
  s.rp = CAT.season && from.season !== CAT.season.id ? 0 : num(from.rp, IMPORT.rp);
  if (CAT.season && from.season === CAT.season.id) s.season = CAT.season.id;
  s.freeSpins = num(from.freeSpins, 100);
  let dropped = 0, value = s.coins + s.yen * CAT.yenRate, count = 0;
  for (const t of TABS) {
    s[BAG[t]] = {};
    const src = from[BAG[t]] && typeof from[BAG[t]] === "object" ? from[BAG[t]] : {};
    for (const id in src) {
      const it = itemOf(t, id);
      if (!src[id] || !it) continue;
      // only ever from a code or never earnable: not brought along (a code can be redeemed on the account)
      if (it.r === "unreleased" || it.rank === "dev" || it.code || it.ultra) { dropped++; continue; }
      give(s, t, id); count++; value += it.v * CAT.yenRate;
    }
  }
  if (from.pass && from.pass.id === P.id) s.pass = { id: P.id, xp: int(from.pass.xp, 0, P.max * P.xpPer) || 0, got: int(from.pass.got, 0, P.max) || 0 };
  ensure(s);
  if (dropped) flags.push({ kind: "import", sev: "flag", detail: "brought " + dropped + " item(s) that cannot be earned (removed)" });
  if (value > 300000 || s.rp >= 5400) flags.push({ kind: "import", sev: "flag", detail: "new account arrived with " + s.coins + " coins, " + s.yen + " yen, " + count + " items, " + s.rp + " RP" });
  return s;
}

/* ---------- Watching: what each account does, for the admin page ----------
   Nothing here caps anybody. It keeps count -- games, wins, streaks, timed
   blocks, what was earned -- and turns the numbers into a suspicion score with
   its reasons, plus flags when something is far outside what a person does.
   Only the flagrant case (a lifetime of near-perfect timing) bans on its own. */
export const WATCH = {
  pfMin: 100,          // timed blocks before the lifetime rate counts
  pfFlag: 0.7, pfBan: 0.88, pfBanMin: 300,
  recentMatches: 10, recentMin: 60, recentFlag: 0.8,
  streakFlag: 25,      // wins in a row (flags at 25, 50, 75 ...)
  wrMin: 40, wrFlag: 0.9,
  mphFlag: 60,         // matches in an hour
  coinsDayFlag: 200000, yenDayFlag: 3000,
  histKept: 60, ledgerKept: 150, daysKept: 14
};
export function newStats(now) {
  return { v: 1, first: now, g: 0, w: 0, sk: 0, bsk: 0, rg: 0, rw: 0, rsk: 0, rbsk: 0, bl: 0, pf: 0, secs: 0,
    ec: { c: 0, y: 0, rp: 0 }, sp: { c: 0, y: 0 }, it: 0, mt: [], d: {}, wf: {}, by: { m: {}, s: {}, a: {}, k: {} } };
}
// what a save holds, to tell what an act changed
export function snap(s) {
  const items = [];
  for (const t of TABS) for (const id in (s[BAG[t]] || {})) if (s[BAG[t]][id]) items.push(t + ":" + id);
  return { c: s.coins | 0, y: s.yen | 0, rp: s.rp | 0, items, eq: [String(s.eqSword || ""), String(s.eqAbil || ""), String(s.eqSkin || "")] };
}
function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }
function dayOf(st, now) {
  const k = dayKey(now);
  if (!st.d[k]) {
    st.d[k] = { g: 0, w: 0, c: 0, y: 0, rp: 0 };
    const keys = Object.keys(st.d).sort();
    while (keys.length > WATCH.daysKept) delete st.d[keys.shift()];
  }
  return st.d[k];
}
/* One act (or a code, or an admin edit), before and after: into the counts,
   the match history and the ledger of every coin, yen, RP and item change. */
export function recordAct(st, hist, ledger, kind, a, res, pre, post, now) {
  const dc = post.c - pre.c, dy = post.y - pre.y, drp = post.rp - pre.rp;
  const had = new Set(pre.items), has = new Set(post.items);
  const got = post.items.filter(x => !had.has(x)), lost = pre.items.filter(x => !has.has(x));
  const day = dayOf(st, now);
  if (dc > 0) { st.ec.c += dc; day.c += dc; } else st.sp.c -= dc;
  if (dy > 0) { st.ec.y += dy; day.y += dy; } else st.sp.y -= dy;
  if (drp > 0) { st.ec.rp += drp; day.rp += drp; }
  st.it += got.length;
  if (kind === "match" && res && res.ok !== false) {
    const won = res.res && res.res.won !== undefined ? !!res.res.won : !!a.won, ranked = !!(CAT.modes[a.mode] && CAT.modes[a.mode].ranked);
    const bl = int(a.blocks, 0, 100000) || 0, pf = Math.min(bl, int(a.perfects, 0, 100000) || 0);
    const secs = Math.max(0, Math.min(MATCH.maxSecs, Number(a.secs) || 0));
    st.g++; day.g++; st.secs += secs; st.bl += bl; st.pf += pf;
    if (won) { st.w++; day.w++; st.sk++; st.bsk = Math.max(st.bsk, st.sk); } else st.sk = 0;
    if (ranked) { st.rg++; if (won) { st.rw++; st.rsk++; st.rbsk = Math.max(st.rbsk, st.rsk); } else st.rsk = 0; }
    st.mt = st.mt.filter(t => now - t < 3600 * 1000).concat([now]);
    // what they played it with, for win rates by mode, blade, ability and skin
    const eq = (pre.eq || post.eq || []).map(x => String(x || "").slice(0, 24)), mode = String(a.mode || "").slice(0, 16);
    if (!st.by) st.by = { m: {}, s: {}, a: {}, k: {} };
    [["m", mode], ["s", eq[0]], ["a", eq[1]], ["k", eq[2]]].forEach(([k, id]) => {
      if (!id) return;
      const row = st.by[k][id] || (st.by[k][id] = [0, 0]);
      row[0]++; if (won) row[1]++;
    });
    hist.push({ at: now, m: mode, won, secs: Math.round(secs), c: dc, rp: drp, bl, pf, sw: eq[0] || "", ab: eq[1] || "", sk: eq[2] || "" });
    while (hist.length > WATCH.histKept) hist.shift();
  }
  if (dc || dy || drp || got.length || lost.length) {
    ledger.push({ at: now, k: kind, dc, dy, drp, got: got.slice(0, 12), lost: lost.slice(0, 12) });
    while (ledger.length > WATCH.ledgerKept) ledger.shift();
  }
}
function recentRate(hist) {
  let bl = 0, pf = 0;
  for (const h of hist.slice(-WATCH.recentMatches)) { bl += h.bl; pf += h.pf; }
  return { bl, pf, rate: bl ? pf / bl : 0 };
}
/* Flags from the running totals. Each kind is said at most once a day (a
   streak once per milestone), so the admin page is not buried in repeats. */
export function watchFlags(st, hist, now) {
  const out = [], once = (k, gap) => { if (st.wf[k] && now - st.wf[k] < gap) return false; st.wf[k] = now; return true; };
  const DAY = 86400000, rate = st.bl ? st.pf / st.bl : 0, rec = recentRate(hist), today = st.d[dayKey(now)] || {};
  if (st.bl >= WATCH.pfBanMin && rate >= WATCH.pfBan)
    out.push({ kind: "autoparry-life", sev: "ban", detail: Math.round(rate * 100) + "% perfect over " + st.bl + " timed blocks, lifetime" });
  else if (st.bl >= WATCH.pfMin && rate >= WATCH.pfFlag && once("pf", DAY))
    out.push({ kind: "parry-rate", sev: "flag", detail: Math.round(rate * 100) + "% perfect over " + st.bl + " timed blocks, lifetime" });
  if (rec.bl >= WATCH.recentMin && rec.rate >= WATCH.recentFlag && once("pfr", DAY))
    out.push({ kind: "parry-recent", sev: "flag", detail: Math.round(rec.rate * 100) + "% perfect over the last " + Math.min(hist.length, WATCH.recentMatches) + " matches (" + rec.bl + " blocks)" });
  if (st.sk >= WATCH.streakFlag && st.sk % WATCH.streakFlag === 0 && once("sk" + st.sk, DAY * 365))
    out.push({ kind: "streak", sev: "flag", detail: st.sk + " wins in a row" });
  if (st.g >= WATCH.wrMin && st.w / st.g >= WATCH.wrFlag && once("wr", DAY))
    out.push({ kind: "win-rate", sev: "flag", detail: Math.round(100 * st.w / st.g) + "% of " + st.g + " games won" });
  if (st.mt.length > WATCH.mphFlag && once("mph", 3600000))
    out.push({ kind: "match-rate", sev: "flag", detail: st.mt.length + " matches in the last hour" });
  if (today.c > WATCH.coinsDayFlag && once("cday", DAY))
    out.push({ kind: "coins-day", sev: "flag", detail: today.c + " coins earned today" });
  if (today.y > WATCH.yenDayFlag && once("yday", DAY))
    out.push({ kind: "yen-day", sev: "flag", detail: today.y + " yen earned today" });
  return out;
}
/* 0-100 and why: the admin page sorts by it. */
export function suspicion(st, hist, flags, now) {
  const why = [];let score = 0;
  const add = (n, t) => { score += n; why.push(t); };
  if (st && st.bl >= WATCH.pfMin) {
    const r = st.pf / st.bl;
    if (r >= 0.85) add(45, Math.round(r * 100) + "% perfect parries (lifetime)");
    else if (r >= 0.7) add(30, Math.round(r * 100) + "% perfect parries (lifetime)");
    else if (r >= 0.55) add(12, Math.round(r * 100) + "% perfect parries (lifetime)");
  }
  const rec = recentRate(hist || []);
  if (rec.bl >= 40 && rec.rate >= 0.8) add(25, Math.round(rec.rate * 100) + "% perfect in recent matches");
  if (st && st.sk >= 25) add(25, st.sk + " wins in a row");
  else if (st && st.sk >= 15) add(10, st.sk + " wins in a row");
  if (st && st.g >= WATCH.wrMin) {
    const wr = st.w / st.g;
    if (wr >= 0.9) add(20, Math.round(wr * 100) + "% win rate");
    else if (wr >= 0.8) add(8, Math.round(wr * 100) + "% win rate");
  }
  if (st && st.mt && st.mt.filter(t => now - t < 3600000).length > 40) add(15, "40+ matches in the last hour");
  let fb = 0, ff = 0;
  for (const f of flags || []) {
    if (now - f.at > 7 * 86400000 || f.kind === "admin") continue;
    if (f.sev === "ban") fb++; else ff++;
  }
  if (fb) add(Math.min(60, fb * 40), fb + " ban-level flag" + (fb > 1 ? "s" : "") + " this week");
  if (ff) add(Math.min(40, ff * 8), ff + " flag" + (ff > 1 ? "s" : "") + " this week");
  return { score: Math.min(100, score), why };
}
// the short version the player list shows
export function summary(st, sus) {
  return { g: st.g, w: st.w, sk: st.sk, bsk: st.bsk, bl: st.bl, pr: st.bl ? Math.round(1000 * st.pf / st.bl) / 10 : null,
    score: sus.score, top: sus.why[0] || "" };
}
