/* ---------- The admin page ----------
   /admin serves the page; /admin/api does the work. Every call carries the
   password (the ADMIN_KEY secret, set with `npx wrangler secret put ADMIN_KEY`).
   With no secret set, nobody gets in. Wrong passwords are counted per address
   and cut off. */
import { CAT } from "./catalog.js";

export const ADMIN_TRIES = 10;                 // wrong passwords per address...
export const ADMIN_WINDOW_MS = 15 * 60 * 1000; // ...in this long

function same(a, b) {                           // compare without leaking where they differ
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return d === 0;
}

/* Spectating: a ticket for one room, good for ten minutes, signed with the
   admin password so the password itself never goes into a link. */
export const SPEC_MS = 10 * 60 * 1000;
export async function specSig(key, code, exp, watch) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("spec|" + code + "|" + exp + "|" + watch));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
export async function specCheck(key, code, tok) {
  const m = /^(\d{10,15})\.([A-Za-z0-9_-]{0,64})\.([0-9a-f]{40})$/.exec(String(tok || ""));
  if (!m || !key || Number(m[1]) < Date.now()) return null;
  const want = await specSig(key, code, m[1], m[2]);
  return same(want, m[3]) ? { watch: m[2] } : null;
}
export const GAME_URL = "https://battleballs.pages.dev/";

export async function handleAdmin(request, env, H) {
  if (request.method !== "POST") return H.jsonRes({ error: "POST only" }, 405);
  if (!env.ADMIN_KEY) return H.jsonRes({ error: "The admin password is not set on the server." }, 503);
  if (String(env.ADMIN_KEY).length < 12) return H.jsonRes({ error: "The admin password on the server is too short: set one of 12 or more characters." }, 503);
  if (!env.VAULT) return H.jsonRes({ error: "saves are not set up on this server" }, 503);
  let b;
  try { b = await H.readJson(request); } catch (e) { return H.jsonRes({ error: "bad request" }, 400); }
  const ip = H.ipKey ? H.ipKey(request.headers.get("CF-Connecting-IP")) : (request.headers.get("CF-Connecting-IP") || "local");
  const gate = env.VAULT.get(env.VAULT.idFromName("adm:" + ip));
  if (!same(b.key || "", env.ADMIN_KEY)) {
    const r = await gate.fetch("https://vault/", { method: "POST", body: JSON.stringify({ op: "atick", fail: true }) });
    if (r.status === 429) return H.jsonRes({ error: "Too many wrong passwords. Try again later." }, 429);
    return H.jsonRes({ error: "Wrong password." }, 401);
  }
  {
    const r = await gate.fetch("https://vault/", { method: "POST", body: JSON.stringify({ op: "atick" }) });
    if (r.status === 429) return H.jsonRes({ error: "Too many wrong passwords. Try again later." }, 429);
  }
  const sub = typeof b.sub === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.sub) ? b.sub : "";
  const vault = p => H.toVault(env, sub, Object.assign({ sub }, p)).then(r => r.json());
  if (b.op === "catalog") {
    const out = {};
    // f: everyone always has it (a starter or a free item), so there is nothing to take away
    for (const t of ["sword", "abil", "skin"]) out[t] = CAT.items[t].list.map(it => ({ id: it.id, n: it.n, r: it.r,
      f: it.free || it.id === CAT.items[t].starter ? 1 : 0 }));
    return H.jsonRes({ items: out, ranks: CAT.ranks.map(r => ({ id: r.id, rp: r.rp })), season: CAT.season || null });
  }
  if (b.op === "list") return H.jsonRes((await H.dirCall(env, { op: "list", q: b.q, only: b.only, sort: b.sort })) || { list: [], total: 0, nodir: true });
  if (b.op === "overview") return H.jsonRes((await H.dirCall(env, { op: "overview" })) || { nodir: true });
  if (b.op === "feed") return H.jsonRes((await H.dirCall(env, { op: "feed" })) || { feed: [] });
  if (b.op === "rooms") return H.jsonRes((await H.dirCall(env, { op: "rooms" })) || { rooms: [] });
  // the ability kill switches
  if (b.op === "abiloff") return H.jsonRes((await H.dirCall(env, { op: "abiloff" })) || { off: [] });
  if (b.op === "setabiloff") return H.jsonRes((await H.dirCall(env, { op: "setabiloff", off: b.off })) || { error: "directory not set up" });
  if (!sub) return H.jsonRes({ error: "no player" }, 400);
  if (b.op === "get") {
    const [v, d] = await Promise.all([vault({ op: "adm_get" }), H.dirCall(env, { op: "get", sub })]);
    return H.jsonRes(Object.assign({ acct: d && d.acct }, v));
  }
  if (b.op === "edit") return H.jsonRes(await vault({ op: "adm_edit", edits: b.edits, note: b.note, silent: !!b.silent }));
  // kick / message: every room they were in lately is asked; only the one they are in has them
  if (b.op === "kick" || b.op === "msg") {
    const text = String(b.text || "").trim().slice(0, 500);
    if (b.op === "msg" && !text) return H.jsonRes({ error: "Write a message first." }, 400);
    const d = await H.dirCall(env, { op: "get", sub });
    const rooms = ((d && d.acct && d.acct.rooms) || []).slice(0, 4);
    let reached = 0;
    if (env.ROOMS) for (const code of rooms) {
      try {
        const r = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch("https://room-admin/", { method: "POST", body: JSON.stringify({ op: b.op, sub, text }) });
        reached += ((await r.json()).reached | 0);
      } catch (e) {}
    }
    if (b.op === "msg") await vault({ op: "adm_msg", text, live: reached > 0 });
    return H.jsonRes({ ok: true, reached });
  }
  // spectate: the room they are in right now (or a room code from the rooms list)
  if (b.op === "spectate") {
    let code = typeof b.code === "string" ? b.code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) : "";
    if (!code && sub && env.ROOMS) {
      const d = await H.dirCall(env, { op: "get", sub });
      for (const c of ((d && d.acct && d.acct.rooms) || []).slice(0, 4)) {
        try {
          const r = await env.ROOMS.get(env.ROOMS.idFromName(c)).fetch("https://room-admin/", { method: "POST", body: JSON.stringify({ op: "has", sub }) });
          if (((await r.json()).reached | 0) > 0) { code = c; break; }
        } catch (e) {}
      }
    }
    if (!code) return H.jsonRes({ error: "They are not in an online room right now. Matches against bots run on their own device and can't be watched." }, 404);
    const exp = String(Date.now() + SPEC_MS), watch = sub || "";
    const st = exp + "." + watch + "." + (await specSig(env.ADMIN_KEY, code, exp, watch));
    return H.jsonRes({ ok: true, code, url: GAME_URL + "?spectate=" + encodeURIComponent(code) + "&st=" + encodeURIComponent(st) });
  }
  if (b.op === "ban") return H.jsonRes(await vault({ op: "adm_ban", why: b.why }));
  if (b.op === "unban") return H.jsonRes(await vault({ op: "adm_unban" }));
  return H.jsonRes({ error: "unknown op" }, 400);
}

