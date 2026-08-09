// S3 recon: bag layout, item-name table from ROM, RAM-write capability,
// START-menu ITEM flow — all empirical, zero hardcoded knowledge trusted.
import { Emulator, KEYS, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { Screen } from "./screen";
import { Sync } from "./sync";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const rom = new Rom(ROM);

// ---- 1. ItemNames from ROM (bank:addr from sym; 0x50-terminated entries) ----
const gen1char = (t: number): string => {
  if (t === 0x7f) return " ";
  if (t >= 0x80 && t <= 0x99) return String.fromCharCode(65 + (t - 0x80));
  if (t >= 0xa0 && t <= 0xb9) return String.fromCharCode(97 + (t - 0xa0));
  if (t >= 0xf6 && t <= 0xff) return String.fromCharCode(48 + (t - 0xf6));
  const m: Record<number, string> = { 0xba:"e", 0xe0:"\u0027", 0xe1:"P", 0xe2:"M", 0xe3:"-", 0xe8:".", 0xf1:"x", 0xf3:"/" };
  return m[t] ?? "?";
};
const it = sym.sym("ItemNames");
let off = 0; const names: string[] = [];
for (let id = 1; id <= 97 && names.length < 97; id++) {
  let s = "";
  for (;;) {
    const b = rom.byte(it.bank, it.addr + off); off++;
    if (b === 0x50) break;
    s += gen1char(b);
  }
  names.push(s);
}
console.log("ITEM NAMES 1..20:", names.slice(0, 20).map((n, i) => `${i + 1}:${n}`).join(" | "));
const idOf = (frag: string) => names.findIndex(n => n.includes(frag)) + 1;
console.log(`IDs -> POKe BALL=${idOf("BALL") /* first *BALL* is MASTER? print several */}`);
["MASTER", "ULTRA", "GREAT", "POKe", "POTION", "ANTIDOTE", "PARCEL", "TOWN MAP"].forEach(f =>
  console.log(`  id(${f}) = ${idOf(f)} [${names[idOf(f) - 1]}]`));

// ---- 2. ItemPrices spot check (BCD, 3 bytes/entry per pret) ----
const pr = sym.sym("ItemPrices");
const price = (id: number) => {
  const o = pr.addr + (id - 1) * 3;
  const b = [rom.byte(pr.bank, o), rom.byte(pr.bank, o + 1), rom.byte(pr.bank, o + 2)];
  return b.reduce((a, x) => a * 100 + ((x >> 4) * 10 + (x & 0xf)), 0);
};
const potionId = idOf("POTION"), ballId = names.findIndex(n => n === "POKe BALL") + 1;
console.log(`PRICES: POTION=${price(potionId)} POKeBALL=${price(ballId)} MASTERBALL=${price(1)}`);

// ---- 3. bag layout from real saves ----
const dump = (save: string) => {
  const e = new Emulator(ROM); loadSnapshotFile(e, save);
  const m = e.mem(), n = m[sym.addr("wNumBagItems")], a = sym.addr("wBagItems");
  const raw = Array.from({ length: 2 * n + 1 }, (_, i) => m[a + i]);
  const items = [];
  for (let i = 0; i < n; i++) items.push(`${names[m[a + 2 * i] - 1] ?? "id" + m[a + 2 * i]}(${m[a + 2 * i]})x${m[a + 2 * i + 1]}`);
  console.log(`${save.split("/").pop()}: count=${n} [${items.join(", ")}] term=0x${m[a + 2 * n].toString(16)}`);
  return e;
};
dump("/home/lumen/pokemon/saves/have-parcel.state.gz");
dump("/home/lumen/pokemon/saves/starter.state.gz");
const e = dump("/home/lumen/pokemon/saves/rival1-won.state.gz");

// ---- 4. RAM write test: inject POTIONx2 + POKe BALLx3 + verify via live menu ----
(async () => {
  const m = e.mem(), nA = sym.addr("wNumBagItems"), bA = sym.addr("wBagItems");
  const n0 = m[nA];
  m[bA + 2 * n0] = potionId; m[bA + 2 * n0 + 1] = 2;
  m[bA + 2 * n0 + 2] = ballId; m[bA + 2 * n0 + 3] = 3;
  m[bA + 2 * n0 + 4] = 0xff; m[nA] = n0 + 2;
  console.log(`RAM WRITE: bag count ${n0} -> ${m[nA]} (readback ${m[nA] === n0 + 2 ? "OK" : "FAILED"})`);

  const scr = new Screen(e, sym); const sync = new Sync(e, sym);
  await e.tapAsync(KEYS.START, 8, 30); await sync.settle(300);
  console.log("START MENU TEXT:\n" + scr.text());
  // walk cursor to ITEM and open
  for (let i = 0; i < 8; i++) {
    const t = scr.text();
    const cur = scr.cursor();
    const lines = t.split("\n");
    const curLine = cur ? (lines[cur.y] ?? "") : "";
    if (/ITEM/.test(curLine)) break;
    await e.tapAsync(KEYS.DOWN, 8, 12);
  }
  await e.tapAsync(KEYS.A, 8, 30); await sync.settle(400);
  console.log("ITEM MENU TEXT:\n" + scr.text());
  console.log("cursor:", JSON.stringify(scr.cursor()));
})();
