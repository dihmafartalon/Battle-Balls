/* =====================================================================
   The server-side host. Every multiplayer match runs here: the ball, the
   bots, every block, every ability's effect, every hit and who won. The
   players' games are all guests -- they show what this sends and send back
   only their own movement and button presses.

   It is the game's own code (simgame.js, built from site/index.html by
   tools/buildsim.cjs) running with no screen: a stand-in for the browser
   below soaks up everything that would draw, play a sound or touch the page.
   ===================================================================== */
import * as THREE_ from "three";
import { bootGame } from "./simgame.js";

export const SIM_ID = "srv";                 // the host's player id, as the games see it
const TICK_MS = 1000 / 60;

/* ---------- a browser with nothing in it ---------- */
const nop = function () {};
// anything not listed reads as a do-nothing function: el.scrollIntoView(), ctx.arc(), ...
function soak(base) {
  return new Proxy(base, {
    get(t, k) { if (k in t) return t[k]; if (typeof k === "symbol") return undefined; return nop; },
    set(t, k, v) { t[k] = v; return true; }
  });
}
function ctx2d() {
  const img = (w, h) => ({ width: w | 0, height: h | 0, data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)) });
  return soak({
    canvas: null, font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, textAlign: "", textBaseline: "",
    measureText: s => ({ width: String(s || "").length * 8 }),
    createImageData: img, getImageData: (x, y, w, h) => img(w, h),
    createLinearGradient: () => ({ addColorStop: nop }), createRadialGradient: () => ({ addColorStop: nop }),
    createPattern: () => ({})
  });
}
function makeEl(tag) {
  const cls = new Set();
  const el = {
    tagName: String(tag || "div").toUpperCase(), nodeType: 1, id: "", className: "",
    textContent: "", innerHTML: "", innerText: "", value: "", checked: false, disabled: false, hidden: false,
    width: 300, height: 150, clientWidth: 1280, clientHeight: 720, offsetWidth: 100, offsetHeight: 100,
    scrollTop: 0, scrollLeft: 0, scrollHeight: 0, children: [], childNodes: [], parentNode: null, parentElement: null,
    firstChild: null, lastChild: null, dataset: {}, attributes: [],
    style: soak({ setProperty: nop, removeProperty: nop, getPropertyValue: () => "" }),
    classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; on ? cls.add(c) : cls.delete(c); return on; },
      contains: c => cls.has(c), replace: nop },
    appendChild: c => c, removeChild: c => c, insertBefore: c => c, replaceChild: c => c, append: nop, prepend: nop,
    remove: nop, replaceChildren: nop, before: nop, after: nop,
    setAttribute: nop, getAttribute: () => null, removeAttribute: nop, hasAttribute: () => false,
    addEventListener: nop, removeEventListener: nop, dispatchEvent: () => true,
    querySelector: () => makeEl("div"), querySelectorAll: () => [], getElementsByTagName: () => [], getElementsByClassName: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, x: 0, y: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    closest: () => null, contains: () => false, cloneNode: () => makeEl(tag), matches: () => false,
    focus: nop, blur: nop, click: nop, select: nop, scrollIntoView: nop, scrollTo: nop,
    requestPointerLock: nop, requestFullscreen: () => Promise.resolve(),
    play: () => Promise.resolve(), pause: nop, load: nop,
    getContext: () => { const c = ctx2d(); return c; },
    toDataURL: () => "data:,", toBlob: nop
  };
  return soak(el);
}
function makeEnv(timers) {
  const byId = new Map(), store = new Map();
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] || null, get length() { return store.size; } };
  const document = soak({
    getElementById: id => { if (!byId.has(id)) { const e = makeEl("div"); e.id = id; byId.set(id, e); } return byId.get(id); },
    createElement: t => makeEl(t), createElementNS: (ns, t) => makeEl(t), createTextNode: () => makeEl("#text"),
    createDocumentFragment: () => makeEl("fragment"),
    querySelector: () => makeEl("div"), querySelectorAll: () => [], getElementsByTagName: () => [], getElementsByClassName: () => [],
    addEventListener: nop, removeEventListener: nop,
    body: makeEl("body"), head: makeEl("head"), documentElement: makeEl("html"),
    hidden: false, visibilityState: "visible", fullscreenElement: null, pointerLockElement: null, activeElement: null,
    cookie: "", title: "", readyState: "complete", exitPointerLock: nop, exitFullscreen: () => Promise.resolve(), hasFocus: () => true
  });
  const perf = { now: () => performance.now() };
  const location = { href: "https://sim/", origin: "https://sim", hostname: "sim", host: "sim", protocol: "https:", pathname: "/", search: "", hash: "", reload: nop, replace: nop };
  const navigator = { userAgent: "battle-balls-sim", maxTouchPoints: 0, language: "en", languages: ["en"], onLine: true,
    vibrate: nop, clipboard: { writeText: () => Promise.resolve() }, getGamepads: () => [] };
  const window = soak({
    document, localStorage, navigator, location, performance: perf,
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, screen: { width: 1280, height: 720 },
    addEventListener: nop, removeEventListener: nop, dispatchEvent: () => true,
    requestAnimationFrame: () => 0, cancelAnimationFrame: nop,
    matchMedia: () => ({ matches: false, addEventListener: nop, removeEventListener: nop, addListener: nop, removeListener: nop }),
    getComputedStyle: () => soak({ getPropertyValue: () => "" }),
    history: { replaceState: nop, pushState: nop, back: nop },
    open: nop, alert: nop, confirm: () => false, prompt: () => null, scrollTo: nop, focus: nop,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    // the game must never reach the network from inside the server
    fetch: () => Promise.reject(new Error("no network in the sim")),
    WebSocket: undefined, AudioContext: undefined, webkitAudioContext: undefined, google: undefined
  });
  // three.js with nothing to draw on: the scene graph and maths are real, the renderer is not
  class StubRenderer {
    constructor() {
      this.domElement = makeEl("canvas");
      this.shadowMap = { enabled: false, type: 0 };
      this.info = { render: { calls: 0, triangles: 0 }, memory: {}, reset: nop };
      this.capabilities = { isWebGL2: true, maxTextureSize: 4096, getMaxAnisotropy: () => 1 };
      this.toneMapping = 0; this.toneMappingExposure = 1; this.outputEncoding = 0; this.autoClear = true;
      return soak(this);
    }
    render() {} setSize() {} setPixelRatio() {} getPixelRatio() { return 1; } setClearColor() {}
    getSize(v) { return v ? v.set(1280, 720) : { x: 1280, y: 720 }; } compile() {} dispose() {} clear() {}
    getContext() { return soak({}); } setAnimationLoop() {} getRenderTarget() { return null; } setRenderTarget() {}
  }
  const THREE = Object.assign({}, THREE_, { WebGLRenderer: StubRenderer });
  return {
    window, document, navigator, location, localStorage, performance: perf,
    requestAnimationFrame: () => 0, cancelAnimationFrame: nop,
    Image: function () { return makeEl("img"); }, Audio: function () { return makeEl("audio"); }, AudioContext: undefined,
    fetch: window.fetch, WebSocket: undefined, alert: nop, confirm: () => false, prompt: () => null,
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, getComputedStyle: window.getComputedStyle, matchMedia: window.matchMedia,
    addEventListener: nop, removeEventListener: nop, google: undefined, history: window.history, screen: window.screen,
    Blob: typeof Blob !== "undefined" ? Blob : function () {}, URL: typeof URL !== "undefined" ? URL : {},
    self: window, setTimeout: timers.setTimeout, setInterval: timers.setInterval, clearTimeout: timers.clearTimeout, clearInterval: timers.clearInterval,
    THREE, BAKED_MUSIC: "", Event: function () {}, KeyboardEvent: function () {}, HTMLElement: function () {},
    atob: typeof atob !== "undefined" ? atob : (s => s), btoa: typeof btoa !== "undefined" ? btoa : (s => s)
  };
}

