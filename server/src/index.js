/* =====================================================================
   BATTLE BALLS — room server
   One Durable Object per lobby code. Holds the roster and RUNS EVERY MATCH
   (4.0): the ball, the bots, every block, ability and hit, and who won, are
   decided here by the game's own code (sim.js). The players' games only send
   their own movement and presses, and show what the room tells them. The
   longest-serving player is the room's leader: they pick the mode and start.

   Deploy:  npx wrangler deploy
   Connect: wss://<worker>.workers.dev/room/ABCDE?name=Ben
   ===================================================================== */

import { CAT } from "./catalog.js";
import { ECON_KEYS, setAbilOff, ultrasOf, timingVerdict, timingAdd, timingPooled, applyAct, importEcon, ensure, codeReward, itemOf, parryVerdict, retire, RETIRED, newStats, snap, recordAct, watchFlags, suspicion, summary, seasonReset, rankClean, settleMatch, settledOf, SETTLE } from "./econ.js";
const RETIRED_RE = new RegExp('"(' + Object.keys(RETIRED.abil).join("|") + ')"');
import { adminPage, handleAdmin, ADMIN_TRIES, ADMIN_WINDOW_MS, specCheck } from "./admin.js";
import { SimHost, SIM_ID } from "./sim.js";
import { Hub, Party, normTag } from "./social.js";
export { Hub, Party };

const MAX_PLAYERS = 6;
const BOSS_MAX = 4;                          // Boss Rally: one to four players
// modes a room opens for one player and starts by itself; what each settles as
export const SOLO_MODES = { sranked1: 1, sranked2: 1, boss: 1 };
export const SETTLE_MODE = { mp: "mp", ranked2: "mpranked2", god1: "god1", sranked1: "ranked1", sranked2: "ranked2", boss: "boss" };
const SETTLE_GIVEUP_MS = 7 * 24 * 3600 * 1000;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no O/0/I/1

/* ---------- pure logic, unit-testable without Cloudflare ---------- */

export function makeCode(rand) {
  rand = rand || Math.random;
  let out = "";
  for (let i = 0; i < 5; i++) out += ALPHA[Math.floor(rand() * ALPHA.length)];
  return out;
}

export function normaliseCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

// longest-serving connection is host; id breaks ties so every peer agrees
export function electHost(players) {
  let best = null;
  for (const p of players) {
    if (!best || p.joinedAt < best.joinedAt ||
       (p.joinedAt === best.joinedAt && p.id < best.id)) best = p;
  }
  return best ? best.id : null;
}

export function buildRoster(players) {
  return {
    t: "roster",
    host: SIM_ID,                       // the server runs the match
    leader: electHost(players),         // the player who picks and starts it
    count: players.length,
    players: players
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
      .map(p => ({ id: p.id, name: p.name, ready: !!p.ready,
                   sword: p.sword, skin: p.skin, abil: p.abil, babil: p.babil }))
  };
}

// pstate is where a player is standing in the shared party lobby, and trade
// is the two-sided offer protocol. Both are peer to peer.
// hold: a guest hitting or throwing a ball it caught; only the host acts on it
const RELAY = { state:1, parry:1, ability:1, swing:1, chat:1, pstate:1, trade:1, hold:1 };
// only the room's own match may say these: from a player they are dropped
const SIM_ONLY = { ball:1, hit:1, spawn:1, roundover:1, botstate:1, parryok:1, corr:1, mvflag:1, boss:1 };
// setup is the leader telling the room which gamemode and how many bots
const LEADER_ONLY = { setup:1 };
// what the match hears from a player; parry and hold are for it alone
const SIM_FEED = { state:1, parry:1, ability:1, swing:1, hold:1 };
const SIM_PRIVATE = { parry:1, hold:1 };
// what the match says, for everyone
const SIM_OUT = { ball:1, botstate:1, hit:1, ability:1, spawn:1, parryok:1, swing:1, boss:1 };

// A public game is a public endpoint. Without these, one script can hold a
// socket open and flood the room, and every relayed byte is billed to you.
const MAX_MSG_BYTES = 8 * 1024;
// what a streaming game may send on to its watchers
const LIVE_MSG = { livestart: 1, liveover: 1, state: 1, ball: 1, botstate: 1, hit: 1, swing: 1 };   // a ball snapshot is a few hundred bytes
// A host legitimately sends ~60/s (state + ball + bots at 20Hz each) plus a
// burst on every deflect, so this sits well clear of real play while still
// stopping a flood, which runs to thousands a second.
const MSG_BUDGET    = 240;        // messages allowed per window
const MSG_WINDOW_MS = 1000;       // the window itself

// Token bucket per connection. Returns false when the sender is over budget.
export function checkRate(state, now, budget, windowMs) {
  budget = budget || MSG_BUDGET;
  windowMs = windowMs || MSG_WINDOW_MS;
  if (!state.windowStart || now - state.windowStart >= windowMs) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count++;
  return state.count <= budget;
}

/* Carried, not owned: Dev2 is one item, and its karambit and BOTH modes are
   ways of carrying it, so each needs Dev2 itself. */
