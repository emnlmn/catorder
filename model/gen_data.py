"""Synthetic order histories for CatOrder (deterministic). Writes model/data/histories.json."""
import json, math, random, glob, os, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
START, END = dt.date(2024, 10, 1), dt.date(2026, 10, 17)  # two years: closures and peaks repeat, so they can be learned
SEED = 20261017
N_CUSTOMERS = 400
SUMMER_CATS = {"water", "beer", "soft drink"}

KIND_POOLS = {  # category -> weight of being part of a core basket
    "bar": {"water": 3, "soft drink": 4, "beer": 3, "coffee": 4, "disposables": 3, "sweets": 2, "wine": 1, "dairy": 1},
    "restaurant": {"pasta": 3, "tomatoes": 2, "oil": 2, "flour": 2, "cheese": 3, "wine": 3, "water": 3, "beer": 1,
                   "cured meat": 1, "cleaning": 2, "coffee": 1, "pantry": 1},
    "deli": {"cured meat": 5, "cheese": 5, "oil": 2, "wine": 2, "pantry": 1, "tomatoes": 1, "pasta": 1, "disposables": 1},
    "grocery": {"water": 2, "pasta": 3, "tomatoes": 2, "oil": 2, "soft drink": 2, "beer": 2, "coffee": 2, "sweets": 1,
                "pantry": 1, "wine": 2, "flour": 1, "dairy": 1, "cleaning": 1},
}
KIND_W = {"bar": 0.3, "restaurant": 0.3, "deli": 0.2, "grocery": 0.2}


def snap_qty(x, unit):
    if unit == "kg":
        return max(0.5, round(x * 2) / 2)
    return max(1, int(round(x)))


def season(d):  # 0..1 bump over Jun-Aug
    doy = d.timetuple().tm_yday
    return max(0.0, math.exp(-((doy - 200) / 38.0) ** 2))


def gen_customer(rng, kind, catalog, by_cat):
    pool = KIND_POOLS[kind]
    cats = list(pool)
    core = {}
    ncore = rng.randint(4, 9)
    guard = 0
    while len(core) < ncore and guard < 200:
        guard += 1
        cat = rng.choices(cats, [pool[c] for c in cats])[0]
        p = rng.choice(by_cat[cat])
        if p["sku"] in core:
            continue
        u = p["sell_unit"]
        base = rng.choice([0.5, 1, 1.5, 2, 3, 4]) if u == "kg" else rng.choice([1, 1, 2, 2, 3, 4, 6, 8])
        prob = rng.uniform(0.85, 0.99) if rng.random() < 0.75 else rng.uniform(0.35, 0.7)
        core[p["sku"]] = (base, prob, cat, u)
    cadence = rng.uniform(5, 28)
    wd = rng.sample(range(0, 6), rng.choice([1, 1, 2]))
    churn_at = None
    if rng.random() < 0.12:
        churn_at = START + dt.timedelta(days=int(rng.uniform(0.3, 0.88) * (END - START).days))
    adopt = None
    if rng.random() < 0.25:
        cand = [p for p in catalog if p["sku"] not in core]
        p = rng.choice(cand)
        adopt = (p["sku"], p["sell_unit"], START + dt.timedelta(days=rng.randint(60, 300)),
                 1 if p["sell_unit"] != "kg" else 1.0)
    extras_rate = rng.uniform(0.1, 0.5)
    seas = rng.uniform(0.3, 0.9)

    d = START + dt.timedelta(days=rng.randint(0, 40))
    orders, stretch, n_after = [], 1.0, 0
    adopted_orders = 0
    while d <= END:
        lines = {}
        s = season(d)
        for sku, (base, prob, cat, u) in core.items():
            mult = 1 + seas * s if cat in SUMMER_CATS else 1.0
            if rng.random() < min(0.99, prob * (1 + 0.1 * s if cat in SUMMER_CATS else 1)):
                q = base * mult * math.exp(rng.gauss(0, 0.18))
                lines[sku] = snap_qty(q, u)
        if adopt and d >= adopt[2]:
            adopted_orders += 1
            if rng.random() < min(0.9, 0.25 * adopted_orders):
                lines[adopt[0]] = snap_qty(adopt[3] * math.exp(rng.gauss(0, 0.2)), adopt[1])
        if rng.random() < extras_rate:
            for p in rng.sample(catalog, rng.choice([1, 1, 2])):
                lines.setdefault(p["sku"], snap_qty(1, p["sell_unit"]))
        if not lines:
            lines[next(iter(core))] = snap_qty(core[next(iter(core))][0], core[next(iter(core))][3])
        orders.append({"date": d.isoformat(), "lines": [{"sku": k, "qty": v} for k, v in lines.items()]})
        gap = cadence * math.exp(rng.gauss(0, 0.15))
        if churn_at and d >= churn_at:
            n_after += 1
            stretch *= 1.35
            gap *= stretch
            if n_after > rng.randint(2, 4):
                break
        nxt = d + dt.timedelta(days=max(2, round(gap)))
        if wd:  # snap to nearest preferred weekday within +-3 days
            best = min((nxt + dt.timedelta(days=k) for k in range(-3, 4)
                        if (nxt + dt.timedelta(days=k)).weekday() in wd),
                       key=lambda x: abs((x - nxt).days), default=nxt)
            nxt = best
        if nxt <= d:
            nxt = d + dt.timedelta(days=1)
        d = nxt
    return orders


