// wq#547 probe — the blackout detector, its ROM-derived Center table, and the
// OBSERVABILITY claim that motivated the whole ticket.
//   npx tsx src/probe_blackout547.ts
//
// Section A re-derives CENTER_MAPS from the ROM on every run (the SPLIT_MAPS /
// POCKET_MAPS contract) so a shipped literal cannot silently drift.
// Section D replays REAL event logs rather than a synthetic bus, because
// wq#547's item 4 is precisely that probe_metrics proved arithmetic and never
// proved observability.
import { readFileSync, existsSync, readdirSync } from "fs";
import * as path from "path";
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import { GameNames } from "./names";
import { CENTER_MAPS } from "./centers";
import { BlackoutDetector } from "./blackout";

// wq#520/540: resolve SOURCE files against THIS checkout, never against a
// hardcoded /home/lumen/pokemon. My first draft of this probe hardcoded the
// primary tree and sections E and F therefore graded the WRONG FILES — they
// went red from a worktree while the change under test was correct. That is
// verify_489.py's defect (wq#520) and probe_phase514's (wq#540) for the third
// and fourth time, and I reproduced it while writing the probe that cites it.
const SRC = __dirname;
const src = (f: string) => readFileSync(path.join(SRC, f), "utf8");
// The event corpus is deliberately NOT checkout-relative: there is exactly one
// live corpus and worktrees do not carry it (events/ is gitignored).
const EVENTS = "/home/lumen/pokemon/events";

let pass = 0, fail = 0;
const chk = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
};

// ─────────────────────────── A. the literal is ROM-checked, not remembered
console.log("=== A. CENTER_MAPS re-derived from the ROM ===");
{
  const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
  const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
  const names = new GameNames(rom, sym);
  const derived = new Set<number>(
    Object.entries(names.maps)
      .filter(([, v]) => /pokecenter/i.test(v))
      .map(([k]) => Number(k)),
  );
  const shipped = [...CENTER_MAPS].sort((a, b) => a - b);
  const fromRom = [...derived].sort((a, b) => a - b);
  chk("A1 shipped CENTER_MAPS equals the ROM-derived set, id for id",
    JSON.stringify(shipped) === JSON.stringify(fromRom),
    `shipped=${shipped.join(",")} rom=${fromRom.join(",")}`);
  chk("A2 the set is non-empty (a null derivation must not pass silently)",
    fromRom.length > 0, `n=${fromRom.length}`);
  chk("A3 Viridian(41) and Pewter(58) are Centers", derived.has(41) && derived.has(58));
  chk("A4 Pewter CITY(2) and Route 4(15) are NOT Centers — the corridor maps the "
    + "campaign actually sits on must not score as a Center",
    !derived.has(2) && !derived.has(15));
}

// ─────────────────────────── B. the rule, including the one the ticket got wrong
console.log("\n=== B. fire on halving + corroborator; never on a normal heal ===");
{
  const hurt = [{ hp: 10, maxHp: 76 }], full = [{ hp: 76, maxHp: 76 }];

  // B1: the canonical blackout — purse halved, warped to a Center, party full.
  let d = new BlackoutDetector();
  d.observe({ map: 61, money: 430, party: hurt });
  chk("B1 halving + Center + restore fires", !!d.observe({ map: 58, money: 215, party: full }));

  // B2: *** THE FALSE POSITIVE wq#547's OWN RULE WOULD HAVE PRODUCED. ***
  // The ticket says "require at least two co-occurring signatures ... so a
  // Center visit for a normal heal is not miscounted". A normal heal IS at a
  // Center (S2) AND restores the party (S3) — two signatures — so two-of-three
  // fires on every single heal. Gen 1 heals are free, so money is what
  // separates them, and money-halving is mandatory here.
  d = new BlackoutDetector();
  d.observe({ map: 58, money: 431, party: hurt });
  chk("B2 a NORMAL HEAL at a Center does not fire (money unchanged)",
    !d.observe({ map: 58, money: 431, party: full }));

  // B3: money halved but nothing corroborates — e.g. a mart purchase that
  // happens to cost exactly half. Not enough on its own.
  d = new BlackoutDetector();
  d.observe({ map: 2, money: 400, party: hurt });
  chk("B3 halving alone, no Center and no restore, does not fire",
    !d.observe({ map: 2, money: 200, party: hurt }));

  // B4: floor rounding, as Red does it on an odd purse.
  d = new BlackoutDetector();
  d.observe({ map: 61, money: 431, party: hurt });
  chk("B4 odd purse halves with floor rounding (431 -> 215)",
    !!d.observe({ map: 58, money: 215, party: full }));

  // B5: an arbitrary spend is not a halving.
  d = new BlackoutDetector();
  d.observe({ map: 58, money: 431, party: hurt });
  chk("B5 a 350-cost purchase (431 -> 81) does not fire",
    !d.observe({ map: 58, money: 81, party: hurt }));

  // B6: restore-corroborated blackout when the Center id is unknown/absent.
  d = new BlackoutDetector();
  d.observe({ map: 61, money: 200, party: hurt });
  chk("B6 halving + party restored fires even without a Center map",
    !!d.observe({ map: 999, money: 100, party: full }));

  // B7: zero purse cannot halve — must not fire on 0 -> 0.
  d = new BlackoutDetector();
  d.observe({ map: 61, money: 0, party: hurt });
  chk("B7 a broke player (0 -> 0) does not fire", !d.observe({ map: 58, money: 0, party: full }));

  // B8: the OLD detector's target — all-fainted — is not required.
  d = new BlackoutDetector();
  d.observe({ map: 61, money: 100, party: [{ hp: 0, maxHp: 76 }] });
  chk("B8 fires without ever seeing an all-fainted sample in the AFTER state",
    !!d.observe({ map: 58, money: 50, party: full }));
}