const SWORD_COMBOS = { dev2both: ["dev2sniper"], dev2karambit: ["dev2sniper"] };
export function ownsSword(inv, id) {
  if (!inv || !inv.swords) return false;
  if (Object.prototype.hasOwnProperty.call(SWORD_COMBOS, id)) return SWORD_COMBOS[id].every(x => !!inv.swords[x]);
  return !!inv.swords[id];
}
export function routeMessage(msg, senderId, hostId) {      // hostId: the room's leader
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string")
    return { action: "drop", reason: "malformed" };

  if (msg.t === "loadout") {
    return { action: "update", fields: {
      name:  typeof msg.name  === "string" ? msg.name.slice(0, 14) : undefined,
      ready: typeof msg.ready === "boolean" ? msg.ready : undefined,
      sword: typeof msg.sword === "string" ? msg.sword.slice(0, 24) : undefined,
      skin:  typeof msg.skin  === "string" ? msg.skin.slice(0, 24) : undefined,
      abil:  typeof msg.abil  === "string" ? msg.abil.slice(0, 24) : undefined,
      // the ability picked for Boss Rally when the usual one sits it out (casting it is still ownership-checked)
      babil: typeof msg.babil === "string" ? msg.babil.slice(0, 24) : undefined
    }};
  }
  if (msg.t === "start") {
    if (senderId !== hostId) return { action: "drop", reason: "not-host" };
    // Everything the clients need to build the SAME match. rf was being
    // dropped here, which meant a networked ranked 2v2 always faced rank-zero
    // bots however high the host actually was.
    const num = (v, lo, hi, dflt) =>
      (typeof v === "number" && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : dflt;
    return { action: "start", payload: {
      t: "start",
      mode: typeof msg.mode === "string" ? msg.mode : "mp",
      map:  typeof msg.map  === "string" ? msg.map  : "sky",
      gm:   typeof msg.gm   === "string" ? msg.gm.slice(0, 16) : "ffa",
      q:    msg.q ? 1 : 0,
      bots: num(msg.bots, 0, 8, 0) | 0,
      rf:   num(msg.rf, 0, 1, 0),
      seed: (Math.random() * 2147483647) | 0,
      at:   Date.now()
    }};
  }
  if (msg.t === "ping")
    return { action: "reply", payload: { t:"pong", c: msg.c, s: Date.now() } };
  // block timing is measured by the room's own match now: a player's report is not asked for
  if (msg.t === "acrep") return { action: "drop", reason: "server-only" };
  if (SIM_ONLY[msg.t]) return { action: "drop", reason: "server-only" };
  if (LEADER_ONLY[msg.t]) {
    if (senderId !== hostId) return { action: "drop", reason: "not-leader" };
    return { action: "relay", payload: Object.assign({}, msg, { from: senderId }) };
  }
  if (RELAY[msg.t])
    return { action: "relay", payload: Object.assign({}, msg, { from: senderId }) };

  return { action: "drop", reason: "unknown" };
}

/* ---------- ability spam: checked here, where nobody can edit it ----------
   A player's own cast arrives as {t:"ability", a} with no `only` and no `bot`
   (those are follow-ups and the host's bots). One message is one cast, after
   which the game runs the full cooldown (Overdrive: 78% of it). So a cast is
   only possible with an ability you own, and never sooner than its cooldown
   after the last one -- with room for the network. */
const ABIL = {};
for (const a of CAT.items.abil.list) ABIL[a.id] = a;
const CAST = { cdShare: 0.78, slackS: 1.5, minCd: 3, strikesToBan: 3, pullsPerCd: 10 };
// follow-ups a guest may send, and the ability each needs; every other follow-up,
// and anything tagged as a bot's, is the host's alone -- and only these kinds
const GUEST_FOLLOW = { taunt: null, riftsnap: "bloodrift", pull: "ramenhair" };
const HOST_FOLLOW = { rift: 1, riftsnap: 1, flash: 1, say: 1, drone: 1, stdshow: 1, cat: 1, pull: 1, taunt: 1, wave: 1, warts: 1, divine: 1 };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// the ability a message needs its sender to own, if any
export function castNeeds(msg, isHost) {
  if (!msg || msg.t !== "ability" || typeof msg.a !== "string") return null;
  if (isHost && msg.only && has(HOST_FOLLOW, msg.only)) return null;
  if (msg.only) return has(GUEST_FOLLOW, msg.only) ? GUEST_FOLLOW[msg.only] : null;
  return msg.a;
}
/* `owned` must be fresh: the Room fetches again before believing "not owned".
   Returns null, or a verdict {sev, kind, detail, drop} -- drop: never pass it on. */
export function castCheck(st, msg, now, owned, isHost) {
  if (!msg || msg.t !== "ability") return null;
  // the host's bots, and effects the host decides -- only the kinds it really sends
  if (isHost && msg.only && has(HOST_FOLLOW, msg.only)) return null;
  if (isHost && (msg.bot || msg.only)) return { drop: true, sev: "flag", kind: "ability", detail: "the host sent an unknown follow-up" };
  if (typeof msg.a !== "string") return { drop: true, sev: "flag", kind: "ability", detail: "an ability message with no ability" };
  if (msg.bot) return { drop: true, sev: "flag", kind: "ability", detail: "a guest sent an ability as a bot" };
  if (msg.only) {
    if (!has(GUEST_FOLLOW, msg.only)) return { drop: true, sev: "flag", kind: "ability", detail: "a guest sent the host's " + String(msg.only).slice(0, 16) };
    const need = GUEST_FOLLOW[msg.only];
    if (need && owned && !owned[need]) return { drop: true, sev: "ban", kind: "ability", detail: msg.only + " without owning " + need };
    if (msg.only === "pull") {
      const cd = (ABIL.ramenhair && ABIL.ramenhair.cd) || 10;
      st.pulls = (st.pulls || []).filter(t => now - t < cd * 1000);
      st.pulls.push(now);
      if (st.pulls.length > CAST.pullsPerCd) return { drop: true, sev: "flag", kind: "ability", detail: st.pulls.length + " pulls inside one Ramen Hair cooldown" };
    }
    return null;
  }
  const a = has(ABIL, msg.a) ? ABIL[msg.a] : null;
  if (!a) return { drop: true, sev: "flag", kind: "ability", detail: "cast an ability that does not exist: " + msg.a.slice(0, 24) };
  if (owned && !owned[a.id]) return { drop: true, sev: "ban", kind: "ability", detail: "cast " + a.id + " without owning it" };
  if (a.passive) return { drop: true, sev: "flag", kind: "ability", detail: "cast " + a.id + ", which is passive" };
  st.last = st.last || {};
  const prev = st.last[a.id];
  st.last[a.id] = now;
  // Blood Rift's request can be refused by the host and pressed again; it is one use per game anyway
  if (a.id === "bloodrift" || !(a.cd >= CAST.minCd) || prev === undefined) return null;
  const gap = (now - prev) / 1000, need = a.cd * CAST.cdShare - CAST.slackS;
  if (gap >= need) return null;
  st.strikes = (st.strikes || 0) + 1;
  return { drop: true, sev: st.strikes >= CAST.strikesToBan ? "ban" : "flag", kind: "ability",
    detail: a.id + " cast again after " + gap.toFixed(1) + "s (cooldown " + a.cd + "s), strike " + st.strikes };
}

/* ---------- Durable Object ---------- */

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    // rate state lives in memory, keyed by socket. A hibernation wake starts a
    // fresh bucket, which is fine -- it only ever costs an attacker, not a player.
    this.rate = new WeakMap();
    this.casts = new WeakMap();                       // per socket, per match: last cast of each ability
    this.invs = new Map();                            // account -> what it owns, fetched when needed
    this.invAt = new Map();                           // account -> when it was last fetched again for a loadout
  }
  async identify(tok) {
    const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{48})$/.exec(String(tok || ""));
    if (!m) return { ok: false, why: "signin" };
    if (!this.env || !this.env.VAULT) return { ok: false, why: "signin" };
    try {
      const r = await toVault(this.env, m[1], { op: "whoami", sub: m[1], secret: m[2] });
      const j = await r.json();
      if (r.status === 403) return { ok: false, why: "banned", reason: j.why || "" };
      if (r.status !== 200) return { ok: false, why: "signin" };
      return { ok: true, sub: m[1], inv: j.inv, rp: j.rp | 0 };
    } catch (e) { return { ok: false, why: "signin" }; }
  }
  async inventory(sub) {
    if (this.invs.has(sub)) return this.invs.get(sub);
    try {
      const r = await toVault(this.env, sub, { op: "inv", sub });
      const j = await r.json();
      if (j.inv) { this.invs.set(sub, j.inv); return j.inv; }
    } catch (e) {}
    return null;
  }
  // gear you do not own is swapped for the starter, and noted
  checkLoadout(me, inv, noteIt) {
    const bad = [];
    if (me.sword && !ownsSword(inv, me.sword)) { bad.push(me.sword); me.sword = CAT.items.sword.starter; }
    if (me.skin && !inv.skins[me.skin]) { bad.push(me.skin); me.skin = CAT.items.skin.starter; }
    if (me.abil && !inv.abils[me.abil]) { bad.push(me.abil); me.abil = CAT.items.abil.starter; }
    if (bad.length && noteIt !== false) this.report(me.sub, { kind: "gear", sev: "flag", detail: "equipped " + bad.join(", ") + " without owning it" });
    return bad.length;
  }
  /* The admin page, through the Worker: kick a player out of this room, or
     show them a message right now. Answers with how many sockets it reached. */
  adminOp(b) {
    if (b.op === "live") return jsonRes({ live: this.liveSrc() });
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || a.sub !== b.sub) continue;
      n++;
      try {
        if (b.op === "kick") { if (this.ctx.storage) this.ctx.storage.put("kick:" + b.sub, Date.now() + KICK_MS); ws.send(JSON.stringify({ t: "denied", why: "kicked", reason: String(b.text || "").slice(0, 200) })); ws.close(4004, "kicked"); }
        else if (b.op === "msg") ws.send(JSON.stringify({ t: "adminmsg", text: String(b.text || "").slice(0, 500) }));
      } catch (e) {}
    }
    if (b.op === "kick" && n) this.pushRoster();
    return jsonRes({ reached: n });
  }
  // tell the account's Vault; if that bans it, it is out of the room now
  report(sub, flag, byId) {
    if (!sub || !this.env || !this.env.VAULT) return;
    const p = toVault(this.env, sub, { op: "flag", sub, flag }).then(r => r.json()).then(j => {
      if (!j.banned) return;
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.sub === sub) {
          try { ws.send(JSON.stringify({ t: "denied", why: "banned", reason: j.why || "" })); ws.close(4003, "banned"); } catch (e) {}
        }
      }
    }).catch(() => {});
    if (this.ctx.waitUntil) this.ctx.waitUntil(p);
    return p;
  }

  roster(leaving) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === leaving) continue;                   // closing: it is not in the room any more
      const a = ws.deserializeAttachment();
      if (a && !a.spec) out.push(a);
    }
    return out;
  }
  hostId() { return electHost(this.roster()); }
  /* ---- seats held for lobby invites ----
     A friend invited to this room has a seat for a minute; held seats count
     toward the six, so an invite can never overfill the room. The room is
     asked directly -- a player's own word about which room they are in, or
     whether it has space, is never taken. */
  async resv() {
    const now = Date.now(), r = (this.ctx.storage && (await this.ctx.storage.get("resv"))) || {};
    for (const k in r) if (r[k] <= now) delete r[k];
    return r;
  }
  async seatsTaken(r, except) {
    const subs = new Set(this.roster().map(p => p.sub));
    let n = subs.size;
    for (const k in r) if (k !== except && !subs.has(k)) n++;
    return n;
  }
  async socialOp(b) {
    const sub = typeof b.sub === "string" ? b.sub.slice(0, 64) : "";
    const meta = (this.ctx.storage && (await this.ctx.storage.get("meta"))) || {};
    const r = await this.resv(), now = Date.now();
    const out = o => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
    if (b.op === "member") return out({ ok: !!sub && this.roster().some(p => p.sub === sub) });
    if (b.op === "release") { delete r[sub]; await this.ctx.storage.put("resv", r); return out({ ok: true }); }
    if (!this.roster().length) return out({ ok: false, why: "closed" });
    if (meta.solo || meta.q) return out({ ok: false, why: "private" });
    if (b.op === "reserve" || b.op === "claim") {
      if (this.roster().some(p => p.sub === sub)) return out({ ok: true, here: true });
      if (!r[sub] && (await this.seatsTaken(r, sub)) >= MAX_PLAYERS) return out({ ok: false, why: "full" });
      r[sub] = now + Math.min(120000, Math.max(5000, b.op === "claim" ? 30000 : (b.ttl | 0) || 60000));
      await this.ctx.storage.put("resv", r);
      return out({ ok: true });
    }
    return out({ ok: false, why: "unknown" });
  }

  broadcast(obj, exceptWs) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(text); } catch (e) { /* socket closing */ }
    }
  }
  sendTo(id, obj) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.id === id) { try { ws.send(text); } catch (e) {} }
    }
  }
  pushRoster(leaving) {
    const r = buildRoster(this.roster(leaving));
    this.broadcast(r, leaving); this.announce(null, leaving);
    if (this.sim && this.sim.running) this.sim.roster(r);      // somebody joined or left mid-match
  }
  /* Public lobbies: every room tells the directory who is in it, what it is
     playing and whether it is open. A private room, a full one or one mid-match
     is simply not listed. */
  async announce(extra, leaving) {
    if (!this.env || !this.env.DIR || !this.ctx.storage) return;
    const st = this.ctx.storage, meta = (await st.get("meta")) || {};
    if (extra) Object.assign(meta, extra);
    if (extra) await st.put("meta", meta);
    const code = meta.code || (await st.get("code")) || "";
    if (!code) return;
    const players = this.roster(leaving), host = players.find(p => p.id === electHost(players));
    const p = dirCall(this.env, { op: "lobby", code, n: players.length, max: MAX_PLAYERS, host: host ? host.name : "",
      gm: meta.gm || "ffa", map: meta.map || "sky", priv: !!meta.priv, playing: !!meta.playing, q: !!meta.q });
    if (this.ctx.waitUntil) this.ctx.waitUntil(p);
  }

  async fetch(request) {
    if (new URL(request.url).hostname === "room-admin") return this.adminOp(await request.json());
    if (new URL(request.url).hostname === "room-social") return this.socialOp(await request.json());
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket upgrade", { status: 426 });
    const url = new URL(request.url);
    const live = (url.pathname.match(/^\/live\/([A-Za-z0-9_-]{1,64})$/) || [])[1];
    if (live) return this.liveSocket(url, live);
    // the admin, watching: not a player, not on the roster, cannot send a thing
    if (url.searchParams.get("spectate")) return this.spectator(url);
    // a solo room (server-run ranked, Boss Rally on your own) is for one player
    const soloAsk = SOLO_MODES[url.searchParams.get("solo")] ? url.searchParams.get("solo") : "";
    const metaNow = (this.ctx.storage && (await this.ctx.storage.get("meta"))) || {};
    if (this.roster().length >= MAX_PLAYERS || (metaNow.solo && this.roster().length >= 1) || (soloAsk && this.roster().length >= 1))
      return new Response("room full", { status: 403 });

    // online play needs a Google account, so a ban sticks. The session token
    // is checked with that account's own Vault; a refusal is told over the
    // socket so the game can say why, then the socket is closed
    const who = await this.identify(url.searchParams.get("tok"));
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    if (!who.ok) {
      server.accept();
      server.send(JSON.stringify({ t: "denied", why: who.why, reason: who.reason || "" }));
      server.close(4001, who.why);
      return new Response(null, { status: 101, webSocket: client });
    }
    // seats held for invited friends count: only they may take them
    if (this.ctx.storage) {
      const r = await this.resv();
      if ((await this.seatsTaken(r, who.sub)) >= MAX_PLAYERS && !this.roster().some(p => p.sub === who.sub)) {
        server.accept();
        server.send(JSON.stringify({ t: "denied", why: "full", reason: "That lobby is full." }));
        server.close(4003, "full");
        return new Response(null, { status: 101, webSocket: client });
      }
      if (r[who.sub]) { delete r[who.sub]; await this.ctx.storage.put("resv", r); }
    }
    // kicked by the admin a moment ago: not straight back in
    const kickedTill = this.ctx.storage ? await this.ctx.storage.get("kick:" + who.sub) : 0;
    if (kickedTill && kickedTill > Date.now()) {
      server.accept();
      server.send(JSON.stringify({ t: "denied", why: "kicked", reason: "You were removed from this room. Try another one in a few minutes." }));
      server.close(4004, "kicked");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);                 // hibernatable

    const me = {
      id: crypto.randomUUID().slice(0, 8),
      name: (url.searchParams.get("name") || "Player").slice(0, 14),
      sword: (url.searchParams.get("sword") || "trainer").slice(0, 24),
      skin:  (url.searchParams.get("skin")  || "rookie").slice(0, 24),
      abil:  (url.searchParams.get("abil")  || "dash").slice(0, 24),
      ready: false,
      joinedAt: Date.now(),
      sub: who.sub,                                   // never sent to anyone: see buildRoster
      rp: who.rp | 0                                  // nor this: a ranked 2v2's bots are tuned from it
    };
    if (who.inv) { this.invs.set(who.sub, who.inv); this.checkLoadout(me, who.inv); }
    server.serializeAttachment(me);
    const code = (url.pathname.match(/\/room\/([A-Za-z0-9]{1,8})$/) || [])[1] || "";
    if (this.ctx.storage && code) await this.ctx.storage.put("code", normaliseCode(code));
    // a room made by the GOD queue is never listed
    if (url.searchParams.get("q") === "1" && this.ctx.storage) { const mt = (await this.ctx.storage.get("meta")) || {}; mt.q = true; await this.ctx.storage.put("meta", mt); }
    // a solo room: private, one player, and it starts itself
    if (soloAsk && this.ctx.storage) { const mt = (await this.ctx.storage.get("meta")) || {}; mt.solo = soloAsk; mt.priv = true; await this.ctx.storage.put("meta", mt); }
    dirCall(this.env, { op: "room", code: normaliseCode(code), sub: who.sub, name: me.name });
    server.send(JSON.stringify({ t:"welcome", you: me.id, host: SIM_ID, leader: this.hostId(), srv: 1,
                                 max: MAX_PLAYERS, now: Date.now() }));
    this.pushRoster();
    if (soloAsk) {
      await this.startMatch({ t: "start", mode: soloAsk, q: 0, map: "random", gm: "ffa", bots: 0, rf: 0,
        seed: (Math.random() * 2147483647) | 0, at: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }
    // a GOD queue room starts itself the moment both players are in
    if (url.searchParams.get("q") === "1" && this.roster().length === 2 && !this.qStarted) {
      this.qStarted = true;
      await this.startMatch({ t: "start", mode: "god1", q: 1, map: "random", gm: "ffa", bots: 0, rf: 0,
        seed: (Math.random() * 2147483647) | 0, at: Date.now() });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /* A live room ("live:<account>"): the player's own game is the source and
     only streams while somebody watches; spectators get whatever it sends. */
  liveCount() { let n = 0; for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.spec && !a.src) n++; } return n; }
  liveTell(leaving) {
    let n = 0;
    for (const w of this.ctx.getWebSockets()) { if (w === leaving) continue; const a = w.deserializeAttachment(); if (a && a.spec && !a.src) n++; }
    for (const w of this.ctx.getWebSockets()) { if (w === leaving) continue; const a = w.deserializeAttachment(); if (a && a.src) try { w.send(JSON.stringify({ t: "watchers", n })); } catch (e) {} }
  }
  async liveSocket(url, sub) {
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    const no = (why, reason) => { server.accept(); server.send(JSON.stringify({ t: "denied", why, reason })); server.close(4005, why); return new Response(null, { status: 101, webSocket: client }); };
    if (url.searchParams.get("src") === "1") {
      const who = await this.identify(url.searchParams.get("tok"));
      if (!who.ok || who.sub !== sub) return no("signin", "");
      // one source at a time: a newer game takes over from an older tab
      for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.src) try { w.close(4006, "replaced"); } catch (e) {} }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ spec: true, src: true, sub, id: "src" });
      server.send(JSON.stringify({ t: "watchers", n: this.liveCount() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    const ok = await specCheck(this.env && this.env.ADMIN_KEY, "live:" + sub, url.searchParams.get("spectate"));
    if (!ok) return no("spec", "That spectate link has expired. Make a new one from the admin page.");
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ spec: true, id: "spec" + crypto.randomUUID().slice(0, 6) });
    server.send(JSON.stringify({ t: "welcome", spec: 1, live: 1, you: "spec", watch: "p", srv: 1, now: Date.now() }));
    this.liveTell();
    return new Response(null, { status: 101, webSocket: client });
  }
  liveSrc() { for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.src) return true; } return false; }

  async spectator(url) {
    const code = normaliseCode((url.pathname.match(/\/room\/([A-Za-z0-9]{1,8})$/) || [])[1] || "");
    const ok = await specCheck(this.env && this.env.ADMIN_KEY, code, url.searchParams.get("spectate"));
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    if (!ok) {
      server.accept();
      server.send(JSON.stringify({ t: "denied", why: "spec", reason: "That spectate link has expired. Make a new one from the admin page." }));
      server.close(4005, "spec");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    const me = { spec: true, id: "spec" + crypto.randomUUID().slice(0, 6), joinedAt: Date.now() };
    server.serializeAttachment(me);
    const players = this.roster(), target = ok.watch ? players.find(p => p.sub === ok.watch) : null;
    server.send(JSON.stringify({ t: "welcome", you: me.id, spec: 1, watch: target ? target.id : "", host: SIM_ID, leader: this.hostId(), srv: 1, max: MAX_PLAYERS, now: Date.now() }));
    server.send(JSON.stringify(buildRoster(players)));
    // a match already running: the same start everyone got, and who is already out
    if (this.sim && this.sim.running && this.startMsg) {
      server.send(JSON.stringify(this.startMsg));
      let dead = [];
      try { dead = (this.sim.state().fighters || []).filter(f => !f.alive).map(f => f.netId || ("bot" + f.botIndex)); } catch (e) {}
      server.send(JSON.stringify({ t: "specsync", dead }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    // drop anything oversized before we even parse it
    const size = typeof raw === "string" ? raw.length : (raw && raw.byteLength) || 0;
    if (size > MAX_MSG_BYTES) return;

    let bucket = this.rate.get(ws);
    if (!bucket) { bucket = { windowStart: 0, count: 0 }; this.rate.set(ws, bucket); }
    if (!checkRate(bucket, Date.now())) return;        // over budget: ignore

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const me = ws.deserializeAttachment();
    if (!me) return;
    if (me.src) {                                     // the streaming game: on to whoever watches
      if (LIVE_MSG[msg.t]) { const text = JSON.stringify(msg); for (const w of this.ctx.getWebSockets()) { if (w === ws) continue; try { w.send(text); } catch (e) {} } }
      return;
    }
    if (me.spec) {                                    // a spectator only ever asks the time
      if (msg.t === "ping") try { ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() })); } catch (e) {}
      return;
    }

    const d = routeMessage(msg, me.id, this.hostId());
    if (d.action === "drop") return;
    if (msg.t === "ability" && me.sub) {
      const isHost = false;                           // the room runs every match: no player is its host
      let st = this.casts.get(ws);
      if (!st) { st = {}; this.casts.set(ws, st); }
      // what this room remembers owning can be out of date (a chest, a pass level, a
      // code since joining): before believing "not owned", ask the account again
      const need = castNeeds(msg, isHost);
      let inv = await this.inventory(me.sub);
      if (need && inv && !inv.abils[need]) { this.invs.delete(me.sub); inv = await this.inventory(me.sub); }
      const v = castCheck(st, msg, Date.now(), inv && inv.abils, isHost);
      if (v) { this.report(me.sub, v); if (v.drop) return; }
    }
    if (d.action === "report") {
      // the host timed a guest's blocks: host word alone never bans (see the Vault)
      const who = this.roster().find(p => p.id === msg.who);
      const blocks = Number(msg.blocks) | 0, perfects = Number(msg.perfects) | 0;
      const v = who && who.sub !== me.sub ? parryVerdict(blocks, perfects) : null;
      if (v) this.report(who.sub, { kind: "autoparry-host", sev: v.sev, by: me.sub,
        detail: "host timed " + Math.round(v.rate * 100) + "% perfect over " + blocks + " blocks" });
      return;
    }
    if (d.action === "update") {
      for (const k in d.fields) if (d.fields[k] !== undefined) me[k] = d.fields[k];
      if (me.sub) {
        let inv = await this.inventory(me.sub);
        const stale = inv && ((me.sword && !ownsSword(inv, me.sword)) || (me.skin && !inv.skins[me.skin]) || (me.abil && !inv.abils[me.abil]));
        // asked again, and noted, at most every few seconds: a flood of loadouts cannot flood the Vault
        const now = Date.now(), fresh = now - (this.invAt.get(me.sub) || 0) > 5000;
        if (stale && fresh) { this.invAt.set(me.sub, now); this.invs.delete(me.sub); inv = await this.inventory(me.sub); }
        if (inv) this.checkLoadout(me, inv, fresh);
      }
      ws.serializeAttachment(me);
      this.pushRoster();
      return;
    }
    // the host's room settings: the directory lists them
    if (msg.t === "setup" && me.id === this.hostId())
      this.announce({ gm: typeof msg.gm === "string" ? msg.gm.slice(0, 16) : "ffa", map: typeof msg.map === "string" ? msg.map.slice(0, 16) : "sky",
        priv: !!msg.priv, playing: false });
    if (d.action === "start")     { await this.startMatch(d.payload); return; }
    if (d.action === "reply")     { ws.send(JSON.stringify(d.payload)); return; }
    if (d.action === "relay") {
      if (SIM_FEED[msg.t] && this.sim && this.sim.running) this.sim.feed(d.payload);
      if (!SIM_PRIVATE[msg.t]) this.broadcast(d.payload, ws);
      return;
    }
    if (d.action === "broadcast") { this.broadcast(d.payload); return; }
  }

  async webSocketClose(ws) { this.left(ws); }
  async webSocketError(ws) { this.left(ws); }
  left(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.spec) { this.liveTell(ws); return; }   // a watcher or a stream: nothing else to tidy
    this.pushRoster(ws);
    if (!this.roster(ws).length) { if (this.sim) this.sim.stop(); this.match = null; this.qStarted = false; }
  }

  /* ---------- the match itself ----------
     The start message every player gets is the one the room's own copy of the
     game starts from, so everyone builds the identical match. */
  async startMatch(p) {
    const players = this.roster();
    if (!players.length) return;
    const meta = (this.ctx.storage && (await this.ctx.storage.get("meta"))) || {};
    // GOD 1v1 only comes from the GOD queue; anything else asking for it plays casual
    if (p.mode === "god1" && !meta.q) p.mode = "mp";
    // a solo room only ever plays the mode it was opened for; nobody else may ask for one
    if (meta.solo) p.mode = meta.solo;
    else if (SOLO_MODES[p.mode] && p.mode !== "boss") p.mode = "mp";
    // Boss Rally is for one to four
    if (p.mode === "boss" && players.length > BOSS_MAX) {
      this.broadcast({ t: "notice", text: "Boss Rally is for up to " + BOSS_MAX + " players. This room has " + players.length + "." });
      return;
    }
    const lead = players.find(x => x.id === electHost(players)) || players[0];
    if (p.mode === "ranked2" || p.mode === "sranked1" || p.mode === "sranked2") {
      // the bots are tuned from the leader's real rank, fetched fresh (a rematch comes after the last match paid)
      if (lead.sub) { const a = await this.account(lead.sub); if (a) lead.rp = a.rp | 0; }
      let idx = 0; for (let i = 0; i < CAT.ranks.length; i++) if ((lead.rp | 0) >= CAT.ranks[i].rp) idx = i;
      p.rf = +(idx / Math.max(1, CAT.ranks.length - 1)).toFixed(4);
      // solo ranked plays the arena of your rank, as it always has
      if (p.mode !== "ranked2") p.map = (CAT.ranks[idx] && CAT.ranks[idx].map) || "sky";
      p.bots = 0;
    }
    if (p.mode === "boss") { p.map = "sky"; p.bots = 0; p.gm = "boss"; }
    if (!this.sim) this.sim = new SimHost(o => this.fromSim(o));
    else if (this.sim.running) this.sim.stop();
    if (p.map === "random") p.map = this.sim.maps[Math.floor(Math.random() * this.sim.maps.length)] || "sky";
    this.match = { id: crypto.randomUUID(), at: Date.now(), mode: SETTLE_MODE[p.mode] || "mp",
      players: players.map(x => ({ id: x.id, sub: x.sub })) };
    p.mid = this.match.id;
    this.casts = new WeakMap();                       // a new match: cooldowns start over
    try { const fl = await dirCall(this.env, { op: "abiloff" }); p.off = (fl && Array.isArray(fl.off)) ? fl.off : []; } catch (e) { p.off = []; }
    this.broadcast(p);
    this.startMsg = p;
    this.sim.start(p, buildRoster(players));
    this.announce({ playing: true });
  }
  fromSim(o) {
    if (!o || typeof o.t !== "string") return;
    // for one player only: the server correcting where they are
    if (o.t === "corr" && typeof o.to === "string") { this.sendTo(o.to, o); return; }
    // the movement check noted a run of impossible moves: a flag for the admin, never a ban
    if (o.t === "mvflag") {
      const who = this.roster().find(p => p.id === o.who);
      if (who && who.sub) this.report(who.sub, { kind: "movement", sev: "flag", by: "room", detail: String(o.detail || "").slice(0, 200) });
      return;
    }
    if (SIM_OUT[o.t]) { this.broadcast(Object.assign({}, o, { from: SIM_ID })); return; }
    if (o.t === "roundover") { this.matchOver(o); return; }
    if (o.t === "acrep") {
      // the room timed every player's blocks against its own ball
      const who = this.roster().find(p => p.id === o.who);
      const v = who ? parryVerdict(Number(o.blocks) | 0, Number(o.perfects) | 0) : null;
      if (v) this.report(who.sub, { kind: "autoparry-host", sev: v.sev, by: "room",
        detail: "the room timed " + Math.round(v.rate * 100) + "% perfect over " + (o.blocks | 0) + " blocks" });
      // and how evenly: the room saw every press against its own ball. One match is
      // too few to judge, so it goes to the account, which judges the last several
      if (who && who.sub && (o.tn | 0) > 0 && this.env && this.env.VAULT) {
        const p = toVault(this.env, who.sub, { op: "tim", sub: who.sub, n: o.tn | 0, mean: Number(o.tmean), sd: Number(o.tsd) }).catch(() => {});
        if (this.ctx && this.ctx.waitUntil) this.ctx.waitUntil(p);
      }
    }
    // anything else the game says (its own loadout, pings, lobby setup) is for nobody
  }
  /* The match is over. Before anyone is told, each account's record of it is
     written to this room's own storage, then delivered to the account. A
     delivery that fails or times out stays here and is tried again (alarm),
     through restarts, until the account has it; the account pays each match id
     once however many times it arrives. Until then the player's result is
     "pending" -- never a loss. */
  async matchOver(o) {
    const M = this.match; this.match = null;
    const mid = M ? M.id : "";
    if (M && this.env && this.env.VAULT) {
      let fighters = [];
      try { fighters = this.sim.state().fighters || []; } catch (e) {}
      const fOf = id => fighters.find(x => x.netId === id) || null;
      let boss = null;
      try { boss = this.sim.g.bossInfo ? this.sim.g.bossInfo() : null; } catch (e) {}
      const secs = Math.round((Date.now() - M.at) / 1000);
      const recs = M.players.filter(p => p.sub).map(p => {
        const f = fOf(p.id);
        const won = M.mode === "boss" ? !!(boss && boss.victory)
          : (typeof o.tm === "number" && o.tm >= 0) ? !!f && f.team === o.tm : o.w === p.id;
        const t = { id: mid, mode: M.mode, won, secs,
          coins: f ? (f.runC | 0) : 0, dfl: f ? (f.deflects | 0) : 0, pf: f ? (f.perfects | 0) : 0, kos: f ? (f.kos | 0) : 0,
          tb: f ? (f.tBlocks | 0) : 0, tp: f ? (f.tPerfects | 0) : 0 };
        if (boss) t.boss = { dealt: boss.dealt | 0, total: boss.total | 0, victory: !!boss.victory };
        return { sub: p.sub, t, tries: 0, next: 0, at: Date.now() };
      });
      if (this.ctx.storage) {
        const put = {}; for (const r of recs) put["settle:" + mid + ":" + r.sub] = r;
        if (recs.length) await this.ctx.storage.put(put);
      }
      // try now, briefly: most land before anyone is told
      await Promise.race([this.deliverAll(), new Promise(r => setTimeout(r, 2500))]);
      if (this.ctx.storage && this.ctx.storage.setAlarm) {
        const left = await this.ctx.storage.list({ prefix: "settle:" });
        if (left.size) await this.ctx.storage.setAlarm(Date.now() + 5000);
      }
    }
    this.broadcast(Object.assign({}, o, { mid, from: SIM_ID }));
    this.qStarted = false;
    this.announce({ playing: false });
  }
  // every settlement still waiting here, sent again; a success is forgotten, a failure backs off
  async deliverAll() {
    if (!this.ctx.storage || !this.env || !this.env.VAULT) return 0;
    const now = Date.now(), all = await this.ctx.storage.list({ prefix: "settle:" });
    let left = 0;
    for (const [key, r] of all) {
      if (r.next > now) { left++; continue; }
      let ok = false;
      try {
        const res = await toVault(this.env, r.sub, { op: "settle", sub: r.sub, ticket: r.t });
        ok = res.status === 200 || res.status === 400;          // 400: a record the account cannot use -- retrying will not help
      } catch (e) { ok = false; }
      if (ok) { await this.ctx.storage.delete(key); continue; }
      r.tries++;
      // a week of trying, then it is written off (and seen on the admin page as a missing match)
      if (now - r.at > SETTLE_GIVEUP_MS) { await this.ctx.storage.delete(key); continue; }
      r.next = now + Math.min(10 * 60 * 1000, 2000 * Math.pow(2, Math.min(r.tries, 9)));
      await this.ctx.storage.put(key, r);
      left++;
    }
    return left;
  }
  async alarm() {
    const left = await this.deliverAll();
    if (left && this.ctx.storage) {
      let soonest = Infinity;
      for (const [, r] of await this.ctx.storage.list({ prefix: "settle:" })) soonest = Math.min(soonest, r.next || 0);
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, isFinite(soonest) ? soonest : Date.now() + 60000));
    }
  }
  // what an account owns and its RP, asked fresh
  async account(sub) {
    try {
      const r = await toVault(this.env, sub, { op: "acct", sub });
      const j = await r.json();
      if (j && j.inv) { this.invs.set(sub, j.inv); return j; }
    } catch (e) {}
    return null;
  }
}