def in_closed(d, closed):
    md = d.strftime("%m-%d")
    for c in closed:
        f, t = c["from"], c["to"]
        if (f <= md <= t) if f <= t else (md >= f or md <= t):
            return True
    return False


def gen_profile(rng, p, catalog, by_sku):
    """One customer from a written profile (model/profiles): closures, summer/December, events, trend, churn, adopt, drop."""
    core = {c["sku"]: (c["qty"], c["prob"], by_sku[c["sku"]]["category"], by_sku[c["sku"]]["sell_unit"]) for c in p["core"]}
    se = p.get("season") or {}
    summer, dec = se.get("summer", 0.0), se.get("december", 0.0)
    events = [(dt.date.fromisoformat(e["date"]), e["mult"]) for e in p.get("events", [])]
    trend = p.get("trend", 0.0)
    churn_at = dt.date.fromisoformat(p["churn"]["start"]) if p.get("churn") else None
    adopt = (p["adopt"]["sku"], dt.date.fromisoformat(p["adopt"]["from"])) if p.get("adopt") else None
    drop = (p["drop"]["sku"], dt.date.fromisoformat(p["drop"]["from"])) if p.get("drop") else None
    wd, closed, extras = p.get("weekdays", []), p.get("closed", []), p.get("extras_rate", 0.2)
    d = START + dt.timedelta(days=rng.randint(0, 30))
    orders, stretch, n_after, adopted = [], 1.0, 0, 0
    while d <= END:
        if in_closed(d, closed):
            d += dt.timedelta(days=1)
            continue
        s = season(d)
        tm = (1 + trend) ** ((d - START).days / 365)
        ev = max([m for (ed, m) in events if abs((ed - d).days) <= 3] or [1.0])
        dm = 1 + dec if d.month == 12 else 1.0
        lines = {}
        for sku, (base, prob, cat, u) in core.items():
            if drop and sku == drop[0] and d >= drop[1]:
                continue
            sm = max(0.2, 1 + summer * s) if cat in SUMMER_CATS else 1.0
            if rng.random() < min(0.99, prob * (sm if sm < 1 else 1)):
                lines[sku] = snap_qty(base * sm * dm * tm * ev * math.exp(rng.gauss(0, 0.18)), u)
        if adopt and d >= adopt[1]:
            adopted += 1
            if rng.random() < min(0.9, 0.25 * adopted):
                u = by_sku[adopt[0]]["sell_unit"]
                lines[adopt[0]] = snap_qty(tm * math.exp(rng.gauss(0, 0.2)) * (2 if u != "kg" else 1), u)
        if rng.random() < extras:
            for q in rng.sample(catalog, rng.choice([1, 1, 2])):
                lines.setdefault(q["sku"], snap_qty(1, q["sell_unit"]))
        if lines:
            orders.append({"date": d.isoformat(), "lines": [{"sku": k, "qty": v} for k, v in lines.items()]})
        gap = p["cadence_days"] * math.exp(rng.gauss(0, 0.15))
        if churn_at and d >= churn_at:
            n_after += 1
            stretch *= 1.35
            gap *= stretch
            if n_after > rng.randint(2, 4):
                break
        nxt = d + dt.timedelta(days=max(1, round(gap)))
        if wd:
            nxt = min((nxt + dt.timedelta(days=k) for k in range(-3, 4) if (nxt + dt.timedelta(days=k)).weekday() in wd),
                      key=lambda x: abs((x - nxt).days), default=nxt)
        d = nxt if nxt > d else d + dt.timedelta(days=1)
    return orders


def main():
    rng = random.Random(SEED)
    catalog = json.load(open(REPO / "data" / "catalog.json"))
    by_cat = {}
    for p in catalog:
        by_cat.setdefault(p["category"], []).append(p)
    out = {}
    kinds = list(KIND_W)
    for i in range(N_CUSTOMERS):
        kind = rng.choices(kinds, [KIND_W[k] for k in kinds])[0]
        orders = gen_customer(rng, kind, catalog, by_cat)
        if len(orders) >= 2:
            out[f"syn-{i:04d}"] = {"kind": kind, "orders": orders}
    from check_profiles import problems
    by_sku = {p["sku"]: p for p in catalog}
    n_prof = n_bad = 0
    for f in sorted(glob.glob(str(ROOT / "profiles" / "batch_*.json"))):
        for prof in json.load(open(f)):
            if problems(prof):
                n_bad += 1
                continue
            orders = gen_profile(rng, prof, catalog, by_sku)
            if len(orders) >= 2:
                out[f"pf-{prof['id']}"] = {"kind": prof["kind"], "orders": orders}
                n_prof += 1
    print(f"profiles: {n_prof} used, {n_bad} invalid skipped")
    for f in sorted(glob.glob(str(REPO / "data" / "customers" / "*.json"))):
        c = json.load(open(f))
        hp = REPO / "data" / "history" / f"{c['id']}.json"
        if hp.exists():
            out[c["id"]] = {"kind": c["kind"], "orders": json.load(open(hp))}
    (ROOT / "data").mkdir(exist_ok=True)
    path = ROOT / "data" / "histories.json"
    json.dump(out, open(path, "w"))
    n = sum(len(v["orders"]) for v in out.values())
    print(f"{len(out)} customers, {n} orders -> {path} ({path.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
