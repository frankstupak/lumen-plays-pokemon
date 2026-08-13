// wq#422 acceptance: catch-policy verification.
// Part A (ground truth): every WANTED internal id decodes to the expected name
//   from THIS ROM's MonsterNames table (sym 07:421e, 10 bytes/entry, id-1
//   indexed, Gen1 charset A=0x80..Z=0x99, 0x50 terminator). Anchors on
//   Charmeleon=178, the species confirmed live in party RAM.
// Part B (pure logic): catchAdvice branch matrix - silence and message cases.

import { Rom } from "./rom";
import { WANTED, catchAdvice } from "./catch_policy";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
// MonsterNames is ROM-banked (07:421e per roms/pokeblue.sym); SymbolTable.addr
// is WRAM-oriented, so the banked address is pinned here and asserted by the
// CHARMELEON anchor below.
const [bank, addr] = [7, 0x421e];

function monName(id: number): string {
  const raw = rom.bytes(bank, addr + (id - 1) * 10, 10);
  let out = "";
  for (const b of raw) {
    if (b === 0x50) break;
    if (b >= 0x80 && b <= 0x99) out += String.fromCharCode(65 + (b - 0x80));
    else out += "?";
  }
  return out;
}

// Part A - ROM name asserts
chk("anchor CHARMELEON=178", monName(178) === "CHARMELEON", monName(178));
for (const [idStr, w] of Object.entries(WANTED)) {
  const id = Number(idStr);
  chk(`WANTED ${w.name}=${id}`, monName(id) === w.name, monName(id));
}

// Part B - advice matrix
const has = (s: string | null, sub: string) => s !== null && s.includes(sub);
chk("silent: no balls", catchAdvice(188, 10, 20, 1, 0, 1) === null);
chk("silent: party full", catchAdvice(188, 10, 20, 6, 5, 1) === null);
chk("silent: HP critical", catchAdvice(188, 10, 20, 1, 5, 0.2) === null);
chk("silent: unwanted foe, party>=2", catchAdvice(200, 10, 20, 2, 5, 1) === null);
chk("silent: non-urgent foe on last ball", catchAdvice(107, 10, 20, 2, 1, 1) === null);
chk("urgent bellsprout weaken-first", has(catchAdvice(188, 20, 20, 1, 3, 1), "! CATCH TARGET BELLSPROUT")
  && has(catchAdvice(188, 20, 20, 1, 3, 1), "weaken it below half"));
chk("bellsprout low-hp throw-now", has(catchAdvice(188, 5, 20, 1, 3, 1), "use_item(poke_ball) now"));
chk("abra throw immediately", has(catchAdvice(148, 25, 25, 1, 3, 1), "NOW, before it escapes"));
chk("zubat tip (not urgent)", has(catchAdvice(107, 10, 20, 2, 3, 1), "TIP: worth catching ZUBAT"));
chk("solo insurance on unknown foe", has(catchAdvice(200, 10, 20, 1, 3, 1), "any second body"));
chk("ball count rendered", has(catchAdvice(188, 20, 20, 1, 3, 1), "[balls: 3]"));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
