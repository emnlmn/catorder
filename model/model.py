"""CatOrder next-basket-recommendation model (NBR): GRU over order history + per-SKU head."""
import datetime as dt, math, os, hashlib
import numpy as np
import torch
import torch.nn as nn

KINDS = ["bar", "restaurant", "deli", "grocery", "other"]
L = 16          # orders of history fed to the GRU
NF = 6          # per-SKU history features
NCTX = 9
CHURN_DAYS = 60


def kind_id(kind):
    k = {"grocer": "grocery", "ristorante": "restaurant"}.get(kind, kind)
    return KINDS.index(k) if k in KINDS else KINDS.index("other")


def pick_device():
    if os.environ.get("MODEL_DEVICE"):
        return torch.device(os.environ["MODEL_DEVICE"])
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def device_name(dev):
    if dev.type == "cuda":
        return torch.cuda.get_device_name(0)
    return dev.type


def ordinal(s):
    return dt.date.fromisoformat(s).toordinal()


def split_ids(ids, seed=7):
    """Deterministic customer split 70/15/15. Demo customers (no 'syn-' prefix) stay out of all splits."""
    syn = sorted(i for i in ids if i.startswith("syn-"))
    rank = sorted(syn, key=lambda i: hashlib.md5(f"{seed}{i}".encode()).hexdigest())
    n = len(rank)
    a, b = int(.7 * n), int(.85 * n)
    return rank[:a], rank[a:b], rank[b:]


def encode_history(orders, vidx):
    """orders: [{date, lines:[{sku,qty}]}] sorted by date. Unknown SKUs ignored.
    Returns dict: dates[n], P[n,V], LQ[n,V] (log1p qty), seq[n,V+5], F[n,V,NF]."""
    V = len(vidx)
    n = len(orders)
    dates = np.array([ordinal(o["date"]) for o in orders], dtype=np.int64)
    LQ = np.zeros((n, V), np.float32)
    for i, o in enumerate(orders):
        for ln in o["lines"]:
            j = vidx.get(ln["sku"])
            if j is not None:
                LQ[i, j] = math.log1p(float(ln["qty"]))
    P = (LQ > 0).astype(np.float32)
    gap = np.zeros(n, np.float32)
    gap[1:] = np.log1p(np.diff(dates)) / 3
    doy = np.array([dt.date.fromordinal(int(d)).timetuple().tm_yday for d in dates]) / 365.25 * 2 * np.pi
    wd = np.array([dt.date.fromordinal(int(d)).weekday() for d in dates]) / 7 * 2 * np.pi
    seq = np.concatenate([LQ, gap[:, None], np.sin(doy)[:, None], np.cos(doy)[:, None],
                          np.sin(wd)[:, None], np.cos(wd)[:, None]], 1).astype(np.float32)
    cP = np.cumsum(P, 0)
    cL = np.cumsum(LQ, 0)
    idx = np.arange(n)[:, None]
    freq_all = cP / (idx + 1)
    mean_lq = cL / np.maximum(cP, 1)
    cP0 = np.vstack([np.zeros((1, V), np.float32), cP])
    lo = np.maximum(np.arange(n) - 2, 0)
    freq3 = (cP0[np.arange(n) + 1] - cP0[lo]) / (np.arange(n) - lo + 1)[:, None]
    last_lq = np.zeros((n, V), np.float32)
    since = np.ones((n, V), np.float32)
    cur = np.zeros(V, np.float32)
    seen_at = np.full(V, -10**6)
    for i in range(n):
        m = P[i] > 0
        cur[m] = LQ[i][m]
        seen_at[m] = i
        last_lq[i] = cur
        since[i] = np.minimum(i - seen_at, 20) / 20.0
    F = np.stack([freq_all, freq3, P, mean_lq, last_lq, since], -1).astype(np.float32)
    return {"dates": dates, "P": P, "LQ": LQ, "seq": seq, "F": F}


