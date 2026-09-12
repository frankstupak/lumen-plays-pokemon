// wq#1877 acceptance: the door out of Cerulean's north region is one NPC away,
// and the harness now says so — including who moves that NPC.
//
// WHAT THE LIVE AGENT DID (2026-09-12 13:29-18:10Z, storyScore frozen 4.6h).
// The Cascade Badge was already on the card, the supervisor correctly called
// OBJECTIVE_DRIFT@3, and its pin said "your next objective is Route 5, take the
// NEXT LEG the ROUTE line names". The next leg is leave_edge(S), and Route 5 is
// in the half of Cerulean the player cannot walk to (wq#1870). Three K attempts
// went by: 70 gotos sweeping every x of row 35, all no_path, and two
// leave_edge(S) refusals. Nothing the pin asked for was possible.
//
// WHAT IS ACTUALLY TRUE, measured here:
//   - the region's ONE exit is warp 0, the Trashed House at (27,11), whose far
//     door (27,9) opens on the region that owns the Route 5 and Route 9 edges;
//   - it is unreachable because object 11, a STAY guard, holds (27,12), the
//     door's only approach cell. Talking to him does not move him (§B measures
//     that rather than assuming it);
//   - the ROM clears that object in exactly two places, and one of them is
//     BillsHouseBillSSTicketText — Bill handing over the S.S. Ticket. That, not
//     Route 5, is the reachable next objective, and unblock.ts derives it from
//     the ROM instead of anybody typing it in;
//   - stuckHint/edgeStuckHint now name the door, the blocker and that place.
//
// Usage: npx tsx src/probe_guard1877.ts
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { GameNames } from "./names";
import { hiddenObjectSlots, toggleableGlobalIds } from "./objects";
import { warpViews, stuckHint, edgeStuckHint, blockedCrossings, reachableEdges } from "./reach";
import { routeBlock, capsFromBadges } from "./route";
import { hideSites, clearedByLine } from "./unblock";
import { findFixture, requireFixture } from "./fixtures";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CERULEAN = 3;
const STUCK = { x: 25, y: 26 };        // where the live agent burned the turns
const DOOR = { x: 27, y: 11 };
const GUARD = { x: 27, y: 12 };

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

