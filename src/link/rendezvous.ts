// wq#483 — M5c: DISTRIBUTED Cable Club rendezvous.
//
// wq#433 problem 2: the in-process rendezvous (drive_cableclub_menu.ts) parks
// one side by READING BOTH cores — `if (a.menu || b.menu)`, `if (a.ls>=2 &&
// b.ls>=2)`. A remote side cannot do that. Each process here drives ONLY its
// own core and infers the partner's state from two sources alone:
//   1. its own RAM (map, wLinkState, screen text), and
//   2. link liveness + the bytes that arrived (SerialBridge telemetry).
//
// The state machine is deliberately small and every transition is driven by an
// observation of OUR side, so a third party implementing the other end only has
// to speak the wire protocol (M5_REMOTE_LINK.md) and run the same phases.
//
//   IDLE -> AWAIT_PARTNER -> HANDSHAKE -> ROOM_SELECT
//        -> IN_ROOM (done) | ABORTED
//
// wq#522: this list, the Phase union and commit 6360dce's message used to
// disagree — the first two carried a WALK_TO_ATTENDANT phase that this.to()
// never entered. The commit message was the one that had it right. Deleted
// from the type and from here rather than implemented, because the walk to the
// attendant is not a phase: AWAIT_PARTNER deliberately does not advance the ROM
// past the attendant until the socket is up (see "late join" below), so there
// is no state to be in between the two.
//
// Failure handling (the ticket's three scenarios):
//   late join     AWAIT_PARTNER polls link readiness on a timer; it does NOT
//                 advance the ROM past the attendant until the socket is up, so
//                 a partner arriving 30s late is simply a longer wait.
//   disconnect    any onClose/pending-timeout mid-flight -> ABORTED with a
//                 reason; the core is left un-wedged by walking the dialog to a
//                 close instead of being killed mid-transfer.
//   room mismatch deterministic YIELD RULE (see below) so the two sides cannot
//                 deadlock politely forever.
import { CFG } from "../config";
import { SerialBridge } from "./bridge";
import { readLinkState } from "./linkstate";

/** Room selections, encoded as the ROM does: $D0 + menu item (main_menu.asm). */
export const ROOM = { TRADE_CENTER: 0xD0, COLOSSEUM: 0xD1, CANCEL: 0xD2 } as const;
export type RoomName = "TRADE_CENTER" | "COLOSSEUM";

export type Phase =
  | "IDLE" | "AWAIT_PARTNER" | "HANDSHAKE"
  | "ROOM_SELECT" | "IN_ROOM" | "ABORTED"
  | "STRANDED";  // wq#510: slave detected it cannot progress (master in room, no clock source)

/**
 * YIELD RULE (deterministic, no negotiation round-trip):
 * if the two sides ask for different rooms, the side whose ROLE is SLAVE
 * yields to the master's choice. Role is not a preference — it is decided by
 * the ROM's own connection handshake and readable at $FFAA on both ends
 * (2 = master/internal clock, 1 = slave), so both sides compute the SAME
 * winner from local RAM with zero extra protocol. A tie is impossible: the
 * handshake assigns exactly one master.
 *
 * If our side is master we keep our selection and re-send it; if slave, we
 * adopt the received selection. Either way both converge in one exchange.
 */
export function resolveRoom(ourRoom: number, theirRoom: number, ourRole: number): { room: number; yielded: boolean } {
  if (ourRoom === theirRoom) return { room: ourRoom, yielded: false };
  const weAreMaster = ourRole === 2;
  return weAreMaster ? { room: ourRoom, yielded: false } : { room: theirRoom, yielded: true };
}

export interface RendezvousOptions {
  room: RoomName;
  /** ms to wait for the partner socket before aborting (config-driven) */
  partnerTimeoutMs?: number;
  /** ms for the ROM-level handshake once the socket is up */
  handshakeTimeoutMs?: number;
  /** ms for room agreement */
  roomTimeoutMs?: number;
  onPhase?: (p: Phase, note: string) => void;
}

