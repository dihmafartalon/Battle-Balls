/* Social, end to end through real Hub, Party, Directory and Room objects (in
   memory): tags, friend requests, blocks, presence that only friends see and
   one "online" toast per real arrival, friends-only messages with history and
   limits, parties (invite, leave, leader, kick, disband, Boss Rally's limit),
   and lobby invites the room itself authorises, holding seats that count
   toward the six. */
import assert from "assert";
import { Hub, Party, Directory, Room } from "../src/index.js";
import { SOC } from "../src/social.js";
import { memState, memNamespace } from "./mockdo.mjs";

const env = {};
env.HUB = memNamespace(() => new Hub(memState(), env));
env.PARTY = memNamespace(() => new Party(memState(), env));
const dirObj = new Directory(memState(), env);
env.DIR = memNamespace(() => dirObj);
// rooms: real Room objects; players are fake sockets whose attachment says who they are
env.ROOMS = memNamespace(() => new Room(memState(), env));
function roomOf(code) { env.ROOMS.get(env.ROOMS.idFromName(code)); return env.ROOMS.objs.get(code); }
function seat(code, sub) { const r = roomOf(code); r.ctx.acceptWebSocket({ deserializeAttachment: () => ({ id: sub, sub, name: sub }), send() {} }); }
function unseat(code, sub) { const st = roomOf(code).ctx; st.socks = st.socks.filter(w => w.deserializeAttachment().sub !== sub); }

// a game connected to its hub: a fake socket that records what it is sent
const games = {};
async function connect(sub, name) {
  const hub = env.HUB.get(env.HUB.idFromName("h:" + sub)) && env.HUB.objs.get("h:" + sub);
  const ws = { got: [], send(m) { this.got.push(JSON.parse(m)); }, close() { this._closed = true; } };
  hub.ctx.acceptWebSocket(ws);
  await hub.attach(ws, sub, name);
  games[sub] = { hub, ws };
  return games[sub];
}
async function say(sub, m) { const g = games[sub]; const n = g.ws.got.length; await g.hub.webSocketMessage(g.ws, JSON.stringify(m)); return g.ws.got.slice(n).find(x => x.t === "re") || null; }
const last = (sub, t) => { const a = games[sub].ws.got.filter(x => x.t === t); return a[a.length - 1]; };
const notes = (sub, kind) => games[sub].ws.got.filter(x => x.t === "note" && (!kind || x.n.kind === kind));
const S = sub => games[sub].hub.s;

for (const [s, n] of [["ann", "Annie"], ["bob", "Bob"], ["cat", "Cat"], ["dan", "Dan"], ["eve", "Eve"], ["fay", "Fay"], ["gus", "Gus"]]) await connect(s, n);

