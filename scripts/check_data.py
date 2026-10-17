"""Self-check of data/: skus exist, quotes verbatim, mocks and media present."""
import json, pathlib, sys

D = pathlib.Path(__file__).resolve().parent.parent / "data"
J = lambda p: json.loads(p.read_text())
skus = {p["sku"] for p in J(D / "catalog.json")}
errs = []

def reading(m):
    if m["channel"] in ("whatsapp", "email"):
        return m["text"]
    suffix = "transcript" if m["channel"] == "voice" else "transcription"
    return (D / "messages" / f"{m['id']}.{suffix}.txt").read_text()

for f in (D / "history").glob("*.json"):
    for o in J(f):
        errs += [f"{f.name}: bad sku {l['sku']}" for l in o["lines"] if l["sku"] not in skus]
for f in (D / "customers").glob("*.json"):
    errs += [f"{f.name}: bad override {s}" for s in J(f)["terms"]["price_overrides"] if s not in skus]
exp = J(D / "expected.json")["messages"]
for f in sorted((D / "messages").glob("??-???.json")):
    m = J(f)
    r = reading(m)
    if m.get("media") and not (D / "messages" / m["media"]).exists():
        errs.append(f"{m['id']}: missing media {m['media']}")
    mf = D / "mock" / f.name
    if not mf.exists():
        errs.append(f"{m['id']}: no mock"); continue
    for q in J(mf):
        if q["quote"] not in r:
            errs.append(f"{m['id']}: mock quote not verbatim: {q['quote']!r}")
        if q["sku"] and q["sku"] not in skus:
            errs.append(f"{m['id']}: mock bad sku {q['sku']}")
    e = exp.get(m["id"])
    if e is None:
        errs.append(f"{m['id']}: not in expected"); continue
    for l in e["lines"]:
        if l["sku"] not in skus: errs.append(f"{m['id']}: expected bad sku {l['sku']}")
    for s in e.get("removed", []):
        if s not in skus: errs.append(f"{m['id']}: removed bad sku {s}")
    for c in e.get("candidates", []):
        errs += [f"{m['id']}: cand bad sku {s}" for s in c["skus"] if s not in skus]
        if c["text_contains"] not in r: errs.append(f"{m['id']}: text_contains not verbatim")
    for q in e.get("quotes", []):
        if q not in r: errs.append(f"{m['id']}: expected quote not verbatim: {q!r}")
print("\n".join(errs) or f"ok: {len(skus)} products, {len(exp)} messages")
sys.exit(1 if errs else 0)
