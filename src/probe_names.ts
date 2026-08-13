// wq#503 probe: proves the kiosk panel's name tables and derived helpers
// against the ROM and against hand-checkable Gen 1 facts. Offline, no service.
//   npx tsx src/probe_names.ts
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import { GameNames, decodeGen1, prettifyLabel, statusLabel, BADGE_NAMES } from "./names";
import { MilestoneLog, StuckWatch, prettifyFlag, objectiveFrom, sentinelAlerts, paceFrom, LOOP_WINDOW } from "./trainer_panel";

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const names = new GameNames(rom, sym);

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ok = (label: string, cond: boolean) => eq(label, !!cond, true);

// ── table shape (lengths derived from nextAddr, never hardcoded) ──────────
eq("map table length", names.mapCount, 248);
eq("mon table length", names.monCount, 190);
ok("symbol reverse index finds MtMoon1F_h", sym.labelsAt(0x12, 0x59bc).includes("MtMoon1F_h"));

// ── map names: the ticket's headline requirement ──────────────────────────
eq("map 59 (ticket: must NOT read '59')", names.mapName(59), "Mt Moon 1F");
eq("map 60", names.mapName(60), "Mt Moon B1F");
eq("map 61 (where the agent is now)", names.mapName(61), "Mt Moon B2F");
eq("map 0", names.mapName(0), "Pallet Town");
eq("map 12", names.mapName(12), "Route 1");
eq("map 54", names.mapName(54), "Pewter Gym");
eq("map 3", names.mapName(3), "Cerulean City");
eq("map 193 (digit/word boundary)", names.mapName(193), "Route 22 Gate");
eq("map 11 is an unused slot -> null, not a guess", names.mapName(11), null);
eq("out-of-range map id -> null", names.mapName(999), null);
ok("no map name is a bare number", Object.values(names.maps).every(n => !/^\d+$/.test(n)));

// ── species names: INTERNAL ids, cross-checked against known Gen 1 values ──
eq("internal 0x99 = Bulbasaur", names.monName(0x99), "BULBASAUR");
eq("internal 0xB0 = Charmander", names.monName(0xb0), "CHARMANDER");
eq("internal 0xB2 = Charmeleon (the live party lead)", names.monName(0xb2), "CHARMELEON");
eq("internal 0x54 = Pikachu", names.monName(0x54), "PIKACHU");
eq("internal 0x01 = Rhydon", names.monName(0x01), "RHYDON");
eq("internal 0x15 = Mew", names.monName(0x15), "MEW");
eq("species 0 -> null", names.monName(0), null);
eq("internal 0x03 = Nidoran male (charmap 0xEF)", names.monName(0x03), "NIDORAN\u2642");
eq("internal 0x0F = Nidoran female (charmap 0xF5)", names.monName(0x0f), "NIDORAN\u2640");
eq("internal 0x40 = Farfetch'd (charmap 0xE0)", names.monName(0x40), "FARFETCH'D");
eq("every species id 1..190 resolves", Object.keys(names.mons).length, names.monCount);
ok("no species name contains an undecoded byte", Object.values(names.mons).every(n => !n.includes("?")));

// ── text + label helpers ──────────────────────────────────────────────────
eq("decodeGen1 stops at 0x50", decodeGen1([0x80, 0x81, 0x50, 0x82]), "AB");
eq("decodeGen1 digits", decodeGen1([0xf6, 0xf7, 0xff]), "019");
eq("decodeGen1 marks unknown bytes", decodeGen1([0x80, 0x02]), "A?");
eq("prettify keeps floor labels intact", prettifyLabel("MtMoonB1F_h"), "Mt Moon B1F");
eq("prettify splits word after digits", prettifyLabel("Route22Gate_h"), "Route 22 Gate");
eq("prettify keeps acronyms", prettifyLabel("SSAnne1F_h"), "SS Anne 1F");
eq("badge bit order starts at Boulder", BADGE_NAMES[0], "Boulder");
eq("badge table is 8 long", BADGE_NAMES.length, 8);
eq("status 0 = OK", statusLabel(0), "OK");
eq("status sleep counter", statusLabel(0x03), "SLP");
eq("status combined", statusLabel(0x48), "PSN+PAR");
eq("flag prettifier", prettifyFlag("EVENT_BEAT_BROCK"), "Beat Brock");
eq("flag prettifier keeps short tokens", prettifyFlag("EVENT_GOT_SS_TICKET"), "Got SS Ticket");
eq("objective reads the GOAL line", objectiveFrom("-- CORRIDOR --\nGOAL: cross MT MOON.\nCORRIDOR: x"), "cross MT MOON.");
eq("objective absent -> null", objectiveFrom("-- CORRIDOR --\nno goal here"), null);

// ── stuck detector: the false-positive guards matter more than the hit ─────
const walk = new StuckWatch();
for (let i = 0; i < LOOP_WINDOW - 1; i++) walk.observe(59, 10, 10);
eq("no verdict before the window is full", walk.state(), null);
walk.observe(59, 10, 10);
ok("full window in one tile = looping", walk.state()!.looping);

const moving = new StuckWatch();
for (let i = 0; i < LOOP_WINDOW; i++) moving.observe(59, 10 + i, 10);
ok("walking across the map is NOT looping", !moving.state()!.looping);

const crossing = new StuckWatch();
for (let i = 0; i < LOOP_WINDOW; i++) crossing.observe(i < 10 ? 59 : 60, 10, 10);
eq("a map change clears the verdict", crossing.state(), null);

const jitter = new StuckWatch();
for (let i = 0; i < LOOP_WINDOW; i++) jitter.observe(59, 10 + (i % 2), 10 + (i % 3));
ok("pacing in a 2x3 box IS looping", jitter.state()!.looping);

const wide = new StuckWatch();
for (let i = 0; i < LOOP_WINDOW; i++) wide.observe(59, 10 + (i % 6), 10);
ok("a 6-tile patrol is NOT looping", !wide.state()!.looping);

// ── milestone ledger: resumed flags must not claim to be fresh ─────────────
const log = new MilestoneLog();
log.observe(["EVENT_BEAT_BROCK"], new Date(), true);
ok("flags from a resumed save are marked seeded", log.last()!.seeded);
eq("milestone label", log.last()!.label, "Beat Brock");
log.observe(["EVENT_BEAT_BROCK", "EVENT_BEAT_MISTY"]);
ok("a flag earned while running is NOT seeded", !log.last()!.seeded);
eq("latest milestone wins", log.last()!.flag, "EVENT_BEAT_MISTY");

// ── sentinel read is fail-soft ────────────────────────────────────────────
eq("missing sentinel state -> no alerts", sentinelAlerts("/nonexistent/sentinel.json"), []);

// ── pace: a run with no turns has no pace, and must not read as "stalled" ──
eq("zero-turn run yields no pace",
  paceFrom({ current: { turns: 0, turnsPerH: 0, brainPerH: 0 }, generatedAt: "T" }), null);
eq("a real run yields its pace",
  paceFrom({ current: { turns: 88, turnsPerH: 40.8, brainPerH: 21.8 }, generatedAt: "T" }),
  { turnsPerH: 40.8, brainPerH: 21.8, at: "T" });
eq("no run summaries at all -> no pace", paceFrom({ current: null }), null);
eq("malformed summary -> no pace", paceFrom({ current: { turns: 5 } }), null);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
