/* =====================================================================
   BATTLE BALLS — room server
   One Durable Object per lobby code. Elects a host, holds the roster,
   relays gameplay. The host client is authoritative for the ball and
   the bots; this server is a smart relay, not a simulator.

   Deploy:  npx wrangler deploy
   Connect: wss://<worker>.workers.dev/room/ABCDE?name=Ben
   ===================================================================== */

import { CAT } from "./catalog.js";
import { ECON_KEYS, applyAct, importEcon, ensure, codeReward, itemOf, parryVerdict } from "./econ.js";
import { adminPage, handleAdmin, ADMIN_TRIES, ADMIN_WINDOW_MS } from "./admin.js";

export const MAX_PLAYERS = 6;
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
    host: electHost(players),
    count: players.length,
    players: players
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
      .map(p => ({ id: p.id, name: p.name, ready: !!p.ready,
                   sword: p.sword, skin: p.skin, abil: p.abil }))
  };
}

// pstate is where a player is standing in the shared party lobby, and trade
// is the two-sided offer protocol. Both are peer to peer.
// hold: a guest hitting or throwing a ball it caught; only the host acts on it
const RELAY = { state:1, parry:1, ability:1, swing:1, chat:1, pstate:1, trade:1, hold:1 };
// setup is the host telling the room which gamemode and how many bots, so the
// roster can see the choice before anyone presses ready
const HOST_ONLY = { ball:1, hit:1, spawn:1, roundover:1, botstate:1, parryok:1, setup:1 };

// A public game is a public endpoint. Without these, one script can hold a
// socket open and flood the room, and every relayed byte is billed to you.
export const MAX_MSG_BYTES = 8 * 1024;   // a ball snapshot is a few hundred bytes
// A host legitimately sends ~60/s (state + ball + bots at 20Hz each) plus a
// burst on every deflect, so this sits well clear of real play while still
// stopping a flood, which runs to thousands a second.
export const MSG_BUDGET    = 240;        // messages allowed per window
export const MSG_WINDOW_MS = 1000;       // the window itself

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

