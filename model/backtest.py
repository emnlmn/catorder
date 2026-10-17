"""Backtest on held-out test customers: model vs P-TopFreq and median-cadence baselines."""
import json
from pathlib import Path
import numpy as np
import torch
from model import *

ROOT = Path(__file__).resolve().parent
END = dt.date(2026, 10, 17).toordinal()
K = 5


def round_vec(x, units):
    return np.array([round_qty(v, u) for v, u in zip(x, units)])


def basket_metrics(pred_set, pred_qty, true_set, true_qty, rank_scores):
    ts = set(true_set)
    topk = set(np.argsort(-rank_scores)[:K])
    tp = len(pred_set & ts)
    rec = tp / len(ts)
    prec = tp / len(pred_set) if pred_set else 0.0
    f1 = 2 * tp / (len(pred_set) + len(ts)) if (pred_set or ts) else 0.0
    matched = pred_set & ts
    qerr = [abs(pred_qty[j] - true_qty[j]) for j in matched]
    return dict(rec_k=len(topk & ts) / min(K, len(ts)), rec=rec, prec=prec, f1=f1,
                qexact=[e == 0 for e in qerr], qabs=qerr)


def agg(rows, key):
    return float(np.mean([r[key] for r in rows]))


def summarize(rows, dates):
    qe = [x for r in rows for x in r["qexact"]]
    qa = [x for r in rows for x in r["qabs"]]
    out = dict(n=len(rows), recall_at_5=agg(rows, "rec_k"), precision=agg(rows, "prec"), recall=agg(rows, "rec"),
               f1=agg(rows, "f1"), qty_exact=float(np.mean(qe)), qty_mae=float(np.mean(qa)))
    if dates is not None:
        e = np.array(dates)
        out.update(date_mae_days=float(np.abs(e).mean()), date_within_2d=float((np.abs(e) <= 2).mean()))
    return out


def main():
    meta = json.load(open(ROOT / "weights" / "catorder-nbr.json"))
    vocab = meta["vocab"]; vidx = {s: i for i, s in enumerate(vocab)}
    units = [meta["sell_unit"][s] for s in vocab]
    hist = json.load(open(ROOT / "data" / "histories.json"))
    _, _, test = split_ids(list(hist))
    dev = pick_device()
    net = NBR(len(vocab)).to(dev)
    net.load_state_dict(torch.load(ROOT / "weights" / "catorder-nbr.pt", map_location=dev)); net.eval()

    def run(items):  # items: list of (enc, i, today, kid)
        ins = [make_inputs(*it) for it in items]
        t = [torch.tensor(np.stack(c), dtype=torch.long if k == 4 else torch.float32).to(dev) for k, c in enumerate(zip(*ins))]
        with torch.no_grad():
            o = net(*t)
        return o["mu"].exp().cpu().numpy(), torch.sigmoid(o["churn"]).cpu().numpy(), \
            torch.sigmoid(o["logit"]).cpu().numpy(), torch.expm1(o["logq"]).cpu().numpy()

    results = {}
    SUM0, SUM1 = dt.date(2026, 6, 15).toordinal(), dt.date(2026, 8, 15).toordinal()
    for name, lasts in [("last_order", 1), ("last_3_cutoffs", 3), ("summer_orders", 0)]:
        items, meta_i = [], []
        for cid in test:
            h = hist[cid]; enc = encode_history(h["orders"], vidx); n = len(enc["dates"])
            if n < 6:
                continue
            rng_i = range(n - 1 - lasts, n - 1) if lasts else \
                [i for i in range(2, n - 1) if SUM0 <= enc["dates"][i + 1] <= SUM1]
            for i in rng_i:
                items.append((enc, i, int(enc["dates"][i]), kind_id(h["kind"]))); meta_i.append((enc, i))
        gap, _, pr, pq = run(items)
        mrows, brows, mdates, bdates = [], [], [], []
        for r, (enc, i) in enumerate(meta_i):
            true = enc["P"][i + 1] > 0
            tset = np.where(true)[0]
            tq = round_vec(np.expm1(enc["LQ"][i + 1]), units)
            # model
            ps = set(np.where(pr[r] >= .5)[0]); qv = round_vec(pq[r].clip(0), units)
            mrows.append(basket_metrics(ps, qv, tset, tq, pr[r]))
            # P-TopFreq: SKUs bought in >=50% of past orders, median qty
            P = enc["P"][:i + 1]; freq = P.mean(0)
            med = np.array([np.median(np.expm1(enc["LQ"][:i + 1][P[:, j] > 0, j])) if P[:, j].any() else 1 for j in range(len(vocab))])
            bs = set(np.where(freq >= .5)[0])
            brows.append(basket_metrics(bs, round_vec(med, units), tset, tq, freq))
            actual = int(enc["dates"][i + 1] - enc["dates"][i])
            mdates.append(gap[r] - actual)
            g = np.diff(enc["dates"][:i + 1]); bdates.append(float(np.median(g)) - actual)
        results[name] = {"model": summarize(mrows, np.round(mdates)),
                         "P-TopFreq + median cadence": summarize(brows, np.round(bdates))}

    # churn AUC: snapshots every 7 days, label = no order in next 60 days
    items, labels, ratio = [], [], []
    for cid in test:
        h = hist[cid]; enc = encode_history(h["orders"], vidx); dates = enc["dates"]
        for today in range(int(dates[2]), END - CHURN_DAYS + 1, 7):
            i = int(np.searchsorted(dates, today, side="right") - 1)
            if i < 2:
                continue
            nxt = dates[i + 1] if i + 1 < len(dates) else 10**9
            labels.append(int(nxt - today > CHURN_DAYS))
            items.append((enc, i, today, kind_id(h["kind"])))
            ratio.append((today - dates[i]) / max(np.median(np.diff(dates[:i + 1])), 1))
    _, pc, _, _ = run(items)
    results["churn"] = {"snapshots": len(labels), "positives": int(sum(labels)),
                        "auc_model": auc(pc, labels), "auc_baseline_days_since_over_median_gap": auc(ratio, labels)}

    json.dump(results, open(ROOT / "backtest.json", "w"), indent=1)
    cols = ["recall_at_5", "precision", "recall", "f1", "qty_exact", "qty_mae", "date_mae_days", "date_within_2d"]
    for name in ("last_order", "last_3_cutoffs", "summer_orders"):
        print(f"\n== {name} (n={results[name]['model']['n']} baskets, test customers) ==")
        print(f"{'method':28s}" + "".join(f"{c:>15s}" for c in cols))
        for m, r in results[name].items():
            print(f"{m:28s}" + "".join(f"{r.get(c, float('nan')):15.3f}" for c in cols))
    c = results["churn"]
    print(f"\n== churn (n={c['snapshots']} snapshots, {c['positives']} positive) ==")
    print(f"AUC model {c['auc_model']:.3f} | baseline (days since last / median gap) {c['auc_baseline_days_since_over_median_gap']:.3f}")


if __name__ == "__main__":
    main()