(async () => {
  const sym = new SymbolTable(SYM);
  const rom = new Rom(ROM);
  const names = new GameNames(rom, sym);
  const path = findFixture(sc => sc.map === CERULEAN);
  requireFixture("a checkpoint standing in Cerulean City (map3)", path);
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, path!);
  const map = new MapModel(emu, sym, rom); map.build();
  const st = new StateReader(emu, sym).read();
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp1877-")), "probe1877");
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const views = () => warpViews(map, STUCK.x, STUCK.y, 0, id => names.mapName(id));
  // the same resolver the live agent installs (agent.ts clearedByHint)
  const namer = (bc: { by: { slot: number } }) => {
    const gid = toggleableGlobalIds(emu.mem(), sym).get(bc.by.slot);
    return gid === undefined ? null : clearedByLine(rom, sym, gid, id => names.mapName(id));
  };
  console.log(`fixture ${path!.split("/").pop()} at (${st.x},${st.y}) map${st.map} badges=${st.badgeCount}\n`);

  // ------------------------------------------------ A: the door and its keeper
  console.log("=== A. The region's one exit, and the NPC on its doorstep ===");
  const blocked = blockedCrossings(map, STUCK.x, STUCK.y);
  chk("A1 exactly one blocked crossing is found, and it is the Trashed House door",
    blocked.length === 1 && blocked[0].x === DOOR.x && blocked[0].y === DOOR.y,
    blocked.map(b => `warp ${b.i} (${b.x},${b.y}) blocked by (${b.by.x},${b.by.y})`).join("; ") || "none");
  const bc = blocked[0];
  chk("A2 the blocker is the sprite on the door's only approach cell",
    !!bc && bc.by.x === GUARD.x && bc.by.y === GUARD.y,
    bc ? `(${bc.by.x},${bc.by.y}) pic ${bc.by.pic} slot ${bc.by.slot}` : "-");
  chk("A3 its far door opens on the region owning the Route 5 (S) exit",
    !!bc && bc.far.x === 27 && bc.far.y === 9 && bc.far.edges.includes("S"),
    bc ? `(${bc.far.x},${bc.far.y}) edges=[${bc.far.edges.join(",")}]` : "-");
  chk("A4 and the player's own region still owns only N and W",
    reachableEdges(map, STUCK.x, STUCK.y).join(",") === "N,W",
    `edges=[${reachableEdges(map, STUCK.x, STUCK.y).join(",")}]`);
  chk("A5 the sprite carries its object slot, so it can be resolved to a flag",
    !!bc && !hiddenObjectSlots(emu.mem(), sym).has(bc.by.slot)
      && toggleableGlobalIds(emu.mem(), sym).has(bc.by.slot),
    bc ? `slot ${bc.by.slot} -> global id ${toggleableGlobalIds(emu.mem(), sym).get(bc.by.slot)}` : "-");

  // -------------------------------------- B: the engine, on "just talk to him"
  console.log("\n=== B. Engine ground truth: the guard does not negotiate ===");
  const d = await act.interactAt(GUARD.x, GUARD.y);
  const said = (d?.lines ?? []).join(" ");
  chk("B1 he answers — this is an NPC, not a phantom", said.length > 0, said.slice(-60).trim());
  map.build();
  chk("B2 ...and he is still standing on the approach cell afterwards",
    map.sprites.some(s => s.x === GUARD.x && s.y === GUARD.y),
    `sprites at the door: ${map.sprites.filter(s => s.y <= 13 && s.x >= 25).map(s => `(${s.x},${s.y})`).join(" ")}`);
  chk("B3 the door is still unreachable after talking",
    blockedCrossings(map, nav.pos().x, nav.pos().y).length === 1);

  // ------------------------------------------ C: who clears him, read from ROM
  console.log("\n=== C. unblock.ts: the ROM names the place that clears him ===");
  const gid = toggleableGlobalIds(emu.mem(), sym).get(bc.by.slot)!;
  const sites = hideSites(rom, sym, gid);
  chk("C1 the ROM hides that object somewhere", sites.length > 0,
    sites.map(s => `${s.bank.toString(16)}:${s.addr.toString(16)} ${s.symbol}`
      + `${s.mapId !== null ? ` [${names.mapName(s.mapId)}]` : ""}`).join("; ") || "nowhere");
  chk("C2 one of the sites is Bill handing over the S.S. Ticket",
    sites.some(s => s.symbol.startsWith("BillsHouse")),
    sites.map(s => s.symbol).join(", "));
  chk("C3 and it resolves to a MAP the agent can be sent to",
    sites.some(s => s.mapId !== null && !!names.mapName(s.mapId)),
    sites.filter(s => s.mapId !== null).map(s => `${s.mapId}=${names.mapName(s.mapId!)}`).join(", ") || "none");
  chk("C4 an object nothing hides reports nothing rather than guessing",
    hideSites(rom, sym, 0xfe).length === 0);

  // --------------------------------------------- D: what the brain is now told
  console.log("\n=== D. The refusals name the door, the blocker and the place ===");
  const eh = edgeStuckHint(map, STUCK.x, STUCK.y, "S", views(), CERULEAN, namer);
  console.log(`  leave_edge(S): ${eh.trim()}`);
  chk("D1 leave_edge(S) still says the edge is in the other region",
    /no opening on the S edge is reachable/.test(eh));
  chk("D2 ...and now names the one door out and the NPC on it",
    /warp 0 at \(27,11\)/.test(eh) && /NPC is standing on \(27,12\)/.test(eh));
  chk("D3 ...and where the game clears that NPC", /Bills House/.test(eh));
  const gh = stuckHint(map, STUCK.x, STUCK.y, 20, 34, views(), null, CERULEAN, namer);
  chk("D4 the goto refusal carries the same three facts",
    /warp 0 at \(27,11\)/.test(gh) && /\(27,12\)/.test(gh) && /Bills House/.test(gh));
  chk("D5 it does not offer the shops as a way across",
    !/The way across/.test(gh) && /no second door onto this map/.test(gh));

  // ------------------------------------------ F: the ROUTE line stops ordering it
  console.log("\n=== F. The prompt's own ROUTE line agrees with the map ===");
  const badges = emu.mem()[sym.addr("wObtainedBadges")];
  const here = reachableEdges(map, STUCK.x, STUCK.y);
  const blind = routeBlock(CERULEAN, badges, capsFromBadges(badges), map.warps);
  const seeing = routeBlock(CERULEAN, badges, capsFromBadges(badges), map.warps, here);
  chk("F1 the leg it names is the S edge — the one that cannot be started here",
    !!blind && /NEXT LEG: leave_edge\(S\)/.test(blind), (blind ?? "").split("\n")[1]);
  chk("F2 told which edges work, it says the leg is not startable",
    !!seeing && /NEXT LEG IS NOT STARTABLE/.test(seeing) && /only N\/W work/.test(seeing),
    (seeing ?? "").split("\n").slice(-1)[0]);
  chk("F3 and it says nothing of the kind when the edge IS walkable",
    !/NOT STARTABLE/.test(routeBlock(CERULEAN, badges, capsFromBadges(badges),
      map.warps, ["N", "S", "E", "W"]) ?? ""));

  // ------------------------- E: SYNTHETIC — with the guard gone, no false claim
  console.log("\n=== E. SYNTHETIC (object 11 flagged hidden): the claim retracts ===");
  const fa = sym.addr("wToggleableObjectFlags");
  emu.mem()[fa + (gid >> 3)] |= 1 << (gid & 7);
  map.build();
  chk("E1 no blocked crossing is reported once the door is walkable",
    blockedCrossings(map, STUCK.x, STUCK.y).length === 0);
  const eh2 = edgeStuckHint(map, STUCK.x, STUCK.y, "S", views(), CERULEAN, namer);
  chk("E2 the refusal drops the NPC sentence and offers the crossing instead",
    !/NPC is standing on/.test(eh2) && /The way across: enter_warp\(0\)/.test(eh2),
    eh2.slice(eh2.indexOf("The way across")).slice(0, 90).trim());

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