/* ---------- Cloud saves, tied to a Google account ----------
   The game signs in with Google and sends us the ID token Google gave it. We
   check that token really came from Google, for THIS game, and has not
   expired, then keep that player's save in their own Vault (one Durable
   Object per Google account). We store Google's account number and the save
   -- never an email, a name or a picture. After sign-in the game holds a
   session token of ours, so it does not have to go back to Google each time. */

const SAVE_MAX_BYTES = 64 * 1024;
const SESSION_MS = 60 * 24 * 3600 * 1000;      // 60 days
const SESSIONS_KEPT = 8;                        // devices signed in at once
const WRITE_GAP_MS = 4000;                      // no account saves more often than this
const SYNC_GAP_MS = 800;                        // changes can come faster: they are small
const OPS_KEPT = 1000;                          // change ids remembered, so a resend is never counted twice
const OPS_PER_SYNC = 60;
// earlier versions of every save, so a bad day can be undone: a copy at most
// every HIST_GAP_MS, the last HIST_KEPT kept, each under its own key
const HIST_GAP_MS = 10 * 60 * 1000;
const HIST_KEPT = 30;
// online match results, written by the room that ran the match (see Room.matchOver)
const TICKET_MS = 2 * 3600 * 1000;
const TICKETS_KEPT = 12;

