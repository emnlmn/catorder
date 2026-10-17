"""Train the CatOrder NBR model. Usage: python train.py [--epochs 40]"""
import argparse, json, random, time
from pathlib import Path
import numpy as np
import torch
import torch.nn.functional as Fn
from model import *

ROOT = Path(__file__).resolve().parent
END = dt.date(2026, 10, 17).toordinal()


def build_examples(ids, hist, vidx, rng):
    X = {k: [] for k in ["seq", "mask", "F", "ctx", "kid"]}
    Y = {k: [] for k in ["lgap", "m_gap", "tp", "tq", "m_bask", "churn", "m_churn"]}
    V = len(vidx)
    for cid in ids:
        h = hist[cid]
        enc = encode_history(h["orders"], vidx)
        dates, n = enc["dates"], len(enc["dates"])
        kid = kind_id(h["kind"])
        for i in range(1, n):
            cases = [0]
            if i < n - 1:
                g = int(dates[i + 1] - dates[i])
                if g > 1:
                    cases += [rng.randint(1, g - 1) for _ in range(2)]
            else:
                cases += [rng.randint(0, 120) for _ in range(8)]
            for d in cases:
                today = int(dates[i]) + d
                if today > END:
                    continue
                for k, v in zip(X, make_inputs(enc, i, today, kid)):
                    X[k].append(v)
                has_next = i < n - 1
                if has_next:
                    nd = int(dates[i + 1]) - int(dates[i])
                    ch = float(int(dates[i + 1]) - today > CHURN_DAYS)
                    mc = 1.0
                else:
                    nd, ch = 1, 1.0
                    mc = float(today + CHURN_DAYS <= END)
                Y["lgap"].append(math.log(nd)); Y["m_gap"].append(float(has_next))
                Y["tp"].append(enc["P"][i + 1] if has_next else np.zeros(V, np.float32))
                Y["tq"].append(enc["LQ"][i + 1] if has_next else np.zeros(V, np.float32))
                Y["m_bask"].append(float(has_next)); Y["churn"].append(ch); Y["m_churn"].append(mc)
    out = {k: torch.tensor(np.array(v), dtype=torch.long if k == "kid" else torch.float32) for k, v in {**X, **Y}.items()}
    return out


def losses(o, b):
    mu, logb = o["mu"], o["logb"]
    gap = ((torch.abs(b["lgap"] - mu) / logb.exp() + logb) * b["m_gap"]).sum() / b["m_gap"].sum().clamp(min=1)
    ch = (Fn.binary_cross_entropy_with_logits(o["churn"], b["churn"], reduction="none") * b["m_churn"]).sum() / b["m_churn"].sum().clamp(min=1)
    bce = Fn.binary_cross_entropy_with_logits(o["logit"], b["tp"], reduction="none").sum(-1)
    bce = (bce * b["m_bask"]).sum() / b["m_bask"].sum().clamp(min=1) / 8
    inc = b["tp"] * b["m_bask"].unsqueeze(-1)
    q = (Fn.smooth_l1_loss(o["logq"], b["tq"], reduction="none") * inc).sum() / inc.sum().clamp(min=1)
    return gap + ch + bce + 2 * q, dict(gap=gap.item(), churn=ch.item(), bce=bce.item(), qty=q.item())


def batch(D, idx, dev):
    return {k: v[idx].to(dev, non_blocking=True) for k, v in D.items()}


@torch.no_grad()
def predict_all(net, D, dev, bs=1024):
    net.eval()
    outs = []
    N = len(D["kid"])
    for s in range(0, N, bs):
        b = batch(D, torch.arange(s, min(N, s + bs)), dev)
        o = net(b["seq"], b["mask"], b["F"], b["ctx"], b["kid"])
        outs.append({k: v.cpu() for k, v in o.items()})
    return {k: torch.cat([o[k] for o in outs]) for k in outs[0]}


