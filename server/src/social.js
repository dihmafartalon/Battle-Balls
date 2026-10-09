/* ============================================================
   SOCIAL: friends, presence, parties, lobby invites, messages
   ------------------------------------------------------------
   Hub   -- one per account ("h:<sub>"). The signed-in game holds one socket to
            it. It keeps that account's friends, requests, blocks, unread
            counts and its own copy of every conversation, and it is the only
            thing that ever tells anyone else about this account.
   Party -- one per party ("p:<id>"): up to six members, a leader, invites,
            readiness, and taking everyone into the leader's lobby.

   Rules, all enforced here and never by the game:
   - presence and messages only ever go to friends, and never across a block
   - a block on either side stops requests, messages and invites
   - nobody can read a conversation that is not their own (each Hub only
     serves its own copy)
   - a lobby invite is only made after the room itself confirms the inviter is
     in it and holds a seat for the friend; a client's room code is never
     taken as proof of anything
   ============================================================ */
export const SOC = {
  graceMs: 25000,                 // a reconnect inside this is not "offline"
  beatMs: 75000,                  // no heartbeat for this long: the socket is dead
  onlineGapMs: 5 * 60 * 1000,     // the same friend's "online" toast at most this often
  msgMax: 280, histPage: 30, msgKeep: 400,
  invTtl: 2 * 60 * 1000,          // a party or lobby invite lasts this long
  resvMs: 60000,                  // the seat a lobby invite holds
  partyMax: 6, bossMax: 4,
  partyIdleMs: 3 * 60 * 1000,     // a party member offline this long is dropped
  limits: { dm: [6, 10000], req: [10, 60000], inv: [12, 60000], find: [20, 60000] }
};
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").trim().slice(0, n);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const okSub = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
export function normTag(t) {
  const m = /^\s*([A-Za-z0-9]{1,10})\s*#?\s*([0-9]{4})\s*$/.exec(String(t || ""));
  return m ? m[1].toUpperCase() + "#" + m[2] : "";
}
async function call(stub, url, body) {
  try { const r = await stub.fetch(url, { method: "POST", body: JSON.stringify(body) }); return await r.json(); }
  catch (e) { return { ok: false, why: "unreachable" }; }
}
export const hubCall = (env, sub, body) => env.HUB ? call(env.HUB.get(env.HUB.idFromName("h:" + sub)), "https://hub/op", body) : Promise.resolve({ ok: false, why: "off" });
export const partyCall = (env, id, body) => env.PARTY ? call(env.PARTY.get(env.PARTY.idFromName("p:" + id)), "https://party/op", body) : Promise.resolve({ ok: false, why: "off" });
export const roomSocial = (env, code, body) => env.ROOMS ? call(env.ROOMS.get(env.ROOMS.idFromName(code)), "https://room-social/", body) : Promise.resolve({ ok: false, why: "off" });
const dir = (env, body) => env.DIR ? call(env.DIR.get(env.DIR.idFromName("dir")), "https://dir/", body) : Promise.resolve(null);