// ─────────────────────────── C. the observability claim, restated as a test
console.log("\n=== C. why the old all-fainted edge could not work ===");
{
  let withParty = 0, allFainted = 0;
  if (existsSync(EVENTS)) {
    for (const f of readdirSync(EVENTS).filter((f) => f.startsWith("live-agent-") && f.endsWith(".jsonl"))) {
      for (const line of readFileSync(`${EVENTS}/${f}`, "utf8").split("\n")) {
        if (!line) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.kind !== "state_read" || !Array.isArray(e.party) || e.party.length === 0) continue;
        withParty++;
        if (e.party.every((p: any) => p.hp === 0)) allFainted++;
      }
    }
  }
  console.log(`  sampled ${withParty} state_reads carrying party data across the surviving logs`);
  chk("C1 the corpus is non-empty (a green tick must not mean 'nothing checked')",
    withParty > 0, `n=${withParty}`);
  chk("C2 all-fainted was observed ZERO times — the old edge was unobservable, "
    + "not merely rare", allFainted === 0, `allFainted=${allFainted}`);
}

// ─────────────────────────── D. backtest on real logs, coverage stated honestly
console.log("\n=== D. replay of the real event logs ===");
{
  const logs = existsSync(EVENTS)
    ? readdirSync(EVENTS).filter((f) => f.startsWith("live-agent-") && f.endsWith(".jsonl")).sort()
    : [];
  const summaries = existsSync(EVENTS)
    ? readdirSync(EVENTS).filter((f) => f.startsWith("run-summary-") && f.endsWith(".json"))
    : [];
  let hits = 0, reads = 0, drops = 0;
  for (const f of logs) {
    const d = new BlackoutDetector();
    let prevMoney: number | null = null;
    for (const line of readFileSync(`${EVENTS}/${f}`, "utf8").split("\n")) {
      if (!line) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.kind !== "state_read") continue;
      reads++;
      if (typeof e.money === "number") {
        if (prevMoney !== null && e.money < prevMoney) drops++;
        prevMoney = e.money;
      }
      if (d.observe(e)) hits++;
    }
  }
  console.log(`  ${logs.length} event logs replayed, ${reads} state_reads, `
    + `${drops} money decreases of ANY size, ${hits} blackouts detected`);
  chk("D1 the replay ran over a real corpus", reads > 0, `reads=${reads}`);
  chk("D2 detector count equals the money-decrease count it can possibly explain",
    hits <= drops, `hits=${hits} drops=${drops}`);
  // *** THE COVERAGE STATEMENT, WHICH IS THE POINT OF THIS SECTION. ***
  // The acceptance asks for a defensible historical count. It is NOT available:
  // event logs rotate and run-summaries do not, so the logs on disk describe a
  // small and recent slice of the campaign. This asserts that the gap is real
  // and visible rather than letting a "0 blackouts found" read as history.
  console.log(`  COVERAGE: ${logs.length} event logs survive against ${summaries.length} `
    + `run-summaries — the replay sees ~${summaries.length ? Math.round(100 * logs.length / summaries.length) : 0}% of runs`);
  chk("D3 coverage is known to be PARTIAL, so no count from this replay may be "
    + "published as the historical total",
    summaries.length > logs.length, `logs=${logs.length} summaries=${summaries.length}`);
}

// ─────────────────────────── E. the ledger never mixes measured with remembered
console.log("\n=== E. ledger honesty ===");
{
  const p = `${EVENTS}/retry_ledger.json`;
  if (!existsSync(p)) {
    console.log("  SKIP: no retry_ledger.json on disk (property not satisfiable here)");
  } else {
    const l = JSON.parse(readFileSync(p, "utf8"));
    const retrySrc = src("retry.ts");
    chk("E1 stats() reports whiteouts from the OBSERVED base, never whiteoutsBase",
      /whiteouts:\s*\(this\.l\.whiteoutsObservedBase\s*\?\?\s*0\)\s*\+\s*this\.l\.currentWhiteouts/.test(retrySrc));
    chk("E2 the frozen estimate is reported as its own field",
      /whiteoutsEstimatePre:\s*this\.l\.whiteoutsEstimatePre/.test(retrySrc));
    chk("E3 nothing adds into whiteoutsEstimatePre", !/whiteoutsEstimatePre\s*\+=/.test(retrySrc));
    chk("E4 the run rollover folds into the OBSERVED base",
      /whiteoutsObservedBase\s*\+=\s*this\.l\.currentWhiteouts/.test(retrySrc));
    console.log(`  ledger now: base=${l.whiteoutsBase} estimatePre=${l.whiteoutsEstimatePre ?? "(unmigrated)"} `
      + `observedBase=${l.whiteoutsObservedBase ?? "(unmigrated)"} current=${l.currentWhiteouts}`);
  }
}

// ─────────────────────────── F. wiring — the kiosk actually renders the split
console.log("\n=== F. kiosk wiring (source text, per wq#520/540) ===");
{
  const s = src("stream.ts");
  chk("F1 the permanently-zero CONTINUES tile is gone from the gameplay block",
    !/<b style='color:#d29922'>CONTINUES<\/b>/.test(s));
  chk("F2 harness resumes are rendered on the dim infra line instead",
    /resumes " \+ retriesTxt\.c/.test(s));
  chk("F3 the pre-instrumentation estimate renders separately from the live count",
    /est\. pre-08-13/.test(s));
  chk("F4 /retries.json carries whiteoutsEstimatePre", /whiteoutsEstimatePre/.test(s));
}

console.log(`\nprobe_blackout547: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