/* ---- redeem codes ----
   They live here, not in the game: the page is readable by anyone, this is
   not. And they are the owner's alone: a code pays out only to a signed-in
   account listed in OWNER_ACCOUNTS (wrangler.toml). To anyone else, signed
   in or not, a real code looks exactly like a wrong one. */
const CODES = {
  "5559": "all",
  "freeblade": "threeblades",
  "pocketchange": "coins5000",
  "santiballs": "stdslash",
  "666": "bloodrift",
  "finnballs": "cruz"
};
// guessing is slow: this many tries a minute from any one address
const REDEEM_TRIES = 8;
const REDEEM_WINDOW_MS = 60 * 1000;
// the accounts codes work for: OWNER_ACCOUNTS = "1234567890,..." (Google account numbers)
export function isOwner(env, sub) {
  return String((env && env.OWNER_ACCOUNTS) || "").split(",").map(x => x.trim()).filter(Boolean).includes(sub);
}
// one person's IPv6 connection hands out a whole /64 of addresses: limits count per /64
export function ipKey(ip) {
  ip = String(ip || "local").toLowerCase().split("%")[0];
  if (ip.indexOf(":") < 0) return ip;
  // expand "::" first, or two addresses in one /64 can be written with different leading groups
  let [head, tail] = ip.indexOf("::") >= 0 ? ip.split("::") : [ip, null];
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = tail === null ? h : h.concat(Array(Math.max(0, 8 - h.length - t.length)).fill("0"), t);
  return full.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}
export async function handleRedeem(request, env) {
  if (request.method !== "POST") return jsonRes({ error: "POST only" }, 405);
  let body;
  try { body = await readJson(request); } catch (e) { return jsonRes({ error: "bad request" }, 400); }
  const code = String(body.code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  if (!code) return jsonRes({ error: "no code" }, 400);
  if (env.VAULT) {
    const ip = ipKey(request.headers.get("CF-Connecting-IP"));
    const r = await env.VAULT.get(env.VAULT.idFromName("ip:" + ip))
      .fetch("https://vault/", { method: "POST", body: JSON.stringify({ op: "tick" }) });
    if (r.status === 429) return jsonRes(Object.assign({ error: "too many tries" }, await r.json()), 429);
  }
  // signed in: the account counts the guess (right or wrong), and an owner account gets the reward, once
  const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{48})$/.exec(String(body.token || ""));
  const reward = m && isOwner(env, m[1]) && Object.prototype.hasOwnProperty.call(CODES, code) ? CODES[code] : null;
  if (m && env.VAULT) return toVault(env, m[1], { op: "redeem", sub: m[1], secret: m[2], code, reward });
  return jsonRes({ error: "no such code" }, 404);
}

/* Roblox-style saving: the account's copy on this server IS the save. A game
   never uploads the whole thing; it sends what changed, as a list of
   [path, kind, value]:  "+" add to a number, "max" keep the bigger, "=" set,
   "-" delete. Each batch has an id, and a batch seen before is skipped, so a
   game can resend until it hears back and nothing ever counts twice. The game
   has an exact copy of this function. */
const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);
export function applyChange(save, c) {
  if (!Array.isArray(c) || !Array.isArray(c[0]) || !c[0].length || c[0].length > 5) return false;
  const path = c[0], kind = c[1], val = c[2];
  for (const k of path) if (typeof k !== "string" || !k || k.length > 64 || BAD_KEY.has(k)) return false;
  let o = save;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!o[k] || typeof o[k] !== "object" || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  const k = path[path.length - 1];
  if (kind === "=") o[k] = val === undefined ? null : JSON.parse(JSON.stringify(val));
  else if (kind === "-") delete o[k];
  else if (kind === "+" && typeof val === "number" && isFinite(val)) o[k] = Math.max(0, (typeof o[k] === "number" ? o[k] : 0) + val);
  else if (kind === "max" && typeof val === "number" && isFinite(val)) o[k] = Math.max(typeof o[k] === "number" ? o[k] : 0, val);
  else return false;
  return true;
}

function b64urlBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }

let JWKS = { keys: null, at: 0 };
export function resetGoogleKeys() { JWKS = { keys: null, at: 0 }; }
async function googleKeys(fetcher, force) {
  if (!force && JWKS.keys && Date.now() - JWKS.at < 3600e3) return JWKS.keys;
  const r = await (fetcher || fetch)("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("google keys " + r.status);
  const j = await r.json();
  JWKS = { keys: j.keys || [], at: Date.now() };
  return JWKS.keys;
}

// returns the token's claims if it is a genuine, current Google sign-in for
// this game; throws otherwise
export async function verifyGoogleToken(jwt, clientId, opts) {
  opts = opts || {};
  if (!clientId) throw new Error("no client id configured");
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const head = b64urlJson(parts[0]), claims = b64urlJson(parts[1]);
  if (head.alg !== "RS256") throw new Error("unexpected algorithm");
  let keys = await googleKeys(opts.fetcher, false);
  let jwk = keys.find(k => k.kid === head.kid);
  if (!jwk) { keys = await googleKeys(opts.fetcher, true); jwk = keys.find(k => k.kid === head.kid); }
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!good) throw new Error("bad signature");
  const now = (opts.now || Date.now()) / 1000;
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") throw new Error("wrong issuer");
  if (claims.aud !== clientId) throw new Error("token is for another app");
  if (!(claims.exp > now - 60)) throw new Error("expired");
  if (claims.iat && claims.iat > now + 300) throw new Error("issued in the future");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(claims.sub || ""))) throw new Error("bad account id");
  return claims;
}

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }

