// HTTP + WebSocket stream server: serves the kiosk page and broadcasts frames/events
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { PowerMeter } from "./power";

// Changes on every server (re)start; the page polls /version.json and
// reloads itself on mismatch so kiosk clients never run a stale page.
const BOOT_STAMP = Date.now();

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lumen Plays Pokemon</title><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; color:#c9d1d9; font-family:'SF Mono',Menlo,monospace; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
#top { flex:1; display:flex; align-items:center; justify-content:center; gap:18px; padding:10px; min-height:0; }
/* wq#503: flex:none is load-bearing. The trainer panel is a flex sibling, and
   without this the browser is free to shrink the game frame to make room for
   it. "Do not shrink the game frame" is then structural, not arithmetic. */
#game { flex:none; image-rendering:pixelated; height:min(100vh - 162px, (100vw - 220px) * 0.9); aspect-ratio:160/144; background:#000; border:2px solid #30363d; border-radius:6px; }
#hud { min-width:165px; font-size:12px; line-height:1.7; text-align:center; }
#hud b { color:#58a6ff; }
#title { color:#58a6ff; font-size:14px; letter-spacing:2px; line-height:1.5; margin-bottom:10px; }
/* Trainer stats panel (wq#503). Takes the leftover width the kiosk was
   wasting: at the tablet's 1368x912 CSS viewport the game is height-bound at
   833px wide, leaving ~314px here. Sized to stay readable across the room. */
