#!/usr/bin/env python3
"""wq#1661 probe — :8871 has one owner, and the cover is never it.

THE INCIDENT (LPP_BEHAVIORAL_ANALYSIS.md M1)
  Aug 27, 04:24-19:49Z: 355 live-agent restarts at a 231s period. Every start
  logged "[stream] port 8871 in use retry 1..12/12" and then FATAL EADDRINUSE,
  because the idle cover (python3 -m http.server, Restart=always) had the port
  and no reason to give it up. The residue was still visible on 2026-09-10:
  restarts at 06:38:08 and 06:38:10 each raised the cover from live's own
  ExecStopPost, one restart to one spurious cover start.

WHAT IS ASSERTED HERE
  A  a crash never raises the cover                     (tools/lpp-cover-maybe-up)
  B  a restart never raises the cover                   (the 06:38 defect)
  C  a plain stop does raise it                         (no 502 regression)
  D  the cover refuses to bind while live owns the port (settle)
  E  the cover binds and serves while live is down      (it still works)
  F  the cover yields the port the moment live returns  (the invariant)
  G  a forced 12-round crash loop: live rebinds 12/12   (M1 cannot recur)
  H  a foreign squatter is exit 3, not a retry storm

systemd is faked (a stub `systemctl` reading a state file), because the real
crash loop cannot be forced without root and would take the product down. What
is real: the sockets, the bind races and both scripts, run unmodified.
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
COVER_UP = os.path.join(HERE, "lpp-cover-maybe-up")
COVER_SERVE = os.path.join(HERE, "lpp-cover-serve")
LIVE_UNIT = "lumen-pokemon-live.service"

FAKE_SYSTEMCTL = '''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(" ".join(args) + "\\n")
if "show" in args:
    print(open(os.environ["FAKE_STATE"]).read().strip())
elif "list-jobs" in args:
    sys.stdout.write(open(os.environ["FAKE_JOBS"]).read())
'''

tmp = tempfile.mkdtemp(prefix="lpp1661-")
SYSTEMCTL = os.path.join(tmp, "systemctl")
STATE = os.path.join(tmp, "state")
JOBS = os.path.join(tmp, "jobs")
LOG = os.path.join(tmp, "calls")
ASSETS = os.path.join(tmp, "assets")
os.mkdir(ASSETS)
with open(os.path.join(ASSETS, "index.html"), "w") as f:
    f.write("<h1>BRB</h1>")
with open(SYSTEMCTL, "w") as f:
    f.write(FAKE_SYSTEMCTL)
os.chmod(SYSTEMCTL, 0o755)

ENV = dict(os.environ, FAKE_STATE=STATE, FAKE_JOBS=JOBS, FAKE_LOG=LOG,
           LPP_SYSTEMCTL=SYSTEMCTL, LPP_LIVE_UNIT=LIVE_UNIT, LPP_SUDO="")


def systemd(state="inactive", jobs=""):
    """Set what the fake systemd reports, and forget past calls."""
    for path, text in ((STATE, state + "\n"), (JOBS, jobs), (LOG, "")):
        with open(path, "w") as f:
            f.write(text)


def cover_starts():
    with open(LOG) as f:
        return [ln for ln in f.read().splitlines() if " start " in f" {ln} "]


def run_hook(result):
    """live's ExecStopPost, as systemd runs it."""
    p = subprocess.run([COVER_UP], env=dict(ENV, SERVICE_RESULT=result),
                       capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, f"hook must never fail the stop job, got {p.returncode}: {p.stderr}"
    return cover_starts()


def free_port():
    s = socket.socket()
    s.bind(("0.0.0.0", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def live_binds(port):
    """Stand in for the agent's stream server taking the port. None = EADDRINUSE."""
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
        s.listen(8)
        return s
    except OSError:
        s.close()
        return None


def start_cover(port, settle="0.4", poll="0.2"):
    return subprocess.Popen(
        [COVER_SERVE, "--port", str(port), "--dir", ASSETS,
         "--settle-sec", settle, "--poll-sec", poll],
        env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def wait_serving(port, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=1) as r:
                return r.status == 200 and b"BRB" in r.read()
        except Exception:
            time.sleep(0.1)
    return False


def reap(proc, timeout=8):
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise AssertionError("cover did not exit — it is squatting the port")
    return proc.returncode, proc.stderr.read()


# --- A: a crash leaves the port to the restart -------------------------------
systemd(state="activating")                     # RestartSec holddown
assert run_hook("exit-code") == [], "A: a crash must not raise the cover"
print("A: crash -> no cover start (Restart=on-failure owns the port)")

# --- B: a restart leaves the port to the start queued behind the stop ---------
systemd(state="deactivating", jobs=f"4211 {LIVE_UNIT} restart running\n")
assert run_hook("success") == [], "B: a queued restart must not raise the cover"
systemd(state="deactivating", jobs=f"4212 {LIVE_UNIT} start waiting\n")
assert run_hook("success") == [], "B: a queued start must not raise the cover"
print("B: restart/start job queued -> no cover start (the 06:38:08 defect)")

# --- C: a plain stop still raises it, or the site 502s -----------------------
systemd(state="deactivating", jobs=f"4213 {LIVE_UNIT} stop running\n")
starts = run_hook("success")
assert len(starts) == 1 and "lumen-kiosk-idle.service" in starts[0], \
    f"C: a stop must raise the cover, got {starts}"
systemd(state="active")
assert run_hook("success") == [], "C: a live that is already back must not be covered"
print(f"C: stop -> {starts[0].strip()!r}; live already back -> no cover")

# --- D: the cover refuses the port while live owns it ------------------------
port = free_port()
for state in ("active", "activating", "deactivating", "reloading"):
    systemd(state=state)
    rc, err = reap(start_cover(port))
    assert rc == 0, f"D: refusing must be a clean exit, got {rc} for '{state}'"
    assert "standing down" in err, f"D: expected a refusal for '{state}', got {err!r}"
    sock = live_binds(port)
    assert sock, f"D: cover took the port while live was '{state}'"
    sock.close()
print("D: cover refuses to bind in all four states where live owns :port")

# --- E: it does cover the port while live is down ----------------------------
systemd(state="inactive")
cover = start_cover(port)
assert wait_serving(port), "E: cover did not serve the splash"
print("E: live down -> cover serves the splash")

# --- F: and yields it the moment live comes back -----------------------------
systemd(state="activating")
t0 = time.time()
rc, err = reap(cover)
yielded = time.time() - t0
assert rc == 0 and "yielding" in err, f"F: expected a yield, got rc={rc} {err!r}"
sock = live_binds(port)
assert sock, "F: port still held after the yield"
sock.close()
assert yielded < 3, f"F: yield took {yielded:.1f}s, live's first bind retry is at 1s"
print(f"F: live returns -> cover yields :port in {yielded:.1f}s")

# --- G: the forced crash loop, 12 rounds — M1's exact shape ------------------
ROUNDS = 12
fatal = []
squats = 0
for i in range(ROUNDS):
    systemd(state="inactive")
    sock = live_binds(port)                     # live starts
    if sock is None:
        fatal.append(i)                         # this is the EADDRINUSE of M1
        continue
    with open(STATE, "w") as f:
        f.write("active\n")
    sock.close()                                # live crashes
    with open(STATE, "w") as f:
        f.write("activating\n")                 # systemd holds down for RestartSec
    if run_hook("exit-code"):
        squats += 1                             # the hook raised a cover mid-loop
    rc, err = reap(start_cover(port))           # worst case: raised out of band anyway
    if "covering" in err:
        squats += 1
assert not fatal, f"G: live failed to bind on rounds {fatal} — M1 recurred"
assert squats == 0, f"G: the cover took the port {squats}x during the crash loop"
print(f"G: forced crash loop {ROUNDS}/{ROUNDS} rebinds, 0 cover squats")

# --- H: a foreign squatter is exit 3, not a retry storm ----------------------
systemd(state="inactive")
squatter = live_binds(port)
rc, err = reap(start_cover(port))
squatter.close()
assert rc == 3, f"H: expected exit 3 (RestartPreventExitStatus), got {rc}: {err!r}"
print("H: port held by a foreign process -> exit 3, no restart storm")

print("\ntest_1661_port_8871: ALL PASS (8 sections, A-H)")
