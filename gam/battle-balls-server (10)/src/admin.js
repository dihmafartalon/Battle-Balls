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
    return H.jsonRes({ items: out });
  }
  if (b.op === "list") return H.jsonRes((await H.dirCall(env, { op: "list", q: b.q, only: b.only })) || { list: [], total: 0, nodir: true });
  if (b.op === "rooms") return H.jsonRes((await H.dirCall(env, { op: "rooms" })) || { rooms: [] });
  if (!sub) return H.jsonRes({ error: "no player" }, 400);
  if (b.op === "get") {
    const [v, d] = await Promise.all([vault({ op: "adm_get" }), H.dirCall(env, { op: "get", sub })]);
    return H.jsonRes(Object.assign({ acct: d && d.acct }, v));
  }
  if (b.op === "edit") return H.jsonRes(await vault({ op: "adm_edit", edits: b.edits }));
  if (b.op === "ban") return H.jsonRes(await vault({ op: "adm_ban", why: b.why }));
  if (b.op === "unban") return H.jsonRes(await vault({ op: "adm_unban" }));
  return H.jsonRes({ error: "unknown op" }, 400);
}

export function adminPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Battle Balls Admin</title>
<style>
:root{--bg:#0b1020;--panel:#141a30;--line:#263056;--text:#e8ecff;--mute:#8b95c2;--acc:#5fd8ff;--bad:#ff5a6e;--good:#6bffb0;--warn:#ffd23f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{font-size:16px;margin:0;letter-spacing:.04em}h2{font-size:15px;margin:0 0 10px}h3{font-size:12px;letter-spacing:.1em;color:var(--mute);margin:18px 0 8px;text-transform:uppercase}
button,input,select{font:inherit;color:var(--text);background:#1c2444;border:1px solid var(--line);border-radius:8px;padding:7px 11px}
button{cursor:pointer}button:hover{border-color:var(--acc)}button.bad{border-color:var(--bad);color:#ffc2c9}button.good{border-color:var(--good);color:#c8ffe2}
.tabs button.on{background:var(--acc);color:#04121c;border-color:var(--acc)}
main{display:grid;grid-template-columns:minmax(280px,420px) 1fr;gap:0;min-height:calc(100vh - 60px)}
#left{border-right:1px solid var(--line);padding:12px;overflow:auto;max-height:calc(100vh - 60px)}#right{padding:16px 20px;overflow:auto;max-height:calc(100vh - 60px)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.p{padding:9px 10px;border:1px solid var(--line);border-radius:10px;margin:6px 0;cursor:pointer;background:var(--panel)}
.p:hover,.p.sel{border-color:var(--acc)}.p b{display:block}.mute{color:var(--mute);font-size:12px}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);margin-left:6px}
.tag.bad{border-color:var(--bad);color:#ffc2c9}.tag.warn{border-color:var(--warn);color:#ffe9a0}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:99px;padding:3px 4px 3px 10px;font-size:12px;background:var(--panel)}
.chip button{padding:0 7px;border-radius:99px;font-size:12px;line-height:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.card{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--panel)}
.card input{width:100%;margin-top:4px}.flag{border-left:3px solid var(--warn);padding:6px 10px;margin:6px 0;background:var(--panel);border-radius:0 8px 8px 0}
.flag.ban{border-color:var(--bad)}#msg{min-height:20px}.ok{color:var(--good)}.err{color:var(--bad)}
#login{max-width:360px;margin:12vh auto;padding:0 16px}#login input{width:100%;margin:10px 0}
@media (max-width:760px){main{grid-template-columns:1fr}#left{max-height:none;border-right:0;border-bottom:1px solid var(--line)}#right{max-height:none}}
</style></head><body>
<div id="login"><h1>Battle Balls Admin</h1><p class="mute">Enter the admin password.</p>
<input id="pw" type="password" autocomplete="current-password"><button id="go">Sign in</button><p id="lmsg" class="err"></p></div>
<div id="app" hidden><header><h1>Battle Balls Admin</h1><div class="tabs row"><button id="tP" class="on">Players</button><button id="tR">Rooms</button></div>
<span class="grow"></span><span id="msg"></span></header>
<main><section id="left"></section><section id="right"><p class="mute">Pick a player.</p></section></main></div>
<script>
var KEY="",CAT=null,CUR=null,VIEW="players";
function el(t,a,kids){var e=document.createElement(t);if(a)for(var k in a){if(k==="text")e.textContent=a[k];else if(k==="on")e.addEventListener("click",a[k]);else e.setAttribute(k,a[k]);}
  (kids||[]).forEach(function(c){if(c)e.appendChild(typeof c==="string"?document.createTextNode(c):c);});return e;}
function ago(t){if(!t)return "never";var s=(Date.now()-t)/1000;if(s<90)return "just now";if(s<5400)return Math.round(s/60)+" min ago";if(s<129600)return Math.round(s/3600)+" h ago";return Math.round(s/86400)+" days ago";}
function say(t,bad){var m=document.getElementById("msg");m.textContent=t||"";m.className=bad?"err":"ok";}
function api(op,body){body=Object.assign({key:KEY,op:op},body||{});
  return fetch("/admin/api",{method:"POST",body:JSON.stringify(body),headers:{"Content-Type":"text/plain"}}).then(function(r){return r.json().then(function(j){j._s=r.status;return j;});});}
function login(){KEY=document.getElementById("pw").value;api("catalog").then(function(j){
  if(j._s!==200){document.getElementById("lmsg").textContent=j.error||"Could not sign in.";return;}
  CAT=j.items;document.getElementById("login").hidden=true;document.getElementById("app").hidden=false;players();});}
document.getElementById("go").onclick=login;document.getElementById("pw").onkeydown=function(e){if(e.key==="Enter")login();};
document.getElementById("tP").onclick=function(){VIEW="players";tabs();players();};
document.getElementById("tR").onclick=function(){VIEW="rooms";tabs();rooms();};
function tabs(){document.getElementById("tP").className=VIEW==="players"?"on":"";document.getElementById("tR").className=VIEW==="rooms"?"on":"";}
var Q="",ONLY="";
function players(){
  var L=document.getElementById("left");L.innerHTML="";
  var q=el("input",{placeholder:"Search name or account id",value:Q});q.style.width="100%";
  var f=el("select",{},[el("option",{value:"",text:"Everyone"}),el("option",{value:"flagged",text:"Flagged"}),el("option",{value:"banned",text:"Banned"})]);f.value=ONLY;
  var list=el("div");
  function load(){Q=q.value;ONLY=f.value;api("list",{q:Q,only:ONLY}).then(function(j){list.innerHTML="";
    if(j.nodir){list.appendChild(el("p",{class:"err",text:"The player directory is not set up on the server yet."}));return;}
    list.appendChild(el("p",{class:"mute",text:j.total+" player"+(j.total===1?"":"s")}));
    if(!j.total&&!Q&&!ONLY)list.appendChild(el("p",{class:"mute",text:"Players appear here the first time they open the game after this server went up. Open the game signed in, then refresh."}));
    (j.list||[]).forEach(function(a){var tags=[];
      if(a.ban)tags.push(el("span",{class:"tag bad",text:"BANNED"}));else if(a.flags)tags.push(el("span",{class:"tag warn",text:a.flags+" flag"+(a.flags>1?"s":"")}));
      list.appendChild(el("div",{class:"p"+(CUR===a.sub?" sel":""),on:function(){open(a.sub);}},[el("b",{},[a.name||"(no name yet)"].concat(tags)),
        el("span",{class:"mute",text:"id "+a.sub+" \\u00b7 seen "+ago(a.last)})]));});});}
  q.oninput=function(){clearTimeout(q._t);q._t=setTimeout(load,250);};f.onchange=load;
  L.appendChild(el("div",{class:"row"},[q,f]));L.appendChild(list);load();}
function rooms(){var L=document.getElementById("left");L.innerHTML="";
  api("rooms").then(function(j){L.appendChild(el("p",{class:"mute",text:"Recent rooms, newest first. Click a name to open that player."}));
    (j.rooms||[]).forEach(function(r){L.appendChild(el("div",{class:"card",style:"margin:8px 0"},[el("b",{text:"Room "+r.code}),el("span",{class:"mute",text:"  "+ago(r.at)}),
      el("div",{class:"chips",style:"margin-top:6px"},r.players.map(function(p){return el("button",{text:p.name||p.sub,on:function(){open(p.sub);}});}))]));});});}
function nameOf(tab,id){var l=CAT[tab]||[];for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i].n;return id;}
function always(tab,id){var l=CAT[tab]||[];for(var i=0;i<l.length;i++)if(l[i].id===id)return !!l[i].f;return false;}
function open(sub){CUR=sub;api("get",{sub:sub}).then(function(j){if(j._s!==200){say(j.error||"Could not load",true);return;}draw(sub,j);});}
function draw(sub,j){
  var R=document.getElementById("right");R.innerHTML="";
  var s=j.save||{},a=j.acct||{},ban=j.ban;
  R.appendChild(el("h2",{},[(a.name||s.netName||"(no name yet)")].concat(ban?[el("span",{class:"tag bad",text:"BANNED"})]:[])));
  R.appendChild(el("p",{class:"mute",text:"Account "+sub+" \\u00b7 first seen "+ago(a.first)+" \\u00b7 last seen "+ago(a.last)+" \\u00b7 save #"+(j.rev||0)}));
  if(a.rooms&&a.rooms.length)R.appendChild(el("p",{class:"mute",text:"Recent rooms: "+a.rooms.join(", ")}));
  // ban
  R.appendChild(el("h3",{text:"Ban"}));
  if(ban){R.appendChild(el("div",{class:"flag ban"},[el("b",{text:(ban.auto?"Banned automatically":"Banned by you")+" "+ago(ban.at)}),el("div",{text:ban.why||""})]));
    R.appendChild(el("button",{class:"good",text:"Unban",on:function(){api("unban",{sub:sub}).then(function(){say("Unbanned");open(sub);});}}));}
  else{var why=el("input",{placeholder:"Reason (they see this)"});why.style.minWidth="260px";
    R.appendChild(el("div",{class:"row"},[why,el("button",{class:"bad",text:"Ban",on:function(){if(!confirm("Ban this player?"))return;
      api("ban",{sub:sub,why:why.value||"banned by admin"}).then(function(){say("Banned");open(sub);});}})]));}
  // money
  R.appendChild(el("h3",{text:"Coins, yen, RP"}));
  var g=el("div",{class:"grid"}),inputs={};
  [["coins","Coins"],["yen","Yen"],["rp","RP"],["freeSpins","Free spins"]].forEach(function(k){
    var i=el("input",{type:"number",min:"0",value:String(s[k[0]]|0)});inputs[k[0]]=i;g.appendChild(el("label",{class:"card"},[el("span",{class:"mute",text:k[1]}),i]));});
  R.appendChild(g);
  R.appendChild(el("p",{},[el("button",{text:"Save these",on:function(){var ed=[];for(var k in inputs)ed.push({k:"set",key:k,v:Math.max(0,parseInt(inputs[k].value,10)||0)});
    api("edit",{sub:sub,edits:ed}).then(function(r){say(r.ok?"Saved":"Could not save",!r.ok);open(sub);});}})]));
  // items
  [["sword","swords","Blades"],["abil","abils","Abilities"],["skin","skins","Skins"]].forEach(function(t){
    var bag=s[t[1]]||{},ids=Object.keys(bag).filter(function(id){return bag[id];});
    R.appendChild(el("h3",{text:t[2]+" ("+ids.length+")"}));
    R.appendChild(el("div",{class:"chips"},ids.map(function(id){return el("span",{class:"chip",style:always(t[0],id)?"padding-right:10px":""},[nameOf(t[0],id),
      always(t[0],id)?null:el("button",{class:"bad",title:"Remove",text:"\\u00d7",on:function(){api("edit",{sub:sub,edits:[{k:"del",tab:t[0],id:id}]}).then(function(){say("Removed "+nameOf(t[0],id));open(sub);});}})]);})));
    var sel=el("select",{},(CAT[t[0]]||[]).filter(function(x){return !bag[x.id];}).map(function(x){return el("option",{value:x.id,text:x.n+" ("+x.r+")"});}));
    R.appendChild(el("div",{class:"row",style:"margin-top:8px"},[sel,el("button",{text:"Give",on:function(){if(!sel.value)return;
      api("edit",{sub:sub,edits:[{k:"add",tab:t[0],id:sel.value}]}).then(function(){say("Gave "+nameOf(t[0],sel.value));open(sub);});}})]));});
  // flags
  var fl=(j.flags||[]).slice().reverse();
  R.appendChild(el("h3",{text:"Anticheat and history ("+fl.length+")"}));
  if(!fl.length)R.appendChild(el("p",{class:"mute",text:"Nothing caught."}));
  fl.forEach(function(f){R.appendChild(el("div",{class:"flag"+(f.sev==="ban"?" ban":"")},[el("b",{text:f.kind+(f.sev==="ban"?" \\u00b7 ban-level":"")+"  "}),
    el("span",{class:"mute",text:ago(f.at)}),el("div",{text:f.detail||""})]));});
}
</script></body></html>`;
}
