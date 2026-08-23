// wq#518 acceptance: the resume ranker must never rewind past Mt Moon again.
// Three layers, because a green tick on the comparator alone is what let this
// run for five days:
//   A. ROM TRUTH  — re-derive the Route 4 split from the shipped ROM every run,
//                   so the constants in resume.ts cannot quietly rot.
//   B. REAL CORPUS— run pickResume over the actual saves/ + checkpoints/ on disk
//                   and demand the Mt Moon B2F state beats auto-msqlak0v-map15.
//   C. GUARD      — red AND green cases for the repeat-resume backstop, plus the
//                   wq#471 cases it must not regress.
// Usage: npx tsx src/probe_resume518.ts
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { pickResume, readProgress, progressRank, rankLabel, SPLIT_MAPS, POCKET_MAPS, STORY_ORDER, VIABLE_HP_PCT, criticalCondition } from "./resume";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const LIVE_SAVES = "/home/lumen/pokemon/saves";
const LIVE_CKPTS = "/home/lumen/pokemon/checkpoints";
// wq#534: WEST_STATE USED TO BE A HARDCODED FILENAME AND THAT FILENAME HAS
// ROTATED OFF DISK. This probe therefore CRASHED at line 39 on pristine
// origin/main — ENOENT, before a single assertion ran, so its "38/38" had
// silently become "0/0 and a stack trace". Same class as the empty-corpus rot
// rabbit13 flagged in probe_phase514 at 08:23Z: a test pinned to a specific
// checkpoint dies the moment checkpoint rotation reaches it.
//
// Resolved from the sidecars instead: any map-15 checkpoint on the WEST side of
// the split will do, and the sidecar JSON gives {map,x,y} without booting an
// emulator per candidate. If none exists, the sections that need one say so and
// are skipped explicitly rather than crashing the run.
function findWestState(): string | null {
  for (const dir of [LIVE_CKPTS, LIVE_SAVES]) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter(f => f.endsWith(".json")).sort(); } catch { continue; }
    for (const j of files) {
      try {
        const s = JSON.parse(readFileSync(`${dir}/${j}`, "utf8"));
        if (s.map !== 15 || typeof s.x !== "number") continue;
        if (s.x >= SPLIT_MAPS[15].beyond) continue;          // east half: wrong pocket
        const state = `${dir}/${j.replace(/\.json$/, ".state.gz")}`;
        if (existsSync(state)) return state;
      } catch {}
    }
  }
  return null;
}
const WEST_STATE = findWestState();

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};
const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);
const quiet = { log: () => {} };

// ---------- A. ROM TRUTH: Route 4 really is two places ----------
console.log("=== A. ROM truth: map 15 geometry ===");
if (!WEST_STATE) {
  chk("a Route-4-WEST checkpoint exists to derive the split geometry from", false,
    "none on disk — section A skipped. This is corpus rot, not a code defect: " +
    "re-run once a run passes back through Route 4 west.");
} else {
  const e = new Emulator(ROM);
  loadSnapshotFile(e, WEST_STATE);
  const rd = new StateReader(e, sym);
  const s = rd.read();
  const mm = new MapModel(e, sym, rom);
  mm.build();
  chk("checkpoint under test is on map 15", s.map === 15, `map=${s.map} at (${s.x},${s.y})`);

  const w = mm.warps.map(x => `${x.x},${x.y}->${x.destMap}`).sort().join(" ");
  chk("map 15 warps are Pokecenter(68), Mt Moon 1F(59), Mt Moon B1F(60)",
    w === "11,5->68 18,5->59 24,5->60", w);

  const split = SPLIT_MAPS[15];
  chk("split is declared on the x axis", split?.axis === "x", JSON.stringify(split));
  // the divider must be solid on EVERY row, or x alone cannot separate the halves
  let wallRows = 0, holes: string[] = [];
  for (let y = 0; y < mm.gh; y++) {
    let solid = true;
    for (let x = 20; x <= 23; x++) if (mm.grid[y][x]) { solid = false; holes.push(`(${x},${y})`); }
    if (solid) wallRows++;
  }
  chk("columns 20..23 are wall on every row", wallRows === mm.gh,
    `${wallRows}/${mm.gh} rows solid${holes.length ? ", open at " + holes.slice(0, 6).join(",") : ""}`);

  // flood fill from the resumed position: what can the player actually reach?
  const seen = new Set<string>([`${s.x},${s.y}`]);
  const q: number[][] = [[s.x, s.y]];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || nx < 0 || ny < 0 || nx >= mm.gw || ny >= mm.gh || !mm.grid[ny][nx]) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  const xs = [...seen].map(k => Number(k.split(",")[0]));
  const maxX = Math.max(...xs);
  chk("resumed position can only reach the west pocket", maxX < split.beyond,
    `reachable x ${Math.min(...xs)}..${maxX}, threshold ${split.beyond}, map width ${mm.gw}`);
  const reach = (x: number, y: number) => seen.has(`${x},${y}`);
  chk("west pocket reaches the Pokecenter warp (11,5)", reach(11, 5));
  chk("west pocket reaches the Mt Moon 1F entrance (18,5)", reach(18, 5));
  chk("west pocket CANNOT reach the Mt Moon B1F exit (24,5)", !reach(24, 5),
    "if this ever passes, Route 4 is one place and the split must be removed");
}

