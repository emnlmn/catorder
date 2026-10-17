"""Learning curve: test quality vs number of training customers (fresh model per size, fixed test set).
Usage: python learning_curve.py [--epochs 12]. Does not touch weights/."""
import argparse, json, random, time
import numpy as np
import torch
from model import *
from train import build_examples, losses, ROOT
from backtest import basket_metrics, summarize, round_vec

SIZES = [25, 50, 100, 200, None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-3)
    args = ap.parse_args()
    dev = pick_device()
    hist = json.load(open(ROOT / "data" / "histories.json"))
    catalog = json.load(open(ROOT.parent / "data" / "catalog.json"))
    vocab = [p["sku"] for p in catalog]; vidx = {s: i for i, s in enumerate(vocab)}
    units = [p["sell_unit"] for p in catalog]
    tr, _, te = split_ids(list(hist))
    tr = sorted(tr); random.Random(123).shuffle(tr)  # fixed order: prefixes are nested subsamples

    items, meta_i = [], []
    for cid in te:
        h = hist[cid]; enc = encode_history(h["orders"], vidx); n = len(enc["dates"])
        if n < 6: continue
        items.append((enc, n - 2, int(enc["dates"][n - 2]), kind_id(h["kind"]))); meta_i.append((enc, n - 2))

    def score(pred_fn):
        rows, errs = [], []
        for r, (enc, i) in enumerate(meta_i):
            ps, qv, gap = pred_fn(r, enc, i)
            tset = np.where(enc["P"][i + 1] > 0)[0]
            tq = round_vec(np.expm1(enc["LQ"][i + 1]), units)
            rows.append(basket_metrics(ps, qv, tset, tq, np.zeros(len(vocab))))
            errs.append(round(gap - int(enc["dates"][i + 1] - enc["dates"][i])))
        s = summarize(rows, errs)
        return dict(f1=s["f1"], qty_exact=None if np.isnan(s["qty_exact"]) else s["qty_exact"], date_mae=s["date_mae_days"], within2=s["date_within_2d"])

    def base_fn(r, enc, i):
        P = enc["P"][:i + 1]; freq = P.mean(0)
        med = np.array([np.median(np.expm1(enc["LQ"][:i + 1][P[:, j] > 0, j])) if P[:, j].any() else 1 for j in range(len(vocab))])
        return set(np.where(freq >= .5)[0]), round_vec(med, units), float(np.median(np.diff(enc["dates"][:i + 1])))
    baseline = score(base_fn)
    print("baseline", baseline)

    out = {"sizes": [], "model": {k: [] for k in baseline}}
    for sz in SIZES:
        n = len(tr) if sz is None else min(sz, len(tr)); t0 = time.time()
        torch.manual_seed(0); np.random.seed(0)
        D = build_examples(tr[:n], hist, vidx, random.Random(0))
        net = NBR(len(vocab)).to(dev); N = len(D["kid"])
        opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-2)
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * ((N + args.bs - 1) // args.bs))
        Dd = {k: v.to(dev) for k, v in D.items()}
        for ep in range(args.epochs):
            net.train(); perm = torch.randperm(N, device=dev)
            for s in range(0, N, args.bs):
                b = {k: v[perm[s:s + args.bs]] for k, v in Dd.items()}
                loss, _ = losses(net(b["seq"], b["mask"], b["F"], b["ctx"], b["kid"]), b)
                opt.zero_grad(); loss.backward()
                torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0); opt.step(); sched.step()
        net.eval()
        ins = [make_inputs(*it) for it in items]
        t = [torch.tensor(np.stack(c), dtype=torch.long if k == 4 else torch.float32).to(dev) for k, c in enumerate(zip(*ins))]
        with torch.no_grad():
            o = net(*t)
        gap = o["mu"].exp().cpu().numpy(); pr = torch.sigmoid(o["logit"]).cpu().numpy(); pq = torch.expm1(o["logq"]).cpu().numpy()
        m = score(lambda r, enc, i: (set(np.where(pr[r] >= .5)[0]), round_vec(pq[r].clip(0), units), float(gap[r])))
        out["sizes"].append(n)
        for k in m: out["model"][k].append(m[k])
        print(n, N, {k: round(v, 3) for k, v in m.items()}, f"{time.time()-t0:.0f}s", flush=True)
    out.update(baseline=baseline, epochs=args.epochs, test_customers=len(meta_i), note="synthetic data")
    json.dump(out, open(ROOT / "learning_curve.json", "w"), indent=1)
    print("\ntrain_customers   f1  qty_exact  date_mae  within2")
    for j, n in enumerate(out["sizes"]):
        mm = out["model"]; print(f"{n:15d} {mm['f1'][j]:.3f} {(mm['qty_exact'][j] if mm['qty_exact'][j] is not None else float('nan')):.3f} {mm['date_mae'][j]:.2f} {mm['within2'][j]:.3f}")
    b = baseline; print(f"{'baseline':>15s} {b['f1']:.3f} {b['qty_exact']:.3f} {b['date_mae']:.2f} {b['within2']:.3f}")


if __name__ == "__main__":
    main()