// one player's saves and sign-ins
export class Vault {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    let body;
    try { body = await request.json(); } catch (e) { return jsonRes({ error: "bad request" }, 400); }
    // one request at a time: the sign-in check awaits crypto, and without this
    // two saves from two devices could both pass the "is it still revision N"
    // check and the second would silently overwrite the first
    return this.state.blockConcurrencyWhile(() => this.handle(body));
  }
  // the copy that is about to be replaced, kept if the last one is old enough
  async snapshot(rec, now, force) {
    const st = this.state.storage;
    if (!rec) return {};
    const meta = (await st.get("hmeta")) || [];
    const gap = typeof this.env.HIST_GAP_MS === "number" ? this.env.HIST_GAP_MS : HIST_GAP_MS;
    if (!force && meta.length && now - meta[meta.length - 1].kept < gap) return {};
    const slot = meta.length ? (meta[meta.length - 1].slot + 1) % HIST_KEPT : 0;
    let s = {};
    try { s = JSON.parse(rec.data) || {}; } catch (e) {}
    const n = o => Object.keys(o || {}).filter(k => o[k]).length;
    const entry = { slot, kept: now, at: rec.at, rev: rec.rev,
      sum: { coins: s.coins | 0, yen: s.yen | 0, rp: s.rp | 0, games: s.games | 0, items: n(s.swords) + n(s.abils) + n(s.skins),
        pass: s.pass && s.pass.xp ? Math.floor(s.pass.xp / 100) : 0 } };
    const next = meta.filter(m => m.slot !== slot).concat([entry]).slice(-HIST_KEPT);
    return { hmeta: next, ["h" + slot]: { data: rec.data, rev: rec.rev, at: rec.at } };
  }
  /* Something was caught. Flags are kept for the admin page; a "ban" flag bans
     straight away -- except a host's report of a guest's blocks, which never
     bans: a host could make it up, and hosts are free to make. */
  // messages from the admin, handed over once
  async takeInbox() {
    const inbox = (await this.state.storage.get("inbox")) || [];
    if (!inbox.length) return undefined;
    await this.state.storage.put("inbox", []);
    return inbox.map(m => ({ id: m.id, at: m.at, text: m.text, gift: m.gift, demo: m.demo }));
  }
  async flagIn(sub, f, now) {
    if (!f || typeof f !== "object") return null;
    const st = this.state.storage;
    const flag = { at: now, kind: String(f.kind || "?").slice(0, 24), sev: f.sev === "ban" ? "ban" : "flag",
      detail: String(f.detail || "").slice(0, 300) };
    if (f.by) flag.by = String(f.by).slice(0, 64);
    const flags = ((await st.get("flags")) || []).concat([flag]).slice(-50);
    await st.put("flags", flags);
    let ban = (await st.get("ban")) || null, newBan = null;
    // a host's report of a guest's blocks is only ever a flag: accounts are free to make,
    // so any number of "hosts" could be one person trying to get somebody banned
    const doBan = flag.sev === "ban" && flag.kind !== "autoparry-host";
    if (doBan && !ban) {
      ban = newBan = { at: now, why: flag.kind + ": " + flag.detail, auto: true };
      await st.put("ban", ban);
    }
    dirCall(this.env, { op: "flag", sub, flag, ban: newBan || undefined });
    return newBan;
  }
  async handle(body) {
    const st = this.state.storage, now = Date.now();
    let sessions = (await st.get("sessions")) || {};
    for (const h in sessions) if (sessions[h] < now) delete sessions[h];
    let rec = (await st.get("save")) || null;
    // something this account owned was taken out of the game: refund it before anyone reads the save
    if (rec && RETIRED_RE.test(rec.data)) {
      const sv = JSON.parse(rec.data);
      if (retire(sv)) { rec = { data: JSON.stringify(sv), rev: rec.rev + 1, at: now }; await st.put("save", rec); }
    }
    /* A new season: reset the STORED account the first time anything touches
       it, not only the copy a game is shown -- or the save, the admin page, the
       GOD queue and the player list keep last season's RP until the player
       happens to buy something. Last season's RP is kept as s0rp. */
    if (rec) {
      const sv = JSON.parse(rec.data);
      const ok = sv && typeof sv === "object" && !Array.isArray(sv);
      const reset = ok && seasonReset(sv), cleaned = ok && rankClean(sv);     // both run: neither may be skipped
      if (reset || cleaned) {
        rec = { data: JSON.stringify(sv), rev: rec.rev + 1, at: now }; await st.put("save", rec);
        const who = (await st.get("sub")) || body.sub || "";
        if (who) dirCall(this.env, { op: "touch", sub: who, name: sv.netName || "", rp: sv.rp | 0, season: sv.season | 0, ul: ultrasOf(sv) });
      }
    }
    // ec: this server owns the economy, so a game knows to ask rather than write
    const view = () => ({ save: rec ? JSON.parse(rec.data) : null, rev: rec ? rec.rev : 0, at: rec ? rec.at : 0, ec: 1 });

    if (body.op === "login") {                     // the Worker has already checked Google's token
      const secret = randomHex(24);
      sessions[await sha256(secret)] = now + SESSION_MS;
      const keep = Object.entries(sessions).sort((a, b) => b[1] - a[1]).slice(0, SESSIONS_KEPT);
      sessions = Object.fromEntries(keep);
      await st.put("sessions", sessions);
      return jsonRes(Object.assign({ token: body.sub + "." + secret }, view()));
    }
    // one address's redeem tries (this object is "ip:<address>", not an account)
    if (body.op === "tick") {
      const recent = ((await st.get("tries")) || []).filter(t => now - t < REDEEM_WINDOW_MS);
      if (recent.length >= REDEEM_TRIES) return jsonRes({ retry: REDEEM_WINDOW_MS - (now - recent[0]) }, 429);
      recent.push(now);
      await st.put("tries", recent);
      return jsonRes({ ok: true });
    }
    // ---- internal: only ever called by this Worker's own code (see handleCloud's list) ----
    if (body.sub && typeof body.sub === "string" && !(await st.get("sub"))) await st.put("sub", body.sub);
    const sub = (await st.get("sub")) || body.sub || "";
    if (body.op === "inv") {                         // a room checking what this account owns
      const s = ensure(rec ? JSON.parse(rec.data) : {});
      return jsonRes({ inv: { swords: s.swords, abils: s.abils, skins: s.skins } });
    }
    if (body.op === "ticket") {                      // a room writing down how this account's match ended
      const t = body.ticket || {};
      if (typeof t.id !== "string" || typeof t.mode !== "string") return jsonRes({ error: "bad ticket" }, 400);
      const list = ((await st.get("tickets")) || []).filter(x => now - x.at < TICKET_MS && x.id !== t.id);
      list.push({ id: t.id.slice(0, 40), mode: t.mode.slice(0, 16), won: !!t.won, secs: Math.max(0, Math.min(3600, Number(t.secs) || 0)), at: now });
      await st.put("tickets", list.slice(-TICKETS_KEPT));
      return jsonRes({ ok: true });
    }
    /* A room settling a match it ran. Idempotent: the id was made by the room,
       and an id seen before gets its first answer back, paid once. */
    if (body.op === "settle") {
      const t = body.ticket || {};
      if (typeof t.id !== "string" || !t.id || t.id.length > 64 || typeof t.mode !== "string") return jsonRes({ error: "bad record" }, 400);
      const settled = (await st.get("settled")) || [];
      const prev = settledOf(settled, t.id);
      if (prev) return jsonRes({ ok: true, dup: true, res: prev.res });
      const save = ensure(rec ? JSON.parse(rec.data) : {});
      if (!save.econ) save.econ = { v: 1, at: now };
      const stats = (await st.get("stats")) || newStats(now), hist = (await st.get("hist")) || [], ledger = (await st.get("ledger")) || [];
      const pre = snap(save), r = settleMatch(save, t, { now, settled });
      if (!r.ok) return jsonRes({ error: r.why }, 400);
      recordAct(stats, hist, ledger, "match", { mode: t.mode, won: !!t.won, secs: t.secs, blocks: t.tb | 0, perfects: t.tp | 0 }, { ok: true, res: r.res }, pre, snap(save), now);
      settled.push({ id: t.id, mode: t.mode, at: now, res: r.res });
      const flags = watchFlags(stats, hist, now);
      const data = JSON.stringify(save);
      const next = { data, rev: (rec ? rec.rev : 0) + 1, at: now };
      const keep = await this.snapshot(rec, now);
      // the save and the record that it was paid go in one put: both or neither
      await st.put(Object.assign({ save: next, settled: settled.slice(-SETTLE.kept), stats, hist, ledger }, keep));
      rec = next;
      for (const f of flags) await this.flagIn(sub, f, now);
      const sus = suspicion(stats, hist, (await st.get("flags")) || [], now);
      dirCall(this.env, { op: "touch", sub, name: save.netName || "", rp: save.rp | 0, season: save.season | 0, sum: summary(stats, sus), ul: ultrasOf(save) });
      return jsonRes({ ok: true, res: r.res });
    }
    if (body.op === "acct") {                        // a room asking what this account owns and its RP (never from a player)
      const s = ensure(rec ? JSON.parse(rec.data) : {});
      return jsonRes({ inv: { swords: s.swords, abils: s.abils, skins: s.skins }, rp: s.rp | 0, name: s.netName || "" });
    }
    if (body.op === "tim") {                         // a room timed this player's blocks (never from a player)
      const stats = (await st.get("stats")) || newStats(now);
      if (!stats.wf) stats.wf = {};
      timingAdd(stats, body.n, body.mean, body.sd);
      const tp = timingPooled(stats), tv = timingVerdict(tp.n, tp.sd, tp.mean);
      let b = null;
      if (tv && !(stats.wf.tim && now - stats.wf.tim < 86400000)) {
        stats.wf.tim = now;
        b = await this.flagIn(sub, { kind: "timing-room", sev: "flag", by: "room", detail: "the room measured " + tv.detail + ", over the last " + stats.tim.length + " online matches" }, now);
      }
      await st.put("stats", stats);
      return jsonRes({ ok: true, flagged: !!tv, banned: !!b });
    }
    if (body.op === "flag") {                        // a room caught something
      const b = await this.flagIn(sub, body.flag, now);
      return jsonRes({ ok: true, banned: !!b, why: b ? b.why : "" });
    }
    // the recount: tell the directory exactly which ULTRAs this account holds
    if (body.op === "adm_ultras") {
      const ul = rec ? ultrasOf(JSON.parse(rec.data)) : [];
      await dirCall(this.env, { op: "touch", sub, ul });
      return jsonRes({ ok: true, ul });
    }
    if (body.op === "adm_get") {
      const stats = (await st.get("stats")) || null, hist = (await st.get("hist")) || [], flags = (await st.get("flags")) || [];
      return jsonRes({ sub, save: rec ? JSON.parse(rec.data) : null, rev: rec ? rec.rev : 0, at: rec ? rec.at : 0,
        ban: (await st.get("ban")) || null, flags, stats, hist, ledger: (await st.get("ledger")) || [],
        sus: suspicion(stats, hist, flags, now), inbox: (await st.get("inbox")) || [], sent: (await st.get("sent")) || [] });
    }
    if (body.op === "adm_msg") {
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) return jsonRes({ error: "empty message" }, 400);
      const m = { id: randomHex(6), at: now, text };
      // live if they are in a room (the Worker tried that first); otherwise the next time the game talks to us
      if (!body.live) await st.put("inbox", ((await st.get("inbox")) || []).concat([m]).slice(-20));
      await st.put("sent", ((await st.get("sent")) || []).concat([Object.assign({ live: !!body.live }, m)]).slice(-30));
      return jsonRes({ ok: true });
    }
    // play a screen on their game to see it (the Apex unlock): it grants nothing, whatever their rank
    if (body.op === "adm_demo") {
      if (body.demo !== "apex") return jsonRes({ error: "unknown demo" }, 400);
      const m = { id: randomHex(6), at: now, text: "", demo: "apex" };
      await st.put("inbox", ((await st.get("inbox")) || []).concat([m]).slice(-20));
      return jsonRes({ ok: true });
    }
    if (body.op === "adm_edit") {
      const save = ensure(rec ? JSON.parse(rec.data) : {});
      if (!save.econ) save.econ = { v: 1, at: now };
      const done = [], pre = snap(save), gift = { items: [], coins: 0, yen: 0, spins: 0 };
      for (const e of (Array.isArray(body.edits) ? body.edits : []).slice(0, 200)) {
        if (!e || typeof e !== "object") continue;
        const bag = { sword: "swords", abil: "abils", skin: "skins" }[e.tab];
        if (e.k === "set" && ["coins", "yen", "rp", "freeSpins"].includes(e.key) && typeof e.v === "number" && isFinite(e.v) && e.v >= 0) {
          const was = save[e.key] | 0;
          save[e.key] = Math.floor(e.v); done.push(e.key + "=" + save[e.key]);
          const up = save[e.key] - was, gk = { coins: "coins", yen: "yen", freeSpins: "spins" }[e.key];
          if (gk && up > 0) gift[gk] += up;
        } else if (e.tab === "emote" && (e.k === "add" || e.k === "del")) {
          const em = (CAT.emotes || []).find(x => x.id === e.id && !x.base);
          if (em && e.k === "add") { if (!save.emotes[e.id]) gift.items.push({ tab: "emote", id: e.id }); save.emotes[e.id] = 1; done.push("+emote:" + e.id); }
          else if (em && save.emotes[e.id]) { delete save.emotes[e.id]; done.push("-emote:" + e.id); }
        } else if (e.k === "add" && bag && itemOf(e.tab, e.id)) {
          if (!save[bag][e.id]) gift.items.push({ tab: e.tab, id: e.id });
          save[bag][e.id] = 1; done.push("+" + e.id);
        }
        else if (e.k === "del" && bag && save[bag][e.id]) {
          delete save[bag][e.id]; done.push("-" + e.id);
          const eq = { sword: "eqSword", abil: "eqAbil", skin: "eqSkin" }[e.tab];
          if (save[eq] === e.id) save[eq] = CAT.items[e.tab].starter;
        }
      }
      ensure(save);
      const next = { data: JSON.stringify(save), rev: (rec ? rec.rev : 0) + 1, at: now };
      const keep = await this.snapshot(rec, now, true);   // an admin edit can always be undone
      const stats = (await st.get("stats")) || newStats(now), hist = (await st.get("hist")) || [], ledger = (await st.get("ledger")) || [];
      recordAct(stats, hist, ledger, "admin", {}, null, pre, snap(save), now);
      // a gift pops up in their game: what they got, and the note if there is one
      const put = { save: next, stats, ledger };
      if (!body.silent && (gift.items.length || gift.coins || gift.yen || gift.spins)) {
        const note = String(body.note || "").trim().slice(0, 300);
        put.inbox = ((await st.get("inbox")) || []).concat([{ id: randomHex(6), at: now, text: note, gift: gift.items.length ? gift : Object.assign(gift, { items: [] }) }]).slice(-20);
      }
      await st.put(Object.assign(put, keep));
      dirCall(this.env, { op: "touch", sub, name: save.netName || "", rp: save.rp | 0, season: save.season | 0, ul: ultrasOf(save) });
      const flags = (await st.get("flags")) || [];
      flags.push({ at: now, kind: "admin", sev: "note", detail: "admin edit: " + done.join(" ").slice(0, 300) });
      await st.put("flags", flags.slice(-50));
      return jsonRes({ ok: true, done, save, rev: next.rev });
    }
    if (body.op === "adm_ban") {
      const b = { at: now, why: String(body.why || "banned by admin").slice(0, 200), auto: false };
      await st.put("ban", b);
      dirCall(this.env, { op: "ban", sub, ban: b });
      return jsonRes({ ok: true, ban: b });
    }
    if (body.op === "adm_unban") {
      await st.delete("ban");
      await st.put("clearedAt", now);                  // what came before the unban no longer counts toward another
      dirCall(this.env, { op: "ban", sub, ban: null });
      return jsonRes({ ok: true });
    }

    // one address's wrong admin passwords (this object is "adm:<address>")
    if (body.op === "atick") {
      const fails = ((await st.get("afails")) || []).filter(t => now - t < ADMIN_WINDOW_MS);
      if (fails.length >= ADMIN_TRIES) return jsonRes({ retry: ADMIN_WINDOW_MS - (now - fails[0]) }, 429);
      if (body.fail) { fails.push(now); await st.put("afails", fails); }
      return jsonRes({ ok: true });
    }
    const h = await sha256(String(body.secret || ""));
    if (!sessions[h]) return jsonRes({ error: "signed out" }, 401);
    // a banned account can still see why, and sign out -- nothing else
    const ban = await st.get("ban");
    if (ban && body.op !== "logout") return jsonRes({ error: "banned", why: ban.why, at: ban.at }, 403);
    if (body.op === "whoami") {                      // a room checking who is joining
      const s = ensure(rec ? JSON.parse(rec.data) : {});
      return jsonRes({ ok: true, name: s.netName || "", rp: s.rp | 0, inv: { swords: s.swords, abils: s.abils, skins: s.skins } });
    }
    // the player directory hears about this account now and then, never every save
    const dirAt = (await st.get("dirAt")) || 0;
    if (now - dirAt > DIR_TOUCH_MS) {
      await st.put("dirAt", now);
      let nm = "", rp, season, ul; try { const sv = rec ? JSON.parse(rec.data) : {}; nm = sv.netName || ""; rp = sv.rp | 0; season = sv.season | 0; ul = ultrasOf(sv); } catch (e) {}
      dirCall(this.env, { op: "touch", sub, name: nm, rp, season, ul });
    }

    // The Crown belongs to whoever is #1 on the leaderboard right now, and to nobody else
    if (rec && (body.op === "load" || body.op === "act" || body.op === "sync")) {
      const t = await dirCall(this.env, { op: "top1" });
      if (t && typeof t.sub === "string") {
        const sv = JSON.parse(rec.data);
        if (crownFix(sv, sub, t.sub)) { rec = { data: JSON.stringify(sv), rev: rec.rev + 1, at: now }; await st.put("save", rec); }
      }
    }
    if (body.op === "redeem") {
      // a signed-in account guessing codes: its own limit, wherever it connects from
      const tries = ((await st.get("rtries")) || []).filter(t => now - t < REDEEM_WINDOW_MS);
      if (tries.length >= REDEEM_TRIES) return jsonRes({ error: "too many tries", retry: REDEEM_WINDOW_MS - (now - tries[0]) }, 429);
      await st.put("rtries", tries.concat([now]));
      if (!body.reward) return jsonRes({ error: "no such code" }, 404);
    }
    if (body.op === "act" || body.op === "redeem") {
      // no more than this many acts in ten seconds: a person clicking, not a script
      const recent = ((await st.get("actT")) || []).filter(t => now - t < 10000);
      if (recent.length >= ACTS_PER_10S) return jsonRes({ error: "slow down", retry: 10000 - (now - recent[0]) }, 429);
      recent.push(now);
      const save = rec ? JSON.parse(rec.data) : {};
      delete save.pids;
      const flags = [];
      if (!save.econ) importEcon(save, body.imp, now, flags);
      const bj = (await st.get("bj")) || {};
      const tickets = ((await st.get("tickets")) || []).filter(x => now - x.at < TICKET_MS);
      const settled = (await st.get("settled")) || [];
      const res = [];
      // the watch: counts, match history and a ledger of every change (see econ.js)
      const stats = (await st.get("stats")) || newStats(now), hist = (await st.get("hist")) || [], ledger = (await st.get("ledger")) || [];
      ensure(save);
      if (body.op === "redeem") {
        const code = String(body.code || "");
        const pre = snap(save);
        if (save.redeemed[code]) res.push({ ok: false, already: true });
        else { const msg = codeReward(save, body.reward, Math.random); save.redeemed[code] = 1; res.push({ ok: !!msg, msg }); }
        recordAct(stats, hist, ledger, "code", {}, res[0], pre, snap(save), now);
      } else {
        const seen = (await st.get("opids")) || [];
        for (const a of (Array.isArray(body.acts) ? body.acts : []).slice(0, 5)) {
          // an act sent again after its answer was lost is not paid twice
          if (a && typeof a.id === "string" && a.id.length <= 32 && seen.indexOf(a.id) >= 0) { res.push({ ok: true, dup: true }); continue; }
          // the kill switches, asked again at most once a minute
          if (a && a.k === "chest" && !(now - (this.offAt || 0) < 60000)) { const fl = await dirCall(this.env, { op: "abiloff" }); setAbilOff(fl ? fl.off : ["guardian"]); this.offAt = now; }
          const pre = snap(save), r = applyAct(save, a, { now, rnd: Math.random, bj, flags, tickets, settled });
          res.push(r);
          recordAct(stats, hist, ledger, a && typeof a.k === "string" ? a.k.slice(0, 12) : "?", a || {}, r, pre, snap(save), now);
          if (a && typeof a.id === "string" && a.id.length <= 32) seen.push(a.id);
        }
        await st.put("opids", seen.slice(-OPS_KEPT));
      }
      for (const f of watchFlags(stats, hist, now)) flags.push(f);
      // the directory (leaderboard, admin list) hears the new totals now, and
      // before the save is written: a win that takes you to #1 hands you the
      // Crown in this same answer, not whenever you next happen to play
      // ponytail: one directory write per act; batch them if the player count ever makes that object busy
      const sus = suspicion(stats, hist, (await st.get("flags")) || [], now);
      await dirCall(this.env, { op: "touch", sub, name: save.netName || "", rp: save.rp | 0, season: save.season | 0, sum: summary(stats, sus), ul: ultrasOf(save) });
      const top = await dirCall(this.env, { op: "top1" });
      if (top && typeof top.sub === "string") crownFix(save, sub, top.sub);
      const data = JSON.stringify(save);
      if (data.length > SAVE_MAX_BYTES) return jsonRes({ error: "save too big" }, 413);
      const next = { data, rev: (rec ? rec.rev : 0) + 1, at: now };
      const keep = await this.snapshot(rec, now);
      await st.put(Object.assign({ save: next, bj, actT: recent, stats, hist, ledger, tickets }, keep));
      let banned = null;
      for (const f of flags) banned = (await this.flagIn(sub, f, now)) || banned;
      return jsonRes({ save, rev: next.rev, at: now, res, ec: 1, banned: banned ? banned.why : undefined, inbox: await this.takeInbox() });
    }

    if (body.op === "load") return jsonRes(Object.assign(view(), { inbox: await this.takeInbox() }));
    // what the server paid for a match it ran: never pays anything itself
    if (body.op === "matchres") {
      const one = settledOf((await st.get("settled")) || [], String(body.mid || "").slice(0, 64));
      return jsonRes(Object.assign(view(), one ? { mid: one.id, mode: one.mode, res: one.res } : { mid: String(body.mid || "").slice(0, 64), pending: true }));
    }
    if (body.op === "sync") {
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (ops.length > OPS_PER_SYNC) return jsonRes({ error: "too many changes at once" }, 400);
      const seen = (await st.get("opids")) || [];
      const fresh = ops.filter(o => o && typeof o.id === "string" && o.id.length <= 32 && Array.isArray(o.d) && seen.indexOf(o.id) < 0);
      const done = ops.filter(o => o && typeof o.id === "string" && seen.indexOf(o.id) >= 0).map(o => o.id);
      if (fresh.length) {
        const gap = typeof this.env.SYNC_GAP_MS === "number" ? this.env.SYNC_GAP_MS : SYNC_GAP_MS;
        if (rec && now - rec.at < gap) return jsonRes(Object.assign({ retry: gap - (now - rec.at), done }, view()), 429);
        const save = rec ? JSON.parse(rec.data) : {};
        delete save.pids;
        const tamper = [];
        for (const o of fresh) {
          for (const c of o.d) {
            // coins, items and the rest are the server's: a game cannot write them
            // (a batch marked e was made by a game that knows this; one made before the
            // update may still carry coins from the old way, and is simply ignored)
            if (Array.isArray(c) && Array.isArray(c[0]) && ECON_KEYS.includes(c[0][0])) { if (o.e) tamper.push(c); continue; }
            applyChange(save, c);
          }
          seen.push(o.id); done.push(o.id);
        }
        // a game that knows the rules never sends these; one that does was edited
        if (tamper.length) {
          const t = tamperVerdict(tamper);
          if (t) await this.flagIn(sub, t, now);
        }
        const data = JSON.stringify(save);
        if (data.length > SAVE_MAX_BYTES) return jsonRes({ error: "save too big" }, 413);
        const next = { data, rev: (rec ? rec.rev : 0) + 1, at: now };
        const keep = await this.snapshot(rec, now);
        // one put of several keys: Cloudflare commits them together or not at all
        await st.put(Object.assign({ save: next, opids: seen.slice(-OPS_KEPT) }, keep));
        return jsonRes({ save, rev: next.rev, at: now, done, ec: 1, inbox: await this.takeInbox() });
      }
      return jsonRes(Object.assign({ done, inbox: await this.takeInbox() }, view()));
    }
    if (body.op === "history") {
      const meta = (await st.get("hmeta")) || [];
      return jsonRes({ list: meta.map(m => ({ at: m.at, kept: m.kept, rev: m.rev, sum: m.sum })).reverse() });
    }
    if (body.op === "restore") {
      const meta = (await st.get("hmeta")) || [];
      const m = meta.find(x => x.kept === body.kept);
      const snap = m && (await st.get("h" + m.slot));
      if (!snap) return jsonRes({ error: "no such save" }, 404);
      // what is there now is kept too, so a restore can itself be undone
      const keep = await this.snapshot(rec, now, true);
      // the economy is never rolled back by a player: spend, restore, spend again
      const old = JSON.parse(snap.data || "{}"), cur = rec ? JSON.parse(rec.data) : {};
      for (const k of ECON_KEYS) { if (k in cur) old[k] = cur[k]; else delete old[k]; }
      const next = { data: JSON.stringify(old), rev: (rec ? rec.rev : 0) + 1, at: now };
      await st.put(Object.assign({ save: next }, keep));
      return jsonRes({ save: JSON.parse(next.data), rev: next.rev, at: now });
    }
    if (body.op === "logout") { delete sessions[h]; await st.put("sessions", sessions); return jsonRes({ ok: true }); }
    if (body.op === "save") {
      if (!body.save || typeof body.save !== "object") return jsonRes({ error: "no save" }, 400);
      // an old game uploading everything: take all of it but the economy
      const cur = rec ? JSON.parse(rec.data) : {};
      for (const k of ECON_KEYS) { if (k in cur) body.save[k] = cur[k]; else delete body.save[k]; }
      const data = JSON.stringify(body.save);
      if (data.length > SAVE_MAX_BYTES) return jsonRes({ error: "save too big" }, 413);
      const rev = rec ? rec.rev : 0;
      // somebody saved from another device since this one last heard: hand
      // back what is there, and let the game decide
      if ((body.base | 0) !== rev) return jsonRes(Object.assign({ conflict: true }, view()));
      const gap = typeof this.env.WRITE_GAP_MS === "number" ? this.env.WRITE_GAP_MS : WRITE_GAP_MS;
      if (rec && now - rec.at < gap) return jsonRes({ retry: gap - (now - rec.at), rev }, 429);
      const keep = await this.snapshot(rec, now);
      await st.put(Object.assign({ save: { data, rev: rev + 1, at: now } }, keep));
      return jsonRes({ rev: rev + 1, at: now });
    }
    return jsonRes({ error: "unknown op" }, 400);
  }
}