// ---------- B. ordering derived from that geometry ----------
console.log("\n=== B. rank order ===");
{
  const west = progressRank(15, 11, 6);
  const east = progressRank(15, 30, 10);
  const mm1 = progressRank(59), mmb1 = progressRank(60), mmb2 = progressRank(61);
  const pc = progressRank(68), r3 = progressRank(14), cer = progressRank(3);
  console.log(`   Route3=${r3} Route4W=${west} Pokecenter=${pc} MtMoon 1F=${mm1} B1F=${mmb1} B2F=${mmb2} Route4E=${east} Cerulean=${cer}`);
  chk("Route 4 west ranks BELOW every Mt Moon floor", west < mm1 && west < mmb1 && west < mmb2,
    `west=${west} vs ${mm1}/${mmb1}/${mmb2}`);
  chk("Route 4 east ranks ABOVE every Mt Moon floor", east > mm1 && east > mmb1 && east > mmb2);
  chk("the walk order Route3 < Route4W < Pokecenter < MtMoon < Route4E < Cerulean holds",
    r3 < west && west < pc && pc < mm1 && mm1 < mmb1 && mmb1 < mmb2 && mmb2 < east && east < cer);
  chk("map 15 with unknown coordinates resolves to the EARLIER half", progressRank(15) === west,
    "never claim progress that cannot be proved");
  chk("rankLabel names the two halves apart",
    rankLabel(15, 11, 6) !== rankLabel(15, 30, 10),
    `${rankLabel(15, 11, 6)} | ${rankLabel(15, 30, 10)}`);
  chk("unranked maps still sort below everything", progressRank(52) === -1 && progressRank(53) === -1);
  // wq#471's ordering must survive: Route 4 beats the Pewter museum trap maps
  chk("Route 4 west still outranks Pewter-era stops (wq#471 trap)",
    west > progressRank(56) && west > progressRank(58) && west > progressRank(54) && west > progressRank(2));
  chk("STORY_ORDER lists map 15 exactly twice",
    STORY_ORDER.filter(m => m === 15).length === 2, STORY_ORDER.join(","));
  // wq#534 GENERALISED THIS ASSERTION RATHER THAN DELETING IT. It used to read
  // "no map other than 15 is duplicated", which was true only while map 15 was
  // the only two-position map. Map 60 is now a second one (POCKET_MAPS), so the
  // invariant is restated in terms of the tables themselves: a map appears
  // twice IF AND ONLY IF a table says it has two story positions. That still
  // catches the copy-paste duplicate the original was written to catch.
  const twoPos = new Set([...Object.keys(SPLIT_MAPS), ...Object.keys(POCKET_MAPS)].map(Number));
  chk("every SPLIT_MAPS/POCKET_MAPS entry appears exactly twice in STORY_ORDER",
    [...twoPos].every(m => STORY_ORDER.filter(v => v === m).length === 2),
    `two-position maps: ${[...twoPos].join(",")}`);
  chk("no map WITHOUT a two-position entry is duplicated in STORY_ORDER",
    STORY_ORDER.filter(m => !twoPos.has(m)).length ===
      new Set(STORY_ORDER.filter(m => !twoPos.has(m))).size);
}

