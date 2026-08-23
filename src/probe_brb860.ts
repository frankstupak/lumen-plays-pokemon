// wq#860 probe: StreamServer survives EADDRINUSE from a port squatter.
// Starts a dummy server on :8871, then constructs a StreamServer on the same
// port. The StreamServer must retry and succeed once the squatter is killed,
// rather than crashing the process. This is the exact failure mode that
// caused 712 restarts and a 1h40m outage.
import { createServer } from "http";
import { StreamServer } from "./stream";

const PORT = 18871; // use a test port so this probe never conflicts with live

async function main() {
  // 1. Start a squatter on the test port
  const squatter = createServer((_, res) => { res.writeHead(200); res.end("squatter"); });
  await new Promise<void>((resolve, reject) => {
    squatter.listen(PORT, "0.0.0.0", () => {
      console.log(`[probe] squatter bound to :${PORT}`);
      resolve();
    });
    squatter.on("error", reject);
  });

  // 2. Try to start StreamServer on the same port — it should retry, not crash
  console.log("[probe] constructing StreamServer on occupied port...");
  const stream = new StreamServer(PORT);

  // 3. After 3 seconds, kill the squatter to free the port
  setTimeout(() => {
    console.log("[probe] killing squatter to free port");
    squatter.close();
  }, 3000);

  // 4. Wait for the StreamServer to bind (check by polling /version.json)
  const deadline = Date.now() + 30000;
  let bound = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/version.json`);
      if (res.ok) { bound = true; break; }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }

  if (bound) {
    console.log("[probe] PASS: StreamServer bound after squatter released");
    process.exit(0);
  } else {
    console.error("[probe] FAIL: StreamServer never bound within 30s");
    process.exit(1);
  }
}

main().catch(e => { console.error("[probe] FAIL:", e); process.exit(1); });
