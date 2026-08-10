// LPP Multiplayer — lockstep runner (wq#431).
//
// WHY THIS EXISTS (measured, 2026-08-08):
// serverboy only exposes whole-frame execution (doFrame ~70k cycles). Running
// core A for a full frame and then core B for a full frame is NOT lockstep at
// serial granularity: during A's frame, B is frozen and cannot run its serial
// ISR, so it cannot stage a fresh reply byte. Per the hardware rule (R2), an
// unready follower re-sends its LAST staged byte — so a master blasting a long
// block clocks hundreds of bytes against one stale value.
//
// That is survivable for the short handshake (a few bytes per frame) but
// corrupts Gen1's 415-byte party block: the trade menu rendered the partner's
// party as glitch entries ('M 'M 'M ...).
//
// FIX: shrink each doFrame() to roughly one serial-transfer window (~512
// cycles, per Pan Docs 8192Hz DMG rate) and complete transfers on a deferred
// tick, so the follower actually executes between the master's clocks.
// MEASURED: party block arrives intact — partner list renders the real party
// ("AAAAAAA CHARMELEON") with ZERO glitch entries; exchanges 701 -> 826.
//
// COST: fine slicing multiplies doFrame() calls, so wall time scales with the
// divisor. Use COARSE (divisor 1) for navigation/dialog and switch to FINE only
// around block transfers — that hybrid keeps runs practical.

import { SerialBus } from "./serialbus";

/** A DMG serial transfer is ~512 cycles at the 8192Hz internal rate. */
export const TRANSFER_CYCLES = 512;

const BASE = new WeakMap<any, number>();

/**
 * Run ONE core for approximately `cycles` CPU cycles.
 * serverboy's core.run() executes exactly CPUCyclesTotal cycles and sets
 * frameDone (doFrame simply loops run() until the frame completes), so setting a
 * small CPUCyclesTotal and calling run() once is a legitimate sub-frame step —
 * no emulator patching required.
 * Restores the previous budget so callers can interleave freely.
 */
export function runCycles(core: any, cycles: number): void {
  const prevBase = core.CPUCyclesTotalBase, prevTotal = core.CPUCyclesTotal;
  core.CPUCyclesTotalBase = core.CPUCyclesTotal = Math.max(4, cycles & ~3);
  core.stopEmulator &= 1;          // same precondition doFrame establishes
  core.frameDone = false;
  core.run();
  core.CPUCyclesTotalBase = prevBase; core.CPUCyclesTotal = prevTotal;
}

/**
 * Set a core's per-doFrame cycle budget to base/div. Idempotent: the original
 * base is remembered, so repeated calls do not compound.
 * Returns the resulting cycles-per-step.
 */
export function setSlice(core: any, div: number): number {
  if (!BASE.has(core)) BASE.set(core, core.CPUCyclesTotalBase);
  const base = BASE.get(core)!;
  core.CPUCyclesTotalBase = core.CPUCyclesTotal = Math.max(4, (base / div) & ~3);
  return core.CPUCyclesTotal;
}

/** Restore a core's normal full-frame budget. */
export function clearSlice(core: any): void {
  if (BASE.has(core)) core.CPUCyclesTotalBase = core.CPUCyclesTotal = BASE.get(core)!;
}

/**
 * Pick the divisor whose slice is closest to one serial transfer window.
 * With serverboy's default ~33552 cycles/iteration this yields 64 (~524 cycles).
 */
export function transferSliceDivisor(core: any): number {
  const base = BASE.get(core) ?? core.CPUCyclesTotalBase;
  return Math.max(1, Math.round(base / TRANSFER_CYCLES));
}

/**
 * Steps two cores together at the current slice, ticking the bus so deferred
 * transfers complete between steps. `keyA`/`keyB` are optional per-core inputs
 * (they differ: the two sides need different inputs once in the Cable Club).
 */
export class Lockstep {
  constructor(
    private a: any,          // Emulator
    private b: any,          // Emulator
    private bus: SerialBus,
  ) {}

  /** Enable ~one-transfer-per-step interleaving on both cores. */
  fine(div?: number): number {
    const d = div ?? transferSliceDivisor(this.a.core);
    setSlice(this.a.core, d);
    return setSlice(this.b.core, d);
  }

  /** Back to full frames (fast; fine for navigation and dialog). */
  coarse(): void { clearSlice(this.a.core); clearSlice(this.b.core); }

  step(n: number, keyA?: number, keyB?: number): void {
    for (let i = 0; i < n; i++) {
      if (keyA !== undefined) this.a.gbPressKey ? this.a.gbPressKey(keyA) : (this.a as any).gb?.pressKey(keyA);
      if (keyB !== undefined) this.b.gbPressKey ? this.b.gbPressKey(keyB) : (this.b as any).gb?.pressKey(keyB);
      (this.a as any).gb.doFrame();
      (this.b as any).gb.doFrame();
      this.bus.tick();
    }
  }
}
