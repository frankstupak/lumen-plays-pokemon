// wq#1829 probe: the live bag must name what it holds.
//
// THE DEFECT. backfillItemNames() has named the bag from THIS ROM's ItemNames
// table since wq#519, but it was only ever CALLED from probes. The live prompt
// therefore still rendered raw ids: run live-agent-1789183317445 (2026-09-12,
// 318 turns, 6.7h) showed
//
//   BAG: item234x1, dome_fossilx1, antidotex1, item49x1, item245x1,
//        item80x1, repelx2, potionx1, item82x1
//
// while the brain was being told it was broke at $96. Five of nine slots were
// unreadable, including id49 — the NUGGET the agent had picked up on Nugget
// Bridge. A brain cannot reason about what it is carrying when the carrier
// prints an integer.
//
// WHAT THIS ASSERTS, AND WHY IT IS A FRESH PROCESS. ITEM_NAME is module state.
// This probe NEVER calls backfillItemNames itself: it checks that the ids are
// unnamed before an Agent exists and named after one is constructed. That is
// the only shape that can tell "the constructor wired it" apart from "some
// other probe in this file already filled the table" — the exact confusion
// that let the gap survive since wq#519.
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Brain } from "./brain";
import { EventBus } from "./events";
import { Agent } from "./agent";
import { ITEM_NAME, itemLabel } from "./items";
import { findFixture, requireFixture, romPath } from "./fixtures";

// The five ids the live bag could not name, with what the ROM calls the three
// that ItemNames covers. 234 and 245 are past the 97-entry table (Gen 1
// machines); itemLabel deliberately refuses to invent a TM number for them.
const NAMED = [[49, "nugget"], [80, "ether"], [82, "elixer"]] as const;
const PAST_TABLE = [234, 245];

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

(async () => {
  console.log("== probe_bagnames1829: an Agent boot names the bag ==");

  // BEFORE. Nothing in this process has backfilled, so the live ids are blank.
  for (const [id] of NAMED)
    chk(`A id ${id} is unnamed before any Agent exists`, ITEM_NAME[id] === undefined,
      String(ITEM_NAME[id]));

  const fx = findFixture(() => true);
  if (!fx) { requireFixture("any checkpoint with a sidecar", fx); return; }

  const rom = new Rom(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym"));
  const emu = new Emulator(romPath("pokeblue.gb"));
  loadSnapshotFile(emu, fx);
  const busDir = mkdtempSync(join(tmpdir(), "lpp1829-bus-"));
  const bus = new EventBus(busDir, "probe1829");
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const rd = new StateReader(emu, sym);
  const ck = mkdtempSync(join(tmpdir(), "lpp1829-ckpt-"));
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, rd,
                          new Brain(bus), bus, ck);

  // AFTER. Construction alone must have filled the table.
  for (const [id, want] of NAMED)
    chk(`B id ${id} names as "${want}" after an Agent is constructed`, itemLabel(id) === want,
      itemLabel(id));
  for (const id of PAST_TABLE)
    chk(`B id ${id} is past ItemNames and stays explicitly unknown (no invented TM)`,
      itemLabel(id) === `unknown_item_${id}`, itemLabel(id));

  const evPath = join(busDir, "probe1829.jsonl");
  const ev = existsSync(evPath) ? readFileSync(evPath, "utf8") : "";
  chk("B the boot is observable in the event log", /"tool":"item_names_backfilled"/.test(ev),
    ev.split("\n").filter(l => l.includes("item_names")).join(" ").slice(0, 120));
  chk("B the backfill did not fail open", !/item_names_backfill_failed/.test(ev));

  // The bag this fixture actually holds, rendered the way the prompt renders it.
  const line = agent.items.bagLine();
  console.log(`   bag: ${line}`);
  const rawIds = line.match(/\bitem\d+x/g) ?? [];
  chk("C no bag slot renders as the old bare 'itemNNN' form", rawIds.length === 0,
    rawIds.join(","));
  const unknown = (line.match(/unknown_item_(\d+)/g) ?? []).map(s => Number(s.split("_")[2]));
  chk("C anything still unnamed is past the ItemNames table, not a gap in it",
    unknown.every(id => id > 97), unknown.join(","));

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
