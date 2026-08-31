#!/usr/bin/env python3
"""wq#697 probe — WARP_OSC + NOISE_STORM stuck classifier signatures."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpp_stuck_mode as M

names = {"63": "Cerulean Trade House", "3": "Cerulean City", "65": "Cerulean Gym",
         "64": "Cerulean Pokecenter", "35": "Route 24", "36": "Route 25",
         "67": "Cerulean Mart", "88": "Bills House"}

# --- A: WARP_OSC — alternating 63<->3 (the exact 2026-08-19 shape) ---
warps_osc = [63, 3, 3, 63, 3, 3, 3, 63]  # ticket's own evidence line
hit, a, b, alt = M.detect_warp_osc(warps_osc)
assert hit, f"A1: should detect oscillation, got hit={hit}"
assert alt >= 4, f"A2: alternations should be >= 4, got {alt}"
print(f"A: WARP_OSC detected: {alt} alternations between map{a} <-> map{b}")

# classify a genuine two-map oscillation between NON-heal maps -> WARP_OSC.
# NOTE: the A1/A2 detector fixture above uses Cerulean City(3)/Trade House(63);
# a loop that collapses onto a city hub is a fight-readiness stall (wq#1081/#1084,
# section G below), NOT a nav bug — so use a dungeon-style pair for the WARP_OSC
# classification assertion.
warps_osc_dungeon = [60, 61, 60, 61, 60, 61, 60, 61]
mode, ev, loc = M.classify_mode(warps_osc_dungeon, [], names)
assert mode == "WARP_OSC", f"A3: mode should be WARP_OSC, got {mode}"
print(f"A3: classify_mode -> {mode}: {ev}")

# --- B: Self-bounce (A->A) ---
warps_self = [63, 63, 63, 63, 63]
hit2, a2, b2, alt2 = M.detect_warp_osc(warps_self)
assert hit2, f"B1: should detect self-bounce, got {hit2}"
print(f"B: self-bounce detected: {alt2} alternations on map{a2}")

# --- C: NO oscillation on healthy travel ---
warps_healthy = [3, 35, 36, 15, 59, 60, 61, 60, 59, 15]
hit3, _, _, _ = M.detect_warp_osc(warps_healthy)
assert not hit3, f"C1: healthy travel should NOT trigger, got hit={hit3}"
print("C: healthy travel correctly NOT flagged")

# --- D: NOISE_STORM — 5 consecutive noise lines ---
noise_lines = [
    "T46 [map36 13,6] move(east) => unknown tool: move",
    "T47 [map36 13,6] move_up() => unknown tool: move_up",
    "T48 [map36 13,6] move(east) => unknown tool: move",
    "T49 [map36 13,6] move down => parse_error: no tool call found",
    "T50 [map36 13,6] move(east) => unknown tool: move",
]
nhit, nstreak = M.detect_noise_storm(noise_lines)
assert nhit, f"D1: should detect noise storm, got hit={nhit}"
assert nstreak >= 5, f"D2: streak should be >= 5, got {nstreak}"
print(f"D: NOISE_STORM detected: {nstreak} consecutive noise turns")

# classify with noise storm
mode2, ev2, _ = M.classify_mode([3, 35], [], names, turn_summaries=noise_lines)
assert mode2 == "NOISE_STORM", f"D3: mode should be NOISE_STORM, got {mode2}"
print(f"D3: classify_mode -> {mode2}: {ev2}")

# --- E: NO noise storm with clean lines mixed in ---
mixed_lines = [
    "T46 [map36 13,6] move(east) => unknown tool: move",
    "T47 [map36 13,6] goto(10,8) => goto -> arrived now {map:36,x:10,y:8}",
    "T48 [map36 13,6] move(east) => unknown tool: move",
    "T49 [map36 13,6] move(east) => unknown tool: move",
]
nhit2, nstreak2 = M.detect_noise_storm(mixed_lines)
assert not nhit2, f"E1: mixed lines should NOT trigger noise storm, got {nhit2} streak={nstreak2}"
print("E: mixed lines correctly NOT flagged as noise storm")

# --- F: FIGHT_LOSS_LOOP still takes priority over WARP_OSC ---
warps_gym = [65, 64, 65, 64, 65, 64, 65, 64]
mode3, _, _ = M.classify_mode(warps_gym, [], names)
assert mode3 == "FIGHT_LOSS_LOOP", f"F1: gym loop should be FIGHT_LOSS_LOOP not WARP_OSC, got {mode3}"
print(f"F: FIGHT_LOSS_LOOP correctly takes priority over WARP_OSC")

# --- G: wq#1081/#1084 — heal/hub-dominated loop -> FIGHT_LOSS_LOOP, not WARP_OSC ---
# The gym warp is absent (a readiness gate refuses entry) so this used to
# misclassify as WARP_OSC and get a self-defeating hub/heal ban.
warps_hub = [3, 64, 3, 64, 3, 64, 3, 64, 63, 64]  # Cerulean City<->Pokecenter heal loop
modeG, evG, locG = M.classify_mode(warps_hub, [], names)
assert modeG == "FIGHT_LOSS_LOOP", f"G1: heal/hub loop should be FIGHT_LOSS_LOOP, got {modeG}"
assert locG == 3, f"G2: hub location should be the city (map3), got {locG}"
print(f"G: heal/hub loop -> {modeG}@{locG} (readiness stall, not a nav bug)")


# --- H: wq#1119 — the live 34h Route 25 stall ---
# runtime/warp_history.json, verbatim, at the moment the ticket last repeated
# (2026-08-31T00:23Z). Six distinct maps across the 64-warp window, so the
# wq#1081/#1084 route guard (<=3 distinct) stayed silent, while the last 22
# warps are a single map, so WARP_OSC fired and the intervention layer resolved
# a ban list of the window's top-2 maps: Route 25 (the grind route) + Cerulean
# City (the only heal hub). Three interventions, all superseded, 34h frozen.
warps_1119 = [88, 36, 64, 3, 63, 3, 64, 3, 63, 3, 64, 3, 3, 63, 3, 64, 3, 3, 63,
              3, 64, 3, 63, 3, 64, 3, 63, 3, 67, 3, 64, 3, 3, 63, 3, 64, 3, 63,
              3, 64, 3, 88] + [36] * 22
modeH, evH, locH = M.classify_mode(warps_1119, [], names)
assert modeH == "FIGHT_LOSS_LOOP", f"H1: live wq#1119 window should be FIGHT_LOSS_LOOP, got {modeH}"
assert locH == 36, f"H2: should anchor on Route 25 (map36), got {locH}"
print(f"H: live wq#1119 window -> {modeH}@{locH} (grind stall, route no longer bannable)")

# H3: the same window still LOOKS like an oscillation to the raw detector — the
# fix is in the classifier's gate, not by blinding the detector.
hitH, aH, bH, _ = M.detect_warp_osc(warps_1119)
assert hitH and aH == bH == 36, f"H3: detector should still see a self-bounce on 36, got {hitH}/{aH}/{bH}"
print("H3: detector unchanged — self-bounce still detected, just not prescribed an edge ban")

# H4: a self-bounce on a map that is neither route nor hub has no edge to ban
# either, so it must not be handed the two-map WARP_OSC remedy.
warps_selfbounce = [60, 61, 15, 59, 62] + [60] * 16
modeH4, _, _ = M.classify_mode(warps_selfbounce, [], names)
assert modeH4 != "WARP_OSC", f"H4: single-map self-bounce should not be WARP_OSC, got {modeH4}"
print(f"H4: non-route self-bounce -> {modeH4} (no edge to ban)")

# H5: a 34h freeze reboots, so the same checkpoint gets picked twice — the
# wq#1081/#1084 RESUME_DEADEND deferral only helps if the readiness diagnoses
# it defers past are asked at the scope that can actually see the stall. Live
# on 2026-08-31 they were not, and RESUME_DEADEND masked Route 25 all over again.
picks_same = [{"file": "/home/lumen/pokemon/checkpoints/auto-mtghr053-map36.state.gz"}] * 2
modeH5, _, locH5 = M.classify_mode(warps_1119, picks_same, names)
assert modeH5 == "FIGHT_LOSS_LOOP", f"H5: repeated resume must not mask the grind stall, got {modeH5}"
assert locH5 == 36, f"H5b: should still anchor on Route 25, got {locH5}"
print(f"H5: repeated same-checkpoint resume -> {modeH5}@{locH5} (deadend no longer masks it)")

print("\ntest_stuck697: ALL PASS (8 sections, A-H)")