export function routeMessage(msg, senderId, hostId) {
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string")
    return { action: "drop", reason: "malformed" };

  if (msg.t === "loadout") {
    return { action: "update", fields: {
      name:  typeof msg.name  === "string" ? msg.name.slice(0, 14) : undefined,
      ready: typeof msg.ready === "boolean" ? msg.ready : undefined,
      sword: typeof msg.sword === "string" ? msg.sword.slice(0, 24) : undefined,
      skin:  typeof msg.skin  === "string" ? msg.skin.slice(0, 24) : undefined,
      abil:  typeof msg.abil  === "string" ? msg.abil.slice(0, 24) : undefined
    }};
  }
  if (msg.t === "start") {
    if (senderId !== hostId) return { action: "drop", reason: "not-host" };
    // Everything the clients need to build the SAME match. rf was being
    // dropped here, which meant a networked ranked 2v2 always faced rank-zero
    // bots however high the host actually was.
    const num = (v, lo, hi, dflt) =>
      (typeof v === "number" && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : dflt;
    return { action: "broadcast", payload: {
      t: "start",
      mode: typeof msg.mode === "string" ? msg.mode : "mp",
      map:  typeof msg.map  === "string" ? msg.map  : "sky",
      gm:   typeof msg.gm   === "string" ? msg.gm.slice(0, 16) : "ffa",
      bots: num(msg.bots, 0, 8, 0) | 0,
      rf:   num(msg.rf, 0, 1, 0),
      seed: (Math.random() * 2147483647) | 0,
      at:   Date.now()
    }};
  }
  if (msg.t === "ping")
    return { action: "reply", payload: { t:"pong", c: msg.c, s: Date.now() } };
  // the host's timing of each guest's blocks, for the anticheat: never relayed
  if (msg.t === "acrep") {
    if (senderId !== hostId) return { action: "drop", reason: "not-host" };
    return { action: "report" };
  }

  if (HOST_ONLY[msg.t]) {
    if (senderId !== hostId) return { action: "drop", reason: "not-host" };
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
export const CAST = { cdShare: 0.78, slackS: 1.5, minCd: 3, strikesToBan: 3, pullsPerCd: 10 };
// follow-ups a guest may send, and the ability each needs; every other follow-up,
// and anything tagged as a bot's, is the host's alone -- and only these kinds
const GUEST_FOLLOW = { taunt: null, riftsnap: "bloodrift", pull: "ramenhair" };
const HOST_FOLLOW = { rift: 1, riftsnap: 1, flash: 1, say: 1, drone: 1, stdshow: 1, cat: 1, pull: 1, taunt: 1 };
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
      return { ok: true, sub: m[1], inv: j.inv };
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
    if (me.sword && !inv.swords[me.sword]) { bad.push(me.sword); me.sword = CAT.items.sword.starter; }
    if (me.skin && !inv.skins[me.skin]) { bad.push(me.skin); me.skin = CAT.items.skin.starter; }
    if (me.abil && !inv.abils[me.abil]) { bad.push(me.abil); me.abil = CAT.items.abil.starter; }
    if (bad.length && noteIt !== false) this.report(me.sub, { kind: "gear", sev: "flag", detail: "equipped " + bad.join(", ") + " without owning it" });
    return bad.length;
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

  roster() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a) out.push(a);
    }
    return out;
  }
  hostId() { return electHost(this.roster()); }

  broadcast(obj, exceptWs) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(text); } catch (e) { /* socket closing */ }
    }
  }
  pushRoster() { this.broadcast(buildRoster(this.roster())); }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket upgrade", { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS)
      return new Response("room full", { status: 403 });

    const url = new URL(request.url);
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
    this.ctx.acceptWebSocket(server);                 // hibernatable

    const me = {
      id: crypto.randomUUID().slice(0, 8),
      name: (url.searchParams.get("name") || "Player").slice(0, 14),
      sword: (url.searchParams.get("sword") || "trainer").slice(0, 24),
      skin:  (url.searchParams.get("skin")  || "rookie").slice(0, 24),
      abil:  (url.searchParams.get("abil")  || "dash").slice(0, 24),
      ready: false,
      joinedAt: Date.now(),
      sub: who.sub                                    // never sent to anyone: see buildRoster
    };
    if (who.inv) { this.invs.set(who.sub, who.inv); this.checkLoadout(me, who.inv); }
    server.serializeAttachment(me);
    const code = (url.pathname.match(/\/room\/([A-Za-z0-9]{1,8})$/) || [])[1] || "";
    dirCall(this.env, { op: "room", code: normaliseCode(code), sub: who.sub, name: me.name });
    server.send(JSON.stringify({ t:"welcome", you: me.id, host: this.hostId(),
                                 max: MAX_PLAYERS, now: Date.now() }));
    this.pushRoster();
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

    const d = routeMessage(msg, me.id, this.hostId());
    if (d.action === "drop") return;
    if (msg.t === "start") this.casts = new WeakMap();      // a new match: cooldowns start over
    if (msg.t === "ability" && me.sub) {
      const isHost = me.id === this.hostId();
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
        const stale = inv && ((me.sword && !inv.swords[me.sword]) || (me.skin && !inv.skins[me.skin]) || (me.abil && !inv.abils[me.abil]));
        // asked again, and noted, at most every few seconds: a flood of loadouts cannot flood the Vault
        const now = Date.now(), fresh = now - (this.invAt.get(me.sub) || 0) > 5000;
        if (stale && fresh) { this.invAt.set(me.sub, now); this.invs.delete(me.sub); inv = await this.inventory(me.sub); }
        if (inv) this.checkLoadout(me, inv, fresh);
      }
      ws.serializeAttachment(me);
      this.pushRoster();
      return;
    }
    if (d.action === "reply")     { ws.send(JSON.stringify(d.payload)); return; }
    if (d.action === "relay")     { this.broadcast(d.payload, ws); return; }
    if (d.action === "broadcast") { this.broadcast(d.payload); return; }
  }

  async webSocketClose() { this.pushRoster(); }
  async webSocketError() { this.pushRoster(); }
}

/* ---------- Cloud saves, tied to a Google account ----------
   The game signs in with Google and sends us the ID token Google gave it. We
   check that token really came from Google, for THIS game, and has not
   expired, then keep that player's save in their own Vault (one Durable
   Object per Google account). We store Google's account number and the save
   -- never an email, a name or a picture. After sign-in the game holds a
   session token of ours, so it does not have to go back to Google each time. */

