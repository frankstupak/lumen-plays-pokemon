// wq#484 — spawning one rdv_side process and reading its report lines back.
// Extracted from probe_m5c3 (wq#511) so the M5d orchestrator drives a side
// exactly the way the M5c gate does; two copies of this would drift, and a
// difference in how the sides are launched is indistinguishable from a
// difference in the link itself.
import { spawn } from "child_process";
import { resolve } from "path";

/** Spawn from THIS tree, not from wherever the probe was invoked. */
export const REPO_ROOT = resolve(__dirname, "..", "..");

export interface Side {
  code: number | null;
  out: string;
  /** the rendezvous report (`RESULT {...}`). */
  res?: any;
  /** the 415-byte block + M5b invariant report (`BLOCKCHECK {...}`). */
  block?: any;
  /** wq#484 per-transfer latency summary (`LATENCY {...}`). */
  lat?: any;
  /** wq#484 the swap verdict (`TRADECHECK {...}`), only in RDV_CONTINUE=trade. */
  trade?: any;
  /** wq#3201 the battle verdict (`BATTLECHECK {...}`), only in RDV_CONTINUE=battle. */
  battle?: any;
}

/** Pull the LAST occurrence of a one-line JSON report. Last, not first: a side
 *  that retried prints more than one, and the final one is the outcome. */
export function reportLine(out: string, tag: string): any {
  const ms = [...out.matchAll(new RegExp(`${tag} (\\{.*\\})`, "g"))];
  if (ms.length === 0) return undefined;
  try { return JSON.parse(ms[ms.length - 1][1]); } catch { return undefined; }
}

/**
 * One side, from launch to exit. Never rejects: a side that times out or dies is
 * a RESULT to assert on, not an exception for the caller to translate — the exit
 * code carries the wq#510 semantics (0 ok / 3 terminal / 4 stranded) and a
 * thrown error would lose it.
 */
export function spawnSide(env: Record<string, string>, timeoutMs: number): Promise<Side> {
  return new Promise(res => {
    const p = spawn("npx", ["tsx", "src/link/rdv_side.ts"], { cwd: REPO_ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", d => { out += d.toString(); });
    p.stderr.on("data", d => { out += d.toString(); });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    p.on("close", code => {
      clearTimeout(t);
      res({
        code, out,
        res: reportLine(out, "RESULT"),
        block: reportLine(out, "BLOCKCHECK"),
        lat: reportLine(out, "LATENCY"),
        trade: reportLine(out, "TRADECHECK"),
        battle: reportLine(out, "BATTLECHECK"),
      });
    });
  });
}
