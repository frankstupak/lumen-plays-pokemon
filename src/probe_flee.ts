import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Battle } from "./battle";
import { StateReader } from "./state";
const sym=new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym"); const emu=new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
// wq#540: FIXTURE RESOLVED BY PROPERTY, NOT BY NAME. This probe used to load
// checkpoints/auto-msjdams8-t230.state.gz (map 51, Viridian Forest) (map 51, Viridian Forest). That file
// rotated off disk, so the probe died with an ENOENT stack trace BEFORE its
// first assertion -- it emitted no FAIL line at all, and its last known score
// was a memory. Any state standing in wild-encounter terrain will do here, so
// ask for that property instead of naming a file.
import { findFixture, requireFixture } from "./fixtures";
// Maps whose overworld generates wild encounters, in preference order:
// Viridian Forest, then the Mt Moon interiors and the routes either side.
const WILD_MAPS = [51, 59, 60, 61, 15, 14, 13, 12];
const WILD_FIXTURE = requireFixture(
  "a checkpoint standing on wild-encounter terrain (map " + WILD_MAPS.join("/") + ")",
  findFixture(sc => WILD_MAPS.includes(sc.map)));
loadSnapshotFile(emu, WILD_FIXTURE);
const rom=new Rom("/home/lumen/pokemon/roms/pokeblue.gb"); const bus=new EventBus("/tmp","flee-"+Date.now());
const map=new MapModel(emu,sym,rom); const scr=new Screen(emu,sym); const sync=new Sync(emu,sym);
const nav=new Navigator(emu,sym,map,bus,sync); const dlg=new Dialog(emu,scr,sync,bus,sym);
const bat=new Battle(emu,sym,scr,sync,dlg,bus); const reader=new StateReader(emu,sym);
let pass=0,fail=0; const chk=(n:string,ok:boolean,d="")=>{console.log(`${ok?"PASS":"FAIL"} ${n}${d?" :: "+d:""}`);ok?pass++:fail++;};
(async()=>{
  await emu.framesAsync(60); await sync.settle();
  // trigger wild battle
  const dirs=[KEYS.UP,KEYS.DOWN,KEYS.LEFT,KEYS.RIGHT]; let trig=false;
  for(let i=0;i<80&&!trig;i++){await emu.tapAsync(dirs[i%4],8,12);await sync.settle(60);if(bat.active())trig=true;}
  chk("wild battle triggered",trig&&reader.read().inBattle===1,`inBattle=${reader.read().inBattle}`);
  if(!trig)process.exit(1);
  const r=await bat.flee();
  chk("flee returned fled",r==="fled",`r=${r}`);
  chk("battle ended after flee",!bat.active(),`active=${bat.active()}`);
  console.log(`\n${pass} pass / ${fail} fail`); process.exit(fail?1:0);
})();
