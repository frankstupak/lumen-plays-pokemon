// M5 transport gate (wq#433): prove the BGB wire layer before any ROM touches it.
//
//   npx tsx src/link/probe_bgblink.ts
//
// Three things are checked, in the order they can silently break:
//   T1 codec      — 8-byte layout, little-endian i1, 31-bit timestamp clamp.
//   T2 framing    — the spec's "packet boundaries are not guaranteed" rule:
//                   several packets in one chunk, and a packet split ACROSS
//                   chunks, including a 1-byte-at-a-time dribble.
//   T3 loopback   — two real BgbLink endpoints over a TCP socket: handshake,
//                   then a byte stream both directions with the roles the
//                   protocol defines (sync1 from the master, sync2 back).
//
// Real BGB is not needed to prove the wire layer: two of our own endpoints
// speaking the documented packet format is BGB-compatible by construction.

import {
  BgbLink, PacketReader, encodePacket, decodePacket, versionPacket, sync1Packet,
  sync2Packet, statusPacket, versionMatches, CMD, PACKET_SIZE,
} from "./bgblink";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- T1 codec
console.log("T1 codec");
{
  const p = { b1: CMD.sync1, b2: 0xAB, b3: 0x81, b4: 0, i1: 0x01020304 };
  const b = encodePacket(p);
  check("packet is 8 bytes", b.length === PACKET_SIZE, `got ${b.length}`);
  check("i1 is little endian", b[4] === 0x04 && b[7] === 0x01,
        `bytes ${[...b.subarray(4)].map(x => x.toString(16)).join(" ")}`);
  const r = decodePacket(b);
  check("round trip", r.b1 === p.b1 && r.b2 === p.b2 && r.b3 === p.b3 && r.i1 === p.i1);
  // Spec: timestamps carry the low 31 bits, the top bit is always 0.
  const hi = decodePacket(encodePacket({ b1: 0, b2: 0, b3: 0, b4: 0, i1: 0xFFFFFFFF }));
  check("timestamp clamped to 31 bits", hi.i1 === 0x7FFFFFFF, `got ${hi.i1.toString(16)}`);
  check("version packet is 1/1/4/0", versionMatches(versionPacket()));
  check("wrong version rejected", !versionMatches({ b1: 1, b2: 1, b3: 5, b4: 0, i1: 0 }));
}

// -------------------------------------------------------------- T2 framing
console.log("T2 framing (spec: packet boundaries are NOT guaranteed)");
{
  const wire = Buffer.concat([
    encodePacket(versionPacket()),
    encodePacket(statusPacket()),
    encodePacket(sync1Packet(0x42, 12345)),
  ]);

  const r1 = new PacketReader();
  const all = r1.push(wire);
  check("three packets in one chunk", all.length === 3, `got ${all.length}`);
  check("order preserved", all[0].b1 === CMD.version && all[1].b1 === CMD.status && all[2].b2 === 0x42);
  check("nothing left pending", r1.pending === 0, `${r1.pending} bytes`);

  // Split mid-packet: 4 bytes, then the rest.
  const r2 = new PacketReader();
  const a = r2.push(wire.subarray(0, 12));
  check("partial packet is withheld", a.length === 1, `got ${a.length}`);
  const b = r2.push(wire.subarray(12));
  check("remainder completes it", a.length + b.length === 3, `got ${a.length + b.length}`);

  // Worst case: one byte at a time.
  const r3 = new PacketReader();
  let n = 0;
  for (const byte of wire) n += r3.push(Buffer.from([byte])).length;
  check("byte-at-a-time dribble", n === 3 && r3.pending === 0, `got ${n}, pending ${r3.pending}`);
}

// ------------------------------------------------------------- T3 loopback
console.log("T3 loopback over a real socket");
(async () => {
  const PORT = Number(process.env.BGB_PORT ?? 8767);
  const STREAM_A = [0xFD, 0x01, 0x02, 0x99, 0xFE, 0x00, 0x7F];   // master -> slave
  const STREAM_B = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70];   // slave  -> master

  const gotOnMaster: number[] = [];   // bytes the SLAVE returned to the master
  const gotOnSlave: number[] = [];    // bytes the MASTER sent to the slave
  let slaveIdx = 0;

  const slaveLink = new BgbLink({
    onMasterByte: (data) => {                    // peer is master: answer as slave
      gotOnSlave.push(data);
      return STREAM_B[slaveIdx++] ?? 0x00;
    },
  });
  const masterLink = new BgbLink({
    onSlaveByte: (data) => { gotOnMaster.push(data); },
  });

  await slaveLink.listen(PORT, "127.0.0.1");
  await masterLink.connect(PORT, "127.0.0.1");
  await new Promise(r => setTimeout(r, 150));

  check("master handshake complete", masterLink.ready);
  check("slave handshake complete", slaveLink.ready);
  check("peer reported running", (masterLink.peerStatus & 0x01) === 0x01,
        `flags ${masterLink.peerStatus}`);

  for (const byte of STREAM_A) {
    masterLink.advance(512);                     // one serial window, 2 MiHz clocks
    masterLink.sendMaster(byte);
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 150));

  check("slave received the master stream byte-exact",
        gotOnSlave.join(",") === STREAM_A.join(","), `got [${gotOnSlave}]`);
  check("master received the slave replies byte-exact",
        gotOnMaster.join(",") === STREAM_B.slice(0, STREAM_A.length).join(","),
        `got [${gotOnMaster}]`);
  check("timestamp advanced with emulated cycles",
        masterLink.timestamp === 512 * STREAM_A.length, `${masterLink.timestamp}`);
  check("packets counted both ways", masterLink.packetsOut > 0 && masterLink.packetsIn > 0,
        `out ${masterLink.packetsOut} in ${masterLink.packetsIn}`);

  masterLink.close(); slaveLink.close();
  console.log(failures === 0 ? "\n*** BGB TRANSPORT VERIFIED ***" : `\n--- ${failures} FAILURE(S) ---`);
  process.exit(failures === 0 ? 0 : 1);
})();