// ---------- B2. Cerulean area rank order (wq#701) ----------
// Same principle as section B but past Cerulean City: strategic interiors (PC,
// Bill's, Gym) must rank in walk order, optional interiors (Trade House, Mart)
// must be unranked, and Bill's house must rank ABOVE its access route (Route 25).
console.log("\n=== B2. Cerulean area rank order (wq#701) ===");
{
  const cerCity = progressRank(3);
  const cerPC = progressRank(64);
  const r24 = progressRank(35);
  const r25 = progressRank(36);
  const bill = progressRank(88, 2, 7);  // Bill's house interior
  const cerGym = progressRank(65);
  const r5 = progressRank(16);
  const tradeHouse = progressRank(63);
  const mart = progressRank(67);

  console.log(`   CeruleanCity=${cerCity} CeruleanPC=${cerPC} Route24=${r24} Route25=${r25} BillsHouse=${bill} CeruleanGym=${cerGym} Route5=${r5}`);
  console.log(`   optional: TradeHouse=${tradeHouse} Mart=${mart}`);

  chk("walk order: Cerulean < PC < Route24 < Route25 < Bill's < Gym < Route5",
    cerCity < cerPC && cerPC < r24 && r24 < r25 && r25 < bill && bill < cerGym && cerGym < r5,
    `${cerCity} < ${cerPC} < ${r24} < ${r25} < ${bill} < ${cerGym} < ${r5}`);
  chk("optional interiors are unranked (rank -1): Trade House", tradeHouse === -1);
  chk("optional interiors are unranked (rank -1): Mart", mart === -1);
  chk("Bill's house beats Route 25 (Bill is mandatory, further along)",
    bill > r25, `bill=${bill} r25=${r25}`);
  chk("Cerulean PC ranks below outdoor routes (heal stop, not progress)",
    cerPC < r24 && cerPC < r25, `PC=${cerPC} R24=${r24} R25=${r25}`);
}

// ---------- C. the real corpus on disk ----------
// This is the acceptance test the ticket asks for, and it runs against the LIVE
// saves/ + checkpoints/ directories, not a fixture. It is written as an
// invariant rather than "the winner is file X" so it keeps meaning something
// after the campaign finally moves past Mt Moon.
console.log("\n=== C. real checkpoint set ===");
{
  const hist = `${mkdtempSync(`${tmpdir()}/wq518-`)}/history.json`;
  const winner = pickResume([LIVE_SAVES, LIVE_CKPTS], sym, ROM, { historyFile: hist, log: () => {} });
  const p = readProgress(winner, sym, ROM);
  console.log(`   winner: ${winner.split("/").pop()} — ${rankLabel(p.map, p.x, p.y)} (map ${p.map} @ ${p.x},${p.y}) rank=${p.rank} story=${p.story}`);
  chk("does NOT resume the pre-cave Route 4 west save", winner !== WEST_STATE, winner.split("/").pop());
  chk("resumes at or beyond Mt Moon 1F", p.rank >= progressRank(59),
    `rank ${p.rank} >= ${progressRank(59)} — the one-sentence acceptance from the ticket`);
  // wq#628: the primary gate is CRITICAL health (one bar of HP no longer
  // outvotes a whole story flag), not the stricter VIABLE_HP_PCT display
  // threshold — a winner can legitimately read viable=false (e.g. hp=0.494)
  // while still being the right pick. "not critical" is the real invariant.
  chk("winner is not in critical condition", !criticalCondition(p), `hp=${p.hpPct} ppOk=${p.ppOk}`);
  // and show what the OLD list would have done with the same files, for contrast
  const OLD = [38, 37, 0, 40, 12, 1, 42, 13, 51, 2, 56, 58, 54, 14, 68, 59, 60, 61, 15, 3];
  const oldRank = (m: number) => OLD.indexOf(m);
  console.log(`   old ranks: Route4=${oldRank(15)} MtMoon 1F/B1F/B2F=${oldRank(59)}/${oldRank(60)}/${oldRank(61)}` +
    ` -> the pre-cave save outranked the deepest state by ${oldRank(15) - oldRank(61)}`);
  chk("the OLD list is what caused it (Route 4 outranked Mt Moon B2F)", oldRank(15) > oldRank(61));
  rmSync(hist, { force: true });
}

// ---------- D. synthetic fixtures: the trap, the wq#471 cases, the guard ----------
// Sidecars mean the fast path never opens the .state.gz, so the file bodies are
// placeholders and every case runs in milliseconds. mtimes are set explicitly
// because "newer" is load-bearing for the repeat guard.
console.log("\n=== D. fixtures ===");
interface Fix { map: number; x: number; y: number; story?: number; events?: number; hp?: number; pp?: boolean; age: number }
function fixture(files: Record<string, Fix>): string {
  const dir = mkdtempSync(`${tmpdir()}/wq518fx-`);
  for (const [stem, f] of Object.entries(files)) {
    writeFileSync(`${dir}/${stem}.state.gz`, "placeholder");
    writeFileSync(`${dir}/${stem}.json`, JSON.stringify({
      v: 2, kind: "map", map: f.map, x: f.x, y: f.y, badges: 1,
      events: f.events ?? 24, storyScore: f.story ?? 6,
      hpPct: f.hp ?? 1, ppOk: f.pp ?? true, money: 71, ts: 0,
    }));
    const t = 1_700_000_000 + f.age;   // age is a plain ordering knob, larger = newer
    utimesSync(`${dir}/${stem}.state.gz`, t, t);
  }
  return dir;
}
const newHist = () => `${mkdtempSync(`${tmpdir()}/wq518h-`)}/history.json`;
const seed = (file: string, picks: string[]) =>
  writeFileSync(file, JSON.stringify({ v: 1, picks: picks.map(f => ({ file: f, at: "2026-08-13T00:00:00Z" })) }));
