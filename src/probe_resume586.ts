// wq#586 — resume ranks Mt Moon positions by ROUTE LEG; warp-tile saves are
// marked and dis-preferred at equal progress.
//
// The audit's evidence (wq#581 A3.2): map61's four pockets and map60's three
// non-exit pockets each collapsed to ONE progressRank, so a fossil-pocket
// checkpoint (L1-L4 walked) tied with a sealed-east-pocket one and raw events
// broke the tie — 2 boots resumed the same east save (03:49Z restart_loop
// sentinel; 18 rewind boots on record). Separately, 100% of the run's
// map-kind checkpoints were written STANDING ON the landing warp tile.
//
// FIX SHAPE: the WRITER stamps `leg` (mtMoonLeg over the live pair-aware map)
// and `onWarp` into v3 sidecars; resume converts leg -> `fine` (LEG_FINE
// ordinal, 0 = unknown = earlier) and sorts rank -> fine -> events -> onWarp.
// The legacy no-sidecar path re-derives both from the loaded emulator.
//
// GREEN: synth-sidecar ordering (L5 beats L1 despite fewer events; legless
// sorts earlier; off-warp beats on-warp at full equality) + a legacy
// slow-path case against a REAL checkpoint. RED (LPP586_RED=1, origin/main):
// the same candidates re-create the audit's mis-pick — events decide, the
// east pocket wins.
//
// ISOLATION: synth candidates + history file live in mkdtemp; the one real
// checkpoint is COPIED there; nothing under /home/lumen/pokemon is written.
//
// SIDE FIX (wq#586, same class as wq#584's probe_claims K): probe_pocket534
// D3 asserted "EVERY map60 checkpoint on disk is a dead pocket" — true of the
// corpus the night wq#534 shipped, and falsified BY THE CAMPAIGN ITSELF the
// moment the agent reached the exit pocket (2026-08-14 05:30Z, run mssgo9l1,
// map60 (23,3)). Live-corpus asserts rot on progress; D3 is now split into
// the durable half (dead-pocket saves rank below B2F) plus the same
// informational reality line.
// Namespace import: RED mode runs this file against origin/main, where the
// wq#586 exports (LEG_FINE) do not exist yet — a named import would break.
import * as R from "./resume";
const { pickResume, readProgress } = R;
const LEG_FINE: Record<string, number> = (R as any).LEG_FINE ?? {};
import { SymbolTable } from "./symbols";
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, utimesSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const CK = `${BASE}/checkpoints`;

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

const RED = process.env.LPP586_RED === "1";
console.log(`== probe_resume586 (${RED ? "RED: expecting the OLD broken ordering" : "GREEN"}) ==`);

const dir = mkdtempSync(join(tmpdir(), "lpp586-"));
const hist = join(dir, "history.json");
const T0 = Date.now() / 1000 - 1000;

/** Write a synth candidate: dummy state.gz + v3-shaped sidecar; fixed mtime. */
function cand(stem: string, side: Record<string, unknown>, mtimeOff = 0): string {
  const f = join(dir, `${stem}.state.gz`);
  writeFileSync(f, "");                        // sidecar path never opens it
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify({
    v: 3, kind: "periodic", badges: 0, events: 0, hpPct: 1, ppOk: true,
    money: 431, ts: Date.now(), storyScore: 6, ...side,
  }));
  utimesSync(f, T0 + mtimeOff, T0 + mtimeOff);
  return f;
}

const noLog = { log: () => {}, historyFile: hist };

// ── A. the audit's exact shape: fossil pocket vs sealed east pocket ──────
// Same story/badges/viability; the east save has MORE raw events (26 vs 20)
// because incidental flags accumulate — the trap that decided 03:49Z.
{
  const east = cand("east-L1", { map: 61, x: 30, y: 11, leg: "L1", onWarp: false, events: 26 }, 10);
  const fossil = cand("fossil-L5", { map: 61, x: 26, y: 17, leg: "L5", onWarp: false, events: 20 }, 0);
  const w = pickResume([dir], sym, ROM, noLog);
  if (RED) {
    chk("R-A1 old comparator lets events pick the SEALED east pocket", w === east,
        w.split("/").pop()!);
  } else {
    chk("A1 fossil pocket (L5) outranks sealed east (L1) despite fewer events", w === fossil,
        w.split("/").pop()!);
    const p = readProgress(fossil, sym, ROM);
    chk("A2 readProgress carries fine=5 from the sidecar leg", p.fine === LEG_FINE.L5,
        `fine=${p.fine}`);
  }
}