// three.js grumbles about material options the game sets for the browser: not news on a server
let quieted = false;
function quietThree() {
  if (quieted) return; quieted = true;
  const w = console.warn.bind(console);
  console.warn = (...a) => { if (typeof a[0] === "string" && a[0].startsWith("THREE.")) return; w(...a); };
}

/* ---------- the host ---------- */
export class SimHost {
  /* out(msg): everything the host says, for every player.
     Timers are tracked so a finished room can drop every one of them. */
  constructor(out) {
    this.out = out;
    this.timers = new Set();
    const T = this.timers;
    const timers = {
      setTimeout: (fn, ms, ...a) => { const h = setTimeout(() => { T.delete(h); try { fn(...a); } catch (e) { this.fault(e); } }, ms); T.add(h); return h; },
      clearTimeout: h => { T.delete(h); clearTimeout(h); },
      setInterval: (fn, ms, ...a) => { const h = setInterval(() => { try { fn(...a); } catch (e) { this.fault(e); } }, ms); T.add(h); return h; },
      clearInterval: h => { T.delete(h); clearInterval(h); }
    };
    quietThree();
    this.env = makeEnv(timers);
    this.g = null;
    bootGame({ env: this.env, hook: g => { this.g = g; } });
    if (!this.g) throw new Error("the game did not boot");
    this.g.boot();
    this.maps = this.g.maps();
    const NET = this.g.NET;
    NET.you = SIM_ID; NET.host = SIM_ID; NET.isHost = true; NET.srv = true;
    NET.ws = { readyState: 1, send: () => {} };     // netTick and friends check for a socket
    NET.rtt = 0;
    this.g.setSend(o => { try { this.out(o); } catch (e) {} return true; });
    this.loop = null; this.last = 0; this.errors = 0; this.running = false;
  }
  fault(e) {
    this.errors++;
    if (this.errors < 5) console.log("sim error:", e && (e.stack || e.message || e));
  }
  roster(r) {
    // the host is never on the roster: it plays no one, it only runs the match
    try { this.g.netHandle(r); } catch (e) { this.fault(e); }
  }
  // the room decided a match starts: the same start message every player gets
  start(msg, roster) {
    this.roster(roster);
    try { this.g.netHandle(msg); } catch (e) { this.fault(e); return false; }
    this.running = true;
    this.last = performance.now();
    if (!this.loop) this.loop = setInterval(() => this.tick(), TICK_MS);
    return true;
  }
  // a player's own message: their movement, a block, an ability, a swing
  feed(msg) {
    if (!this.running) return;
    try { this.g.netHandle(msg); } catch (e) { this.fault(e); }
  }
  tick() {
    const now = performance.now();
    // the clock only moves between events here: never step more than a fraction of a second at once
    try { this.g.frame(now); } catch (e) { this.fault(e); }
    this.last = now;
    const st = this.g.get().STATE;
    if (st === "over" || !this.g.NET.on) this.finishSoon();
  }
  finishSoon() {
    if (this.endT) return;
    this.endT = setTimeout(() => { this.endT = null; this.stop(); }, 2500);
  }
  stop() {
    this.running = false;
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    if (this.endT) { clearTimeout(this.endT); this.endT = null; }
    for (const h of this.timers) { clearTimeout(h); clearInterval(h); }
    this.timers.clear();
    try { this.g.reset(); } catch (e) { this.fault(e); }
  }
  state() { return this.g.get(); }
}