const pick = (dir: string, historyFile: string) =>
  pickResume([dir], sym, ROM, { historyFile, ...quiet }).split("/").pop();

// pick() APPENDS to the history file, so every case calls it exactly once and
// asserts on the stored result. Calling it a second time to build the failure
// message reads the guard's own side effect back and prints a value that
// contradicts the assertion — caught while writing this probe, and the reason
// the sequence case D4g exists at all.

// D1 — the wq#518 trap itself, in miniature. Old pre-cave save vs newer Mt Moon
// states, every candidate tied on viable/badges/storyScore exactly as on disk.
{
  const dir = fixture({
    "west-map15": { map: 15, x: 11, y: 6, age: 10 },
    "mtmoon-b2f": { map: 61, x: 25, y: 11, age: 90 },
    "mtmoon-1f":  { map: 59, x: 14, y: 35, age: 50 },
  });
  const got = pick(dir, newHist());
  chk("D1 trap: the deepest Mt Moon state wins over the pre-cave save",
    got === "mtmoon-b2f.state.gz", String(got));
  rmSync(dir, { recursive: true, force: true });
}

// D2 — the east half must beat Mt Moon, or the split is only half a fix.
{
  const dir = fixture({
    "east-map15": { map: 15, x: 30, y: 10, age: 20 },
    "mtmoon-b2f": { map: 61, x: 25, y: 11, age: 90 },
  });
  const got = pick(dir, newHist());
  chk("D2 Route 4 EAST beats Mt Moon B2F even though it is older",
    got === "east-map15.state.gz", String(got));
  rmSync(dir, { recursive: true, force: true });
}

// D3 — wq#471 must not regress: viability first, then storyScore over rank.
{
  const dir = fixture({
    "far-dying":   { map: 61, x: 25, y: 11, hp: 0.1, age: 90 },
    "mid-healthy": { map: 59, x: 14, y: 35, age: 50 },
  });
  const a = pick(dir, newHist());
  chk("D3a viable beats further-but-dying (wq#471)", a === "mid-healthy.state.gz", String(a));
  rmSync(dir, { recursive: true, force: true });

  const dir2 = fixture({
    "far-nopp":    { map: 61, x: 25, y: 11, pp: false, age: 90 },
    "mid-healthy": { map: 59, x: 14, y: 35, age: 50 },
  });
  const b = pick(dir2, newHist());
  chk("D3b move-dead state loses to a healthy one (wq#471)", b === "mid-healthy.state.gz", String(b));
  rmSync(dir2, { recursive: true, force: true });

  // the Pewter-museum trap: high incidental events, LOWER story score
  const dir3 = fixture({
    "pewter-museum": { map: 52, x: 5, y: 5, story: 5, events: 26, age: 99 },
    "route4-west":   { map: 15, x: 11, y: 6, story: 6, events: 24, age: 10 },
  });
  const c = pick(dir3, newHist());
  chk("D3c storyScore still beats incidental event count (wq#471 Pewter trap)",
    c === "route4-west.state.gz", String(c));
  rmSync(dir3, { recursive: true, force: true });
}

