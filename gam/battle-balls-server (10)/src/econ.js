/* ---------- The economy, on the server ----------
   Coins, yen, RP, what you own, the pass and free spins belong to the server.
   A game cannot write them; it asks for something to happen ("open a chest",
   "sell this", "the match ended") and the rules below -- the game's own rules,
   ported, with the game's own numbers from catalog.js -- decide what that is
   worth. Every roll of the dice happens here.
   Each act returns {ok, res} or {ok:false, why}; `flags` it pushes are for the
   anticheat: {kind, sev:"flag"|"ban", detail}. */
import { CAT } from "./catalog.js";

export const ECON_KEYS = ["coins", "yen", "rp", "swords", "abils", "skins", "pass", "freeSpins", "redeemed", "casino", "econ"];
const BAG = { sword: "swords", abil: "abils", skin: "skins" };
const EQ = { sword: "eqSword", abil: "eqAbil", skin: "eqSkin" };
const TABS = ["sword", "abil", "skin"];
const BY = {};
for (const t of TABS) { BY[t] = {}; for (const it of CAT.items[t].list) BY[t][it.id] = it; }
export function itemOf(tab, id) { return (BY[tab] && Object.prototype.hasOwnProperty.call(BY[tab], id)) ? BY[tab][id] : null; }
// a whole number inside [lo, hi], or null: an amount out of range is refused, never nudged into range
const int = (v, lo, hi) => (typeof v === "number" && isFinite(v) && Math.floor(v) >= lo && Math.floor(v) <= hi) ? Math.floor(v) : null;

/* ---- the shape of a save's economy ---- */
export function ensure(s) {
  for (const k of ["coins", "yen", "rp", "freeSpins"]) if (typeof s[k] !== "number" || !isFinite(s[k]) || s[k] < 0) s[k] = 0;
  for (const t of TABS) if (!s[BAG[t]] || typeof s[BAG[t]] !== "object" || Array.isArray(s[BAG[t]])) s[BAG[t]] = {};
  if (!s.redeemed || typeof s.redeemed !== "object") s.redeemed = {};
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
export function chestPool(tab) {
  const d = CAT.items[tab];
  return d.list.filter(it => !(it.rank || it.r === "rank" || it.ultra || it.pass || it.id === d.starter || it.free));
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
function limEligible(it) { return !it.rank && !it.code && !it.pass && it.r !== "rank" && !it.free && it.v > 0; }
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
  rpWin: 100, rpLose: -30, rpMinSecs: 40, passMinSecs: 20, rankedWinsPerHour: 20, passMatchesPerHour: 30 };
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
export function applyAct(s, a, ctx) {
  const rnd = ctx.rnd || Math.random, now = ctx.now || Date.now(), flags = ctx.flags || (ctx.flags = []);
  ensure(s);
  if (!a || typeof a !== "object" || typeof a.k !== "string") return { ok: false, why: "bad request" };
  const tab = TABS.includes(a.tab) ? a.tab : null;

  if (a.k === "chest") {
    if (!tab) return { ok: false, why: "bad tab" };
    const grade = CAT.grades[a.grade] ? a.grade : "normal", n = Math.min(10, int(a.n, 1, 1000) || 1), free = !!a.free;
    let unit = grade !== "normal" ? CAT.grades[grade].cost : CAT.items[tab].cost;
    if (free) { if (!(s.freeSpins > 0) || grade !== "normal" || n !== 1) return { ok: false, why: "No free spins." }; unit = 0; }
    if (s.coins < unit * n) return { ok: false, why: "Not enough coins." };
    if (!chestTiers(tab, grade).pool.length) return { ok: false, why: "Nothing in that chest." };
    if (free) s.freeSpins--;
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
    // fill the bank for the time that has passed, then pay this match out of it
    if (typeof e.bank !== "number" || !isFinite(e.bank)) { e.bank = MATCH.maxSecs; e.bankAt = now; }
    e.bank = Math.min(MATCH.bankMax, e.bank + Math.max(0, now - (e.bankAt || now)) / 1000);
    e.bankAt = now;
    const own = Math.max(0, Math.min(MATCH.maxSecs, Number(a.secs) || 0));
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
      if (rp > 0 && secs < MATCH.rpMinSecs) rp = 0;                 // no ranked win in a few seconds
      if (rp > 0) {
        // no more ranked wins in an hour than a person can play: past that, no RP (and a note)
        e.rw = (e.rw || []).filter(t => now - t < 3600 * 1000);
        if (e.rw.length >= MATCH.rankedWinsPerHour) {
          rp = 0;
          if (!e.rwFlag || now - e.rwFlag > 3600 * 1000) { e.rwFlag = now; flags.push({ kind: "ranked", sev: "flag", detail: "more than " + MATCH.rankedWinsPerHour + " ranked wins claimed in an hour" }); }
        } else e.rw.push(now);
      }
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
    // the blocks this game timed for itself
    const v = parryVerdict(int(a.blocks, 0, 100000), int(a.perfects, 0, 100000));
    if (v) flags.push({ kind: "autoparry", sev: v.sev, detail: Math.round(v.rate * 100) + "% perfect over " + a.blocks + " blocks (" + mode + ")" });
    return { ok: true, res: { coins, rp, ranked, pass } };
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
  s.coins = num(from.coins, IMPORT.coins); s.yen = num(from.yen, IMPORT.yen); s.rp = num(from.rp, IMPORT.rp);
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
