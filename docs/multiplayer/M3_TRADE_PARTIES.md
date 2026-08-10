# M3 — Party sizes 1 through 6 (VERIFIED 2026-08-10)

`npx tsx src/link/drive_trade_partysweep.ts` — six full cold-start trades, one
per party size, ~35s each.

```
size 1: PASS  full two-way swap  attempts=1 ex=750 23.1s
size 2: PASS  full two-way swap  attempts=1 ex=749 35.9s
size 3: PASS  full two-way swap  attempts=1 ex=749 35.8s
size 4: PASS  full two-way swap  attempts=1 ex=749 34.8s
size 5: PASS  full two-way swap  attempts=1 ex=749 33.8s
size 6: PASS  full two-way swap  attempts=1 ex=749 34.4s
*** ALL 6 PARTY SIZES VERIFIED ***
```

Evidence: `evidence/m3-trade-partysweep-verified.log`.

## Why the LAST slot

Every run offers slot `size - 1` — the entry sitting directly above CANCEL in
the party list. That is the worst case for the cursor walk: one DOWN too many
lands on CANCEL, and selecting CANCEL aborts the session (`wLinkState` 50 -> 1,
bus goes quiet). If the cursor logic were counting presses instead of reading
`wCurrentMenuItem` (`$CC26`) back, this is where it would fail.

It held at every size, on the first rendezvous attempt each time.

## Full-party edge case (size 6)

Gen1 removes the offered mon before inserting the received one, so a full party
has room — but that is exactly where an off-by-one in the party rewrite would
surface. Size 6 result:

```
A [5] lv15 OT"AAAAAAA" nick"ASIX"  ->  B [5]
B [5] lv45 OT"BOB"     nick"BSIX"  ->  A [5]
slots 0-4 byte-identical on both sides
```

The sweep asserts party COUNT is preserved on both sides (`size` in, `size`
out), not just that the two mons moved — a trade that dropped or duplicated a
slot would pass a mons-only check.

## Exchange count is flat

749-750 exchanges regardless of party size. The 415-byte party block is a
fixed-size structure (`wSerialPlayerDataBlock` `$D152` through
`wPartyDataEnd` `$D2F7`), sent whole with empty slots included, so a 1-mon party
costs exactly what a 6-mon party costs. Wall time rises from 23s to ~35s only
because of the extra cursor walking, not extra bytes.