// D4 — the repeat guard. Red AND green: a guard that only ever fires is as bad
// as one that never does, and this one sits in the path of every single boot.
{
  const mk = () => fixture({
    "stuck-pick": { map: 61, x: 25, y: 11, age: 10 },   // ranks highest, keeps winning
    "newer-alt":  { map: 60, x: 21, y: 17, age: 99 },   // lower rank, but newer
  });

  const d1 = mk(), h1 = newHist();
  seed(h1, [`${d1}/stuck-pick.state.gz`, `${d1}/stuck-pick.state.gz`]);
  const a = pick(d1, h1);
  chk("D4a guard fires on the 3rd identical pick when newer states exist",
    a === "newer-alt.state.gz", String(a));
  // ONE-SHOT: the very next selection must return to normal ranking. This is
  // what keeps a wrong demotion from becoming the new permanent answer.
  const a2 = pick(d1, h1);
  chk("D4b the demotion is one-shot — the next selection ranks normally again",
    a2 === "stuck-pick.state.gz", String(a2));
  rmSync(d1, { recursive: true, force: true });

  const d2 = mk(), h2 = newHist();
  seed(h2, [`${d2}/stuck-pick.state.gz`]);
  const b = pick(d2, h2);
  chk("D4c guard does NOT fire on the 2nd pick", b === "stuck-pick.state.gz", String(b));
  rmSync(d2, { recursive: true, force: true });

  const d3 = mk();
  const c = pick(d3, newHist());
  chk("D4d guard does NOT fire on a first boot", c === "stuck-pick.state.gz", String(c));
  rmSync(d3, { recursive: true, force: true });

  const d4 = mk(), h4 = newHist();
  seed(h4, [`${d4}/newer-alt.state.gz`, `${d4}/newer-alt.state.gz`]);
  const d = pick(d4, h4);
  chk("D4e guard does NOT fire when the repeats were a different file",
    d === "stuck-pick.state.gz", String(d));
  rmSync(d4, { recursive: true, force: true });

  // D4f — the whole point, stated as a sequence: over many boots the guard must
  // keep offering the alternative WITHOUT ever locking onto either state.
  const d5 = mk(), h5 = newHist();
  const seq: string[] = [];
  for (let i = 0; i < 9; i++) seq.push(String(pick(d5, h5)));
  const alts = seq.filter(s => s === "newer-alt.state.gz").length;
  chk("D4f over 9 consecutive selections the guard is bounded and starves neither state",
    alts >= 2 && alts <= 4 && seq.length - alts >= 4,
    seq.map(s => s.replace(".state.gz", "")).join(" -> "));
  rmSync(d5, { recursive: true, force: true });
}

{
  // red: repeats, but nothing newer to move to -> keep the pick, do not thrash
  const dir = fixture({
    "only-option": { map: 61, x: 25, y: 11, age: 90 },
    "older-alt":   { map: 60, x: 21, y: 17, age: 10 },
  });
  const h = newHist();
  seed(h, [`${dir}/only-option.state.gz`, `${dir}/only-option.state.gz`]);
  const got = pick(dir, h);
  chk("D4g guard holds its pick when no NEWER alternative exists",
    got === "only-option.state.gz", String(got));
  rmSync(dir, { recursive: true, force: true });
}

{
  // red: never trade a viable state for a non-viable one to escape a repeat
  const dir = fixture({
    "stuck-viable": { map: 61, x: 25, y: 11, age: 10 },
    "newer-dying":  { map: 60, x: 21, y: 17, hp: 0.1, age: 99 },
  });
  const h = newHist();
  seed(h, [`${dir}/stuck-viable.state.gz`, `${dir}/stuck-viable.state.gz`]);
  const got = pick(dir, h);
  chk("D4h guard will not swap a viable state for a non-viable one",
    got === "stuck-viable.state.gz", String(got));
  rmSync(dir, { recursive: true, force: true });
}

// D5 — bookkeeping must never be able to break a boot. Resume selection is the
// one function that runs before anything else can go right.
{
  const dir = fixture({ "a-state": { map: 61, x: 25, y: 11, age: 10 } });

  const corrupt = newHist();
  writeFileSync(corrupt, "{not json at all");
  let ok = true, got = "";
  try { got = String(pick(dir, corrupt)); } catch { ok = false; }
  chk("D5a corrupt history file does not throw", ok && got === "a-state.state.gz", got);

  let ok2 = true, got2 = "";
  try { got2 = String(pick(dir, "/dev/null/cannot/exist/history.json")); } catch { ok2 = false; }
  chk("D5b unwritable history path does not throw", ok2 && got2 === "a-state.state.gz", got2);

  const h = newHist();
  for (let i = 0; i < 12; i++) pick(dir, h);
  const picks = JSON.parse(readFileSync(h, "utf8")).picks as unknown[];
  chk("D5c history is written and capped", picks.length === 8, `${picks.length} entries kept`);

  const empty = mkdtempSync(`${tmpdir()}/wq518empty-`);
  let ok3 = true;
  try { pickResume([empty, "/does/not/exist"], sym, ROM, { historyFile: newHist(), ...quiet }); } catch { ok3 = false; }
  chk("D5d empty and missing directories do not throw", ok3);
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  *** ${fail} FAILED ***` : ""}`);
console.log(`(VIABLE_HP_PCT=${VIABLE_HP_PCT})`);
process.exit(fail ? 1 : 0);