const DIR_TOUCH_MS = 5 * 60 * 1000;
/* The Crown: held by the account at #1, taken back from anyone who is not.
   Returns whether the save changed. */
export function crownFix(save, sub, top1) {
  if (!save || typeof save !== "object") return false;
  if (!save.swords || typeof save.swords !== "object") save.swords = {};
  const mine = !!sub && sub === top1, has = !!save.swords.crown;
  if (mine && !has) { save.swords.crown = 1; return true; }
  if (!mine && has) {
    delete save.swords.crown;
    if (save.eqSword === "crown") save.eqSword = CAT.items.sword.starter;
    return true;
  }
  return false;
}
const ACTS_PER_10S = 40;
/* What an edited game tried to write. Items nobody can have, or a pile of
   coins out of nowhere, is a ban; the rest is a flag to look at. */
export function tamperVerdict(ops) {
  const bad = [], big = [];
  for (const c of ops) {
    const p = c[0], kind = c[1], v = c[2];
    const tab = { swords: "sword", abils: "abil", skins: "skin" }[p[0]];
    if (tab && p.length === 2 && kind === "=" && v) {
      const it = itemOf(tab, p[1]);
      if (it && (it.ultra || it.rank === "dev" || (it.r === "unreleased" || it.r === "secret") || it.code)) bad.push(p[1]);
      else big.push("+" + p[1]);
    } else if ((p[0] === "coins" || p[0] === "yen" || p[0] === "rp") && kind === "+" && typeof v === "number" && v > 0) {
      if (v > 100000) bad.push(p[0] + " +" + v); else big.push(p[0] + " +" + v);
    } else if (kind === "=" && (p[0] === "coins" || p[0] === "yen" || p[0] === "rp")) big.push(p[0] + "=" + v);
  }
  if (bad.length) return { kind: "tamper", sev: "ban", detail: "tried to give itself " + bad.join(", ").slice(0, 200) };
  if (big.length) return { kind: "tamper", sev: "flag", detail: "tried to write " + big.join(", ").slice(0, 200) };
  return null;
}
// the player directory: fire and forget, and a server without one carries on
function dirCall(env, payload) {
  if (!env || !env.DIR) return Promise.resolve(null);
  try {
    return env.DIR.get(env.DIR.idFromName("dir")).fetch("https://dir/", { method: "POST", body: JSON.stringify(payload) })
      .then(r => r.json()).catch(() => null);
  } catch (e) { return Promise.resolve(null); }
}