export const SAVE_MAX_BYTES = 64 * 1024;
export const SESSION_MS = 60 * 24 * 3600 * 1000;      // 60 days
export const SESSIONS_KEPT = 8;                        // devices signed in at once
export const WRITE_GAP_MS = 4000;                      // no account saves more often than this
export const SYNC_GAP_MS = 800;                        // changes can come faster: they are small
export const OPS_KEPT = 1000;                          // change ids remembered, so a resend is never counted twice
export const OPS_PER_SYNC = 60;
// earlier versions of every save, so a bad day can be undone: a copy at most
// every HIST_GAP_MS, the last HIST_KEPT kept, each under its own key
export const HIST_GAP_MS = 10 * 60 * 1000;
export const HIST_KEPT = 30;

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
  "finnballs": "cruz",
  "wendigo0925bm": "wendigo"     // unreleased: owner's test copy. Delete at launch.
};
// guessing is slow: this many tries a minute from any one address
export const REDEEM_TRIES = 8;
export const REDEEM_WINDOW_MS = 60 * 1000;
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
    const rec = (await st.get("save")) || null;
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
    if (body.op === "flag") {                        // a room caught something
      const b = await this.flagIn(sub, body.flag, now);
      return jsonRes({ ok: true, banned: !!b, why: b ? b.why : "" });
    }
    if (body.op === "adm_get") {
      return jsonRes({ sub, save: rec ? JSON.parse(rec.data) : null, rev: rec ? rec.rev : 0, at: rec ? rec.at : 0,
        ban: (await st.get("ban")) || null, flags: (await st.get("flags")) || [] });
    }
    if (body.op === "adm_edit") {
      const save = ensure(rec ? JSON.parse(rec.data) : {});
      if (!save.econ) save.econ = { v: 1, at: now };
      const done = [];
      for (const e of (Array.isArray(body.edits) ? body.edits : []).slice(0, 200)) {
        if (!e || typeof e !== "object") continue;
        const bag = { sword: "swords", abil: "abils", skin: "skins" }[e.tab];
        if (e.k === "set" && ["coins", "yen", "rp", "freeSpins"].includes(e.key) && typeof e.v === "number" && isFinite(e.v) && e.v >= 0) {
          save[e.key] = Math.floor(e.v); done.push(e.key + "=" + save[e.key]);
        } else if (e.k === "add" && bag && itemOf(e.tab, e.id)) { save[bag][e.id] = 1; done.push("+" + e.id); }
        else if (e.k === "del" && bag && save[bag][e.id]) {
          delete save[bag][e.id]; done.push("-" + e.id);
          const eq = { sword: "eqSword", abil: "eqAbil", skin: "eqSkin" }[e.tab];
          if (save[eq] === e.id) save[eq] = CAT.items[e.tab].starter;
        }
      }
      ensure(save);
      const next = { data: JSON.stringify(save), rev: (rec ? rec.rev : 0) + 1, at: now };
      const keep = await this.snapshot(rec, now, true);   // an admin edit can always be undone
      await st.put(Object.assign({ save: next }, keep));
      dirCall(this.env, { op: "touch", sub, name: save.netName || "", rp: save.rp | 0 });
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
      return jsonRes({ ok: true, name: s.netName || "", inv: { swords: s.swords, abils: s.abils, skins: s.skins } });
    }
    // the player directory hears about this account now and then, never every save
    const dirAt = (await st.get("dirAt")) || 0;
    if (now - dirAt > DIR_TOUCH_MS) {
      await st.put("dirAt", now);
      let nm = "", rp; try { const sv = rec ? JSON.parse(rec.data) : {}; nm = sv.netName || ""; rp = sv.rp | 0; } catch (e) {}
      dirCall(this.env, { op: "touch", sub, name: nm, rp });
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
      const res = [];
      if (body.op === "redeem") {
        const code = String(body.code || "");
        ensure(save);
        if (save.redeemed[code]) res.push({ ok: false, already: true });
        else { const msg = codeReward(save, body.reward, Math.random); save.redeemed[code] = 1; res.push({ ok: !!msg, msg }); }
      } else {
        const seen = (await st.get("opids")) || [];
        for (const a of (Array.isArray(body.acts) ? body.acts : []).slice(0, 5)) {
          // an act sent again after its answer was lost is not paid twice
          if (a && typeof a.id === "string" && a.id.length <= 32 && seen.indexOf(a.id) >= 0) { res.push({ ok: true, dup: true }); continue; }
          res.push(applyAct(save, a, { now, rnd: Math.random, bj, flags }));
          if (a && typeof a.id === "string" && a.id.length <= 32) seen.push(a.id);
        }
        await st.put("opids", seen.slice(-OPS_KEPT));
      }
      const data = JSON.stringify(save);
      if (data.length > SAVE_MAX_BYTES) return jsonRes({ error: "save too big" }, 413);
      const next = { data, rev: (rec ? rec.rev : 0) + 1, at: now };
      const keep = await this.snapshot(rec, now);
      await st.put(Object.assign({ save: next, bj, actT: recent }, keep));
      let banned = null;
      for (const f of flags) banned = (await this.flagIn(sub, f, now)) || banned;
      // RP moved: the leaderboard hears now, not at the next touch
      const rpBefore = rec ? (JSON.parse(rec.data).rp | 0) : 0;
      if ((save.rp | 0) !== rpBefore) dirCall(this.env, { op: "touch", sub, name: save.netName || "", rp: save.rp | 0 });
      return jsonRes({ save, rev: next.rev, at: now, res, ec: 1, banned: banned ? banned.why : undefined });
    }

    if (body.op === "load") return jsonRes(view());
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
        return jsonRes({ save, rev: next.rev, at: now, done, ec: 1 });
      }
      return jsonRes(Object.assign({ done }, view()));
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

