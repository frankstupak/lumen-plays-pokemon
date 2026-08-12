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
#game { image-rendering:pixelated; height:min(100vh - 162px, (100vw - 220px) * 0.9); aspect-ratio:160/144; background:#000; border:2px solid #30363d; border-radius:6px; }
#hud { min-width:165px; font-size:12px; line-height:1.7; text-align:center; }
#hud b { color:#58a6ff; }
#title { color:#58a6ff; font-size:14px; letter-spacing:2px; line-height:1.5; margin-bottom:10px; }
#bottom { height:104px; border-top:2px solid #30363d; padding:6px 16px; overflow:hidden; background:#010409; }
#ticker { font-size:12px; line-height:1.6; height:100%; overflow-y:auto; scrollbar-width:thin; }
#ticker div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.k-tool { color:#d29922; } .k-state { color:#3fb950; } .k-think { color:#bc8cff; } .k-sys { color:#8b949e; }
#pwr { height:28px; border-top:2px solid #30363d; background:#010409; display:flex; align-items:center; gap:12px; padding:0 16px; font-size:12px; white-space:nowrap; }
#pwr b { color:#58a6ff; }
#pwrmeter { flex:1; max-width:340px; height:12px; background:#161b22; border:1px solid #30363d; border-radius:6px; overflow:hidden; }
#pwrfill { height:100%; width:0%; background:linear-gradient(90deg,#3fb950,#d29922,#f85149); transition:width .8s; }
#pwrstats span { margin-left:14px; } #pwrstats .v { color:#3fb950; }
</style></head><body>
<div id="top"><img id="game"><div id="hud"><div id="title">LUMEN PLAYS:<br>POKEMON!</div><div id="hudbody">connecting…</div></div></div>
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
      "<br><b style='color:#d29922'>CONTINUES</b> <span style='color:#f0b429;font-weight:bold'>" + retriesTxt.c + "</span>" +
      "<br><b style='color:#d29922'>WHITE-OUTS</b> <span style='color:#f0b429;font-weight:bold'>" + retriesTxt.w + "</span>" +
      "<br><span style='color:#8b949e;font-size:10px'>RESTARTS (infra) " + retriesTxt.b + "</span>";
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
let retriesTxt = { c: "…", w: "…", b: "…" };
async function pollRetries() {
  try {
    const r = await (await fetch("/retries.json", { cache: "no-store" })).json();
    if (r.continues === null || r.continues === undefined) { retriesTxt = { c: "…", w: "…", b: "…" }; return; }
    // wq#470: continues = gameplayContinues; serviceBoots = infra restarts (dim line)
    retriesTxt = { c: r.continues, w: r.whiteouts, b: (r.serviceBoots ?? "…") };
  } catch (e) { retriesTxt = { c: "…", w: "…", b: "…" }; }
}
pollRetries(); setInterval(pollRetries, 30000);

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
  retryStats: (() => { continues: number; gameplayContinues: number; serviceBoots: number; whiteouts: number }) | null = null;
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
        res.end(JSON.stringify(this.retryStats ? this.retryStats() : { continues: null, gameplayContinues: null, serviceBoots: null, whiteouts: null }));
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
