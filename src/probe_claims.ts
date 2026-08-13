// wq#519 probe: false possession pins + unnameable items.
//
// The fixtures are not invented. PINS_LIVE is the exact seven-line pinned
// region the live agent wrote into runtime/notepad.txt between 05:47Z and
// 06:09Z on 2026-08-13, and the item ids are asserted against the ROM rather
// than against my memory -- the ticket itself recalled HELIX_FOSSIL as 0x28
// and this ROM says 0x2a.
import { readFileSync, existsSync } from "fs";
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import { decodeGen1, decodeGen1Bytes } from "./names";
import { ITEM, ITEM_NAME, backfillItemNames, itemLabel } from "./items";
import { Notepad, parsePossessionClaim, PossessionClaim } from "./notepad";

const ROM_PATH = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM_PATH = "/home/lumen/pokemon/roms/pokeblue.sym";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// The live pinned region, verbatim, in write order.
const PINS_LIVE = [
  "Dome Fossil acquired - verify in inventory",
  "Dome Fossil confirmed in inventory",
  "Dome Fossil acquired and verified in inventory",
  "Dome Fossil confirmed in inventory",
  "Dome Fossil verified in inventory",
  "Dome Fossil in inventory",
  "Dome Fossil acquired and verified in inventory",
];

console.log("\n== A. item ids come from the ROM, not from memory ==");
const rom = new Rom(ROM_PATH);
const sym = new SymbolTable(SYM_PATH);

function romItemEntry(id: number): { text: string; unmapped: number[] } {
  const t = sym.sym("ItemNames");
  let addr = t.addr;
  for (let i = 1; ; i++) {
    const buf: number[] = [];
    let b = -1;
    for (;;) { b = rom.byte(t.bank, addr++); if (b === 0x50) break; buf.push(b); }
    if (i === id) { const d = decodeGen1Bytes(buf); return { text: d.text.trim(), unmapped: d.unmapped }; }
    if (i > 300) throw new Error("ran off ItemNames");
  }
}
const romItemName = (id: number) => romItemEntry(id).text;
const romItemNameUnmapped = (id: number) => romItemEntry(id).unmapped;
chk("ROM says DOME FOSSIL is ITEM.DOME_FOSSIL", romItemName(ITEM.DOME_FOSSIL) === "DOME FOSSIL", `got "${romItemName(ITEM.DOME_FOSSIL)}"`);
chk("ROM says HELIX FOSSIL is ITEM.HELIX_FOSSIL (ticket said 0x28)", romItemName(ITEM.HELIX_FOSSIL) === "HELIX FOSSIL", `got "${romItemName(ITEM.HELIX_FOSSIL)}"`);
chk("ROM says OLD AMBER is ITEM.OLD_AMBER", romItemName(ITEM.OLD_AMBER) === "OLD AMBER", `got "${romItemName(ITEM.OLD_AMBER)}"`);
chk("ticket's recalled HELIX id 0x28 is NOT helix", romItemName(0x28) !== "HELIX FOSSIL", `0x28 = "${romItemName(0x28)}"`);

console.log("\n== B. decodeGen1 byte coverage (all three read out of ItemNames) ==");
chk("POKe BALL decodes with no '?'", !romItemName(ITEM.POKE_BALL).includes("?"), `got "${romItemName(ITEM.POKE_BALL)}"`);
chk("0xba decodes to e-acute", decodeGen1([0xba]) === "\u00e9", `got "${decodeGen1([0xba])}"`);
chk("0xbd decodes to the 's ligature (OAK's PARCEL)", decodeGen1([0xbd]) === "'s", `got "${decodeGen1([0xbd])}"`);
chk("id 70 reads as OAK's PARCEL", romItemName(70) === "OAK's PARCEL", `got "${romItemName(70)}"`);
chk("0xe6 is a LITERAL question mark, not a decode failure", decodeGen1Bytes([0xe6]).text === "?" && decodeGen1Bytes([0xe6]).unmapped.length === 0);
chk("id 7 really is named ????? and reports zero unmapped bytes", romItemName(7) === "?????" && romItemNameUnmapped(7).length === 0, `got "${romItemName(7)}"`);
chk("a genuinely unmapped byte IS reported", decodeGen1Bytes([0x01]).unmapped.length === 1, JSON.stringify(decodeGen1Bytes([0x01])));
chk("no ItemNames entry has an unmapped byte", (() => { for (let i = 1; i <= 97; i++) if (romItemNameUnmapped(i).length) return false; return true; })());