export interface RendezvousResult {
  ok: boolean;
  phase: Phase;
  room?: number;
  yielded: boolean;
  reason?: string;
  /** wq#510: true when the failure is a stranded-slave condition that a retry
   *  can resolve (reconnect + re-run from snapshot). False for genuinely dead
   *  peers, timeouts with no socket, or exhausted retries. */
  retryable: boolean;
  role: number;
  map: number;
  linkState: number;
  elapsedMs: number;
}

/** Everything the driver needs from a core, injected so the machine stays
 *  testable without an emulator (probe uses real cores; unit tests can fake). */
export interface CoreView {
  map(): number;
  linkState(): number;
  role(): number;               // $FFAA: 2 = master, 1 = slave, 255 = unset
  onMenu(): boolean;            // room-select menu visible
  hasDialog(): boolean;
  /** step our own core n frames, optionally holding a key */
  step(n: number, key?: number): Promise<void>;
  /** press A this step */
  keyA: number;
  /** wCurrentMenuItem ($CC26), or undefined while the room menu is not yet
   *  taking input. Optional: without it room select can only take the menu's
   *  default entry, which is TRADE CENTER (wq#3201). */
  menuCursor?(): number | undefined;
  keyDown?: number;
}

const TRADE_CENTER_MAP = 0xEF;
const COLOSSEUM_MAP = 0xF0;
export const ROOM_MAP: Record<number, number> = { [ROOM.TRADE_CENTER]: TRADE_CENTER_MAP, [ROOM.COLOSSEUM]: COLOSSEUM_MAP };

export class Rendezvous {
  phase: Phase = "IDLE";
  yielded = false;
  reason?: string;
  room: number;
  private t0 = Date.now();
  /** disconnect is owned by the bridge (wq#483): it fails pending waiters and
   *  flags .closed, so we never hijack the link's own onClose handler. */
  private get closed(): boolean { return this.bridge.closed; }

  constructor(private core: CoreView, private bridge: SerialBridge, private opts: RendezvousOptions) {
    this.room = opts.room === "COLOSSEUM" ? ROOM.COLOSSEUM : ROOM.TRADE_CENTER;
  }

  private to(p: Phase, note = ""): void {
    this.phase = p;
    this.opts.onPhase?.(p, note);
  }

  private abort(reason: string, retryable = false): RendezvousResult {
    this.reason = reason;
    this.to(retryable ? "STRANDED" : "ABORTED", reason);
    return this.result(false, retryable);
  }

  private result(ok: boolean, retryable = false): RendezvousResult {
    return {
      ok, phase: this.phase, room: ok ? this.room : undefined, yielded: this.yielded,
      reason: this.reason, retryable, role: this.core.role(), map: this.core.map(),
      linkState: this.core.linkState(), elapsedMs: Date.now() - this.t0,
    };
  }

