// M4 duel grid: one server, two Game Boys side by side.
//
// Deliberately SEPARATE from src/stream.ts. That server is wired into the live
// single-player service and its page assumes one screen; forking a small
// dedicated server costs a hundred lines and keeps the live kiosk untouchable.
// Same throttling discipline as stream.ts: frames are best-effort video, the
// pair runs many times realtime, and a back-pressured client must be allowed to
// drop frames rather than grow an unbounded send queue.

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const PAGE = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>LUMEN DUEL — link battle</title>
<style>
 :root{--bg:#0d0f14;--fg:#e8eef7;--dim:#7d8799;--a:#7cc7ff;--b:#ff9d7c}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 ui-monospace,Menlo,monospace}
 h1{font-size:15px;letter-spacing:.22em;margin:14px 0 10px;text-align:center;color:var(--dim)}
 .grid{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;padding:0 14px 18px}
 .side{flex:1 1 320px;max-width:460px}
 .cap{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
 .who{font-weight:700;letter-spacing:.1em}
 .A .who{color:var(--a)} .B .who{color:var(--b)}
 .model{color:var(--dim);font-size:12px}
 img{width:100%;image-rendering:pixelated;background:#000;border-radius:6px;display:block}
 .hud{margin-top:8px;font-size:13px}
 .row{display:flex;justify-content:space-between;border-bottom:1px solid #1c2029;padding:3px 0}
 .row span:last-child{color:var(--dim)}
 .bar{height:6px;background:#1c2029;border-radius:3px;overflow:hidden;margin-top:6px}
 .bar i{display:block;height:100%;background:var(--a)}
 .B .bar i{background:var(--b)}
 #log{max-width:940px;margin:0 auto 24px;padding:0 14px;color:var(--dim);font-size:12px}
 #log div{border-bottom:1px solid #161a22;padding:2px 0}
</style>
<h1>LUMEN DUEL &mdash; LINK BATTLE</h1>
<div class=grid>
  <div class="side A" id=sA></div>
  <div class="side B" id=sB></div>
</div>
<div id=log></div>
<script>
const mk = t => \`<div class=cap><span class=who>SIDE \${t}</span><span class=model id=m\${t}>-</span></div>
 <img id=i\${t}><div class=hud>
 <div class=row><span>HP</span><span id=hp\${t}>-</span></div>
 <div class=bar><i id=bar\${t} style="width:100%"></i></div>
 <div class=row><span>LAST MOVE</span><span id=mv\${t}>-</span></div>
 <div class=row><span>TURN</span><span id=tn\${t}>-</span></div>
 <div class=row><span>TOKENS</span><span id=tk\${t}>-</span></div></div>\`;
sA.innerHTML = mk('A'); sB.innerHTML = mk('B');
const log = m => { const d=document.createElement('div'); d.textContent=m;
  document.getElementById('log').prepend(d);
  while (document.getElementById('log').childElementCount>40) document.getElementById('log').lastChild.remove(); };
function apply(m){
  if(m.kind==='frame'){ document.getElementById('i'+m.side).src='data:image/png;base64,'+m.b64; return; }
  if(m.kind==='hud'){ const t=m.side;
    document.getElementById('m'+t).textContent=m.model||'-';
    document.getElementById('hp'+t).textContent=m.hp+'/'+m.maxHp;
    document.getElementById('bar'+t).style.width=Math.max(0,100*m.hp/(m.maxHp||1))+'%';
    document.getElementById('mv'+t).textContent=m.move||'-';
    document.getElementById('tn'+t).textContent=m.turn??'-';
    document.getElementById('tk'+t).textContent=m.tokens??'-'; return; }
  if(m.kind==='log') log(m.text);
}
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
ws.onmessage=e=>apply(JSON.parse(e.data));
ws.onclose=()=>log('-- stream closed --');
</script>`;

export class DuelStream {
  private clients = new Set<WebSocket>();
  private last: Record<string, Buffer> = {};
  private lastAt: Record<string, number> = { A: 0, B: 0 };
  constructor(port: number) {
    const srv = createServer((req, res) => {
      const m = req.url?.match(/^\/snap([AB])\.png/);
      if (m && this.last[m[1]]) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(this.last[m[1]]); return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE);
    });
    new WebSocketServer({ server: srv, path: "/ws" }).on("connection", ws => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
    });
    srv.listen(port, "0.0.0.0", () => console.log(`duel stream on :${port}`));
  }
  send(obj: object): void {
    const s = JSON.stringify(obj);
    for (const c of this.clients)
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 256 * 1024) c.send(s);
  }
  frame(side: string, png: Buffer): void {
    this.last[side] = png;                       // /snapA.png pollers get the freshest
    const now = Date.now();
    if (now - this.lastAt[side] < 100) return;   // <=10fps per side
    this.lastAt[side] = now;
    this.send({ kind: "frame", side, b64: png.toString("base64") });
  }
}
