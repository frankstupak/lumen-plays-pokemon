// P0 acceptance: checksum ROM, boot -> overworld, GameState decode, savestate round-trip
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { Emulator, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { EventBus } from "./events";

const ROM = process.argv[2] ?? "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = process.argv[3] ?? "/home/lumen/pokemon/roms/pokeblue.sym";
const KNOWN_SHA1: Record<string, string> = {
  "d7037c83e1ae5b39bde3c30787637ba1d4c48ce2": "Pokemon Blue (USA/Europe) - pret verified",
  "ea9bcae617fdf159b045185467ae58b2e4a48b9a": "Pokemon Red (USA/Europe) - pret verified",
};

if (!existsSync(ROM)) { console.error(`ROM not found: ${ROM}`); process.exit(2); }
const sha1 = createHash("sha1").update(readFileSync(ROM)).digest("hex");
const known = KNOWN_SHA1[sha1];
console.log(`ROM sha1 ${sha1} -> ${known ?? "UNKNOWN DUMP (symbols may not match!)"}`);
if (!known) process.exit(3);

const bus = new EventBus("/home/lumen/pokemon/events", "verify-" + Date.now());
const sym = new SymbolTable(SYM);
console.log(`symbols loaded: ${sym.size}`);
const emu = new Emulator(ROM);
const reader = new StateReader(emu, sym);
bus.emit("boot", { rom: ROM, sha1 });

emu.frames(400);
for (let i = 0; i < 8; i++) emu.tap(KEYS.START);
for (let i = 0; i < 4; i++) emu.tap(KEYS.A);
let st = reader.read();
for (let i = 0; i < 250 && st.map === 0; i++) { emu.tap(KEYS.A, 8, 14); st = reader.read(); }

console.log("GameState:", JSON.stringify(st));
bus.emit("state_read", st as unknown as object);
if (st.map !== 38) { console.error("FAIL: did not reach overworld map 38"); process.exit(4); }

// savestate round-trip
const snap = emu.saveState();
const before = JSON.stringify(reader.read());
emu.hold([KEYS.DOWN], 60); emu.frames(30);
emu.loadState(snap);
const after = JSON.stringify(reader.read());
console.log("savestate round-trip:", before === after ? "PASS" : "FAIL");
emu.screenPng("/home/lumen/pokemon/events/verify_frame.png");
bus.emit("verify", { result: before === after ? "PASS" : "FAIL", map: st.map });
if (before !== after) process.exit(5);
console.log("P0 VERIFY: ALL PASS");