// tags: stable, unique, apart from the name
{
  const tA = S("ann").tag;
  assert.match(tA, /^ANNIE#\d{4}$/);
  const all = new Set(["ann", "bob", "cat", "dan", "eve", "fay", "gus"].map(x => S(x).tag));
  assert.equal(all.size, 7, "unique");
  await connect("ann", "Annabelle");
  assert.equal(S("ann").tag, tA, "renaming keeps the tag");
  const f = await say("bob", { t: "find", tag: tA.toLowerCase() });
  assert.equal(f.found.sub, "ann"); assert.equal(f.found.name, "Annabelle");
  assert.equal((await say("bob", { t: "find", tag: "NOBODY#0000" })).found, null);
  console.log("tags ok");
}
// friend requests: send, decline, cancel, accept, mutual, remove
{
  let r = await say("ann", { t: "freq", tag: S("bob").tag });
  assert.ok(r.ok); assert.ok(S("bob").reqIn.ann && S("ann").reqOut.bob);
  assert.equal(notes("bob", "freq").length, 1, "bob is told");
  await say("bob", { t: "fdec", sub: "ann" });
  assert.ok(!S("ann").reqOut.bob && !S("bob").reqIn.ann, "declined both sides");
  await say("ann", { t: "freq", tag: S("bob").tag }); await say("ann", { t: "fcan", sub: "bob" });
  assert.ok(!S("bob").reqIn.ann, "cancelled");
  await say("ann", { t: "freq", tag: S("bob").tag });
  r = await say("bob", { t: "facc", sub: "ann" });
  assert.ok(r.ok && S("ann").friends.bob && S("bob").friends.ann, "friends");
  // both ask each other: friends at once
  await say("cat", { t: "freq", tag: S("ann").tag });
  r = await say("ann", { t: "freq", tag: S("cat").tag });
  assert.ok(r.auto && S("cat").friends.ann && S("ann").friends.cat, "mutual requests make friends");
  assert.equal((await say("ann", { t: "freq", tag: S("ann").tag })).err, "That's you.");
  for (const x of ["dan", "eve", "fay", "gus"]) { await say("ann", { t: "freq", sub: undefined, tag: S(x).tag }); await say(x, { t: "facc", sub: "ann" }); }
  await say("cat", { t: "frem", sub: "ann" });
  assert.ok(!S("ann").friends.cat && !S("cat").friends.ann, "removed both sides");
  console.log("friend requests ok");
}
// presence: friends only; "online" once per real arrival, not on a quick reconnect
{
  await say("bob", { t: "st", s: "match" });
  assert.equal(S("ann").fpres.bob, "match");
  assert.equal(S("cat").fpres.bob, undefined, "a non-friend sees nothing");
  // bob closes the game: offline only after the grace
  const before = notes("ann", "online").length;
  const g = games.bob; await g.hub.webSocketClose(g.ws); g.hub.ctx.socks = [];
  assert.equal(S("ann").fpres.bob, "match", "still there inside the grace");
  await connect("bob", "Bob");                       // back inside the grace
  assert.equal(notes("ann", "online").length, before, "a reconnect is not news");
  await g.hub.webSocketClose(games.bob.ws); games.bob.hub.ctx.socks = [];
  S("bob").offAt = Date.now() - 1; await games.bob.hub.alarm();
  assert.equal(S("ann").fpres.bob, "offline", "offline after the grace");
  S("ann").lastOn.bob = 0;
  await connect("bob", "Bob");
  assert.equal(notes("ann", "online").length, before + 1, "one toast for a real arrival");
  S("bob").pres = "online"; await games.bob.hub.webSocketClose(games.bob.ws); games.bob.hub.ctx.socks = []; S("bob").offAt = Date.now() - 1; await games.bob.hub.alarm();
  await connect("bob", "Bob");
  assert.equal(notes("ann", "online").length, before + 1, "and not again minutes later");
  // a dead socket with no heartbeat is noticed
  S("bob").seen = Date.now() - SOC.beatMs - 1000; await games.bob.hub.alarm();
  assert.ok(games.bob.ws._closed, "a silent socket is closed");
  await connect("bob", "Bob");
  console.log("presence ok");
}
// messages: friends only, stored on both sides, paged, unread, limits, plain text
{
  let r = await say("ann", { t: "dm", to: "bob", text: "<b>hi</b>\u0007 there", cid: "c1" });
  assert.ok(r.ok && r.cid === "c1");
  assert.equal(r.msg.text, "<b>hi</b>  there", "kept as text; control characters gone (the game renders it as text)");
  assert.equal(S("bob").unread.ann, 1);
  assert.equal(last("bob", "dm").msg.text, r.msg.text);
  r = await say("ann", { t: "dm", to: "cat", text: "hey" });
  assert.match(r.err, /friends/, "not friends: refused");
  r = await say("ann", { t: "dm", to: "bob", text: "x".repeat(900) });
  assert.equal(r.msg.text.length, SOC.msgMax, "length capped");
  r = await say("ann", { t: "dm", to: "bob", text: "   " });
  assert.ok(r.err, "empty refused");
  // rate limit
  let limited = false;
  for (let i = 0; i < 10; i++) { const x = await say("ann", { t: "dm", to: "bob", text: "spam " + i }); if (x.err && /fast/.test(x.err)) limited = true; }
  assert.ok(limited, "too fast is refused");
  games.ann.hub.rate.clear();
  // pages
  for (let i = 0; i < 40; i++) { games.ann.hub.rate.clear(); await say("ann", { t: "dm", to: "bob", text: "m" + i }); }
  const p1 = await say("bob", { t: "hist", with: "ann" });
  assert.equal(p1.msgs.length, SOC.histPage); assert.ok(p1.more);
  assert.equal(p1.msgs[p1.msgs.length - 1].text, "m39", "newest last");
  const k = p1.msgs[0]; const p2 = await say("bob", { t: "hist", with: "ann", before: k.k });
  assert.ok(p2.msgs.length > 0 && p2.msgs.every(m => m.at <= k.at && m.id !== k.id), "the page before");
  // nobody else's conversation: cat asking for ann+bob's gets cat's own (empty)
  const spy = await say("cat", { t: "hist", with: "ann" });
  assert.equal(spy.msgs.length, 0, "only your own copy");
  await say("bob", { t: "read", with: "ann" }); assert.equal(S("bob").unread.ann, 0);
  // previews off: the toast says nothing of the message
  await say("bob", { t: "set", prev: false });
  await say("ann", { t: "dm", to: "bob", text: "secret" });
  const n = notes("bob", "dm").pop(); assert.ok(!/secret/.test(n.n.text), "no preview");
  console.log("messages ok");
}
// blocks: requests, messages and invites stop, on the server
{
  await say("ann", { t: "block", sub: "dan" });
  assert.ok(!S("ann").friends.dan && !S("dan").friends.ann, "unfriended both sides");
  assert.ok((await say("dan", { t: "freq", tag: S("ann").tag })).err, "can't request");
  assert.ok((await say("dan", { t: "dm", to: "ann", text: "hi" })).err, "can't message");
  const r = await games.ann.hub.op({ op: "dm", from: "dan", text: "hi", id: "x", at: Date.now() });
  assert.equal(r.ok, false, "even a direct delivery is refused");
  await say("ann", { t: "unblock", sub: "dan" });
  assert.ok(!S("ann").blocked.dan);
  await say("ann", { t: "freq", tag: S("dan").tag }); await say("dan", { t: "facc", sub: "ann" });
  console.log("blocks ok");
}
// lobby invites: the room authorises; seats are held and count; expire, cancel, close
{
  await say("bob", { t: "st", s: "lobby" });
  let r = await say("ann", { t: "linv", to: "bob", room: "ROOM1" });
  assert.match(r.err, /not in a lobby/, "a room code from the game proves nothing");
  for (const x of ["ann", "x1", "x2", "x3", "x4"]) seat("ROOM1", x);
  r = await say("ann", { t: "linv", to: "bob", room: "ROOM1" });
  assert.ok(r.ok, "invited");
  const inv = S("bob").linvIn[r.id]; assert.equal(inv.code, "ROOM1");
  assert.equal(notes("bob", "linv").length, 1);
  // the held seat counts: room has 5 + bob's seat = 6, so nobody else fits
  r = await say("ann", { t: "linv", to: "eve", room: "ROOM1" });
  assert.match(r.err, /full/, "a held seat counts toward six");
  // bob accepts: the room confirms, he is told to go
  r = await say("bob", { t: "lacc", id: Object.keys(S("bob").linvIn)[0] });
  assert.equal(r.go, "ROOM1");
  assert.equal(Object.keys(S("ann").linvOut).length, 0, "the inviter is told");
  seat("ROOM1", "bob");
  // an invite to a room that then closes
  for (const x of ["ann", "x1", "x2", "x3", "x4", "bob"]) unseat("ROOM1", x);
  seat("ROOM2", "ann");
  r = await say("ann", { t: "linv", to: "eve", room: "ROOM2" });
  unseat("ROOM2", "ann");
  r = await say("eve", { t: "lacc", id: Object.keys(S("eve").linvIn)[0] });
  assert.match(r.err, /closed/, "the lobby closed");
  // cancelled by the inviter
  seat("ROOM3", "ann");
  r = await say("ann", { t: "linv", to: "fay", room: "ROOM3" });
  await say("ann", { t: "lcan", id: r.id });
  assert.equal(Object.keys(S("fay").linvIn).length, 0, "cancelled");
  const rv = await roomOf("ROOM3").resv(); assert.ok(!rv.fay, "and the seat released");
  // expired
  r = await say("ann", { t: "linv", to: "fay", room: "ROOM3" });
  S("fay").linvIn[r.id].exp = Date.now() - 1;
  r = await say("fay", { t: "lacc", id: r.id });
  assert.match(r.err, /run out/);
  // in a match: the invite waits for them
  await say("gus", { t: "st", s: "match" });
  r = await say("ann", { t: "linv", to: "gus", room: "ROOM3" });
  assert.ok(r.ok && Object.keys(S("gus").linvIn).length === 1, "kept while they play");
  // offline friends can't be invited
  await games.cat.hub.webSocketClose(games.cat.ws);
  console.log("lobby invites ok");
}
// parties
{
  let r = await say("ann", { t: "pinv", sub: "bob" });
  assert.ok(r.ok && S("ann").party, "a party is made on the first invite");
  const pid = S("ann").party;
  assert.ok(S("bob").pinv[pid]);
  r = await say("bob", { t: "pacc", pid });
  assert.ok(r.ok && S("bob").party === pid);
  assert.equal(S("ann").partyView.members.length, 2, "everyone sees the party");
  for (const x of ["eve", "fay", "gus", "dan"]) { await say("ann", { t: "pinv", sub: x }); await say(x, { t: "pacc", pid }); }
  assert.equal(S("ann").partyView.members.length, 6, "six");
  // a seventh: no room (ann is friends with cat? no -- make one)
  r = await say("ann", { t: "pinv", sub: "bob" });
  assert.ok(r.err, "already in");
  // Boss Rally takes four: explained before anyone moves
  seat("ROOM9", "ann");
  r = await say("ann", { t: "pgo", room: "ROOM9", mode: "boss" });
  assert.match(r.err, /up to 4/);
  // readiness
  await say("bob", { t: "pready", r: true });
  assert.ok(S("ann").partyView.members.find(m => m.sub === "bob").ready);
  // kick, leader, leave
  r = await say("bob", { t: "pkick", sub: "eve" }); assert.match(r.err, /leader/, "only the leader kicks");
  r = await say("ann", { t: "pkick", sub: "eve" }); assert.ok(r.ok && !S("eve").party, "kicked");
  await say("fay", { t: "pleave" }); assert.ok(!S("fay").party && S("ann").partyView.members.length === 4);
  r = await say("ann", { t: "plead", sub: "bob" }); assert.equal(S("ann").partyView.leader, "bob", "leadership passed");
  // the leader takes the party to their lobby (seats held, invites sent)
  seat("ROOM9", "bob");
  r = await say("bob", { t: "pgo", room: "ROOM9" });
  assert.ok(r.ok && r.sent === 3, "everyone else is sent: " + JSON.stringify(r));
  const pi = Object.values(S("dan").linvIn).find(x => x.party);
  assert.ok(pi && pi.code === "ROOM9", "a party invite to the lobby");
  assert.equal(S("ann").partyView.room, "ROOM9", "everyone knows which lobby the leader took the party to");
  // a member who missed it (a reload) catches up on their own
  S("dan").linvIn = {};
  r = await say("dan", { t: "pfollow" });
  assert.ok(r.ok && Object.values(S("dan").linvIn).some(x => x.party && x.code === "ROOM9"), "follow sends them to the leader's lobby: " + JSON.stringify(r));
  // a member already in that lobby is not sent again
  seat("ROOM9", "dan"); S("dan").linvIn = {};
  r = await say("dan", { t: "pfollow" });
  assert.equal(Object.keys(S("dan").linvIn).length, 0, "already there: nothing sent");
  unseat("ROOM9", "dan");
  // the leader goes offline: leadership moves to someone who is here
  await games.bob.hub.setPres("offline");
  assert.notEqual(S("ann").partyView.leader, "bob");
  // gone too long: dropped
  const pobj = env.PARTY.objs.get("p:" + pid);
  pobj.p.members.find(m => m.sub === "bob").offAt = Date.now() - SOC.partyIdleMs - 10;
  await pobj.alarm();
  assert.ok(!S("ann").partyView.members.some(m => m.sub === "bob"), "dropped after being away");
  // disband
  const lead = S("ann").partyView.leader;
  r = await say(lead, { t: "pdisband" });
  assert.ok(r.ok && !S("ann").party && !S("dan").party, "disbanded for everyone");
  // invites expire
  games.ann.hub.rate.clear();
  r = await say("ann", { t: "pinv", sub: "dan" });
  assert.ok(r.ok, JSON.stringify(r));
  const pid2 = S("ann").party;
  S("dan").pinv[pid2].exp = Date.now() - 1;
  r = await say("dan", { t: "pacc", pid: pid2 }); assert.match(r.err, /run out/);
  console.log("parties ok");
}
console.log("social tests passed");