export class Hub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.s = null; this.rate = new Map(); }
  async load() {
    if (this.s) return this.s;
    this.s = Object.assign({ sub: "", tag: "", name: "", friends: {}, reqIn: {}, reqOut: {}, blocked: {}, fpres: {}, unread: {},
      pinv: {}, linvIn: {}, linvOut: {}, party: null, pres: "offline", room: "", set: { sound: true, prev: true, online: true },
      offAt: 0, lastOn: {}, seen: 0, seq: 0 }, (await this.ctx.storage.get("s")) || {});
    return this.s;
  }
  save() { return this.ctx.storage.put("s", this.s); }
  socks() { return this.ctx.getWebSockets().filter(w => !w._closed); }
  push(o) { const m = JSON.stringify(o); for (const w of this.socks()) try { w.send(m); } catch (e) {} }
  // a notification for the top-right of the game: one id, so a repeat is the same toast
  note(n) { this.push({ t: "note", n: Object.assign({ at: Date.now() }, n) }); }
  me() { return { sub: this.s.sub, tag: this.s.tag, name: this.s.name }; }
  view() {
    const s = this.s, now = Date.now();
    const fr = Object.keys(s.friends).map(k => Object.assign({ sub: k, pres: s.fpres[k] || "offline", unread: s.unread[k] | 0 }, s.friends[k]));
    return { t: "state", me: this.me(), pres: s.pres, friends: fr,
      reqIn: Object.keys(s.reqIn).map(k => Object.assign({ sub: k }, s.reqIn[k])),
      reqOut: Object.keys(s.reqOut).map(k => Object.assign({ sub: k }, s.reqOut[k])),
      blocked: Object.keys(s.blocked).map(k => Object.assign({ sub: k }, s.blocked[k])),
      pinv: Object.keys(s.pinv).filter(k => s.pinv[k].exp > now).map(k => Object.assign({ pid: k }, s.pinv[k])),
      linvIn: Object.keys(s.linvIn).filter(k => s.linvIn[k].exp > now).map(k => Object.assign({ id: k }, s.linvIn[k])),
      linvOut: Object.keys(s.linvOut).filter(k => s.linvOut[k].exp > now).map(k => Object.assign({ id: k }, s.linvOut[k])),
      party: s.partyView || null, set: s.set };
  }
  limited(kind) {
    const [n, ms] = SOC.limits[kind], now = Date.now();
    const a = (this.rate.get(kind) || []).filter(t => now - t < ms);
    if (a.length >= n) { this.rate.set(kind, a); return true; }
    a.push(now); this.rate.set(kind, a); return false;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/op") {
      let b; try { b = await req.json(); } catch (e) { return json({ ok: false, why: "bad" }, 400); }
      // no lock: hubs and parties call each other, and a lock held across those
      // calls would deadlock. Every call works on the one in-memory state.
      await this.load(); const r = await this.op(b); await this.save();
      return json(r);
    }
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      await this.attach(pair[1], url.searchParams.get("sub"), url.searchParams.get("name"));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return json({ ok: false }, 404);
  }
  // a game connected (the Worker already checked its session belongs to this account)
  async attach(ws, sub, name) {
    await this.load();
    const s = this.s;
    if (okSub(sub)) s.sub = sub;
    const nm = clean(name, 14);
    if (nm) s.name = nm;
    if (!s.tag || nm) {
      const r = await dir(this.env, { op: "tag", sub: s.sub, name: s.name || "Player" });
      if (r && r.tag) s.tag = r.tag;
    }
    s.seen = Date.now(); s.offAt = 0;
    if (s.pres === "offline") await this.setPres("online");
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + SOC.beatMs);
    try { ws.send(JSON.stringify(this.view())); } catch (e) {}
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 2000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    await this.load();
    this.s.seen = Date.now();
    let r;
    try { r = await this.client(m); } catch (e) { r = { err: "Something went wrong." }; }
    if (r) { if (m.rq !== undefined) r.rq = m.rq; try { ws.send(JSON.stringify(Object.assign({ t: "re" }, r))); } catch (e) {} }
    await this.save();
  }
  async webSocketClose(ws) {
    ws._closed = true;
    await this.load();
    if (this.socks().length === 0) {
      this.s.offAt = Date.now() + SOC.graceMs;
      await this.save();
      await this.ctx.storage.setAlarm(this.s.offAt);
    }
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
  async alarm() {
    await this.load();
    const s = this.s, now = Date.now();
    const live = this.socks();
    // a socket that stopped sending heartbeats is dead
    if (live.length && now - s.seen > SOC.beatMs) { for (const w of live) { w._closed = true; try { w.close(4008, "timeout"); } catch (e) {} } }
    if (this.socks().length === 0 && s.pres !== "offline") {
      if (!s.offAt) s.offAt = now + SOC.graceMs;
      if (now >= s.offAt - 50) { s.offAt = 0; await this.setPres("offline"); }
    }
    // invites that ran out
    for (const k in s.pinv) if (s.pinv[k].exp <= now) delete s.pinv[k];
    for (const k in s.linvIn) if (s.linvIn[k].exp <= now) delete s.linvIn[k];
    for (const k in s.linvOut) if (s.linvOut[k].exp <= now) delete s.linvOut[k];
    await this.save();
    if (this.socks().length) await this.ctx.storage.setAlarm(now + SOC.beatMs);
    else if (s.offAt) await this.ctx.storage.setAlarm(s.offAt);
  }
  // tell every friend (and the party) where this account is
  async setPres(p) {
    const s = this.s;
    if (s.pres === p) return;
    s.pres = p;
    const tasks = Object.keys(s.friends).filter(k => !s.blocked[k]).map(k => hubCall(this.env, k, { op: "fpres", from: s.sub, pres: p, tag: s.tag, name: s.name }));
    if (s.party) tasks.push(partyCall(this.env, s.party, { op: "pres", sub: s.sub, on: p !== "offline", name: s.name }));
    await Promise.all(tasks);
  }
  async resolveTag(tag) {
    const t = normTag(tag);
    if (!t) return null;
    const r = await dir(this.env, { op: "findTag", tag: t });
    return r && r.sub ? r : null;
  }
  async peer(m) {
    if (okSub(m.sub)) { const s = this.s, k = m.sub; const x = s.friends[k] || s.reqIn[k] || s.reqOut[k] || s.blocked[k]; return x ? { sub: k, tag: x.tag, name: x.name } : null; }
    if (m.tag) return this.resolveTag(m.tag);
    return null;
  }
  state() { this.push(this.view()); return null; }

  /* ---- what the game asks for ---- */
  async client(m) {
    const s = this.s, me = this.me(), now = Date.now();
    switch (m.t) {
      case "ping": return { ok: true, pong: now };
      case "st": {
        const p = { lobby: 1, match: 1, online: 1 }[m.s] ? m.s : "online";
        s.room = typeof m.room === "string" ? m.room.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase() : "";
        await this.setPres(p);
        return null;
      }
      case "find": {
        if (this.limited("find")) return { err: "Slow down a little." };
        const r = await this.resolveTag(m.tag);
        if (!r) return { found: null };
        const k = r.sub;
        const rel = k === s.sub ? "you" : s.friends[k] ? "friend" : s.reqOut[k] ? "sent" : s.reqIn[k] ? "incoming" : s.blocked[k] ? "blocked" : "";
        return { found: { sub: k, tag: r.tag, name: r.name, rel } };
      }
      case "freq": {
        if (this.limited("req")) return { err: "Too many requests. Try again in a minute." };
        const r = await this.peer(m);
        if (!r) return { err: "No player has that tag." };
        const k = r.sub;
        if (k === s.sub) return { err: "That's you." };
        if (s.blocked[k]) return { err: "Unblock them first." };
        if (s.friends[k]) return { err: "You're already friends." };
        if (Object.keys(s.friends).length >= 200) return { err: "Your friends list is full." };
        const res = await hubCall(this.env, k, { op: "freq", from: s.sub, tag: s.tag, name: s.name });
        if (!res.ok) return { err: "You can't send a request to that player." };
        if (res.auto) { s.friends[k] = { tag: r.tag, name: r.name, since: now }; s.fpres[k] = res.pres || "offline"; delete s.reqIn[k]; delete s.reqOut[k]; }
        else s.reqOut[k] = { tag: r.tag, name: r.name, at: now };
        this.state();
        return { ok: true, auto: !!res.auto };
      }
      case "facc": {
        const k = m.sub, q = okSub(k) && s.reqIn[k];
        if (!q) return { err: "That request is gone." };
        const res = await hubCall(this.env, k, { op: "facc", from: s.sub, tag: s.tag, name: s.name, pres: s.pres });
        delete s.reqIn[k];
        if (!res.ok) { this.state(); return { err: "That request is gone." }; }
        s.friends[k] = { tag: q.tag, name: q.name, since: now }; s.fpres[k] = res.pres || "offline";
        this.state(); return { ok: true };
      }
      case "fdec": if (okSub(m.sub) && s.reqIn[m.sub]) { delete s.reqIn[m.sub]; await hubCall(this.env, m.sub, { op: "fdec", from: s.sub }); } return this.state();
      case "fcan": if (okSub(m.sub) && s.reqOut[m.sub]) { delete s.reqOut[m.sub]; await hubCall(this.env, m.sub, { op: "fcan", from: s.sub }); } return this.state();
      case "frem": if (okSub(m.sub) && s.friends[m.sub]) { this.forget(m.sub); await hubCall(this.env, m.sub, { op: "frem", from: s.sub }); } return this.state();
      case "block": {
        const r = await this.peer(m);
        if (!r || r.sub === s.sub) return { err: "No player has that tag." };
        this.forget(r.sub);
        s.blocked[r.sub] = { tag: r.tag, name: r.name, at: now };
        await hubCall(this.env, r.sub, { op: "blockedby", from: s.sub });
        this.state(); return { ok: true };
      }
      case "unblock": if (okSub(m.sub)) delete s.blocked[m.sub]; return this.state();
      case "set": {
        for (const k of ["sound", "prev", "online"]) if (typeof m[k] === "boolean") s.set[k] = m[k];
        return this.state();
      }
      case "read": if (okSub(m.with)) { s.unread[m.with] = 0; } return null;
      case "dm": {
        const k = m.to, text = clean(m.text, SOC.msgMax);
        const ack = x => Object.assign({ cid: typeof m.cid === "string" ? m.cid.slice(0, 20) : "" }, x);
        if (!okSub(k) || !s.friends[k]) return ack({ err: "You can only message friends." });
        if (!text) return ack({ err: "Say something first." });
        if (this.limited("dm")) return ack({ err: "You're sending messages too fast." });
        const id = rid(), at = now;
        const res = await hubCall(this.env, k, { op: "dm", from: s.sub, tag: s.tag, name: s.name, text, id, at });
        if (!res.ok) return ack({ err: res.why === "unreachable" ? "Not delivered. Try again." : "You can't message that player." });
        const msg = { id, at, from: s.sub, text };
        await this.keep(k, msg);
        return ack({ ok: true, msg });
      }
      case "hist": {
        const k = m.with;
        if (!okSub(k)) return { err: "No conversation." };
        const before = typeof m.before === "string" ? m.before.slice(0, 40) : "";
        const L = await this.ctx.storage.list({ prefix: "m:" + k + ":", reverse: true, limit: SOC.histPage + 1, end: before ? "m:" + k + ":" + before : undefined });
        const msgs = [...L.values()];
        const more = msgs.length > SOC.histPage;
        if (more) msgs.length = SOC.histPage;
        return { with: k, msgs: msgs.reverse(), more };
      }
      /* ---- parties ---- */
      case "pnew": {
        if (s.party) return { err: "You're already in a party." };
        const pid = rid();
        const r = await partyCall(this.env, pid, { op: "create", id: pid, who: Object.assign({ on: true }, me) });
        if (!r.ok) return { err: "Couldn't make a party." };
        s.party = pid; s.partyView = r.party; this.state(); return { ok: true };
      }
      case "pinv": {
        if (this.limited("inv")) return { err: "Too many invites. Try again in a minute." };
        if (!okSub(m.sub) || !s.friends[m.sub]) return { err: "You can only invite friends." };
        if (!s.party) {
          const pid = rid();
          const r0 = await partyCall(this.env, pid, { op: "create", id: pid, who: Object.assign({ on: true }, me) });
          if (!r0.ok) return { err: "Couldn't make a party." };
          s.party = pid; s.partyView = r0.party;
        }
        const f = s.friends[m.sub];
        const r = await partyCall(this.env, s.party, { op: "invite", by: s.sub, to: { sub: m.sub, tag: f.tag, name: f.name } });
        this.state();
        return r.ok ? { ok: true } : { err: r.why || "Couldn't invite them." };
      }
      case "pacc": {
        const pid = m.pid, inv = typeof pid === "string" && s.pinv[pid];
        if (!inv || inv.exp < now) { if (inv) delete s.pinv[pid]; this.state(); return { err: "That invite has run out." }; }
        if (s.party && s.party !== pid) await this.leaveParty();
        const r = await partyCall(this.env, pid, { op: "accept", who: Object.assign({ on: true }, me) });
        delete s.pinv[pid];
        if (!r.ok) { this.state(); return { err: r.why || "That party is gone." }; }
        s.party = pid; s.partyView = r.party; this.state(); return { ok: true };
      }
      case "pdec": {
        const pid = m.pid;
        if (typeof pid === "string" && s.pinv[pid]) { delete s.pinv[pid]; await partyCall(this.env, pid, { op: "decline", sub: s.sub }); }
        return this.state();
      }
      case "pleave": await this.leaveParty(); return this.state();
      case "pkick": case "plead": case "pdisband": case "pready": {
        if (!s.party) return { err: "You're not in a party." };
        const op = { pkick: "kick", plead: "lead", pdisband: "disband", pready: "ready" }[m.t];
        const r = await partyCall(this.env, s.party, { op, by: s.sub, sub: m.sub, r: !!m.r });
        return r.ok ? { ok: true } : { err: r.why || "Couldn't do that." };
      }
      case "pfollow": {
        if (!s.party) return { err: "You're not in a party." };
        const r = await partyCall(this.env, s.party, { op: "follow", sub: s.sub });
        return r.ok ? { ok: true } : { err: r.why || "Couldn't reach your leader." };
      }
      case "pgo": {
        // the leader takes everyone to the lobby they are in (the room confirms it)
        if (!s.party) return { err: "You're not in a party." };
        const code = typeof m.room === "string" ? m.room.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase() : "";
        if (!code) return { err: "Join or host a lobby first." };
        const r = await partyCall(this.env, s.party, { op: "go", by: s.sub, code, mode: m.mode === "boss" ? "boss" : "" });
        return r.ok ? { ok: true, sent: r.sent | 0 } : { err: r.why || "Couldn't bring the party." };
      }
      /* ---- lobby invites ---- */
      case "linv": {
        if (this.limited("inv")) return { err: "Too many invites. Try again in a minute." };
        const k = m.to;
        if (!okSub(k) || !s.friends[k]) return { err: "You can only invite friends." };
        if ((s.fpres[k] || "offline") === "offline") return { err: "They're offline." };
        const code = typeof m.room === "string" ? m.room.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase() : "";
        if (!code) return { err: "Join or host a lobby first." };
        // the room is the authority: is the inviter really in it, and is there a seat?
        const mem = await roomSocial(this.env, code, { op: "member", sub: s.sub });
        if (!mem.ok) return { err: "You're not in a lobby." };
        const rs = await roomSocial(this.env, code, { op: "reserve", sub: k, ttl: SOC.resvMs });
        if (!rs.ok) return { err: rs.why === "full" ? "Your lobby is full." : "You can't invite people to this lobby." };
        for (const id in s.linvOut) if (s.linvOut[id].to === k) delete s.linvOut[id];     // one at a time per friend
        const id = rid(), exp = now + SOC.invTtl;
        const res = await hubCall(this.env, k, { op: "linv", from: s.sub, tag: s.tag, name: s.name, id, code, exp });
        if (!res.ok) { await roomSocial(this.env, code, { op: "release", sub: k }); return { err: "You can't invite that player." }; }
        s.linvOut[id] = { to: k, name: s.friends[k].name, code, exp };
        this.state(); return { ok: true, id };
      }
      case "lcan": {
        const o = typeof m.id === "string" && s.linvOut[m.id];
        if (o) { delete s.linvOut[m.id]; await roomSocial(this.env, o.code, { op: "release", sub: o.to }); await hubCall(this.env, o.to, { op: "lcan", from: s.sub, id: m.id }); }
        return this.state();
      }
      case "lacc": {
        const id = m.id, inv = typeof id === "string" && s.linvIn[id];
        if (!inv || inv.exp < now) { if (inv) delete s.linvIn[id]; this.state(); return { err: "That invite has run out." }; }
        // the room decides: does it still exist, and is the seat still there?
        const c = await roomSocial(this.env, inv.code, { op: "claim", sub: s.sub });
        delete s.linvIn[id];
        this.state();
        if (!c.ok) {
          await hubCall(this.env, inv.from, { op: "ldone", from: s.sub, id, ok: false });
          return { err: c.why === "full" ? "That lobby is full now." : "That lobby has closed." };
        }
        await hubCall(this.env, inv.from, { op: "ldone", from: s.sub, id, ok: true, name: s.name });
        return { ok: true, go: inv.code };
      }
      case "ldec": {
        const id = m.id, inv = typeof id === "string" && s.linvIn[id];
        if (inv) { delete s.linvIn[id]; await hubCall(this.env, inv.from, { op: "ldone", from: s.sub, id, ok: false, declined: true }); }
        return this.state();
      }
    }
    return { err: "Unknown request." };
  }
  forget(k) {
    const s = this.s;
    delete s.friends[k]; delete s.reqIn[k]; delete s.reqOut[k]; delete s.fpres[k]; delete s.unread[k]; delete s.lastOn[k];
    for (const id in s.linvIn) if (s.linvIn[id].from === k) delete s.linvIn[id];
    for (const id in s.pinv) if (s.pinv[id].from === k) delete s.pinv[id];
  }
  async keep(peer, msg) {
    // ordered by time, then by arrival here: the key is also the page cursor
    this.s.seq = (this.s.seq | 0) + 1;
    msg.k = String(msg.at).padStart(14, "0") + ":" + String(this.s.seq).padStart(9, "0");
    await this.ctx.storage.put("m:" + peer + ":" + msg.k, msg);
    // only the newest few hundred per conversation are kept
    const all = await this.ctx.storage.list({ prefix: "m:" + peer + ":" });
    if (all.size > SOC.msgKeep) await this.ctx.storage.delete([...all.keys()].slice(0, all.size - SOC.msgKeep));
  }
  async leaveParty() {
    const s = this.s;
    if (!s.party) return;
    const pid = s.party; s.party = null; s.partyView = null;
    await partyCall(this.env, pid, { op: "leave", sub: s.sub });
  }

  /* ---- what other accounts' hubs (and parties) tell this one ---- */
  async op(b) {
    const s = this.s, now = Date.now(), k = b.from;
    if (b.op === "pupd") {
      // a party this account is (or was) in changed
      if (b.party && b.party.members.some(x => x.sub === s.sub)) { s.party = b.party.id; s.partyView = b.party; }
      else if (s.party === b.pid || (b.party && s.party === b.party.id)) {
        s.party = null; s.partyView = null;
        if (b.why) this.note({ kind: "info", id: "party:" + b.pid + ":" + now, title: "PARTY", text: b.why });
      }
      this.state(); return { ok: true };
    }
    if (b.op === "pinv") {
      if (!okSub(k) || s.blocked[k]) return { ok: false };
      s.pinv[b.pid] = { from: k, tag: b.tag, name: b.name, exp: b.exp, n: b.n | 0 };
      this.note({ kind: "pinv", id: "pinv:" + b.pid, pid: b.pid, from: k, title: "PARTY INVITE", text: (b.name || "A friend") + " invited you to their party", exp: b.exp });
      this.state(); return { ok: true };
    }
    if (b.op === "pinvx") { delete s.pinv[b.pid]; this.state(); return { ok: true }; }
    if (!okSub(k)) return { ok: false };
    switch (b.op) {
      case "freq": {
        if (s.blocked[k]) return { ok: false };
        if (s.friends[k]) return { ok: true, auto: true, pres: s.pres };
        if (s.reqOut[k]) {                    // they asked us too: friends now
          s.friends[k] = { tag: b.tag, name: b.name, since: now }; s.fpres[k] = "online"; delete s.reqOut[k]; delete s.reqIn[k];
          this.note({ kind: "info", id: "fa:" + k, title: "NEW FRIEND", text: (b.name || b.tag) + " is now your friend" });
          this.state(); return { ok: true, auto: true, pres: s.pres };
        }
        if (Object.keys(s.reqIn).length >= 100) return { ok: false };
        s.reqIn[k] = { tag: clean(b.tag, 16), name: clean(b.name, 14), at: now };
        this.note({ kind: "freq", id: "fr:" + k, from: k, title: "FRIEND REQUEST", text: (b.name || b.tag) + " (" + b.tag + ") wants to be friends" });
        this.state(); return { ok: true };
      }
      case "facc": {
        if (!s.reqOut[k] || s.blocked[k]) return { ok: false };
        s.friends[k] = { tag: s.reqOut[k].tag, name: clean(b.name, 14) || s.reqOut[k].name, since: now }; delete s.reqOut[k];
        s.fpres[k] = b.pres || "online";
        this.note({ kind: "info", id: "fa:" + k, title: "REQUEST ACCEPTED", text: (b.name || b.tag) + " accepted your friend request" });
        this.state(); return { ok: true, pres: s.pres };
      }
      case "fdec": delete s.reqOut[k]; this.state(); return { ok: true };
      case "fcan": delete s.reqIn[k]; this.state(); return { ok: true };
      case "frem": case "blockedby": this.forget(k); this.state(); return { ok: true };
      case "fpres": {
        if (!s.friends[k] || s.blocked[k]) return { ok: false };
        const was = s.fpres[k] || "offline", p = { online: 1, lobby: 1, match: 1, offline: 1 }[b.pres] ? b.pres : "offline";
        s.fpres[k] = p;
        if (b.name) s.friends[k].name = clean(b.name, 14);
        this.push({ t: "pres", sub: k, pres: p, name: s.friends[k].name });
        // "came online", once -- a reconnect never says it again, and never more than every few minutes
        if (was === "offline" && p !== "offline" && s.set.online && now - (s.lastOn[k] || 0) > SOC.onlineGapMs) {
          s.lastOn[k] = now;
          this.note({ kind: "online", id: "on:" + k, from: k, title: "FRIEND ONLINE", text: s.friends[k].name + " is online" });
        }
        return { ok: true };
      }
      case "dm": {
        if (!s.friends[k] || s.blocked[k]) return { ok: false, why: "not friends" };
        const text = clean(b.text, SOC.msgMax);
        if (!text) return { ok: false };
        const msg = { id: String(b.id).slice(0, 24), at: +b.at || now, from: k, text };
        await this.keep(k, msg);
        s.unread[k] = (s.unread[k] | 0) + 1;
        this.push({ t: "dm", with: k, msg, unread: s.unread[k] });
        this.note({ kind: "dm", id: "dm:" + k, from: k, title: s.friends[k].name, text: s.set.prev ? text : "sent you a message", n: s.unread[k] });
        return { ok: true };
      }
      case "linv": {
        if (s.blocked[k]) return { ok: false };
        // a party's leader may send it without being a friend; anyone else must be one
        if (!s.friends[k] && !(b.party && s.party && s.partyView && s.partyView.leader === k)) return { ok: false };
        for (const id in s.linvIn) if (s.linvIn[id].from === k) delete s.linvIn[id];
        s.linvIn[b.id] = { from: k, tag: b.tag, name: clean(b.name, 14), code: String(b.code || "").slice(0, 8), exp: b.exp, party: !!b.party };
        this.note({ kind: "linv", id: "li:" + b.id, inv: b.id, from: k, party: !!b.party, title: b.party ? "PARTY → LOBBY" : "LOBBY INVITE",
          text: (b.name || "A friend") + (b.party ? " is taking the party to their lobby" : " invited you to their lobby"), exp: b.exp });
        this.state(); return { ok: true };
      }
      case "lcan": delete s.linvIn[b.id]; this.push({ t: "noteGone", id: "li:" + b.id }); this.state(); return { ok: true };
      case "ldone": {
        const o = s.linvOut[b.id];
        if (o) {
          delete s.linvOut[b.id];
          if (!b.ok) await roomSocial(this.env, o.code, { op: "release", sub: o.to });
          this.note({ kind: "info", id: "ld:" + b.id, title: "LOBBY INVITE", text: o.name + (b.ok ? " is joining your lobby" : b.declined ? " declined your invite" : " couldn't join") });
        }
        this.state(); return { ok: true };
      }
    }
    return { ok: false, why: "unknown op" };
  }
}