// ── B. legless old sidecar = earlier at equal rank (wq#518/534 principle) ─
if (!RED) {
  const d2 = mkdtempSync(join(tmpdir(), "lpp586b-"));
  const mk = (stem: string, side: Record<string, unknown>, off = 0) => {
    const f = join(d2, `${stem}.state.gz`);
    writeFileSync(f, "");
    writeFileSync(join(d2, `${stem}.json`), JSON.stringify({
      v: 2, kind: "periodic", badges: 0, events: 20, hpPct: 1, ppOk: true,
      money: 431, ts: Date.now(), storyScore: 6, ...side,
    }));
    utimesSync(f, T0 + off, T0 + off);
    return f;
  };
  const legless = mk("v2-fossil", { map: 61, x: 26, y: 17 }, 10);           // truly in the pocket, unproved
  const legged = mk("v3-east", { v: 3, map: 61, x: 30, y: 11, leg: "L1" }, 0);
  const w = pickResume([d2], sym, ROM, { log: () => {}, historyFile: join(d2, "h.json") });
  chk("B1 unproved (legless) progress sorts EARLIER at equal rank", w === legged,
      w.split("/").pop()!);
}

// ── C. onWarp is the last quality tiebreak before mtime ──────────────────
if (!RED) {
  const d3 = mkdtempSync(join(tmpdir(), "lpp586c-"));
  const mk = (stem: string, onWarp: boolean, off: number) => {
    const f = join(d3, `${stem}.state.gz`);
    writeFileSync(f, "");
    writeFileSync(join(d3, `${stem}.json`), JSON.stringify({
      v: 3, kind: "map", map: 60, x: onWarp ? 21 : 20, y: 17, leg: "L4", onWarp,
      badges: 0, events: 24, hpPct: 1, ppOk: true, money: 431, ts: Date.now(), storyScore: 6,
    }));
    utimesSync(f, T0 + off, T0 + off);
    return f;
  };
  const on = mk("on-ladder", true, 10);        // NEWER, would win old mtime tiebreak
  const off = mk("off-ladder", false, 0);
  const w = pickResume([d3], sym, ROM, { log: () => {}, historyFile: join(d3, "h.json") });
  chk("C1 off-warp save beats on-warp twin at equal progress (despite older mtime)",
      w === off, w.split("/").pop()!);
  chk("C2 sanity: on-warp sidecar reads onWarp=true", readProgress(on, sym, ROM).onWarp === true);
}

// ── D. legacy slow path: a REAL checkpoint with its sidecar removed ──────
{
  const real = readdirSync(CK).filter(f => f.endsWith(".state.gz")).map(f => {
    const sc = `${CK}/${f.replace(/\.state\.gz$/, ".json")}`;
    if (!existsSync(sc)) return null;
    try {
      const j = JSON.parse(readFileSync(sc, "utf8"));
      return { f, j };
    } catch { return null; }
  }).find(e => e && e.j.map === 61 && !e.j.onWarp);
  if (!real) skipped("D1 legacy path derives leg+onWarp", "no map61 checkpoint on disk");
  else {
    const cp = join(dir, "legacy.state.gz");
    copyFileSync(`${CK}/${real.f}`, cp);        // NO sidecar copied -> slow path
    const p = readProgress(cp, sym, ROM);
    if (RED) {
      chk("R-D1 old Progress has no fine/onWarp fields",
          (p as any).fine === undefined && (p as any).onWarp === undefined,
          JSON.stringify({ fine: (p as any).fine, onWarp: (p as any).onWarp }));
    } else {
      chk("D1 legacy path derives a leg from the loaded map", p.fine > 0,
          `${real.f}: fine=${p.fine}`);
      chk("D2 legacy path derives onWarp from the loaded map", typeof p.onWarp === "boolean",
          `onWarp=${p.onWarp}`);
    }
  }
}

console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
process.exit(fail ? 1 : 0);
