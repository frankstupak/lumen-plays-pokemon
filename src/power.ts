// Power meter for the kiosk tablet's own draw (E1 plug, Athom ESP32-C3, ex-P12).
// HA-direct (Bes :8123) — entity slugs still read p12_* (cosmetic, per fleet state).
// Persistent ledger accrues kWh + PG&E E-TOU-C cost from the plug's monotonic
// total-energy counter, so restarts/downtime never double- or under-count.
import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";

const HA_URL = "http://100.110.156.91:8123";
const TOKEN_PATH = "/home/lumen/.secrets/bes_ha_token";
const LEDGER_PATH = "/home/lumen/pokemon/events/power_ledger.json";
const POLL_MS = 15_000;

// PG&E E-TOU-C $/kWh (above-baseline), rates eff 2026-03-01 per fleet cost engine
// (/home/lumen/power-dash/staged/pge_tou_cost.py — keep in sync with that source).
// Summer = Jun 1–Sep 30. Peak 4-9pm daily; partial 3-4pm + 9pm-12am; off 12am-3pm.
function rateNow(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", month: "numeric", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const month = get("month"), h = get("hour") % 24;
  const summer = month >= 6 && month <= 9;
  if (h >= 16 && h < 21) return summer ? 0.52 : 0.40;          // peak
  if (h === 15 || h >= 21) return summer ? 0.40 : 0.37;        // partial
  return summer ? 0.32 : 0.29;                                  // off-peak
}

interface Ledger {
  start: string;          // ISO — metered tracking start
  kwh: number;            // metered kWh since start
  cost: number;           // metered $ since start (TOU-rated at time of use)
  lastTotalKwh: number;   // plug's monotonic total_energy at last sample
  backfill_kwh?: number;  // estimated pre-meter usage (project start -> plug connect)
  backfill_cost?: number;
  backfill_note?: string;
}

export class PowerMeter {
  private token: string | null = null;
  private ledger: Ledger | null = null;
  private currentW: number | null = null;
  private lastOk = 0;

  constructor() {
    try { this.token = readFileSync(TOKEN_PATH, "utf8").trim(); }
    catch { console.error("power: HA token unreadable — meter disabled"); return; }
    try { this.ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")); }
    catch { this.ledger = null; }   // first run: initialized on first sample
    this.poll();
    setInterval(() => this.poll(), POLL_MS).unref();
  }

  private async ha(entity: string): Promise<number | null> {
    const r = await fetch(`${HA_URL}/api/states/${entity}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const v = Number((await r.json() as any).state);
    return Number.isFinite(v) ? v : null;
  }

  private async poll() {
    if (!this.token) return;
    try {
      const [w, total] = await Promise.all([
        this.ha("sensor.p12_power"), this.ha("sensor.p12_total_energy"),
      ]);
      if (w !== null) { this.currentW = w; this.lastOk = Date.now(); }
      if (total === null) return;
      if (!this.ledger) {
        this.ledger = { start: new Date().toISOString(), kwh: 0, cost: 0, lastTotalKwh: total };
        this.save(); return;
      }
      const delta = total - this.ledger.lastTotalKwh;
      // Counter reset (ESPHome reflash) or absurd jump -> resync, don't accrue.
      if (delta < 0 || delta > 1) { this.ledger.lastTotalKwh = total; this.save(); return; }
      if (delta > 0) {
        this.ledger.kwh += delta;
        this.ledger.cost += delta * rateNow(new Date());
        this.ledger.lastTotalKwh = total;
        this.save();
      }
    } catch { /* fail-open: stale stats beat a crashed stream server */ }
  }

  private save() {
    try {
      writeFileSync(LEDGER_PATH + ".tmp", JSON.stringify(this.ledger));
      renameSync(LEDGER_PATH + ".tmp", LEDGER_PATH);
    } catch {}
  }

  /** Stats for /power.json. Lifetime = metered + pre-meter backfill estimate.
      avg_w = energy-true average over the metered period only. */
  stats() {
    const stale = Date.now() - this.lastOk > 90_000;
    const l = this.ledger;
    const hours = l ? Math.max((Date.now() - Date.parse(l.start)) / 3.6e6, 1 / 60) : 0;
    return {
      ok: !!this.token && !stale,
      w: stale ? null : this.currentW,
      avg_w: l ? (l.kwh * 1000) / hours : null,
      kwh: l ? l.kwh + (l.backfill_kwh ?? 0) : null,
      cost: l ? l.cost + (l.backfill_cost ?? 0) : null,
      rate: rateNow(new Date()),
      since: l ? l.start : null,
    };
  }
}