export function adminPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Battle Balls Admin</title>
<style>
:root{--bg:#0b1020;--panel:#141a30;--panel2:#10162a;--line:#263056;--text:#e8ecff;--mute:#8b95c2;--acc:#5fd8ff;--bad:#ff5a6e;--good:#6bffb0;--warn:#ffd23f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:3;flex-wrap:wrap}
h1{font-size:16px;margin:0;letter-spacing:.04em}h2{font-size:18px;margin:0 0 4px}h3{font-size:12px;letter-spacing:.1em;color:var(--mute);margin:22px 0 8px;text-transform:uppercase}
button,input,select,textarea{font:inherit;color:var(--text);background:#1c2444;border:1px solid var(--line);border-radius:8px;padding:7px 11px}
textarea{width:100%;min-height:64px;resize:vertical}
button{cursor:pointer}button:hover{border-color:var(--acc)}button.bad{border-color:var(--bad);color:#ffc2c9}button.good{border-color:var(--good);color:#c8ffe2}button.warn{border-color:var(--warn);color:#ffe9a0}
.tabs{display:flex;gap:6px}.tabs button.on{background:var(--acc);color:#04121c;border-color:var(--acc)}
main{display:grid;grid-template-columns:minmax(300px,440px) 1fr;min-height:calc(100vh - 58px)}
main.wide{grid-template-columns:1fr}main.wide #right{display:none}
#left{border-right:1px solid var(--line);padding:12px;overflow:auto;max-height:calc(100vh - 58px)}#right{padding:16px 20px;overflow:auto;max-height:calc(100vh - 58px)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.p{padding:9px 10px;border:1px solid var(--line);border-radius:10px;margin:6px 0;cursor:pointer;background:var(--panel)}
.p:hover,.p.sel{border-color:var(--acc)}.p b{display:inline}.mute{color:var(--mute);font-size:12px}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);margin-left:6px;vertical-align:1px}
.tag.bad{border-color:var(--bad);color:#ffc2c9}.tag.warn{border-color:var(--warn);color:#ffe9a0}.tag.good{border-color:var(--good);color:#c8ffe2}
.score{display:inline-block;min-width:34px;text-align:center;font-weight:700;border-radius:6px;padding:1px 6px;font-size:12px;float:right}
.s0{background:#1f3a2c;color:#9dffc9}.s1{background:#4a3d10;color:#ffe48a}.s2{background:#5a1c26;color:#ffb3bd}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:99px;padding:3px 4px 3px 10px;font-size:12px;background:var(--panel)}
.chip button{padding:0 7px;border-radius:99px;font-size:12px;line-height:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.card{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--panel)}
.card .v{font-size:22px;font-weight:700;margin-top:2px}.card .v.bad{color:var(--bad)}.card .v.warn{color:var(--warn)}.card .v.good{color:var(--good)}
.card input{width:100%;margin-top:4px}.flag{border-left:3px solid var(--warn);padding:6px 10px;margin:6px 0;background:var(--panel);border-radius:0 8px 8px 0}
.flag.ban{border-color:var(--bad)}.flag.click{cursor:pointer}.flag.click:hover{background:#1a2140}
#msg{min-height:20px}.ok{color:var(--good)}.err{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:5px 7px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mute);font-weight:600;position:sticky;top:0;background:var(--panel2)}tr.hot td{background:#3a1520}tr.won td:nth-child(3){color:var(--good)}
.tbl{max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px}
.pos{color:var(--good)}.neg{color:var(--bad)}
.meter{height:10px;border-radius:99px;background:#1c2444;overflow:hidden;margin:6px 0}.meter i{display:block;height:100%}
.box{border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--panel);margin:10px 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:1100px){.cols{grid-template-columns:1fr}}
#login{max-width:360px;margin:12vh auto;padding:0 16px}#login input{width:100%;margin:10px 0}
svg.bars{width:100%;height:70px;display:block}
@media (max-width:760px){main{grid-template-columns:1fr}#left{max-height:none;border-right:0;border-bottom:1px solid var(--line)}#right{max-height:none;padding:12px}}
</style></head><body>
<div id="login"><h1>Battle Balls Admin</h1><p class="mute">Enter the admin password.</p>
<input id="pw" type="password" autocomplete="current-password"><button id="go">Sign in</button><p id="lmsg" class="err"></p></div>
<div id="app" hidden><header><h1>Battle Balls Admin</h1><div class="tabs"><button id="tO" class="on">Overview</button><button id="tP">Players</button><button id="tF">Flags</button><button id="tR">Rooms</button><button id="tA">Abilities</button></div>
<span class="grow"></span><span id="msg"></span></header>
<main id="main"><section id="left"></section><section id="right"><p class="mute">Pick a player.</p></section></main></div>
<script>
var KEY="",CAT=null,RANKS=[],CUR=null,VIEW="overview";
function el(t,a,kids){var e=document.createElement(t);if(a)for(var k in a){if(k==="text")e.textContent=a[k];else if(k==="on")e.addEventListener("click",a[k]);else e.setAttribute(k,a[k]);}
  (kids||[]).forEach(function(c){if(c!==null&&c!==undefined&&c!==false)e.appendChild(typeof c==="string"||typeof c==="number"?document.createTextNode(String(c)):c);});return e;}
function ago(t){if(!t)return "never";var s=(Date.now()-t)/1000;if(s<90)return "just now";if(s<5400)return Math.round(s/60)+" min ago";if(s<129600)return Math.round(s/3600)+" h ago";return Math.round(s/86400)+" days ago";}
function when(t){var d=new Date(t);return d.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});}
function pct(a,b){return b?Math.round(1000*a/b)/10+"%":"-";}
function num(n){return (n|0).toLocaleString();}
function signed(n){n=n|0;return el("span",{class:n>0?"pos":(n<0?"neg":"mute"),text:n>0?"+"+num(n):(n<0?num(n):"0")});}
function say(t,bad){var m=document.getElementById("msg");m.textContent=t||"";m.className=bad?"err":"ok";}
function api(op,body){body=Object.assign({key:KEY,op:op},body||{});
  return fetch("/admin/api",{method:"POST",body:JSON.stringify(body),headers:{"Content-Type":"text/plain"}}).then(function(r){return r.json().then(function(j){j._s=r.status;return j;});});}
function scorePill(sc){sc=sc|0;return el("span",{class:"score "+(sc>=50?"s2":(sc>=20?"s1":"s0")),title:"Suspicion score",text:String(sc)});}
function login(){KEY=document.getElementById("pw").value;api("catalog").then(function(j){
  if(j._s!==200){document.getElementById("lmsg").textContent=j.error||"Could not sign in.";return;}
  CAT=j.items;RANKS=j.ranks||[];document.getElementById("login").hidden=true;document.getElementById("app").hidden=false;go("overview");});}
document.getElementById("go").onclick=login;document.getElementById("pw").onkeydown=function(e){if(e.key==="Enter")login();};
["O","P","F","R","A"].forEach(function(k){document.getElementById("t"+k).onclick=function(){go({O:"overview",P:"players",F:"flags",R:"rooms",A:"abils"}[k]);};});
function go(v){VIEW=v;["O","P","F","R","A"].forEach(function(k){document.getElementById("t"+k).className={O:"overview",P:"players",F:"flags",R:"rooms",A:"abils"}[k]===v?"on":"";});
  document.getElementById("main").className=(v==="overview"||v==="abils")?"wide":"";({overview:overview,players:players,flags:flagsView,rooms:rooms,abils:abilsView})[v]();}
/* ---- kill switches: one per ability ---- */
function abilsView(){var L=document.getElementById("left");L.innerHTML="";
  api("abiloff").then(function(j){var off={};(j.off||[]).forEach(function(id){off[id]=1;});
    L.appendChild(el("h2",{text:"Ability kill switches"}));
    L.appendChild(el("p",{class:"mute",text:"Switch an ability off and it plays as Dash for everyone: in new online matches straight away, and in offline games within about a minute. It also stops dropping from chests. Anyone who owns it keeps it, and it comes back the moment you switch it on."}));
    var nOff=Object.keys(off).length;
    L.appendChild(el("p",{},[el("b",{text:nOff?nOff+" switched off":"Everything is on"})]));
    var g=el("div",{class:"grid"});
    (CAT.abil||[]).forEach(function(a){if(a.f&&a.id==="dash")return;
      var isOff=!!off[a.id];
      var btn=el("button",{class:isOff?"bad":"good",text:isOff?"OFF \u2014 turn on":"ON \u2014 turn off",on:function(){
        var next=Object.keys(off).filter(function(k){return k!==a.id;});if(!isOff)next.push(a.id);
        if(!isOff&&!confirm("Switch off "+a.n+"? It plays as Dash for everyone until you switch it back on."))return;
        api("setabiloff",{off:next}).then(function(r){if(!r.ok){say(r.error||"Could not save",true);return;}say(a.n+(isOff?" is back on":" is switched off"));abilsView();});}});
      g.appendChild(el("div",{class:"card",style:isOff?"border-color:var(--bad)":""},[el("div",{class:"v",style:"font-size:16px",text:a.n}),el("div",{class:"mute",text:a.r}),el("div",{style:"margin-top:8px"},[btn])]));});
    L.appendChild(g);});}
function playerRow(a,extra){var sm=a.sum||{},tags=[];
  if(a.ban)tags.push(el("span",{class:"tag bad",text:"BANNED"}));else if(a.flags)tags.push(el("span",{class:"tag warn",text:a.flags+" flag"+(a.flags>1?"s":"")}));
  var line=[sm.g!==undefined?num(sm.g)+" games":null,sm.g?pct(sm.w,sm.g)+" wins":null,sm.pr!==null&&sm.pr!==undefined?sm.pr+"% perfect":null,sm.sk?"streak "+sm.sk:null,(a.rp|0)+" RP","seen "+ago(a.last)].filter(Boolean).join(" \\u00b7 ");
  return el("div",{class:"p"+(CUR===a.sub?" sel":""),on:function(){open(a.sub);}},[scorePill(sm.score),el("b",{},[a.name||"(no name yet)"].concat(tags)),
    el("div",{class:"mute",text:line}),sm.top?el("div",{class:"mute",style:"color:#ffe48a",text:sm.top}):null,extra||null]);}
/* ---- overview ---- */
function overview(){var L=document.getElementById("left");L.innerHTML="";L.appendChild(el("p",{class:"mute",text:"Loading\\u2026"}));
  api("overview").then(function(j){L.innerHTML="";
    if(j.nodir){L.appendChild(el("p",{class:"err",text:"The player directory is not set up on the server yet."}));return;}
    var g=el("div",{class:"grid"});
    [["Online now",j.online,"good"],["Played today",j.day],["This week",j.week],["New today",j.newDay],["All players",j.total],["Games played",j.games],["Flagged",j.flagged,j.flagged?"warn":""],["Banned",j.banned,j.banned?"bad":""]]
      .forEach(function(c){g.appendChild(el("div",{class:"card"},[el("div",{class:"mute",text:c[0]}),el("div",{class:"v "+(c[2]||""),text:num(c[1])})]));});
    L.appendChild(g);
    var cols=el("div",{class:"cols"});
    var a=el("div"),b=el("div");cols.appendChild(a);cols.appendChild(b);L.appendChild(cols);
    a.appendChild(el("h3",{text:"Worth a look"}));
    if(!(j.sus||[]).length)a.appendChild(el("p",{class:"mute",text:"Nobody stands out right now."}));
    (j.sus||[]).forEach(function(x){a.appendChild(playerRow(x));});
    a.appendChild(el("h3",{text:"Newest players"}));
    (j.newest||[]).forEach(function(x){a.appendChild(playerRow(x));});
    b.appendChild(el("h3",{text:"Latest flags"}));
    if(!(j.feed||[]).length)b.appendChild(el("p",{class:"mute",text:"No flags yet."}));
    (j.feed||[]).forEach(function(f){b.appendChild(feedItem(f));});});}
function feedItem(f){var fl=f.flag||{};return el("div",{class:"flag click"+(fl.sev==="ban"||f.ban?" ban":""),on:function(){open(f.sub);}},[
  el("b",{text:(f.name||f.sub)+" \\u00b7 "+(fl.kind||"?")+(f.ban?" \\u00b7 BANNED":(fl.sev==="ban"?" \\u00b7 ban-level":""))}),el("span",{class:"mute",text:"  "+ago(f.at)}),el("div",{text:fl.detail||""})]);}
/* ---- players ---- */
var Q="",ONLY="",SORT="sus";
function players(){
  var L=document.getElementById("left");L.innerHTML="";
  var q=el("input",{placeholder:"Search name or account id",value:Q});q.style.width="100%";
  var f=el("select",{},[el("option",{value:"",text:"Everyone"}),el("option",{value:"flagged",text:"Flagged"}),el("option",{value:"banned",text:"Banned"})]);f.value=ONLY;
  var so=el("select",{},[["sus","Most suspicious"],["","Recently seen"],["rp","Most RP"],["games","Most games"],["parry","Highest perfect %"],["streak","Longest streak"],["new","Newest"]].map(function(o){return el("option",{value:o[0],text:o[1]});}));so.value=SORT;
  var list=el("div");
  function load(){Q=q.value;ONLY=f.value;SORT=so.value;api("list",{q:Q,only:ONLY,sort:SORT}).then(function(j){list.innerHTML="";
    if(j.nodir){list.appendChild(el("p",{class:"err",text:"The player directory is not set up on the server yet."}));return;}
    list.appendChild(el("p",{class:"mute",text:j.total+" player"+(j.total===1?"":"s")+" \\u00b7 the number on the right is the suspicion score (0\\u2013100)"}));
    (j.list||[]).forEach(function(a){list.appendChild(playerRow(a));});});}
  q.oninput=function(){clearTimeout(q._t);q._t=setTimeout(load,250);};f.onchange=load;so.onchange=load;
  L.appendChild(q);L.appendChild(el("div",{class:"row",style:"margin-top:8px"},[f,so]));L.appendChild(list);load();}
function flagsView(){var L=document.getElementById("left");L.innerHTML="";
  api("feed").then(function(j){L.appendChild(el("p",{class:"mute",text:"Every flag from every player, newest first. Click one to open the player."}));
    if(!(j.feed||[]).length)L.appendChild(el("p",{class:"mute",text:"No flags yet."}));
    (j.feed||[]).forEach(function(f){L.appendChild(feedItem(f));});});}
function rooms(){var L=document.getElementById("left");L.innerHTML="";
  api("rooms").then(function(j){L.appendChild(el("p",{class:"mute",text:"Recent rooms, newest first. Click a name to open that player."}));
    (j.rooms||[]).forEach(function(r){L.appendChild(el("div",{class:"card",style:"margin:8px 0"},[el("b",{text:"Room "+r.code}),el("span",{class:"mute",text:"  "+ago(r.at)+"  "}),el("button",{class:"good",text:"\u25b6 Watch",on:function(){spectate({code:r.code});}}),
      el("div",{class:"chips",style:"margin-top:6px"},r.players.map(function(p){return el("button",{text:p.name||p.sub,on:function(){open(p.sub);}});}))]));});});}
function nameOf(tab,id){var l=CAT[tab]||[];for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i].n;return id;}
function rarOf(tab,id){var l=CAT[tab]||[];for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i].r;return "";}
function rankOf(rp){var i=0;for(var k=0;k<RANKS.length;k++)if((rp|0)>=RANKS[k].rp)i=k;var r=RANKS[i]||{id:"?",rp:0},n=RANKS[i+1];
  return {name:r.id.charAt(0).toUpperCase()+r.id.slice(1),idx:i,next:n?n.id.charAt(0).toUpperCase()+n.id.slice(1):"",need:n?n.rp-(rp|0):0,frac:n?((rp|0)-r.rp)/Math.max(1,n.rp-r.rp):1};}
function spectate(o){var w=window.open("","_blank");api("spectate",o).then(function(r){
  if(!r.ok){if(w)w.close();say(r.error||"Could not spectate",true);return;}
  if(w)w.location.href=r.url;else location.href=r.url;say("Opened room "+r.code+" (link good for 10 minutes)");});}
/* a win-rate table: one row per mode or item, most played first */
function rateTable(title,rows,label){
  var list=Object.keys(rows||{}).map(function(k){return {k:k,g:rows[k][0]|0,w:rows[k][1]|0};}).filter(function(x){return x.g>0;}).sort(function(a,b){return b.g-a.g;});
  if(!list.length)return null;
  return el("div",{},[el("h4",{text:title,style:"margin:10px 0 4px"}),el("div",{class:"tbl"},[el("table",{},[el("tr",{},[label,"Games","Wins","Win rate",""].map(function(h){return el("th",{text:h});}))].concat(list.map(function(x){
    var r=x.w/x.g,bar=el("div",{class:"meter",style:"width:110px;margin:0"});var bi=el("i");bi.style.width=Math.round(r*100)+"%";bi.style.background=r>=.6?"var(--good)":(r>=.4?"var(--acc)":"var(--bad)");bar.appendChild(bi);
    return el("tr",{},[el("td",{text:x.n||x.k}),el("td",{text:num(x.g)}),el("td",{text:num(x.w)}),el("td",{text:pct(x.w,x.g)}),el("td",{},[bar])]);})))])]);}
function always(tab,id){var l=CAT[tab]||[];for(var i=0;i<l.length;i++)if(l[i].id===id)return !!l[i].f;return false;}
function itemName(k){var p=k.split(":");return nameOf(p[0],p[1]);}
function open(sub){CUR=sub;if(VIEW==="overview")go("players");api("get",{sub:sub}).then(function(j){if(j._s!==200){say(j.error||"Could not load",true);return;}draw(sub,j);});}
/* ---- one player ---- */
function draw(sub,j){
  var R=document.getElementById("right");R.innerHTML="";R.scrollTop=0;
  var s=j.save||{},a=j.acct||{},ban=j.ban,st=j.stats,hist=j.hist||[],sus=j.sus||{score:0,why:[]};
  R.appendChild(el("h2",{},[(a.name||s.netName||"(no name yet)")].concat(ban?[el("span",{class:"tag bad",text:"BANNED"})]:[])));
  R.appendChild(el("p",{class:"mute",text:"Account "+sub+" \\u00b7 first seen "+ago(a.first)+" \\u00b7 last seen "+ago(a.last)+(a.rooms&&a.rooms.length?" \\u00b7 rooms "+a.rooms.slice(0,5).join(", "):"")}));
  // right now: what they have on, where they are on the ladder, and a way to watch
  var rk=rankOf(s.rp|0),ld=[["Blade","sword",s.eqSword],["Ability","abil",s.eqAbil],["Skin","skin",s.eqSkin]];
  var rbar=el("div",{class:"meter"});var rbi=el("i");rbi.style.width=Math.round(rk.frac*100)+"%";rbi.style.background="var(--acc)";rbar.appendChild(rbi);
  R.appendChild(el("div",{class:"box"},[el("div",{class:"grid"},ld.map(function(x){return el("div",{class:"card"},[el("div",{class:"mute",text:x[0]}),
      el("div",{class:"v",text:x[2]?nameOf(x[1],x[2]):"-"}),el("div",{class:"mute",text:x[2]?rarOf(x[1],x[2]):""})]);}).concat([
      el("div",{class:"card"},[el("div",{class:"mute",text:"Rank"}),el("div",{class:"v",text:rk.name+" \u00b7 "+num(s.rp)+" RP"}),
        el("div",{class:"mute",text:rk.next?(num(rk.need)+" RP to "+rk.next):"Top rank"}),rbar])])),
    el("div",{class:"row",style:"margin-top:10px"},[el("button",{class:"good",text:"\u25b6 Spectate",on:function(){spectate({sub:sub});}}),
      el("span",{class:"mute",text:"Opens the game watching their online room. Matches against bots run on their own device and can't be watched."})])]));
  // suspicion
  var sc=sus.score|0,col=sc>=50?"var(--bad)":(sc>=20?"var(--warn)":"var(--good)");
  R.appendChild(el("div",{class:"box"},[el("div",{class:"row"},[el("b",{text:"Suspicion "+sc+" / 100"}),el("span",{class:"mute",text:sc>=50?"look closely":(sc>=20?"worth a look":"looks normal")})]),
    (function(){var m=el("div",{class:"meter"});var i=el("i");i.style.width=sc+"%";i.style.background=col;m.appendChild(i);return m;})(),
    sus.why&&sus.why.length?el("ul",{style:"margin:6px 0 0 18px;padding:0"},sus.why.map(function(w){return el("li",{text:w});})):el("div",{class:"mute",text:"Nothing unusual in the numbers."})]));
  // actions
  R.appendChild(el("h3",{text:"Talk to them, kick, ban"}));
  var mt=el("textarea",{placeholder:"Message \\u2014 shows up on their screen right away if they are in a room, otherwise the next time they open the game"});
  var kr=el("input",{placeholder:"Kick reason (optional)"});kr.style.minWidth="220px";
  R.appendChild(el("div",{class:"box"},[mt,el("div",{class:"row",style:"margin-top:8px"},[el("button",{class:"good",text:"Send message",on:function(){if(!mt.value.trim())return;
    api("msg",{sub:sub,text:mt.value}).then(function(r){if(!r.ok){say(r.error||"Could not send",true);return;}say(r.reached?"Delivered live":"Saved \\u2014 they get it next time they play");open(sub);});}}),
    el("span",{class:"grow"}),kr,el("button",{class:"warn",text:"Kick from room",on:function(){api("kick",{sub:sub,text:kr.value||"Removed by an admin"}).then(function(r){say(r.reached?"Kicked (kept out of that room for 10 minutes)":"They are not in a room right now",!r.reached);});}})])]));
  if(ban){R.appendChild(el("div",{class:"flag ban"},[el("b",{text:(ban.auto?"Banned automatically":"Banned by you")+" "+ago(ban.at)}),el("div",{text:ban.why||""})]));
    R.appendChild(el("button",{class:"good",text:"Unban",on:function(){api("unban",{sub:sub}).then(function(){say("Unbanned");open(sub);});}}));}
  else{var why=el("input",{placeholder:"Ban reason (they see this)"});why.style.minWidth="260px";
    R.appendChild(el("div",{class:"row"},[why,el("button",{class:"bad",text:"Ban",on:function(){if(!confirm("Ban this player?"))return;
      api("ban",{sub:sub,why:why.value||"banned by admin"}).then(function(){say("Banned");open(sub);});}})]));}
  if((j.sent||[]).length){R.appendChild(el("h3",{text:"Messages you sent"}));
    j.sent.slice().reverse().forEach(function(m){R.appendChild(el("div",{class:"flag",style:"border-color:var(--acc)"},[el("span",{class:"mute",text:when(m.at)+(m.live?" \\u00b7 delivered live":" \\u00b7 by inbox")}),el("div",{text:m.text})]));});}
  // statistics
  R.appendChild(el("h3",{text:"Statistics"}));
  if(!st)R.appendChild(el("p",{class:"mute",text:"No games recorded yet (stats start from this server update)."}));
  else{
    var rec=hist.slice(-10),rb=0,rp2=0;rec.forEach(function(h){rb+=h.bl;rp2+=h.pf;});
    var mph=(st.mt||[]).filter(function(t){return Date.now()-t<3600000;}).length;
    var hrs=(st.secs||0)/3600;
    var g=el("div",{class:"grid"});
    [["Games",num(st.g)],["Wins",num(st.w)],["Win rate",pct(st.w,st.g),st.g>=40&&st.w/st.g>=0.9?"bad":""],["Win streak",num(st.sk),st.sk>=25?"bad":(st.sk>=15?"warn":"")],["Best streak",num(st.bsk)],
     ["Ranked W\\u2013L",num(st.rw)+"\\u2013"+num(st.rg-st.rw)],["Ranked best streak",num(st.rbsk)],["Timed blocks",num(st.bl)],
     ["Perfect % (all)",pct(st.pf,st.bl),st.bl>=100&&st.pf/st.bl>=0.7?"bad":(st.bl>=100&&st.pf/st.bl>=0.55?"warn":"")],["Perfect % (last 10)",pct(rp2,rb),rb>=40&&rp2/rb>=0.8?"bad":""],
     ["Played",hrs>=1?hrs.toFixed(1)+" h":Math.round(hrs*60)+" min"],["Matches last hour",num(mph),mph>40?"warn":""],
     ["Coins earned",num(st.ec.c)],["Yen earned",num(st.ec.y)],["RP earned",num(st.ec.rp)],["Coins spent",num(st.sp.c)],["Yen spent",num(st.sp.y)],["Items gained",num(st.it)]]
      .forEach(function(c){g.appendChild(el("div",{class:"card"},[el("div",{class:"mute",text:c[0]}),el("div",{class:"v "+(c[2]||""),text:c[1]})]));});
    R.appendChild(g);
    // win rates: all time (since this update) by mode and by what they had on
    if(st.by){R.appendChild(el("h3",{text:"Win rates"}));
      var MN={classic:"Classic",gauntlet:"Gauntlet",duel:"1v1 Duel",pro:"1v1 Pro",chaos:"1v1 Chaos",swarm:"Swarm",trick:"Trick or Treat",ranked1:"Ranked 1v1",ranked2:"Ranked 2v2",mp:"Online casual",mpranked2:"Online ranked 2v2",god1:"GOD 1v1"};
      var tbl=function(t,rows,tab,lab){var tb=rateTable(t,rows,lab);if(!tb)return;
        tb.querySelectorAll("tr").forEach(function(tr,i){if(!i)return;var td=tr.firstChild;td.textContent=tab?nameOf(tab,td.textContent):(MN[td.textContent]||td.textContent);});R.appendChild(tb);};
      var rk2=0,rw2=0,ck=0,cw=0,wk=0,ww=0;hist.forEach(function(h){var rd=/ranked|god/.test(h.m);if(rd){rk2++;if(h.won)rw2++;}else{ck++;if(h.won)cw++;}if(Date.now()-h.at<7*864e5){wk++;if(h.won)ww++;}});
      var g3=el("div",{class:"grid"});
      [["Ranked (last "+hist.length+")",pct(rw2,rk2)+" of "+rk2],["Casual (last "+hist.length+")",pct(cw,ck)+" of "+ck],["Last 7 days",pct(ww,wk)+" of "+wk]]
        .forEach(function(c){g3.appendChild(el("div",{class:"card"},[el("div",{class:"mute",text:c[0]}),el("div",{class:"v",text:c[1]})]));});
      R.appendChild(g3);
      tbl("By mode",st.by.m,null,"Mode");tbl("By blade",st.by.s,"sword","Blade");tbl("By ability",st.by.a,"abil","Ability");tbl("By skin",st.by.k,"skin","Skin");}
    // perfect % per match, oldest to newest
    if(hist.length){R.appendChild(el("h3",{text:"Perfect % per match (last "+hist.length+")"}));
      var W=600,Hh=70,bw=W/Math.max(hist.length,20),ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 "+W+" "+Hh);svg.setAttribute("class","bars");svg.setAttribute("preserveAspectRatio","none");
      var gl=document.createElementNS(ns,"line");gl.setAttribute("x1",0);gl.setAttribute("x2",W);gl.setAttribute("y1",Hh*0.2);gl.setAttribute("y2",Hh*0.2);gl.setAttribute("stroke","#5a1c26");gl.setAttribute("stroke-dasharray","4 4");svg.appendChild(gl);
      hist.forEach(function(h,i){var r=h.bl?h.pf/h.bl:0,bh=Math.max(1,r*(Hh-4)),re=document.createElementNS(ns,"rect");
        re.setAttribute("x",i*bw+1);re.setAttribute("y",Hh-bh);re.setAttribute("width",Math.max(1,bw-2));re.setAttribute("height",bh);
        re.setAttribute("fill",!h.bl?"#263056":(r>=0.8&&h.bl>=5?"#ff5a6e":(r>=0.55?"#ffd23f":"#5fd8ff")));
        var tt=document.createElementNS(ns,"title");tt.textContent=when(h.at)+": "+h.pf+"/"+h.bl+" perfect";re.appendChild(tt);svg.appendChild(re);});
      R.appendChild(svg);R.appendChild(el("div",{class:"mute",text:"Each bar is one match. Red: 80%+ perfect (the dashed line). A script usually shows up as a wall of red."}));}
    // days
    var days=Object.keys(st.d||{}).sort().reverse();
    if(days.length){R.appendChild(el("h3",{text:"By day"}));
      R.appendChild(el("div",{class:"tbl"},[el("table",{},[el("tr",{},["Day","Games","Wins","Coins","Yen","RP"].map(function(h){return el("th",{text:h});}))].concat(days.map(function(k){var d=st.d[k];
        return el("tr",{},[el("td",{text:k}),el("td",{text:num(d.g)}),el("td",{text:num(d.w)}),el("td",{},[signed(d.c)]),el("td",{},[signed(d.y)]),el("td",{},[signed(d.rp)])]);})))]));}
  }
  // matches
  if(hist.length){R.appendChild(el("h3",{text:"Match history"}));
    R.appendChild(el("div",{class:"tbl"},[el("table",{},[el("tr",{},["When","Mode","Result","Loadout","Length","Blocks","Perfect","Coins","RP"].map(function(h){return el("th",{text:h});}))].concat(hist.slice().reverse().map(function(h){
      var hot=h.bl>=5&&h.pf/h.bl>=0.8;
      return el("tr",{class:(hot?"hot ":"")+(h.won?"won":"")},[el("td",{text:when(h.at)}),el("td",{text:h.m}),el("td",{text:h.won?"Won":"Lost"}),el("td",{style:"white-space:normal",text:h.sw?[nameOf("sword",h.sw),nameOf("abil",h.ab),nameOf("skin",h.sk)].join(" \u00b7 "):"-"}),el("td",{text:h.secs+"s"}),
        el("td",{text:num(h.bl)}),el("td",{text:pct(h.pf,h.bl)}),el("td",{},[signed(h.c)]),el("td",{},[signed(h.rp)])]);})))]));}
  // ledger
  var lg=(j.ledger||[]).slice().reverse();
  if(lg.length){R.appendChild(el("h3",{text:"Every coin, yen, RP and item change"}));
    var KIND={match:"Match",chest:"Chest",limited:"Limited shop",sell:"Sold",upgrade:"Upgrader",exchange:"Exchange",slots:"Slots",bj:"Blackjack",passbuy:"Pass",code:"Code",admin:"You (admin)"};
    R.appendChild(el("div",{class:"tbl"},[el("table",{},[el("tr",{},["When","From","Coins","Yen","RP","Items"].map(function(h){return el("th",{text:h});}))].concat(lg.map(function(x){
      var it=(x.got||[]).map(function(k){return "+"+itemName(k);}).concat((x.lost||[]).map(function(k){return "\\u2212"+itemName(k);})).join(", ");
      return el("tr",{},[el("td",{text:when(x.at)}),el("td",{text:KIND[x.k]||x.k}),el("td",{},[signed(x.dc)]),el("td",{},[signed(x.dy)]),el("td",{},[signed(x.drp)]),el("td",{style:"white-space:normal",text:it})]);})))]));}
  // gifts: what you give below pops up in their game, with this note
  R.appendChild(el("h3",{text:"Gift pop-up"}));
  var gNote=el("input",{type:"text",maxlength:"300",placeholder:"Optional note, e.g. GG on the tournament!",style:"width:100%;max-width:520px"});
  var gPop=el("input",{type:"checkbox"});gPop.checked=true;
  R.appendChild(el("div",{class:"row"},[gNote]));
  R.appendChild(el("label",{class:"mute",style:"display:inline-flex;gap:6px;align-items:center;margin-top:6px"},[gPop,el("span",{text:"Show them a gift pop-up for items, coins, yen and spins given"})]));
  var giftOpts=function(){return {note:gNote.value,silent:!gPop.checked};};
  // money
  R.appendChild(el("h3",{text:"Coins, yen, RP (edit)"}));
  var g2=el("div",{class:"grid"}),inputs={};
  [["coins","Coins"],["yen","Yen"],["rp","RP"],["freeSpins","Free spins"]].forEach(function(k){
    var i=el("input",{type:"number",min:"0",value:String(s[k[0]]|0)});inputs[k[0]]=i;g2.appendChild(el("label",{class:"card"},[el("span",{class:"mute",text:k[1]}),i]));});
  R.appendChild(g2);
  R.appendChild(el("p",{},[el("button",{text:"Save these",on:function(){var ed=[];for(var k in inputs)ed.push({k:"set",key:k,v:Math.max(0,parseInt(inputs[k].value,10)||0)});
    api("edit",Object.assign({sub:sub,edits:ed},giftOpts())).then(function(r){say(r.ok?"Saved":"Could not save",!r.ok);open(sub);});}})]));
  // items
  [["sword","swords","Blades"],["abil","abils","Abilities"],["skin","skins","Skins"]].forEach(function(t){
    var bag=s[t[1]]||{},ids=Object.keys(bag).filter(function(id){return bag[id];});
    R.appendChild(el("h3",{text:t[2]+" ("+ids.length+")"}));
    R.appendChild(el("div",{class:"chips"},ids.map(function(id){return el("span",{class:"chip",style:always(t[0],id)?"padding-right:10px":""},[nameOf(t[0],id),
      always(t[0],id)?null:el("button",{class:"bad",title:"Remove",text:"\\u00d7",on:function(){api("edit",{sub:sub,edits:[{k:"del",tab:t[0],id:id}]}).then(function(){say("Removed "+nameOf(t[0],id));open(sub);});}})]);})));
    var sel=el("select",{},(CAT[t[0]]||[]).filter(function(x){return !bag[x.id];}).map(function(x){return el("option",{value:x.id,text:x.n+" ("+x.r+")"});}));
    R.appendChild(el("div",{class:"row",style:"margin-top:8px"},[sel,el("button",{text:"Give",on:function(){if(!sel.value)return;
      api("edit",Object.assign({sub:sub,edits:[{k:"add",tab:t[0],id:sel.value}]},giftOpts())).then(function(){say("Gave "+nameOf(t[0],sel.value));open(sub);});}})]));});
  // flags
  var fl=(j.flags||[]).slice().reverse();
  R.appendChild(el("h3",{text:"Anticheat and history ("+fl.length+")"}));
  if(!fl.length)R.appendChild(el("p",{class:"mute",text:"Nothing caught."}));
  fl.forEach(function(f){R.appendChild(el("div",{class:"flag"+(f.sev==="ban"?" ban":"")},[el("b",{text:f.kind+(f.sev==="ban"?" \\u00b7 ban-level":"")+"  "}),
    el("span",{class:"mute",text:when(f.at)+" ("+ago(f.at)+")"}),el("div",{text:f.detail||""})]));});
}
</script></body></html>`;
}