  /** Run the whole rendezvous. Returns when we are IN_ROOM or ABORTED.
   *  The caller has already walked to the attendant tile and faced it. */
  async run(): Promise<RendezvousResult> {
    const partnerMs = this.opts.partnerTimeoutMs ?? CFG.rendezvous.partnerTimeoutMs;
    const handshakeMs = this.opts.handshakeTimeoutMs ?? CFG.rendezvous.handshakeTimeoutMs;
    const roomMs = this.opts.roomTimeoutMs ?? CFG.rendezvous.roomTimeoutMs;

    // --- AWAIT_PARTNER -----------------------------------------------------
    // Crucially we do NOT drive the ROM forward here: the attendant dialog is
    // where the ROM probes the cable, so starting it before the socket is up
    // burns the probe window. A late partner is just a longer wait.
    this.to("AWAIT_PARTNER", `waiting up to ${partnerMs}ms for the peer socket`);
    const deadlineP = Date.now() + partnerMs;
    while (!this.bridge.link.ready) {
      if (this.closed) return this.abort("peer disconnected while we waited for it");
      if (Date.now() > deadlineP) return this.abort(`no partner within ${partnerMs}ms`);
      await new Promise(r => setTimeout(r, 100));
    }

    // --- HANDSHAKE ---------------------------------------------------------
    // Drive OUR attendant dialog only. The ROM's own connection loop does the
    // rest; we watch our RAM for the role byte and the room menu.
    this.to("HANDSHAKE", "driving attendant dialog");
    const deadlineH = Date.now() + handshakeMs;
    while (!this.core.onMenu()) {
      if (this.closed) return this.abort("peer disconnected during the handshake");
      if (Date.now() > deadlineH)
        return this.abort(`handshake timeout after ${handshakeMs}ms (role=${this.core.role()}, ls=${this.core.linkState()})`);
      // Per frame, not per batch (wq#3201, measured): an 8-frame A hold that
      // straddles the room menu opening selects entry 0 before ROOM_SELECT ever
      // runs, and the first A pressed wins for BOTH sides. Stop the instant the
      // menu text is on screen.
      for (let i = 0; i < 30 && !this.core.onMenu(); i++) await this.core.step(1, i < 8 ? this.core.keyA : undefined);
    }

    // --- ROOM_SELECT -------------------------------------------------------
    // Our own screen shows the menu. We select OUR room; if the peer wanted a
    // different one, resolveRoom() decides deterministically from the role
    // byte, so both sides pick the same winner without extra protocol.
    this.to("ROOM_SELECT", `selecting $${this.room.toString(16)} (role=${this.core.role()})`);
    const deadlineR = Date.now() + roomMs;
    const target = ROOM_MAP[this.room];
    while (this.core.map() !== target) {
      // wq#510: if the peer drops during room-select and we are NOT in the room
      // yet, this is always a stranded-slave situation — the master entered the
      // room, lingered, and gave up. Retryable: reconnect and re-run.
      if (this.closed) return this.abort("peer disconnected during room select", true);
      if (Date.now() > deadlineR) {
        // one legitimate ending: the peer chose the OTHER room and we are the
        // slave -> we are in THEIR room, which is success, not failure.
        const other = this.core.map();
        if (other === TRADE_CENTER_MAP || other === COLOSSEUM_MAP) {
          const theirRoom = other === TRADE_CENTER_MAP ? ROOM.TRADE_CENTER : ROOM.COLOSSEUM;
          const r = resolveRoom(this.room, theirRoom, this.core.role());
          // Report the room we are standing in, not the one resolveRoom keeps
          // for a master: a master that landed elsewhere did not get its way.
          this.room = theirRoom; this.yielded = r.yielded;
          this.to("IN_ROOM", `landed in the peer's room ($${theirRoom.toString(16)}), yielded=${r.yielded}`);
          return this.result(true);
        }
        // wq#510: if the socket is STILL ALIVE and we are not in any room map,
        // this is a stranded slave (rabbit2/rabbit15 root cause: master entered
        // the room and stopped clocking; slave is passive with sent=0, so it
        // can never progress). Return STRANDED so the caller can retry via
        // reconnect rather than aborting terminally.
        const socketAlive = !this.closed;
        return this.abort(
          `room select ${socketAlive ? "stranded" : "timeout"} after ${roomMs}ms (map=$${other.toString(16)}, socket=${socketAlive ? "alive" : "dead"})`,
          socketAlive,  // retryable only when the peer is still there
        );
      }
      // press A only while our own menu/dialog is up — never blind-tap. On the
      // menu, walk the cursor to our room first: the menu opens on entry 0
      // (TRADE CENTER), so a bare A can never select COLOSSEUM (wq#3201). And
      // the FIRST side to press A imposes its entry on the other
      // (LinkMenu.useEnemyMenuSelection, $01:5C98), so an early A on the wrong
      // entry sends both sides to the wrong room.
      const onMenu = this.core.onMenu();
      const cur = onMenu ? this.core.menuCursor?.() : undefined;
      const want = this.room - ROOM.TRADE_CENTER;
      if (onMenu && this.core.menuCursor && this.core.keyDown !== undefined) {
        if (cur !== undefined) await this.core.step(6, cur === want ? this.core.keyA : this.core.keyDown);
      } else if (onMenu || this.core.hasDialog()) await this.core.step(6, this.core.keyA);
      await this.core.step(24);
    }

    this.to("IN_ROOM", `map $${this.core.map().toString(16)}`);
    return this.result(true);
  }
}
