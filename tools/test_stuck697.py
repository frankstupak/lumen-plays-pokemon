#!/usr/bin/env python3
"""wq#697 probe — WARP_OSC + NOISE_STORM stuck classifier signatures."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpp_stuck_mode as M

names = {"63": "Cerulean Trade House", "3": "Cerulean City", "65": "Cerulean Gym",
         "64": "Cerulean Pokecenter", "35": "Route 24", "36": "Route 25"}

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

print("\ntest_stuck697: ALL PASS (7 sections, A-G)")