/* ============================================================ */
export class Party {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.p = null; }
  async load() { if (!this.p) this.p = (await this.ctx.storage.get("p")) || null; return this.p; }
  save() { return this.p ? this.ctx.storage.put("p", this.p) : this.ctx.storage.delete("p"); }
  view() { const p = this.p; return p ? { id: p.id, leader: p.leader, room: p.room || "", members: p.members.map(m => ({ sub: m.sub, tag: m.tag, name: m.name, ready: !!m.ready, on: !!m.on })), max: SOC.partyMax,
    inv: Object.keys(p.inv).map(k => ({ sub: k, name: p.inv[k].name, exp: p.inv[k].exp })) } : null; }
  async fetch(req) {
    let b; try { b = await req.json(); } catch (e) { return json({ ok: false }, 400); }
    await this.load(); const r = await this.op(b); await this.save();
    return json(r);
  }
  async tell(gone, why) {
    const v = this.view(), tasks = [];
    if (v) for (const m of v.members) tasks.push(hubCall(this.env, m.sub, { op: "pupd", party: v, pid: v.id }));
    for (const g of gone || []) tasks.push(hubCall(this.env, g, { op: "pupd", party: null, pid: this.pid, why }));
    await Promise.all(tasks);
  }
  member(sub) { return this.p && this.p.members.find(m => m.sub === sub); }
  // hold a seat for one member in the leader's room and send them there (unless they already are)
  async pull(m, lead, code) {
    const rs = await roomSocial(this.env, code, { op: "reserve", sub: m.sub, ttl: SOC.resvMs });
    if (!rs.ok) return rs.why === "full" ? "full" : "no";
    if (rs.here) return "here";
    const r = await hubCall(this.env, m.sub, { op: "linv", from: lead.sub, tag: lead.tag, name: lead.name, id: rid(), code, exp: Date.now() + SOC.invTtl, party: true });
    if (!r.ok) { await roomSocial(this.env, code, { op: "release", sub: m.sub }); return "no"; }
    return "sent";
  }
  async drop(sub, why) {
    const p = this.p;
    p.members = p.members.filter(m => m.sub !== sub);
    if (!p.members.length) { this.pid = p.id; for (const k in p.inv) await hubCall(this.env, k, { op: "pinvx", pid: p.id }); this.p = null; await this.tell([sub], why); return; }
    if (p.leader === sub) { p.leader = (p.members.find(m => m.on) || p.members[0]).sub; p.room = null; }   // leadership passes on
    this.pid = p.id;
    await this.tell([sub], why);
  }
  async schedule() {
    const p = this.p; if (!p) return;
    let next = Infinity;
    for (const k in p.inv) next = Math.min(next, p.inv[k].exp);
    for (const m of p.members) if (!m.on && m.offAt) next = Math.min(next, m.offAt + SOC.partyIdleMs);
    if (next < Infinity) await this.ctx.storage.setAlarm(next + 50);
  }
  async alarm() {
    await this.load(); const p = this.p; if (!p) return;
    const now = Date.now();
    for (const k in p.inv) if (p.inv[k].exp <= now) { delete p.inv[k]; await hubCall(this.env, k, { op: "pinvx", pid: p.id }); }
    for (const m of p.members.slice()) if (!m.on && m.offAt && now - m.offAt >= SOC.partyIdleMs) { await this.drop(m.sub, "You were away too long and left the party."); if (!this.p) break; }
    if (this.p) await this.tell();
    await this.save(); await this.schedule();
  }
  async op(b) {
    const now = Date.now();
    if (b.op === "create") {
      if (this.p) return { ok: false, why: "taken" };
      const w = b.who || {};
      if (!okSub(w.sub)) return { ok: false };
      this.p = { id: (b.id || "").slice(0, 32) || rid(), leader: w.sub, members: [{ sub: w.sub, tag: w.tag, name: clean(w.name, 14), ready: false, on: true }], inv: {}, at: now };
      return { ok: true, party: this.view() };
    }
    const p = this.p;
    if (!p) return { ok: false, why: "That party is gone." };
    switch (b.op) {
      case "invite": {
        if (!this.member(b.by)) return { ok: false, why: "You're not in this party." };
        const t = b.to || {};
        if (!okSub(t.sub)) return { ok: false };
        if (this.member(t.sub)) return { ok: false, why: "They're already in your party." };
        if (p.members.length + Object.keys(p.inv).length >= SOC.partyMax) return { ok: false, why: "A party holds " + SOC.partyMax + "." };
        const by = this.member(b.by), exp = now + SOC.invTtl;
        const r = await hubCall(this.env, t.sub, { op: "pinv", from: b.by, tag: by.tag, name: by.name, pid: p.id, exp, n: p.members.length });
        if (!r.ok) return { ok: false, why: "You can't invite that player." };
        p.inv[t.sub] = { name: clean(t.name, 14), exp };
        await this.tell(); await this.schedule();
        return { ok: true };
      }
      case "accept": {
        const w = b.who || {};
        if (!okSub(w.sub) || !p.inv[w.sub] || p.inv[w.sub].exp < now) return { ok: false, why: "That invite has run out." };
        if (p.members.length >= SOC.partyMax) return { ok: false, why: "That party is full." };
        delete p.inv[w.sub];
        if (!this.member(w.sub)) p.members.push({ sub: w.sub, tag: w.tag, name: clean(w.name, 14), ready: false, on: true });
        await this.tell();
        return { ok: true, party: this.view() };
      }
      case "decline": if (p.inv[b.sub]) { delete p.inv[b.sub]; await this.tell(); } return { ok: true };
      case "leave": if (this.member(b.sub)) await this.drop(b.sub, ""); return { ok: true };
      case "kick": {
        if (p.leader !== b.by) return { ok: false, why: "Only the leader can do that." };
        if (b.sub === b.by || !this.member(b.sub)) return { ok: false, why: "They're not in the party." };
        await this.drop(b.sub, "You were removed from the party.");
        return { ok: true };
      }
      case "lead": {
        if (p.leader !== b.by) return { ok: false, why: "Only the leader can do that." };
        if (!this.member(b.sub)) return { ok: false, why: "They're not in the party." };
        p.leader = b.sub; p.room = null; await this.tell(); return { ok: true };
      }
      case "disband": {
        if (p.leader !== b.by) return { ok: false, why: "Only the leader can do that." };
        const gone = p.members.map(m => m.sub);
        for (const k in p.inv) await hubCall(this.env, k, { op: "pinvx", pid: p.id });
        this.pid = p.id; this.p = null;
        await this.tell(gone, "The party was disbanded.");
        return { ok: true };
      }
      case "ready": { const m = this.member(b.by); if (!m) return { ok: false }; m.ready = !!b.r; await this.tell(); return { ok: true }; }
      case "pres": {
        const m = this.member(b.sub); if (!m) return { ok: false };
        if (!b.on && p.leader === b.sub) p.room = null;
        m.on = !!b.on; m.offAt = m.on ? 0 : now; if (b.name) m.name = clean(b.name, 14);
        // the leader going away hands the party to someone who is here
        if (!m.on && p.leader === m.sub) { const o = p.members.find(x => x.on); if (o) { p.leader = o.sub; p.room = null; } }
        await this.tell(); await this.schedule();
        return { ok: true };
      }
      case "go": {
        if (p.leader !== b.by) return { ok: false, why: "Only the leader can do that." };
        if (b.mode === "boss" && p.members.length > SOC.bossMax) return { ok: false, why: "Boss Rally takes up to " + SOC.bossMax + " — your party has " + p.members.length + "." };
        const lead = this.member(b.by);
        const mem = await roomSocial(this.env, b.code, { op: "member", sub: b.by });
        if (!mem.ok) return { ok: false, why: "You're not in that lobby." };
        const moved = p.room !== b.code;
        p.room = b.code; p.roomAt = now;
        let sent = 0, full = 0;
        for (const m of p.members) {
          if (m.sub === b.by || !m.on) continue;
          if ((await this.pull(m, lead, b.code)) === "full") full++; else sent++;
        }
        if (moved) await this.tell();
        if (full && !sent) return { ok: false, why: "Your lobby doesn't have room for everyone.", sent };
        return { ok: true, sent, full };
      }
      case "follow": {
        // a member (back after a reload, or new to the party) catching up with the leader
        const m = this.member(b.sub);
        if (!m) return { ok: false, why: "You're not in this party." };
        if (b.sub === p.leader) return { ok: false, why: "You're the leader." };
        if (!p.room) return { ok: false, why: "Your leader isn't in a lobby." };
        const mem = await roomSocial(this.env, p.room, { op: "member", sub: p.leader });
        if (!mem.ok) { p.room = null; await this.tell(); return { ok: false, why: "Your leader isn't in a lobby." }; }
        const r = await this.pull(m, this.member(p.leader), p.room);
        return r === "full" ? { ok: false, why: "Your leader's lobby is full." } : { ok: true };
      }
    }
    return { ok: false, why: "unknown op" };
  }
}