def make_inputs(enc, i, today, kid):
    """Model inputs for history = orders 0..i, evaluated at ordinal date `today` (>= dates[i])."""
    V = enc["P"].shape[1]
    lo = max(0, i - L + 1)
    s = enc["seq"][lo:i + 1]
    seq = np.zeros((L, V + 5), np.float32)
    seq[L - len(s):] = s
    mask = np.zeros(L, np.float32)
    mask[L - len(s):] = 1
    dates = enc["dates"][:i + 1]
    d = today - dates[-1]
    g = np.diff(dates).astype(np.float64)
    if len(g) == 0:
        med = mean = last = 14.0
        sd = 0.0
    else:
        med, mean, last = float(np.median(g)), float(g.mean()), float(g[-1])
        sd = float(np.log(np.maximum(g, 1)).std())
    doy = dt.date.fromordinal(int(today)).timetuple().tm_yday / 365.25 * 2 * math.pi
    ctx = np.array([math.log1p(d) / 3, min(d / max(med, 1), 5) / 2, math.log(max(med, 1)) / 3,
                    math.log(max(mean, 1)) / 3, sd, math.log(max(last, 1)) / 3,
                    math.log1p(i + 1) / 4, math.sin(doy), math.cos(doy)], np.float32)
    return seq, mask, enc["F"][i], ctx, np.array(kid)


class NBR(nn.Module):
    def __init__(self, V, hid=128, emb=16):
        super().__init__()
        self.V = V
        self.inp = nn.Linear(V + 5, 96)
        self.gru = nn.GRU(96, hid, batch_first=True)
        self.kind = nn.Embedding(len(KINDS), 8)
        self.trunk = nn.Sequential(nn.Linear(hid + 8 + NCTX, 128), nn.ReLU(), nn.Dropout(0.1))
        self.gap = nn.Linear(128, 2)
        self.churn = nn.Linear(128, 1)
        self.proj = nn.Linear(128, 32)
        self.sku_emb = nn.Embedding(V, emb)
        self.sku_mlp = nn.Sequential(nn.Linear(NF + emb + 32 + 2, 48), nn.ReLU(), nn.Linear(48, 2))

    def forward(self, seq, mask, F, ctx, kid):
        x = torch.relu(self.inp(seq)) * mask.unsqueeze(-1)
        h, _ = self.gru(x)
        z = self.trunk(torch.cat([h[:, -1], self.kind(kid), ctx], -1))
        g = self.gap(z)
        mu = g[:, 0] + ctx[:, 2] * 3          # residual on log median gap
        logb = g[:, 1].clamp(-4, 3)
        churn = self.churn(z).squeeze(-1)
        B = z.shape[0]
        zp = self.proj(z).unsqueeze(1).expand(B, self.V, -1)
        se = self.sku_emb.weight.unsqueeze(0).expand(B, -1, -1)
        sc = ctx[:, 7:9].unsqueeze(1).expand(B, self.V, 2)
        o = self.sku_mlp(torch.cat([F, se, zp, sc], -1))
        logit = o[..., 0]
        logq = o[..., 1] + F[..., 3]          # residual on historical mean log-qty
        return {"mu": mu, "logb": logb, "churn": churn, "logit": logit, "logq": logq}


def round_qty(x, unit):
    """x = expm1(pred log1p qty)."""
    if unit == "kg":
        return max(0.5, round(x * 2) / 2)
    return max(1, int(round(x)))


def auc(scores, labels):
    """ROC AUC via rank statistic (ties averaged)."""
    s = np.asarray(scores, float); y = np.asarray(labels, int)
    pos, neg = (y == 1).sum(), (y == 0).sum()
    if pos == 0 or neg == 0:
        return float("nan")
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s)); ss = s[order]
    i = 0
    while i < len(ss):
        j = i
        while j + 1 < len(ss) and ss[j + 1] == ss[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))
