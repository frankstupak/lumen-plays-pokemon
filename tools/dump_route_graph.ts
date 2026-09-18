// wq#1849: dump the Kanto TRAVEL GRAPH from the ROM, as the src/route_graph.ts
// module the agent pathfinds over. Read-only: opens the ROM, prints, exits.
//   npx tsx tools/dump_route_graph.ts            # the generated module, to stdout
//   npx tsx tools/dump_route_graph.ts --audit    # id/edge counts + a few spot rows
//
// WHY GENERATED AND COMMITTED rather than parsed at runtime. The CI probe set
// runs with no ROM (scripts/probes-pure.sh: roms/*.gb is untracked, copyright),
// so a graph parsed at runtime could not be tested where it is most likely to
// rot. Committing the table keeps route.ts pure, and probe_route1849.ts §E
// re-derives it from the ROM on the Lumen host and fails on any drift.
//
// THE THREE ROM FACTS THIS READS (pokered map_header / connection / object
// macros; header layout already relied on by src/map.ts romMapHeader):
//   header: db tileset; db height, width; dw blocks, texts, script;
//           db connections; <11 bytes per connection, in bit order N,S,W,E>;
//           dw object_data
//   object: db border block; db nwarps; <warp: db y, x, dest warp, dest map>
// A warp whose dest map is 0xFF is pokered's LAST_MAP: it returns the player to
// the map they entered from, which is static as long as exactly one map warps
// in. Resolved that way here, and dropped when it is ambiguous.
import { Rom } from "../src/rom";
import { SymbolTable } from "../src/symbols";
import { GameNames } from "../src/names";

const ROM_PATH = process.env.LPP_ROM ?? "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM_PATH = process.env.LPP_SYM ?? "/home/lumen/pokemon/roms/pokeblue.sym";

const LAST_MAP = 0xff;
const PALLET_TOWN = 0;
const DIR_BITS = [[8, "north"], [4, "south"], [2, "west"], [1, "east"]] as const;

export interface RawMap {
  id: number;
  name: string;
  connections: number;
  /** direction walked off this map -> the map entered */
  conn: { dir: "north" | "south" | "east" | "west"; to: number }[];
  /** warp tiles on this map, with the map they lead to (0xFF = LAST_MAP) */
  warps: { x: number; y: number; to: number }[];
}

/** Every map header the ROM can be read for, minus the ones whose bytes are not
 *  a map. Unused ids share duplicate headers (see names.ts) and decode as
 *  hundreds of out-of-bounds warps — id 11 is the loud one. A map is kept only
 *  when the ROM names it AND its own object data fits inside its own grid. */
export function readMaps(rom: Rom, sym: SymbolTable, names: GameNames): RawMap[] {
  const p = sym.sym("MapHeaderPointers");
  const b = sym.sym("MapHeaderBanks");
  const count = (sym.nextAddr(p.bank, p.addr) - p.addr) >> 1;
  const out: RawMap[] = [];
  for (let id = 0; id < count; id++) {
    const name = names.mapName(id);
    if (!name) continue;
    try {
      const a = rom.byte(p.bank, p.addr + id * 2) | (rom.byte(p.bank, p.addr + id * 2 + 1) << 8);
      const bank = rom.byte(b.bank, b.addr + id);
      const h = rom.bytes(bank, a, 10);
      const height = h[1], width = h[2], connections = h[9];
      // 128 blocks, not 64: Route 17 (the Cycling Road) is 72 blocks tall and a
      // 64 cap silently dropped it and Route 23 out of the graph.
      if (width < 1 || width > 128 || height < 1 || height > 128 || connections > 15) continue;
      let off = a + 10;
      const conn: RawMap["conn"] = [];
      for (const [bit, dir] of DIR_BITS) {
        if (connections & bit) { conn.push({ dir, to: rom.byte(bank, off) }); off += 11; }
      }
      const objPtr = rom.byte(bank, off) | (rom.byte(bank, off + 1) << 8);
      const n = rom.byte(bank, objPtr + 1);
      if (n > 32) continue;
      const warps: RawMap["warps"] = [];
      let sane = true;
      for (let i = 0; i < n; i++) {
        const w = rom.bytes(bank, objPtr + 2 + i * 4, 4);
        if (w[1] >= width * 2 || w[0] >= height * 2) { sane = false; break; }
        warps.push({ x: w[1], y: w[0], to: w[3] });
      }
      if (!sane) continue;
      out.push({ id, name, connections, conn, warps });
    } catch { /* a header that does not read is not a map */ }
  }
  return out;
}

export interface GraphEdge {
  from: number; to: number;
  via: "north" | "south" | "east" | "west" | "warp";
  at?: [number, number][];
}

/** The travel graph: every outdoor map, plus the interiors that are the ONLY
 *  way between two different outdoor maps (the underground paths, Diglett's
 *  Cave). An interior chain that returns to the map it started from — Mt Moon,
 *  Rock Tunnel, every gate house, every gym — is a passage WITHIN that map at
 *  this granularity and is deliberately not a node: it would add a self-loop
 *  and no route. */