def evaluate(net, D, dev):
    o = predict_all(net, D, dev)
    loss, parts = losses(o, D)
    m = D["m_gap"] > 0
    off0 = m & (D["ctx"][:, 0] == 0)
    mae = (torch.exp(o["mu"][off0]) - torch.exp(D["lgap"][off0])).abs().mean().item()
    mc = D["m_churn"] > 0
    a = auc(torch.sigmoid(o["churn"][mc]).numpy(), D["churn"][mc].numpy())
    pred = (torch.sigmoid(o["logit"]) >= .5).float(); tp = D["tp"]; mb = D["m_bask"] > 0
    tpn = (pred * tp)[mb].sum(); f1 = (2 * tpn / (pred[mb].sum() + tp[mb].sum()).clamp(min=1)).item()
    return dict(loss=loss.item(), gap_mae_days=mae, churn_auc=a, basket_f1=f1, **parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-3)
    args = ap.parse_args()
    torch.manual_seed(0); np.random.seed(0)
    rng = random.Random(0)
    dev = pick_device()
    print(f"device: {dev} ({device_name(dev)})  torch {torch.__version__}")
    hist = json.load(open(ROOT / "data" / "histories.json"))
    catalog = json.load(open(ROOT.parent / "data" / "catalog.json"))
    vocab = [p["sku"] for p in catalog]
    vidx = {s: i for i, s in enumerate(vocab)}
    tr, va, te = split_ids(list(hist))
    t0 = time.time()
    Dtr, Dva = build_examples(tr, hist, vidx, rng), build_examples(va, hist, vidx, rng)
    print(f"customers train/val/test {len(tr)}/{len(va)}/{len(te)}; examples {len(Dtr['kid'])}/{len(Dva['kid'])} ({time.time()-t0:.1f}s)")
    net = NBR(len(vocab)).to(dev)
    nparam = sum(p.numel() for p in net.parameters())
    print(f"params: {nparam:,}")
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-2)
    N = len(Dtr["kid"])
    steps = args.epochs * ((N + args.bs - 1) // args.bs)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps)
    Dtr_dev = {k: v.to(dev) for k, v in Dtr.items()}
    best, best_state, best_m, t0 = 1e9, None, None, time.time()
    for ep in range(1, args.epochs + 1):
        net.train()
        perm = torch.randperm(N, device=dev)
        tot = 0.0
        for s in range(0, N, args.bs):
            b = {k: v[perm[s:s + args.bs]] for k, v in Dtr_dev.items()}
            o = net(b["seq"], b["mask"], b["F"], b["ctx"], b["kid"])
            loss, _ = losses(o, b)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step(); sched.step()
            tot += loss.item() * len(perm[s:s + args.bs])
        m = evaluate(net, Dva, dev)
        score = m["gap_mae_days"] / 4 + (1 - m["churn_auc"]) + (1 - m["basket_f1"])
        if score < best:
            best, best_m = score, {**m, "epoch": ep}
            best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
        if ep % 5 == 0 or ep == 1:
            print(f"ep {ep:3d} train {tot/N:.3f} | val loss {m['loss']:.3f} gapMAE {m['gap_mae_days']:.2f}d "
                  f"churnAUC {m['churn_auc']:.3f} F1 {m['basket_f1']:.3f}  [{time.time()-t0:.0f}s]")
    train_s = time.time() - t0
    net.load_state_dict(best_state)
    (ROOT / "weights").mkdir(exist_ok=True)
    torch.save(best_state, ROOT / "weights" / "catorder-nbr.pt")
    meta = {"model": "catorder-nbr-v1", "vocab": vocab, "sell_unit": {p["sku"]: p["sell_unit"] for p in catalog},
            "kinds": KINDS, "hyperparams": {"L": L, "hid": 128, "emb": 16, "epochs": args.epochs, "bs": args.bs,
                                            "lr": args.lr, "params": nparam, "churn_days": CHURN_DAYS},
            "train": {"device": device_name(dev), "seconds": round(train_s, 1)}, "val_metrics": best_m}
    json.dump(meta, open(ROOT / "weights" / "catorder-nbr.json", "w"), indent=1)
    print(f"trained in {train_s:.0f}s on {device_name(dev)}; best epoch {best_m['epoch']}; val {best_m}")
    print(f"weights: {(ROOT/'weights'/'catorder-nbr.pt').stat().st_size/1e6:.2f} MB")


if __name__ == "__main__":
    main()