console.log("\n== C. backfillItemNames: gaps only, lengths derived ==");
const beforeNames: Record<number, string> = { ...ITEM_NAME };
const res = backfillItemNames(rom, sym);
chk("backfill added entries", res.added > 0, `added=${res.added}`);
chk("ItemNames/ItemPrices agree on count", res.total === 97, `total=${res.total}`);
let overwritten = 0;
for (const k of Object.keys(beforeNames)) if (ITEM_NAME[Number(k)] !== beforeNames[Number(k)]) overwritten++;
chk("no pre-existing name overwritten (buy() cursor match depends on them)", overwritten === 0, `overwritten=${overwritten}`);
chk("poke_ball name still the hand-written form", ITEM_NAME[ITEM.POKE_BALL] === "poke_ball", `got "${ITEM_NAME[ITEM.POKE_BALL]}"`);
chk("a fossil is now nameable", /fossil/.test(itemLabel(ITEM.DOME_FOSSIL)), itemLabel(ITEM.DOME_FOSSIL));
chk("the bag's actual item 234 gets an honest label, not a guess", itemLabel(234) === "unknown_item_234", itemLabel(234));
chk("backfill is idempotent", backfillItemNames(rom, sym).added === 0);

console.log("\n== D. possession-claim parsing on the REAL pins ==");
for (const p of PINS_LIVE) {
  const c = parsePossessionClaim(p);
  chk(`parsed: "${p}"`, c !== null && c.subject === "dome fossil", c ? `subject="${c.subject}"` : "null");
}

console.log("\n== E. non-possession lines must NOT be treated as claims (false-positive guard) ==");
for (const s of [
  "Mt Moon B2F ladder to Route 4 east is at (21,25)",
  "DO NOT re-enter Mt Moon after exiting east",
  "Super Nerd at (21,17) guards the fossils",
  "Route 4 west and east share map id 15",
  "buy a POKE BALL when money >= 200",
]) chk(`not a claim: "${s.slice(0, 44)}"`, parsePossessionClaim(s) === null, JSON.stringify(parsePossessionClaim(s)));

console.log("\n== F. duplicate guard collapses the live loop ==");
{
  const pad = new Notepad();
  const results = PINS_LIVE.map(p => pad.note("PIN: " + p));
  chk("first pin accepted", results[0] === "PINNED (permanent)", results[0]);
  chk("remaining six all rejected", results.slice(1).every(r => r.startsWith("pin REDUNDANT")), results.slice(1).join(" | ").slice(0, 120));
  chk("pinned region holds exactly 1 line (was 7)", pad.pinned.length === 1, `len=${pad.pinned.length}`);
  chk("reject text names the existing pin", results[1].includes("Dome Fossil acquired - verify in inventory"), results[1]);
  chk("reject text tells the brain how to correct instead", results[2].includes("write a normal note instead"), results[2]);
}

console.log("\n== G. duplicate guard must not block genuinely different pins ==");
{
  const pad = new Notepad();
  const a = pad.note("PIN: Dome Fossil in inventory");
  const b = pad.note("PIN: Helix Fossil in inventory");
  const c = pad.note("PIN: east exit ladder at (21,25)");
  const d = pad.note("PIN: Mt Moon B2F has no mart");
  chk("different item is allowed", b === "PINNED (permanent)", b);
  chk("non-claim pin is allowed", c === "PINNED (permanent)", c);
  chk("second non-claim pin is allowed", d === "PINNED (permanent)", d);
  chk("four distinct pins retained", pad.pinned.length === 4, `len=${pad.pinned.length}`);
  chk("first still accepted", a === "PINNED (permanent)", a);
}

