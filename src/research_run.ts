// wq#1053: run one research driver under the systemd watchdog beat.
//
//   npx tsx src/research_run.ts src/link/drive_trade_e2e.ts [driver args...]
//
// The driver is imported in-process, so its Emulator frames feed markResearchProgress().
// Only research entry points are allowed: src/link/* and src/accept_*.ts. The live agent,
// the stream and anything else are refused, so this wrapper can never become a back door
// around DECOMMISSIONED.md (wq#2073).
import { basename, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { startResearchBeat } from "./research_beat.js";

const ROOT = resolve(__dirname, "..");

/** Returns an absolute path when the target is an allowed research driver, else throws. */
export function checkTarget(target: string, root: string = ROOT): string {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || resolve(abs) !== abs) throw new Error(`refusing ${target}: outside the repo`);
  const parts = rel.split(sep);
  const inLink = parts[0] === "src" && parts[1] === "link" && parts.length >= 3 && /\.ts$/.test(rel);
  const accept = parts.length === 2 && parts[0] === "src" && /^accept_.*\.ts$/.test(basename(rel));
  if (!inLink && !accept) throw new Error(`refusing ${target}: only src/link/*.ts and src/accept_*.ts may run here`);
  return abs;
}

async function main() {
  const [target, ...rest] = process.argv.slice(2);
  if (!target) { console.error("usage: research_run.ts <src/link/driver.ts> [args...]"); process.exit(2); }
  let abs: string;
  try { abs = checkTarget(target); } catch (e) { console.error(String((e as Error).message)); process.exit(2); }
  const beat = startResearchBeat();
  console.error(`research_run: ${relative(ROOT, abs)} watchdog=${beat.enabled ? `on stall_after=${beat.stallAfterMs}ms unit=${beat.unit}` : "off (no systemd watchdog)"}`);
  process.argv = [process.argv[0], abs, ...rest];
  await import(pathToFileURL(abs).href);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
