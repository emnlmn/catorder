"""CatOrder prediction server (stdlib). POST /predict, GET /health. Env: PORT (8077), PREDICT_TOKEN (optional)."""
import datetime as dt, json, os, time, hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import numpy as np
import torch
from model import NBR, encode_history, make_inputs, kind_id, pick_device, device_name, round_qty

ROOT = Path(__file__).resolve().parent
MODEL_NAME = "catorder-nbr-v1"


class BadRequest(ValueError):
    pass


class Predictor:
    def __init__(self):
        self.meta = json.load(open(ROOT / "weights" / "catorder-nbr.json"))
        self.vocab = self.meta["vocab"]
        self.vidx = {s: i for i, s in enumerate(self.vocab)}
        self.units = [self.meta["sell_unit"][s] for s in self.vocab]
        self.dev = pick_device()
        self.dname = device_name(self.dev)
        self.net = NBR(len(self.vocab)).to(self.dev)
        self.net.load_state_dict(torch.load(ROOT / "weights" / "catorder-nbr.pt", map_location=self.dev))
        self.net.eval()

    def predict(self, body):
        t0 = time.time()
        if not isinstance(body, dict):
            raise BadRequest("body must be an object")
        try:
            today = dt.date.fromisoformat(body["today"])
            kind = (body.get("customer") or {}).get("kind", "other")
            orders = []
            for o in body["history"]:
                d = dt.date.fromisoformat(o["date"])
                if d <= today:
                    lines = [{"sku": l["sku"], "qty": float(l["qty"])} for l in o["lines"]
                             if l["sku"] in self.vidx and float(l["qty"]) > 0]
                    orders.append({"date": d.isoformat(), "lines": lines})
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            raise BadRequest(f"invalid input: {e}")
        if not orders:
            raise BadRequest("history has no orders on or before today")
        orders.sort(key=lambda o: o["date"])
        enc = encode_history(orders, self.vidx)
        i = len(orders) - 1
        last = dt.date.fromordinal(int(enc["dates"][-1]))

        def run(at):
            ins = make_inputs(enc, i, at, kind_id(kind))
            t = [torch.tensor(np.asarray(x)[None], dtype=torch.long if k == 4 else torch.float32).to(self.dev)
                 for k, x in enumerate(ins)]
            with torch.no_grad():
                return self.net(*t)
        # gap and basket are trained as of the last order (offset 0): "when did we expect them, with what";
        # churn is trained at offsets after it, so it is read as of today
        o = run(last.toordinal())
        oc = o if today == last else run(today.toordinal())
        gap = float(o["mu"].exp()[0])
        p = torch.sigmoid(o["logit"])[0].cpu().numpy()
        q = torch.expm1(o["logq"])[0].clamp(min=0).cpu().numpy()
        since = (today - last).days
        basket = [{"sku": self.vocab[j], "qty": round_qty(float(q[j]), self.units[j]), "p": round(float(p[j]), 3)}
                  for j in np.argsort(-p) if p[j] >= 0.5]
        return {"next_order_date": (last + dt.timedelta(days=max(1, round(gap)))).isoformat(),
                "expected_gap_days": round(gap, 2), "days_since_last": since,
                "days_overdue": max(0, since - round(gap)),
                "p_churn": round(float(torch.sigmoid(oc["churn"])[0]), 4), "basket": basket,
                "model": MODEL_NAME, "device": self.dname, "trained_on": self.meta.get("train", {}).get("device", ""), "latency_ms": int((time.time() - t0) * 1000)}


def make_handler(pred, token):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "device": pred.dname, "model": MODEL_NAME})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/predict":
                return self._send(404, {"error": "not found"})
            if token and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
                return self._send(401, {"error": "unauthorized"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"")
                self._send(200, pred.predict(body))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send(400, {"error": "bad JSON"})
            except BadRequest as e:
                self._send(400, {"error": str(e)})

        def log_message(self, *a):
            pass
    return H


def main():
    pred = Predictor()
    port = int(os.environ.get("PORT", "8077"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), make_handler(pred, os.environ.get("PREDICT_TOKEN")))
    print(f"serving {MODEL_NAME} on :{port}, device {pred.dname}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