console.log("\n== H. verifyClaims: drops only on positive disagreement ==");
{
  const mk = () => { const p = new Notepad(); p.pinned = [...PINS_LIVE.slice(0, 3), "east exit ladder at (21,25)"]; return p; };

  const padFalse = mk();
  padFalse.claimChecker = (c: PossessionClaim) => c.subject === "dome fossil" ? { holds: false, evidence: "Bag read: wNumBagItems=1, entries [234]." } : null;
  const rF = padFalse.verifyClaims();
  chk("false claims dropped", rF.dropped.length === 3, `dropped=${rF.dropped.length}`);
  chk("non-claim pin survives", padFalse.pinned.length === 1 && padFalse.pinned[0].startsWith("east exit"), JSON.stringify(padFalse.pinned));
  chk("correction written where the brain will read it", padFalse.rolling.some(r => r.includes("is FALSE") && r.includes("wNumBagItems")), JSON.stringify(padFalse.rolling).slice(0, 140));
  chk("correction forbids re-pinning", padFalse.rolling.some(r => r.includes("Do not re-pin")), "");

  const padTrue = mk();
  padTrue.claimChecker = () => ({ holds: true, evidence: "bag has it" });
  const rT = padTrue.verifyClaims();
  chk("true claims kept", rT.dropped.length === 0 && padTrue.pinned.length === 4, `dropped=${rT.dropped.length} len=${padTrue.pinned.length}`);

  const padUnk = mk();
  padUnk.claimChecker = () => null;
  const rU = padUnk.verifyClaims();
  chk("unverifiable claims kept, never guessed away", rU.dropped.length === 0 && padUnk.pinned.length === 4, `dropped=${rU.dropped.length}`);

  const padThrow = mk();
  padThrow.claimChecker = () => { throw new Error("checker exploded"); };
  const rX = padThrow.verifyClaims();
  chk("a throwing checker drops nothing", rX.dropped.length === 0 && padThrow.pinned.length === 4, `dropped=${rX.dropped.length}`);

  const padNone = mk();
  const rN = padNone.verifyClaims();
  chk("no checker installed = no-op", rN.checked === 0 && padNone.pinned.length === 4, `checked=${rN.checked}`);
}

console.log("\n== I. unpin: the inverse the pad never had ==");
{
  const pad = new Notepad();
  pad.pinned = [...PINS_LIVE.slice(0, 3), "east exit ladder at (21,25)"];
  const removed = pad.unpin("dome fossil");
  chk("unpin removed the fossil pins", removed.length === 3, `removed=${removed.length}`);
  chk("unpin left the unrelated pin", pad.pinned.length === 1, JSON.stringify(pad.pinned));
  chk("unpin by regex works", new (class { })() !== null && (() => { const p = new Notepad(); p.pinned = ["a fact", "b fact"]; return p.unpin(/^a /).length === 1; })());
  chk("unpin with no match is a no-op", pad.unpin("helix").length === 0);
}

console.log("\n== J. lazy verification runs on first render (hook lives in notepad.ts) ==");
{
  const pad = new Notepad();
  pad.pinned = [...PINS_LIVE];
  pad.claimChecker = () => ({ holds: false, evidence: "bag empty." });
  chk("not yet verified before render", pad.lastVerification === null);
  const out = pad.renderNotes();
  chk("verification ran on render", pad.lastVerification !== null && pad.lastVerification.dropped.length === 7, JSON.stringify(pad.lastVerification));
  chk("pinned region is now empty", pad.pinned.length === 0, JSON.stringify(pad.pinned));
  chk("render has no PINNED block at all", !out.includes("PINNED:"), out.slice(0, 120));
  chk("render carries the correction instead", out.includes("is FALSE"), out.slice(0, 160));
  const before = pad.lastVerification!.dropped.length;
  pad.renderNotes();
  chk("verification is idempotent", pad.lastVerification!.dropped.length === before);
}

console.log("\n== K. against the REAL live notepad on disk (read-only) ==");
{
  const LIVE = "/home/lumen/pokemon/runtime/notepad.txt";
  if (!existsSync(LIVE)) { console.log("  skip: runtime/notepad.txt absent"); }
  else {
    const j = JSON.parse(readFileSync(LIVE, "utf8")) as { pinned: string[] };
    console.log(`  live pinned region: ${j.pinned.length} lines`);
    const claims = j.pinned.filter(p => parsePossessionClaim(p) !== null);
    chk("every live pin is recognised as a possession claim", claims.length === j.pinned.length, `${claims.length}/${j.pinned.length}`);
    const pad = new Notepad();
    const accepted = j.pinned.filter(p => pad.note("PIN: " + p) === "PINNED (permanent)");
    console.log(`  with the guard: ${j.pinned.length} live pins -> ${accepted.length} accepted`);
    chk("guard collapses the live pinned region to one line", accepted.length === 1, `accepted=${accepted.length}`);
  }
}

console.log(`\nprobe_claims: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
