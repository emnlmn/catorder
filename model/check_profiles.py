"""Validate customer profiles written for gen_data.py. Usage: python3 check_profiles.py profiles/batch_1.json"""
import json, re, sys
from pathlib import Path

CAT = {p["sku"]: p for p in json.load(open(Path(__file__).resolve().parent.parent / "data" / "catalog.json"))}
KINDS = {"bar", "restaurant", "deli", "grocery"}
DATE = re.compile(r"^20(24|25|26)-\d{2}-\d{2}$")
MD = re.compile(r"^\d{2}-\d{2}$")


def problems(p):
    e = []
    if p.get("kind") not in KINDS: e.append("kind")
    core = p.get("core") or []
    if not 3 <= len(core) <= 12: e.append("core size")
    for c in core:
        if c.get("sku") not in CAT: e.append(f"sku {c.get('sku')}")
        if not (isinstance(c.get("qty"), (int, float)) and c["qty"] > 0): e.append("qty")
        if not (isinstance(c.get("prob"), (int, float)) and 0.05 <= c["prob"] <= 1): e.append("prob")
    if not (isinstance(p.get("cadence_days"), (int, float)) and 2 <= p["cadence_days"] <= 45): e.append("cadence_days")
    if any(w not in range(7) for w in p.get("weekdays", [])): e.append("weekdays")
    for c in p.get("closed", []):
        if not (MD.match(c.get("from", "")) and MD.match(c.get("to", ""))): e.append("closed")
    for ev in p.get("events", []):
        if not (DATE.match(ev.get("date", "")) and isinstance(ev.get("mult"), (int, float))): e.append("event")
    for k in ("adopt", "drop"):
        v = p.get(k)
        if v and (v.get("sku") not in CAT or not DATE.match(v.get("from", ""))): e.append(k)
    ch = p.get("churn")
    if ch and not DATE.match(ch.get("start", "")): e.append("churn")
    return e


if __name__ == "__main__":
    profs = json.load(open(sys.argv[1]))
    bad = [(p.get("id"), problems(p)) for p in profs if problems(p)]
    ids = [p.get("id") for p in profs]
    print(f"{len(profs)} profiles, {len(bad)} invalid, {len(ids) - len(set(ids))} duplicate ids")
    for b in bad[:20]: print(" ", b)
    sys.exit(1 if bad or len(ids) != len(set(ids)) else 0)
