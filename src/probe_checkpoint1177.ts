// wq#1177 item 2 — checkpoint write gate: refuse to persist a checkpoint
// while loadPending, wJoyIgnore, onWarp, or inBattle holds (agent.ts
// maybeCheckpoint/writeCheckpoint; lpp-improvement-plan.md section 1
// "Transition/checkpoint truth" / section 5 item 2). Two of the four
// (loadPending, inBattle) were already gated in maybeCheckpoint before this
// ticket; wJoyIgnore and onWarp are new. All four are exercised here so a
// future change cannot silently drop one.
//
// Drives a real Agent against a real overworld save and monkeypatches the
// condition-reading methods (map.loadPending/isWarp, bat.active, and a
// direct wJoyIgnore RAM poke) rather than trying to script the emulator into
// each transient frame window -- the gate must react to what those methods
// report, not to how rare the real window is.
//
// Usage: npx tsx src/probe_checkpoint1177.ts
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Brain } from "./brain";
import { Agent } from "./agent";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");

(async () => {
  const ck = mkdtempSync(`${tmpdir()}/lpp1177ck-`);
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, "/home/lumen/pokemon/saves/rival1-won.state.gz");
  const rom = new Rom(ROM);
  const bus = new EventBus("/tmp", "probe-1177-" + Date.now());
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const reader = new StateReader(emu, sym);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, new Brain(bus), bus, ck);

  await emu.framesAsync(120);
  const ow = reader.read();

  const skipped: { reason: string }[] = [];
  bus.on((e: any) => { if (e.kind === "tool_call" && e.tool === "checkpoint_skipped") skipped.push(e); });

  const filesNow = () => readdirSync(ck).filter(f => f.endsWith(".state.gz"));
  const attempt = (turn: number) => { agent.turn = turn; agent.maybeCheckpoint(ow, ow); };

  // -- baseline: a clean idle overworld state writes, and the sidecar carries
  // the new v4 stateKey field (item 1's write-side half) --
  attempt(10);   // turn % 10 === 0 -> periodic path
  let files = filesNow();
  chk("baseline: a clean, idle overworld state writes a checkpoint", files.length === 1, files.join(","));
  const sc = JSON.parse(readFileSync(`${ck}/${files[0].replace(/\.state\.gz$/, ".json")}`, "utf8"));
  chk("sidecar is v4 and carries a non-empty stateKey string",
    sc.v === 4 && typeof sc.stateKey === "string" && sc.stateKey.length > 0, JSON.stringify(sc));
  chk("stateKey encodes this write's own map/x/y/story/badges",
    sc.stateKey.startsWith(`${sc.map}:${sc.x}:${sc.y}:${sc.storyScore}:${sc.badges}:`), sc.stateKey);
  chk("baseline write is never onWarp (the gate makes this invariant, not incidental)",
    sc.onWarp === false, JSON.stringify(sc.onWarp));

  // -- gate 1: loadPending (pre-existing gate, re-verified as part of the
  // combined contract) --
  skipped.length = 0;
  const realLoadPending = map.loadPending.bind(map);
  (map as any).loadPending = () => true;
  attempt(20);
  chk("gate: loadPending refuses the write", filesNow().length === 1, filesNow().join(","));
  chk("gate: loadPending skip is logged", skipped.some(s => s.reason === "map_load_pending"), JSON.stringify(skipped));
  (map as any).loadPending = realLoadPending;

  // -- gate 2: wJoyIgnore (new) --
  skipped.length = 0;
  const aJoyIgnore = sym.addr("wJoyIgnore");
  const savedJoyIgnore = emu.mem()[aJoyIgnore];
  emu.mem()[aJoyIgnore] = 1;
  attempt(30);
  chk("gate: wJoyIgnore != 0 refuses the write", filesNow().length === 1, filesNow().join(","));
  chk("gate: wJoyIgnore skip is logged with reason joy_ignore",
    skipped.some(s => s.reason === "joy_ignore"), JSON.stringify(skipped));
  emu.mem()[aJoyIgnore] = savedJoyIgnore;

  // -- gate 3: onWarp (new) --
  skipped.length = 0;
  const realIsWarp = map.isWarp.bind(map);
  (map as any).isWarp = () => true;
  attempt(40);
  chk("gate: onWarp refuses the write", filesNow().length === 1, filesNow().join(","));
  chk("gate: onWarp skip is logged with reason on_warp",
    skipped.some(s => s.reason === "on_warp"), JSON.stringify(skipped));
  (map as any).isWarp = realIsWarp;

  // -- gate 4: inBattle (pre-existing gate, re-verified as part of the
  // combined contract) --
  skipped.length = 0;
  const realActive = bat.active.bind(bat);
  (bat as any).active = () => true;
  attempt(50);
  chk("gate: inBattle refuses the write", filesNow().length === 1, filesNow().join(","));
  (bat as any).active = realActive;

  // -- gates must expire (wq#517/518 lesson): once every condition clears,
  // the very next eligible turn writes normally again, proving none of the
  // four leaves a stuck flag behind --
  attempt(60);
  chk("gates expire: a normal turn after all four conditions clear writes again",
    filesNow().length === 2, filesNow().join(","));

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