export function buildGraph(maps: RawMap[]): { nodes: RawMap[]; edges: GraphEdge[] } {
  const byId = new Map(maps.map(m => [m.id, m]));
  const outdoor = (id: number) => (byId.get(id)?.connections ?? 0) !== 0;

  // Which OUTDOOR maps warp INTO each map — this resolves LAST_MAP. Outdoor
  // only: a LAST_MAP warp is a door back outside, and counting the interior
  // that also links in makes every underground-path entrance ambiguous (its
  // inbound set is {Route 5, the tunnel}) and drops the door edge entirely.
  const inbound = new Map<number, Set<number>>();
  for (const m of maps)
    for (const w of m.warps)
      if (w.to !== LAST_MAP && byId.has(w.to) && outdoor(m.id))
        (inbound.get(w.to) ?? inbound.set(w.to, new Set()).get(w.to)!).add(m.id);

  /** The map a LAST_MAP warp on `id` returns to, or null when ambiguous. */
  const lastMapOf = (id: number): number | null => {
    const s = inbound.get(id);
    return s && s.size === 1 ? [...s][0] : null;
  };

  const warpEdges: GraphEdge[] = [];
  for (const m of maps) {
    const dests = new Map<number, [number, number][]>();
    for (const w of m.warps) {
      const to = w.to === LAST_MAP ? lastMapOf(m.id) : w.to;
      if (to === null || to === m.id || !byId.has(to)) continue;
      (dests.get(to) ?? dests.set(to, []).get(to)!).push([w.x, w.y]);
    }
    for (const [to, at] of dests) warpEdges.push({ from: m.id, to, via: "warp", at });
  }

  // Interior components over warp edges, and the outdoor maps each component
  // can LEAD TO. Outgoing only. A gate house's doors are all LAST_MAP, so it
  // puts the player back on the map they entered from (reach.ts resolveDest) —
  // two outdoor maps lead in, none leads out, and it is a bypass within a map
  // rather than a way between two. Counting inbound as "touch" made Route 22
  // Gate a node the router could enter and never leave.
  const outOf = new Map<number, number[]>();
  for (const e of warpEdges) (outOf.get(e.from) ?? outOf.set(e.from, []).get(e.from)!).push(e.to);
  const interiorLinks = new Map<number, Set<number>>();
  for (const e of warpEdges) {
    if (!outdoor(e.from) && !outdoor(e.to)) {
      (interiorLinks.get(e.from) ?? interiorLinks.set(e.from, new Set()).get(e.from)!).add(e.to);
      (interiorLinks.get(e.to) ?? interiorLinks.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
  }
  const keptInteriors = new Set<number>();
  const seen = new Set<number>();
  for (const m of maps) {
    if (outdoor(m.id) || seen.has(m.id)) continue;
    const comp: number[] = [], q = [m.id];
    seen.add(m.id);
    while (q.length) {
      const cur = q.pop()!;
      comp.push(cur);
      for (const nb of interiorLinks.get(cur) ?? [])
        if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    const touch = new Set(comp.flatMap(c => (outOf.get(c) ?? []).filter(outdoor)));
    if (touch.size >= 2) for (const c of comp) keptInteriors.add(c);
  }

  const isNode = (id: number) => outdoor(id) || keptInteriors.has(id);
  const candidates = maps.filter(m => isNode(m.id));
  const all: GraphEdge[] = [];
  for (const m of candidates)
    for (const c of m.conn)
      if (isNode(c.to)) all.push({ from: m.id, to: c.to, via: c.dir });
  for (const e of warpEdges)
    if (isNode(e.from) && isNode(e.to)) all.push(e);

  // Reachable from Pallet Town, or it is not a place the player can travel to.
  // Several unused map slots duplicate a real map's header (names.ts) and so
  // carry its exits without anything leading in — "Underground Path Route 6"
  // twice, at ids 74 and 75. Keeping both would put a phantom on the board.
  const reach = new Set([PALLET_TOWN]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of all) if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; }
  }
  const nodes = candidates.filter(m => reach.has(m.id)).sort((a, b) => a.id - b.id);
  const edges = all.filter(e => reach.has(e.from) && reach.has(e.to))
    .sort((a, b) => a.from - b.from || a.to - b.to || a.via.localeCompare(b.via));
  return { nodes, edges };
}

function main(): void {
  const sym = new SymbolTable(SYM_PATH);
  const rom = new Rom(ROM_PATH);
  const names = new GameNames(rom, sym);
  const maps = readMaps(rom, sym, names);
  const { nodes, edges } = buildGraph(maps);

  if (process.argv.includes("--audit")) {
    console.log(`${maps.length} sane maps, ${nodes.length} travel nodes, ${edges.length} edges`);
    for (const id of [3, 16, 71, 119, 74, 17, 35]) {
      const out = edges.filter(e => e.from === id)
        .map(e => `${e.via === "warp" ? `warp${e.at!.map(a => `(${a[0]},${a[1]})`).join("")}` : e.via}->${e.to}`);
      console.log(String(id).padStart(4), (nodes.find(n => n.id === id)?.name ?? "?").padEnd(26), out.join(" "));
    }
    return;
  }

  const q = (s: string) => JSON.stringify(s);
  const lines: string[] = [
    "// GENERATED by tools/dump_route_graph.ts from roms/pokeblue.gb — do not edit by hand.",
    "// The Kanto travel graph: outdoor maps plus the interiors that are the only way",
    "// between two of them. Regenerate with `npx tsx tools/dump_route_graph.ts > src/route_graph.ts`;",
    "// probe_route1849.ts §E fails if this file and the ROM disagree.",
    "import type { RouteEdge } from \"./route\";",
    "",
    "export const ROUTE_NODES: Readonly<Record<number, string>> = {",
    ...nodes.map(n => `  ${n.id}: ${q(n.name)},`),
    "};",
    "",
    "export const ROUTE_EDGES: readonly RouteEdge[] = [",
    ...edges.map(e => `  { from: ${e.from}, to: ${e.to}, via: "${e.via}"` +
      (e.at ? `, at: [${e.at.map(a => `[${a[0]}, ${a[1]}]`).join(", ")}] },` : " },")),
    "];",
    "",
  ];
  console.log(lines.join("\n"));
}

if (process.argv[1] && process.argv[1].endsWith("dump_route_graph.ts")) main();