export const DIR_TOUCH_MS = 5 * 60 * 1000;
export const ACTS_PER_10S = 40;
/* What an edited game tried to write. Items nobody can have, or a pile of
   coins out of nowhere, is a ban; the rest is a flag to look at. */
export function tamperVerdict(ops) {
  const bad = [], big = [];
  for (const c of ops) {
    const p = c[0], kind = c[1], v = c[2];
    const tab = { swords: "sword", abils: "abil", skins: "skin" }[p[0]];
    if (tab && p.length === 2 && kind === "=" && v) {
      const it = itemOf(tab, p[1]);
      if (it && (it.ultra || it.rank === "dev" || it.r === "unreleased" || it.code)) bad.push(p[1]);
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
  if (!["load", "save", "sync", "logout", "history", "restore", "act"].includes(body.op)) return jsonRes({ error: "unknown op" }, 400);
  return toVault(env, m[1], { op: body.op, sub: m[1], secret: m[2], save: body.save, base: body.base, ops: body.ops, kept: body.kept,
    acts: body.acts, imp: body.imp });
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
      return new Response("ok", { headers: cors() });
    if (url.pathname === "/auth/google" || url.pathname === "/cloud")
      return handleCloud(request, env, url.pathname);
    if (url.pathname === "/redeem") return handleRedeem(request, env);
    if (url.pathname === "/leaderboard") return handleLeaderboard(request, env);
    if (url.pathname === "/admin") return new Response(adminPage(), { headers: { "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
    if (url.pathname === "/admin/api") return handleAdmin(request, env, { toVault, dirCall, jsonRes, readJson, ipKey });
    if (url.pathname === "/new")
      return new Response(JSON.stringify({ code: makeCode() }),
        { headers: Object.assign({ "Content-Type":"application/json" }, cors()) });

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
export const DIR_ROOMS_KEPT = 60, DIR_ROOMS_PER_ACCOUNT = 12;
export const LB_SIZE = 10, LB_CACHE_MS = 30 * 1000;
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
    if (b.op === "touch" || b.op === "room" || b.op === "flag" || b.op === "ban") {
      if (!sub) return jsonRes({ error: "no account" }, 400);
      const a = await this.acct(sub);
      a.last = now;
      if (typeof b.name === "string" && b.name) a.name = b.name.slice(0, 14);
      if (typeof b.rp === "number" && isFinite(b.rp) && b.rp >= 0) { const rp = Math.floor(b.rp); if (a.rp !== rp) { this.top = null; a.rp = rp; a.rpAt = now; } }
      if (b.op === "flag") { a.flags = (a.flags | 0) + 1; a.lastFlag = b.flag || null; if (b.ban) { a.ban = b.ban; this.top = null; } }
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
    // the RP leaderboard: everyone not banned, most RP first (first to get there wins a tie).
    // Worked out at most every LB_CACHE_MS, so a crowd opening it costs one read
    if (b.op === "top") {
      if (!this.top || now - this.top.at > LB_CACHE_MS) {
        const all = [];   // ponytail: reads every account; keep a sorted "top" key instead if accounts reach the tens of thousands
        for (const [, a] of await st.list({ prefix: "a:" })) if (!a.ban && a.rp > 0) all.push({ sub: a.sub, name: a.name || "Player", rp: a.rp, at: a.rpAt || 0 });
        all.sort((x, y) => y.rp - x.rp || x.at - y.at);
        this.top = { at: now, all };
      }
      const all = this.top.all, i = sub ? all.findIndex(x => x.sub === sub) : -1;
      return jsonRes({ top: all.slice(0, LB_SIZE), me: i >= 0 ? { pos: i + 1, rp: all[i].rp } : null, total: all.length });
    }
    if (b.op === "rooms") return jsonRes({ rooms: (await st.get("rooms")) || [] });
    if (b.op === "list") {
      const q = String(b.q || "").toLowerCase().slice(0, 40), out = [];
      const all = await st.list({ prefix: "a:" });
      for (const [, a] of all) {
        if (q && !((a.name || "").toLowerCase().includes(q) || a.sub.includes(q))) continue;
        if (b.only === "flagged" && !(a.flags > 0)) continue;
        if (b.only === "banned" && !a.ban) continue;
        out.push(a);
      }
      out.sort((x, y) => (y.last || 0) - (x.last || 0));
      return jsonRes({ total: out.length, list: out.slice(0, 200) });
    }
    return jsonRes({ error: "unknown op" }, 400);
  }
}