function jsonRes(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors()) });
}
// the game sends plain text so the browser never needs a preflight, and so a
// last save can go out with keepalive as the tab closes
async function readJson(request) {
  const t = await request.text();
  if (t.length > SAVE_MAX_BYTES + 4096) throw new Error("too big");
  return JSON.parse(t);
}
function vaultFor(env, sub) { return env.VAULT.get(env.VAULT.idFromName("g:" + sub)); }
function toVault(env, sub, payload) {
  return vaultFor(env, sub).fetch("https://vault/", { method: "POST", body: JSON.stringify(payload) });
}

/* The RP leaderboard, for anyone: in-game names and RP, never an account
   number. A signed-in game sends its token and is told which row is its own
   (and where it stands if it is not in the top ten). */
export async function handleLeaderboard(request, env) {
  if (!env.DIR) return jsonRes({ top: [], me: null, total: 0 });
  let body = {};
  if (request.method === "POST") { try { body = await readJson(request); } catch (e) { body = {}; } }
  const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{48})$/.exec(String(body.token || ""));
  // only a real session of that account is told where it stands
  let me = "";
  if (m) { try { const r = await toVault(env, m[1], { op: "whoami", sub: m[1], secret: m[2] }); if (r.status === 200) me = m[1]; } catch (e) {} }
  const j = (await dirCall(env, { op: "top", sub: me })) || { top: [], me: null, total: 0 };
  return jsonRes({ top: (j.top || []).map((x, i) => ({ pos: i + 1, name: x.name, rp: x.rp, you: !!me && x.sub === me })),
    me: j.me || null, total: j.total | 0 });
}

/* The GOD queue. Only a real session of an account that is GOD this season
   gets in; the directory does the pairing. */
export async function handleQueue(request, env) {
  if (request.method !== "POST") return jsonRes({ error: "POST only" }, 405);
  let body; try { body = await readJson(request); } catch (e) { return jsonRes({ error: "bad request" }, 400); }
  const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{48})$/.exec(String(body.token || ""));
  if (!m || !env.VAULT) return jsonRes({ error: "signed out" }, 401);
  const r = await toVault(env, m[1], { op: "whoami", sub: m[1], secret: m[2] });
  if (r.status !== 200) return jsonRes({ error: "signed out" }, 401);
  const j = await r.json();
  const god = CAT.ranks.findIndex(x => x.pvp);
  if (!body.leave && !(god >= 0 && (j.rp | 0) >= CAT.ranks[god].rp)) return jsonRes({ error: "not god" }, 403);
  return jsonRes((await dirCall(env, { op: "queue", sub: m[1], leave: !!body.leave })) || { error: "unavailable" });
}
/* The social socket: only a real session of the account gets its Hub, and
   the Hub is told who it is by the Worker, never by the game. */
export async function handleSocial(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") return jsonRes({ error: "expected websocket" }, 426);
  if (!env.HUB || !env.VAULT) return jsonRes({ error: "social is not set up on this server" }, 503);
  const url = new URL(request.url);
  const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{48})$/.exec(String(url.searchParams.get("tok") || ""));
  let ok = false;
  if (m) { try { const r = await toVault(env, m[1], { op: "whoami", sub: m[1], secret: m[2] }); ok = r.status === 200; } catch (e) {} }
  if (!ok) return jsonRes({ error: "signed out" }, 401);
  const to = new URL("https://hub/ws");
  to.searchParams.set("sub", m[1]);
  to.searchParams.set("name", (url.searchParams.get("name") || "").slice(0, 14));
  return env.HUB.get(env.HUB.idFromName("h:" + m[1])).fetch(new Request(to.toString(), { headers: { Upgrade: "websocket" } }));
}
export async function handleCloud(request, env, path, opts) {
  if (request.method !== "POST") return jsonRes({ error: "POST only" }, 405);
  if (!env.VAULT) return jsonRes({ error: "cloud saves are not set up on this server" }, 503);
  let body;
  try { body = await readJson(request); } catch (e) { return jsonRes({ error: "bad request" }, 400); }
  if (path === "/auth/google") {
    let claims;
    try { claims = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID, opts); }
    catch (e) { return jsonRes({ error: "sign-in rejected: " + e.message }, 401); }
    return toVault(env, claims.sub, { op: "login", sub: claims.sub });
  }
  // /cloud: { token: "<account>.<secret>", op, save?, base? }
  const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{48})$/.exec(String(body.token || ""));
  if (!m) return jsonRes({ error: "signed out" }, 401);
  if (!["load", "save", "sync", "logout", "history", "restore", "act", "matchres"].includes(body.op)) return jsonRes({ error: "unknown op" }, 400);
  return toVault(env, m[1], { op: body.op, sub: m[1], secret: m[2], save: body.save, base: body.base, ops: body.ops, kept: body.kept,
    acts: body.acts, imp: body.imp, mid: typeof body.mid === "string" ? body.mid.slice(0, 64) : undefined });
}

/* ---------- Worker ---------- */

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (url.pathname === "/health")
      return new Response("ok " + SERVER_VERSION, { headers: cors() });
    if (url.pathname === "/auth/google" || url.pathname === "/cloud")
      return handleCloud(request, env, url.pathname);
    if (url.pathname === "/redeem") return handleRedeem(request, env);
    if (url.pathname === "/leaderboard") return handleLeaderboard(request, env);
    if (url.pathname === "/lobbies") return jsonRes((await dirCall(env, { op: "lobbies" })) || { lobbies: [] });
    // which abilities are switched off right now: every game asks
    if (url.pathname === "/flags") return jsonRes((await dirCall(env, { op: "abiloff" })) || { off: [] });
    // how many players own each ULTRA
    if (url.pathname === "/owners") return jsonRes((await dirCall(env, { op: "owners" })) || { owners: {} });
    if (url.pathname === "/queue") return handleQueue(request, env);
    if (url.pathname === "/social") return handleSocial(request, env);
    if (url.pathname === "/admin") return new Response(adminPage(), { headers: { "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
    if (url.pathname === "/admin/api") return handleAdmin(request, env, { toVault, dirCall, jsonRes, readJson, ipKey });
    if (url.pathname === "/new")
      return new Response(JSON.stringify({ code: makeCode() }),
        { headers: Object.assign({ "Content-Type":"application/json" }, cors()) });

    // a solo ranked match, streamed from the player's own game while the admin watches
    const lv = url.pathname.match(/^\/live\/([A-Za-z0-9_-]{1,64})$/);
    if (lv) return env.ROOMS.get(env.ROOMS.idFromName("live:" + lv[1])).fetch(request);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{1,8})$/);
    if (!m) return new Response("not found", { status: 404, headers: cors() });
    const code = normaliseCode(m[1]);
    if (!code) return new Response("bad code", { status: 400, headers: cors() });

    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  }
};

/* ---------- The player directory ----------
   One object for the whole game: every account's in-game name, when it was
   first and last seen, its flags and any ban, and the last rooms played and
   with whom -- what the admin page lists. No email, no real name: players are
   told apart by the name they play under and the rooms they were in. */