#stats { flex:1 1 0; min-width:0; max-width:360px; align-self:stretch; overflow-y:auto; overflow-x:hidden; text-align:left; padding:2px 4px; scrollbar-width:thin; }
#stats h3 { color:#58a6ff; font-size:11px; letter-spacing:2px; font-weight:600; border-bottom:1px solid #30363d; padding-bottom:3px; margin:12px 0 6px; }
#stats h3:first-child { margin-top:0; }
.row { display:flex; justify-content:space-between; align-items:baseline; gap:10px; line-height:1.5; }
.lab { color:#8b949e; font-size:12px; letter-spacing:1px; white-space:nowrap; }
.val { color:#c9d1d9; font-size:16px; font-weight:600; text-align:right; overflow:hidden; text-overflow:ellipsis; }
.val.big { font-size:19px; color:#58a6ff; }
.sub { color:#6e7681; font-size:11px; line-height:1.5; }
.mon { border-top:1px solid #21262d; padding:5px 0; }
.mon:first-child { border-top:none; }
.hpbar { height:9px; background:#161b22; border:1px solid #30363d; border-radius:5px; overflow:hidden; margin:3px 0 2px; }
.hpfill { height:100%; width:0%; transition:width .5s; }
#stuck { display:none; background:#3d1418; border:2px solid #f85149; border-radius:6px; padding:7px 9px; margin-bottom:10px; }
#stuck .hd { color:#f85149; font-size:17px; font-weight:700; letter-spacing:2px; }
#stuck .why { color:#ffa198; font-size:12px; line-height:1.45; margin-top:3px; }
#bottom { height:208px; border-top:2px solid #30363d; padding:6px 16px; overflow:hidden; background:#010409; }
#ticker { font-size:12px; line-height:1.6; height:100%; overflow-y:auto; scrollbar-width:thin; }
#ticker div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.k-tool { color:#d29922; } .k-state { color:#3fb950; } .k-think { color:#bc8cff; } .k-sys { color:#8b949e; }
#pwr { height:28px; border-top:2px solid #30363d; background:#010409; display:flex; align-items:center; gap:12px; padding:0 16px; font-size:12px; white-space:nowrap; }
#pwr b { color:#58a6ff; }
#pwrmeter { flex:1; max-width:340px; height:12px; background:#161b22; border:1px solid #30363d; border-radius:6px; overflow:hidden; }
#pwrfill { height:100%; width:0%; background:linear-gradient(90deg,#3fb950,#d29922,#f85149); transition:width .8s; }
#pwrstats span { margin-left:14px; } #pwrstats .v { color:#3fb950; }
</style></head><body>
<div id="top"><img id="game"><div id="hud"><div id="title">LUMEN PLAYS:<br>POKEMON!</div><div id="hudbody">connecting…</div></div><div id="stats">
<div id="stuck"><div class="hd">STUCK</div><div class="why" id="stuckwhy"></div></div>
<h3>TRAINER</h3>
<div class="row"><span class="lab">WHERE</span><span class="val big" id="s-map">--</span></div>
<div class="sub" id="s-pos">&nbsp;</div>
<div class="row"><span class="lab">BADGES</span><span class="val" id="s-badges">--</span></div>
<div class="sub" id="s-badgenames">&nbsp;</div>
<div class="row"><span class="lab">POKEDEX</span><span class="val" id="s-dex">--</span></div>
<div class="row"><span class="lab">MONEY</span><span class="val" id="s-money">--</span></div>
<div class="row"><span class="lab">PLAY TIME</span><span class="val" id="s-time">--</span></div>
<h3>PARTY</h3>
<div id="s-party"><div class="sub">--</div></div>
<h3>PROGRESS</h3>
<div class="row"><span class="lab">STORY</span><span class="val" id="s-story">--</span></div>
<div class="row"><span class="lab">PACE</span><span class="val" id="s-pace">--</span></div>
<div class="row"><span class="lab">TOKENS</span><span class="val" id="s-tok">--</span></div>
<div class="row"><span class="lab">MILESTONE</span><span class="val" id="s-ms">--</span></div>
<div class="sub" id="s-msago">&nbsp;</div>
<div class="lab" style="margin-top:8px">OBJECTIVE</div>
<div class="sub" id="s-goal" style="white-space:normal">--</div>
</div></div>
<div id="bottom"><div id="ticker"></div></div>
<div id="pwr"><b>TABLET&nbsp;PWR</b><div id="pwrmeter"><div id="pwrfill"></div></div><div id="pwrstats">…</div></div>
<script>
const img = document.getElementById("game"), hud = document.getElementById("hudbody"), ticker = document.getElementById("ticker");
let gotWsData = false, polling = false, seen = new Set();

function renderEvent(m) {
  if (m.kind === "frame") { img.src = "data:image/png;base64," + m.b64; return; }
  // one dedup gate for BOTH paths (WS + polling run concurrently)
  const k = (m.t || "") + (m.kind || "") + (m.line || m.turn || "");
  if (seen.has(k)) return; seen.add(k);
  if (seen.size > 600) seen = new Set([...seen].slice(-150));
  if (m.kind === "state_read") {
    hud.innerHTML = "<b>MAP</b> " + m.map + " &nbsp;<b>POS</b> " + m.x + "," + m.y +
      "<br><b>BADGES</b> " + m.badgeCount + " &nbsp;<b>MONEY</b> ₽" + m.money +
      "<br><b>PARTY</b> " + (m.partyCount || "none") + "<br><b>BATTLE</b> " + (m.inBattle ? "YES" : "no") +
      // wq#547: the CONTINUES tile is GONE from the gameplay block. It was not
      // miscounting - it counts brain-fail-streak/softlock resumes, which fired
      // 217 times in August - but that is a HARNESS statistic sitting next to
      // badges, and it has read 0 since the counter was created on 08-12. It
      // now sits on the infra line beside RESTARTS, which is where wq#547 itself
      // argues it belongs. WHITE-OUTS shows the MEASURED count; the hand-typed
      // pre-instrumentation estimate is rendered separately and dim so it can
      // never be mistaken for a live number.
      "<br><b style='color:#d29922'>WHITE-OUTS</b> <span style='color:#f0b429;font-weight:bold'>" + retriesTxt.w + "</span>" +
      (retriesTxt.e && retriesTxt.e !== "0"
        ? "<span style='color:#8b949e;font-size:10px'> +" + retriesTxt.e + " est. pre-08-13</span>" : "") +
      "<br><span style='color:#8b949e;font-size:10px'>RESTARTS (infra) " + retriesTxt.b
        + " &middot; resumes " + retriesTxt.c + "</span>";
    renderStats(m);   // wq#503
  }
  const cls = m.kind === "tool_call" ? "k-tool" : m.kind === "state_read" ? "k-state" : m.kind === "think_chunk" ? "k-think" : "k-sys";
  const d = document.createElement("div"); d.className = cls;
  d.textContent = new Date(m.t || Date.now()).toLocaleTimeString() + "  " + m.kind.toUpperCase() + "  " + JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => !["kind","t","b64"].includes(k)))).slice(0, 220);
  // Scrollable history: newest on top. If the viewer has scrolled down into
  // the past, keep their view pinned by offsetting the prepended row height.
  const scrolled = ticker.scrollTop > 4;
  ticker.prepend(d);
  if (scrolled) ticker.scrollTop += d.offsetHeight;
  while (ticker.children.length > 250) ticker.lastChild.remove();
}

// Polling runs from t=0 alongside the WebSocket: the CF-tunnel path often
// stalls WS negotiation for seconds (or breaks it entirely), and waiting on
// it is what made the page sit at "connecting…". Events dedup in renderEvent;
// snapshot polls yield to WS frames whenever the socket is delivering.
function startPolling() {
  if (polling) return; polling = true;
  setInterval(() => { if (!gotWsData) img.src = "/snap.png?t=" + Date.now(); }, 1000);
  setInterval(async () => {
    try {
      const evs = await (await fetch("/events.json", { cache: "no-store" })).json();
      for (const m of evs) renderEvent(m);
    } catch (e) {}
  }, 1500);
}

function connect() {
  let ws;
  try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws"); }
  catch (e) { return; }
  ws.onmessage = ev => { gotWsData = true; renderEvent(JSON.parse(ev.data)); };
  ws.onclose = () => { gotWsData = false; setTimeout(connect, 2000); };
}
connect();
startPolling();

// Tablet power bar: E1 plug via server-side HA proxy. 50W meter ceiling
// (Surface Pro 6 charger is 44W; battery-buffered so draw is bursty).
const pwrfill = document.getElementById("pwrfill"), pwrstats = document.getElementById("pwrstats");
async function pollPower() {
  try {
    const p = await (await fetch("/power.json", { cache: "no-store" })).json();
    if (p.w === null || p.w === undefined) { pwrstats.textContent = "no data"; return; }
    pwrfill.style.width = Math.min(100, p.w / 50 * 100).toFixed(1) + "%";
    pwrstats.innerHTML =
      "<span><b>NOW</b> <span class=v>" + p.w.toFixed(1) + "W</span></span>" +
      "<span><b>AVG</b> <span class=v>" + p.avg_w.toFixed(1) + "W</span></span>" +
      "<span><b>TOTAL</b> <span class=v>" + p.kwh.toFixed(3) + " kWh</span></span>" +
      "<span><b>COST FOR LUMEN TO PLAY POKEMON</b> <span class=v>$" + p.cost.toFixed(2) + "</span></span>";
  } catch (e) { pwrstats.textContent = "…"; }
}
pollPower(); setInterval(pollPower, 15000);

// Lumen continue counter: lifetime resets (boots) + in-game white-outs.
// Rendered inside the HUD stats list (under BATTLE); the hud is rebuilt on
// every state_read, so we just keep the latest text in a var it reads.
let retriesTxt = { c: "…", w: "…", b: "…", e: "" };
async function pollRetries() {
  try {
    const r = await (await fetch("/retries.json", { cache: "no-store" })).json();
    if (r.continues === null || r.continues === undefined) { retriesTxt = { c: "…", w: "…", b: "…", e: "" }; return; }
    // wq#470: continues = gameplayContinues (now the dim infra "resumes").
    // wq#547: w = OBSERVED blackouts only; e = frozen pre-instrumentation estimate.
    retriesTxt = { c: r.continues, w: r.whiteouts, b: (r.serviceBoots ?? "…"),
                   e: String(r.whiteoutsEstimatePre ?? "") };
  } catch (e) { retriesTxt = { c: "…", w: "…", b: "…", e: "" }; }
}
pollRetries(); setInterval(pollRetries, 30000);

// ── wq#503 trainer stats panel ───────────────────────────────────────────
// Name tables are ROM-derived server-side and fetched ONCE per page load, so
// state_read stays numeric and the ticker underneath stays readable. Every
// renderer below falls back to "--" (or the raw id) rather than to a guess.
const el = id => document.getElementById(id);
const DASH = "--";
let NAMES = null;
fetch("/names.json", { cache: "no-store" }).then(r => r.json()).then(j => { NAMES = j; }).catch(e => {});

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function mapLabel(id) {
  if (typeof id !== "number") return DASH;
  const n = NAMES && NAMES.maps ? NAMES.maps[id] : null;
  return n || ("MAP " + id);        // a raw id is a fact; a made-up name is not
}
function statusOf(b) {
  if (!b) return "OK";
  if (!NAMES || !NAMES.statusBits) return "?";
  const on = NAMES.statusBits.filter(p => b & p[0]).map(p => p[1]);
  return on.length ? on.join("+") : "OK";
}
function agoText(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return DASH;
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h >= 1 ? (h + "h " + (m % 60) + "m ago") : (m + "m ago");
}

function renderStats(m) {
  el("s-map").textContent = mapLabel(m.map);
  el("s-pos").textContent = "map " + m.map + "  ·  x" + m.x + " y" + m.y + (m.inBattle ? "  ·  IN BATTLE" : "");
  el("s-badges").textContent = (m.badgeCount != null ? m.badgeCount : DASH) + "/8";
  if (NAMES && NAMES.badges && typeof m.badges === "number") {
    const got = NAMES.badges.filter((_, i) => (m.badges >> i) & 1);
    el("s-badgenames").textContent = got.length ? got.join(", ") : "none yet";
  }
  el("s-dex").textContent = (m.pokedexOwned != null ? m.pokedexOwned : DASH) + " own · " +
    (m.pokedexSeen != null ? m.pokedexSeen : DASH) + " seen";
  el("s-money").textContent = m.money != null ? ("₽" + m.money) : DASH;
  el("s-time").textContent = (m.playH != null && m.playM != null)
    ? (m.playH + "h " + pad2(m.playM) + "m") : DASH;
  const box = el("s-party");
  if (!Array.isArray(m.party) || !m.party.length) { box.innerHTML = '<div class="sub">' + DASH + '</div>'; return; }
  box.innerHTML = m.party.map(p => {
    const nm = (NAMES && NAMES.mons && NAMES.mons[p.species]) || ("SPECIES " + p.species);
    const f = p.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 0;
    const col = f > 0.5 ? "#3fb950" : (f > 0.25 ? "#d29922" : "#f85149");
    return '<div class="mon"><div class="row"><span class="val" style="text-align:left">' + nm +
      '</span><span class="lab">L' + p.level + '</span></div>' +
      '<div class="hpbar"><div class="hpfill" style="width:' + (f * 100).toFixed(0) + '%;background:' + col + '"></div></div>' +
      '<div class="row"><span class="sub">' + p.hp + "/" + p.maxHp + '</span><span class="sub">' + statusOf(p.status) + '</span></div></div>';
  }).join("");
}

// Slow half of the panel: milestone, objective, rates, stuck signal.
async function pollProgress() {
  try {
    const p = await (await fetch("/progress.json", { cache: "no-store" })).json();
    el("s-story").textContent = p.storyScore != null ? (p.storyScore + "/" + p.storyMax) : DASH;
    el("s-pace").textContent = (p.rates && p.rates.turnsPerH != null)
      ? (Math.round(p.rates.turnsPerH) + " t/h · " + Math.round(p.rates.brainPerH) + " brain/h") : DASH;
    if (p.tokens) {
      const t = p.tokens;
      const perTurn = t.perTurn ? (Math.round(t.perTurn.avg) + "/turn(" + t.perTurn.window + "t)") : DASH;
      const perCall = t.perCall ? (Math.round(t.perCall.avgPrompt + t.perCall.avgCompletion) + "/call") : DASH;
      const totalM = ((t.campaign.promptTotal + t.campaign.completionTotal) / 1e6).toFixed(2) + "M total";
      el("s-tok").textContent = perTurn + " · " + perCall + " · " + totalM;
    } else { el("s-tok").textContent = DASH; }
    if (p.milestone) {
      el("s-ms").textContent = p.milestone.label;
      el("s-msago").textContent = (p.milestone.seeded ? "first seen " : "reached ") + agoText(p.milestone.firstSeen);
    } else { el("s-ms").textContent = DASH; el("s-msago").innerHTML = "&nbsp;"; }
    el("s-goal").textContent = p.objective || DASH;
    const s = el("stuck");
    if (p.stuck && p.stuck.active) { s.style.display = "block"; el("stuckwhy").textContent = p.stuck.reasons.join(" · "); }
    else { s.style.display = "none"; }
  } catch (e) {}
}
pollProgress(); setInterval(pollProgress, 10000);

// One-shot geometry beacon. The kiosk layout is tuned for a viewport nobody
// had actually measured; this reports the real one so the claim can be checked
// after deploy instead of assumed. Runs after layout has settled.
setTimeout(() => {
  try {
    const r = img.getBoundingClientRect();
    fetch("/viewport?w=" + innerWidth + "&h=" + innerHeight + "&dpr=" + (devicePixelRatio || 1) +
      "&gw=" + Math.round(r.width) + "&gh=" + Math.round(r.height) +
      "&sw=" + Math.round(el("stats").getBoundingClientRect().width), { cache: "no-store" });
  } catch (e) {}
}, 2500);

// Kiosk staleness guard: the tablet's Firefox loads this page ONCE and then
// runs it for days — server restarts reconnect the WS but never re-fetch the
// HTML, so HUD features shipped after page-load silently don't exist on the
// kiosk. Poll the server's boot stamp; when it changes, hard-reload the page.
let bootStamp = null;
setInterval(async () => {
  try {
    const v = await (await fetch("/version.json", { cache: "no-store" })).json();
    if (bootStamp === null) bootStamp = v.boot;
    else if (v.boot !== bootStamp) location.reload();
  } catch (e) {}
}, 60000);
</script></body></html>`;

export class StreamServer {
  private clients = new Set<WebSocket>();
  private lastPng: Buffer | null = null;
  private recent: object[] = [];
  private power = new PowerMeter();
  // set by live_agent after RetryCounter construction; null-safe until then
  // wq#470: continues = gameplayContinues (kiosk number); serviceBoots = infra restarts
  // wq#547: whiteouts is OBSERVED-only; whiteoutsEstimatePre rides alongside.
  retryStats: (() => { continues: number; gameplayContinues: number; serviceBoots: number; whiteouts: number; whiteoutsEstimatePre: number }) | null = null;
  // wq#503: set by live_agent once the ROM name tables and the progress
  // trackers exist. Null-safe until then — the page renders "--" and the raw
  // map id rather than blocking on them.
  names: (() => object) | null = null;
  progress: (() => object) | null = null;
  /** Last geometry the kiosk reported about itself (see the beacon in PAGE).
   *  Kept so the layout can be checked against the tablet's REAL viewport. */
  lastViewport: object | null = null;
  constructor(port: number) {
    const srv = createServer((req, res) => {
      // Polling endpoints: fallback for clients whose WebSocket path is broken
      // (in-app webviews, odd CDN protocol negotiation). Plain GETs work
      // anywhere the HTML loads.
      if (req.url?.startsWith("/snap.png")) {
        if (this.lastPng) { res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); res.end(this.lastPng); }
        else { res.writeHead(204); res.end(); }
        return;
      }
      if (req.url?.startsWith("/events.json")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(this.recent));
        return;
      }
      if (req.url?.startsWith("/power.json")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(this.power.stats()));
        return;
      }
      if (req.url?.startsWith("/version.json")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ boot: BOOT_STAMP }));
        return;
      }
      if (req.url?.startsWith("/retries.json")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(this.retryStats ? this.retryStats() : { continues: null, gameplayContinues: null, serviceBoots: null, whiteouts: null, whiteoutsEstimatePre: null }));
        return;
      }
      // wq#503: static-per-ROM name tables, fetched once per page load.
      if (req.url?.startsWith("/names.json")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(this.names ? this.names() : { maps: {}, mons: {}, badges: [], statusBits: [] }));
        return;
      }
      // wq#503: the derived half of the panel (milestone / objective / rates /
      // stuck). Polled every 10s; everything RAM-fast rides state_read instead.
      if (req.url?.startsWith("/progress.json")) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(this.progress ? this.progress() : null));
        return;
      }
      // wq#503: the kiosk reports its own viewport here on load, and the same
      // path GETs it back. Measurement, so the layout is never argued from an
      // assumed resolution.
      if (req.url?.startsWith("/viewport")) {
        const q = new URL(req.url, "http://x").searchParams;
        if ([...q.keys()].length) {
          const num = (k: string) => { const v = Number(q.get(k)); return Number.isFinite(v) ? v : null; };
          this.lastViewport = {
            at: new Date().toISOString(), w: num("w"), h: num("h"), dpr: num("dpr"),
            gameW: num("gw"), gameH: num("gh"), statsW: num("sw"),
          };
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(this.lastViewport));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE);
    });
    const wss = new WebSocketServer({ server: srv, path: "/ws" });
    wss.on("connection", ws => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
    });
    srv.listen(port, "0.0.0.0", () => console.log(`stream server on :${port}`));
  }
  broadcast(obj: object) {
    // Trim bulky fields (multi-KB reasoning dumps) before they hit slow clients.
    const o: any = { ...obj };
    if (typeof o.reasoning === "string") o.reasoning = o.reasoning.slice(0, 300);
    if (typeof o.think === "string") o.think = o.think.slice(0, 300);
    if (typeof o.grid === "string") delete o.grid;
    if (!o.t) o.t = new Date().toISOString();
    this.recent.push(o);
    if (this.recent.length > 100) this.recent.shift();
    const s = JSON.stringify(o);
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  private lastFrameAt = 0;
  /**
   * Frames are best-effort video, not events. The emulator runs ~25x realtime,
   * so unthrottled frames are megabytes/sec - a phone client back-pressures,
   * the socket queue grows without bound, and the viewer sees a black screen
   * with events stuck behind the backlog. Cap at 10fps and skip clients whose
   * send buffer is already deep; dropped frames cost nothing.
   */
  broadcastFrame(png: Buffer) {
    this.lastPng = png;   // always keep the freshest frame for /snap.png pollers
    const now = Date.now();
    if (now - this.lastFrameAt < 100) return;   // <=10fps
    this.lastFrameAt = now;
    const s = JSON.stringify({ kind: "frame", b64: png.toString("base64") });
    for (const c of this.clients)
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 256 * 1024) c.send(s);
  }
}
