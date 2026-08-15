// wq#503 probe: boots a StreamServer on a spare port (never :8871, so the live
// kiosk is untouched) and checks that the panel's endpoints serve what the
// page expects, including the null-provider path a fresh boot goes through.
//   npx tsx src/probe_panel.ts
import { StreamServer } from "./stream";
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import { GameNames, BADGE_NAMES, STATUS_BITS } from "./names";

const PORT = 8899;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`);
};
const get = async (path: string) => fetch(`http://127.0.0.1:${PORT}${path}`);

(async () => {
  const s = new StreamServer(PORT);
  await new Promise(r => setTimeout(r, 400));

  // Fresh boot: providers unset. The page must still render and degrade to
  // "--" rather than 500 — a kiosk that white-screens during startup is worse
  // than one that shows dashes for ten seconds.
  const empty = await (await get("/names.json")).json();
  ok("names.json before providers are set is an empty-but-valid shape",
    Array.isArray(empty.badges) && empty.badges.length === 0 && typeof empty.maps === "object");
  ok("progress.json before providers are set is null", await (await get("/progress.json")).json() === null);

  const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
  const names = new GameNames(new Rom("/home/lumen/pokemon/roms/pokeblue.gb"), sym);
  s.names = () => ({ maps: names.maps, mons: names.mons, badges: BADGE_NAMES, statusBits: STATUS_BITS });
  // wq#612: tokens field on the same progress() closure, exercising both the
  // populated-window and the empty-window ("--" on the tile) shapes at once.
  s.progress = () => ({ storyScore: 9, storyMax: 25, objective: "cross MT MOON", milestone: null,
    rates: { turnsPerH: 41, brainPerH: 22, at: null }, stuck: { active: false, reasons: [] },
    tokens: {
      perCall: { avgPrompt: 1500, avgCompletion: 250, window: 2 },
      perTurn: null,
      perModel: { x: { avgPrompt: 1500, avgCompletion: 250, calls: 2 } },
      campaign: { promptTotal: 3000, completionTotal: 500, calls: 2, turns: 5 },
    } });

  const n = await (await get("/names.json")).json();
  ok("names.json map 59 is named", n.maps["59"] === "Mt Moon 1F", JSON.stringify(n.maps["59"]));
  ok("names.json species 178 is named", n.mons["178"] === "CHARMELEON", JSON.stringify(n.mons["178"]));
  ok("names.json carries the badge + status tables", n.badges.length === 8 && n.statusBits.length === 6);

  const p = await (await get("/progress.json")).json();
  ok("progress.json round-trips", p.storyScore === 9 && p.objective === "cross MT MOON");
  ok("progress.json tokens field round-trips (populated + empty windows)",
    p.tokens && p.tokens.perCall.avgPrompt === 1500 && p.tokens.perTurn === null && p.tokens.campaign.calls === 2,
    JSON.stringify(p.tokens));

  // Geometry beacon: record then read back.
  await get("/viewport?w=1368&h=912&dpr=2&gw=833&gh=750&sw=314");
  const v = await (await get("/viewport")).json();
  ok("viewport beacon records what the kiosk reported",
    v && v.w === 1368 && v.h === 912 && v.gameW === 833 && v.statsW === 314, JSON.stringify(v));

  const html = await (await get("/")).text();
  for (const id of ["s-map", "s-badges", "s-dex", "s-money", "s-time", "s-party", "s-story", "s-pace", "s-tok", "s-ms", "s-goal", "stuck"])
    ok(`page has #${id}`, html.includes(`id="${id}"`));
  ok("page pins the game frame against flex shrink", html.includes("#game { flex:none;"));
  ok("page never hardcodes a map name", !html.includes("Mt Moon"));

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