const KICK_MS = 10 * 60 * 1000;          // a kicked player is kept out of that room this long
const DIR_ROOMS_KEPT = 60, DIR_ROOMS_PER_ACCOUNT = 12, DIR_FEED_KEPT = 200;
const SERVER_VERSION = "2026-10-01b";
const LB_SIZE = 10, LB_CACHE_MS = 30 * 1000, OWNERS_CACHE_MS = 3 * 60 * 1000;
const LOBBY_TTL_MS = 90 * 1000, QUEUE_TTL_MS = 8 * 1000;
// switched off until the admin page says otherwise
const DEFAULT_ABIL_OFF = [];
export class Directory {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    let b;
    try { b = await request.json(); } catch (e) { return jsonRes({ error: "bad request" }, 400); }
    return this.state.blockConcurrencyWhile(() => this.handle(b));
  }
  async acct(sub) { return (await this.state.storage.get("a:" + sub)) || { sub, name: "", first: Date.now(), last: 0, flags: 0, ban: null, rooms: [] }; }
  async handle(b) {
    const st = this.state.storage, now = Date.now();
    const sub = typeof b.sub === "string" ? b.sub.slice(0, 64) : "";
    // the ability kill switches (the admin page flips them; games and rooms read them)
    if (b.op === "abiloff") {
      const off = await st.get("abilOff");
      return jsonRes({ off: Array.isArray(off) ? off : DEFAULT_ABIL_OFF });
    }
    if (b.op === "setabiloff") {
      const ids = new Set(CAT.items.abil.list.map(x => x.id));
      const off = [...new Set((Array.isArray(b.off) ? b.off : []).map(String))].filter(id => ids.has(id) && id !== CAT.items.abil.starter);
      await st.put("abilOff", off);
      return jsonRes({ ok: true, off });
    }
    if (b.op === "touch" || b.op === "room" || b.op === "flag" || b.op === "ban") {
      if (!sub) return jsonRes({ error: "no account" }, 400);
      const a = await this.acct(sub);
      a.last = now;
      if (typeof b.name === "string" && b.name) a.name = b.name.slice(0, 14);
      if (b.sum && typeof b.sum === "object") a.sum = b.sum;
      if (Array.isArray(b.ul)) {
        const ul = b.ul.filter(x => typeof x === "string" && x.length < 40).slice(0, 20).sort();
        if (JSON.stringify(ul) !== JSON.stringify(a.ul || [])) { a.ul = ul; this.owners = null; }
      }
      if (typeof b.season === "number" && a.season !== b.season) { a.season = b.season; this.top = null; }
      if (typeof b.rp === "number" && isFinite(b.rp) && b.rp >= 0) { const rp = Math.floor(b.rp); if (a.rp !== rp) { this.top = null; a.rp = rp; a.rpAt = now; } }
      if (b.op === "flag") {
        a.flags = (a.flags | 0) + 1; a.lastFlag = b.flag || null; if (b.ban) { a.ban = b.ban; this.top = null; }
        // the admin page's live feed: every flag, newest last
        const feed = (await st.get("feed")) || [];
        feed.push({ at: now, sub, name: a.name || b.name || "", flag: b.flag || null, ban: !!b.ban });
        await st.put("feed", feed.slice(-DIR_FEED_KEPT));
      }
      if (b.op === "ban") { a.ban = b.ban || null; this.top = null; }
      if (b.op === "room" && b.code) {
        a.rooms = [b.code].concat((a.rooms || []).filter(c => c !== b.code)).slice(0, DIR_ROOMS_PER_ACCOUNT);
        const rooms = (await st.get("rooms")) || [];
        let r = rooms.find(x => x.code === b.code && now - x.at < 6 * 3600 * 1000);
        if (!r) { r = { code: b.code, at: now, players: [] }; rooms.unshift(r); }
        r.at = now;
        r.players = r.players.filter(p => p.sub !== sub).concat([{ sub, name: a.name || b.name || "" }]).slice(-12);
        rooms.sort((x, y) => y.at - x.at);
        await st.put("rooms", rooms.slice(0, DIR_ROOMS_KEPT));
      }
      await st.put("a:" + sub, a);
      return jsonRes({ ok: true });
    }
    if (b.op === "get") return jsonRes({ acct: sub ? await st.get("a:" + sub) || null : null });
    // how many accounts own each ULTRA, worked out at most every few minutes
    if (b.op === "owners") {
      if (!this.owners || now - this.owners.at > OWNERS_CACHE_MS) {
        const n = {};
        for (const [, a] of await st.list({ prefix: "a:" })) if (!a.ban) for (const k of (a.ul || [])) n[k] = (n[k] | 0) + 1;
        this.owners = { at: now, n };
      }
      return jsonRes({ owners: this.owners.n, at: this.owners.at });
    }
    // every account, for the admin's recount
    if (b.op === "subs") { const out = []; for (const [, a] of await st.list({ prefix: "a:" })) out.push(a.sub); return jsonRes({ subs: out }); }
    // the RP leaderboard: everyone not banned, most RP first (first to get there wins a tie).
    // Worked out at most every LB_CACHE_MS, so a crowd opening it costs one read
    if (b.op === "top") {
      if (!this.top || now - this.top.at > LB_CACHE_MS) {
        const all = [];   // ponytail: reads every account; keep a sorted "top" key instead if accounts reach the tens of thousands
        const season = CAT.season ? CAT.season.id : 0;
        // this season only: an account that has not played since the reset still has last season's RP
        for (const [, a] of await st.list({ prefix: "a:" })) if (!a.ban && a.rp > 0 && (a.season | 0) === season) all.push({ sub: a.sub, name: a.name || "Player", rp: a.rp, at: a.rpAt || 0 });
        all.sort((x, y) => y.rp - x.rp || x.at - y.at);
        this.top = { at: now, all };
      }
      const all = this.top.all, i = sub ? all.findIndex(x => x.sub === sub) : -1;
      return jsonRes({ top: all.slice(0, LB_SIZE), me: i >= 0 ? { pos: i + 1, rp: all[i].rp } : null, total: all.length });
    }
    // ---- public lobbies ----
    if (b.op === "lobby") {
      const code = typeof b.code === "string" ? b.code.slice(0, 8) : "";
      if (!code) return jsonRes({ error: "no code" }, 400);
      const lob = (await st.get("lobbies")) || {};
      if (!(b.n > 0)) delete lob[code];
      else lob[code] = { code, n: b.n | 0, max: b.max | 0, host: String(b.host || "").slice(0, 14), gm: String(b.gm || "ffa").slice(0, 16),
        map: String(b.map || "sky").slice(0, 16), priv: !!b.priv, playing: !!b.playing, q: !!b.q, at: now };
      for (const k in lob) if (now - lob[k].at > LOBBY_TTL_MS) delete lob[k];
      await st.put("lobbies", lob);
      return jsonRes({ ok: true });
    }
    /* ---- player tags: a stable, unique handle apart from the display name ----
       NAME#1234, made once from the name the account had then; it never
       changes when the name does. Search is by exact tag only. */
    if (b.op === "tag") {
      if (!sub) return jsonRes({ error: "no account" }, 400);
      let tag = await st.get("tagOf:" + sub);
      const nm = typeof b.name === "string" ? b.name.slice(0, 14) : "";
      if (!tag) {
        const base = (nm.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "PLAYER").slice(0, 10);
        for (let i = 0; i < 40 && !tag; i++) {
          const t = base + "#" + String(1000 + Math.floor(Math.random() * 9000));
          if (!(await st.get("tag:" + t))) tag = t;
        }
        if (!tag) return jsonRes({ error: "busy" }, 503);
        await st.put("tag:" + tag, { sub, name: nm });
        await st.put("tagOf:" + sub, tag);
      } else if (nm) await st.put("tag:" + tag, { sub, name: nm });
      return jsonRes({ tag });
    }
    if (b.op === "findTag") {
      const t = normTag(b.tag);
      const r = t ? await st.get("tag:" + t) : null;
      return jsonRes(r ? { sub: r.sub, name: r.name, tag: t } : { sub: null });
    }
    if (b.op === "lobbies") {
      const lob = (await st.get("lobbies")) || {}, out = [];
      for (const k in lob) { const l = lob[k]; if (now - l.at > LOBBY_TTL_MS || l.priv || l.q || l.playing || l.n >= l.max) continue; out.push(l); }
      out.sort((x, y) => y.n - x.n || y.at - x.at);
      return jsonRes({ lobbies: out.slice(0, 30) });
    }
    /* ---- the GOD queue: two GOD players make a ranked 1v1 ----
       A player asks every couple of seconds. If somebody else is waiting, the
       two are paired into a fresh room and both are told its code; the one who
       was waiting first hosts. Nobody waiting: you are, for as long as you keep
       asking. */
    if (b.op === "queue") {
      if (!sub) return jsonRes({ error: "no account" }, 400);
      const q = (await st.get("godq")) || {};
      for (const k in q) if (now - q[k].at > QUEUE_TTL_MS && !q[k].match) delete q[k];
      for (const k in q) if (q[k].match && now - q[k].at > 60000) delete q[k];
      if (b.leave) { delete q[sub]; await st.put("godq", q); return jsonRes({ ok: true }); }
      const mine = q[sub];
      if (mine && mine.match) { delete q[sub]; await st.put("godq", q); return jsonRes({ match: mine.match, host: mine.host }); }
      const other = Object.keys(q).find(k => k !== sub && !q[k].match);
      if (other) {
        const code = "G" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
        q[other] = { at: now, match: code, host: true };
        delete q[sub];
        await st.put("godq", q);
        return jsonRes({ match: code, host: false });
      }
      q[sub] = { at: now, since: mine ? mine.since : now };
      await st.put("godq", q);
      return jsonRes({ waiting: true, since: q[sub].since });
    }
    if (b.op === "top1") {
      if (!this.top || now - this.top.at > LB_CACHE_MS) await this.handle({ op: "top" });
      const t = this.top && this.top.all[0];
      return jsonRes({ sub: t ? t.sub : "", name: t ? t.name : "" });
    }
    if (b.op === "rooms") return jsonRes({ rooms: (await st.get("rooms")) || [] });
    if (b.op === "list") {
      const q = String(b.q || "").toLowerCase().slice(0, 40), out = [];
      const all = await st.list({ prefix: "a:" });
      for (const [, a] of all) {
        if (q && !((a.name || "").toLowerCase().includes(q) || a.sub.includes(q))) continue;
        if (b.only === "flagged" && !(a.flags > 0)) continue;
        if (b.only === "banned" && !a.ban) continue;
        const cur = CAT.season ? CAT.season.id : 0;
        out.push((a.season | 0) === cur ? a : Object.assign({}, a, { rp: 0, s0rp: a.rp || 0 }));
      }
      const key = { sus: a => (a.sum && a.sum.score) || 0, rp: a => a.rp || 0, games: a => (a.sum && a.sum.g) || 0,
        parry: a => (a.sum && a.sum.pr) || 0, streak: a => (a.sum && a.sum.sk) || 0, new: a => a.first || 0 }[b.sort];
      out.sort(key ? (x, y) => key(y) - key(x) || (y.last || 0) - (x.last || 0) : (x, y) => (y.last || 0) - (x.last || 0));
      return jsonRes({ total: out.length, list: out.slice(0, 200) });
    }
    if (b.op === "feed") return jsonRes({ feed: ((await st.get("feed")) || []).slice().reverse() });
    // the front page: head counts and the accounts worth a look
    if (b.op === "overview") {
      const all = [];
      for (const [, a] of await st.list({ prefix: "a:" })) all.push(a);
      const H = 3600000, D = 24 * H, n = f => all.filter(f).length;
      const sus = all.filter(a => !a.ban && a.sum && a.sum.score >= 20).sort((x, y) => y.sum.score - x.sum.score).slice(0, 12);
      let games = 0; for (const a of all) games += (a.sum && a.sum.g) || 0;
      return jsonRes({ total: all.length, online: n(a => now - (a.last || 0) < 10 * 60000), day: n(a => now - (a.last || 0) < D),
        week: n(a => now - (a.last || 0) < 7 * D), newDay: n(a => now - (a.first || 0) < D), banned: n(a => a.ban), flagged: n(a => a.flags > 0 && !a.ban),
        games, sus, newest: all.slice().sort((x, y) => (y.first || 0) - (x.first || 0)).slice(0, 8),
        feed: ((await st.get("feed")) || []).slice(-15).reverse() });
    }
    return jsonRes({ error: "unknown op" }, 400);
  }
}
