#!/usr/bin/env python3
"""JSON adapter over Minerva's lumen_state.py — the fleet's bi-temporal store.

wq#1191. LPP's persona memory keeps its facts in lumen_state, not in a private
file, because "cross-platform" means the Messenger bridge and an operator at a
terminal read the same rows the streamer wrote. This wrapper exists for two
reasons, both of them about being able to TRUST that path:

  1. lumen_state.py's CLI prints for humans ("subject.predicate = value  (since
     2026-09-02)") and drops source_ref entirely. Scraping that back into typed
     rows is guesswork the moment a value contains " = ". The module's own
     current()/ingest() return dicts; this prints them as JSON.
  2. lumen_state.py hardcodes DB = /home/lumen/minerva/minerva.db. That is right
     for production and untestable: a probe exercising the real subprocess path
     would write junk facts into live fleet state. LPP_LUMEN_STATE_DB overrides
     the constant AFTER import, so a probe runs the SAME supersession code the
     agent runs, against a throwaway file.

It calls lumen_state's functions directly — it is an encoding, not a second
store. Anything ingested here is visible to `lumen_state.py current <subject>`.

USAGE
  lumen_state_json.py current <subject> [--db FILE]
  lumen_state_json.py ingest <subject> <predicate> <value>
                             [--valid-from YYYY-MM-DD] [--source REF] [--db FILE]
  lumen_state_json.py history <subject> <predicate> [--db FILE]
  lumen_state_json.py cli [--db FILE] -- <lumen_state.py args...>

ENV
  LPP_LUMEN_STATE_PY   path to lumen_state.py (default /home/lumen/minerva/lumen_state.py)
  LPP_LUMEN_STATE_DB   alternate sqlite file (default: the module's own DB); --db wins

EXIT
  0 ok (stdout is one JSON document)   2 lumen_state.py unavailable   1 usage
"""
import argparse
import importlib.util
import json
import os
import sys

DEFAULT_PY = "/home/lumen/minerva/lumen_state.py"
PY_ARGV0 = "lumen_state.py"


def load_lumen_state(db=None):
    path = os.environ.get("LPP_LUMEN_STATE_PY", DEFAULT_PY)
    spec = importlib.util.spec_from_file_location("lumen_state", path)
    if spec is None or spec.loader is None:
        sys.stderr.write("lumen_state.py not found at %s\n" % path)
        sys.exit(2)
    mod = importlib.util.module_from_spec(spec)
    try:
        # Imported under the name "lumen_state", so the module's __main__ guard
        # does not fire and nothing is executed but the definitions.
        spec.loader.exec_module(mod)
    except Exception as e:                                  # noqa: BLE001
        sys.stderr.write("lumen_state.py failed to load: %s\n" % e)
        sys.exit(2)
    db = db or os.environ.get("LPP_LUMEN_STATE_DB")
    if db:
        mod.DB = db
        # Only on an override: a throwaway file starts empty, and the real
        # minerva.db already has its schema — no reason to run DDL against it.
        mod.init_schema()
        _ensure_v3_columns(mod)
    return mod


def _ensure_v3_columns(mod):
    """init_schema() predates the Memory-V3 columns and its _migrate() only
    backfills two of them, so a DB it creates from scratch cannot take an
    ingest (`no column named fact_class`). Production never hits this — the
    real minerva.db was migrated out of band — but a throwaway test DB does.
    Adding them here keeps the fixture identical to production without
    reaching into /home/lumen/minerva.
    """
    conn = mod._conn()
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(state_facts)")}
        for name in ("fact_class", "render_tier"):
            if name not in cols:
                conn.execute("ALTER TABLE state_facts ADD COLUMN %s TEXT" % name)
        conn.commit()
    finally:
        conn.close()


def main(argv):
    ap = argparse.ArgumentParser(prog="lumen_state_json.py", add_help=True,
                                 description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    db = argparse.ArgumentParser(add_help=False)
    db.add_argument("--db", default=None, help="alternate sqlite file (tests)")
    pc = sub.add_parser("current", parents=[db], help="open facts for a subject, as JSON")
    pc.add_argument("subject")
    pi = sub.add_parser("ingest", parents=[db], help="write one fact, as JSON")
    pi.add_argument("subject")
    pi.add_argument("predicate")
    pi.add_argument("value")
    pi.add_argument("--valid-from", default=None)
    pi.add_argument("--source", default=None)
    ph = sub.add_parser("history", parents=[db], help="every version of one fact, as JSON")
    ph.add_argument("subject")
    ph.add_argument("predicate")
    pl = sub.add_parser("cli", parents=[db],
                        help="run lumen_state.py's own CLI (human output) against --db")
    pl.add_argument("rest", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)

    m = load_lumen_state(a.db)
    if a.cmd == "current":
        rows = [dict(r) for r in m.current(a.subject)]
        print(json.dumps({"rows": rows}))
        return 0
    if a.cmd == "ingest":
        res = m.ingest(a.subject, a.predicate, a.value,
                       valid_from=a.valid_from, source_ref=a.source)
        print(json.dumps(res))
        return 0
    if a.cmd == "history":
        rows = [dict(r) for r in m.history(a.subject, a.predicate)]
        print(json.dumps({"rows": rows}))
        return 0
    if a.cmd == "cli":
        # lumen_state.py's own argv-driven CLI, human formatting and all, so a
        # test can assert that `lumen_state.py current <subject>` really prints
        # the persona rows rather than trusting this wrapper's word for it.
        sys.argv = [PY_ARGV0] + list(a.rest)
        m._main()
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
