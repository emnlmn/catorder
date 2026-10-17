import datetime as dt, json, unittest
from pathlib import Path
from serve import Predictor, BadRequest

REPO = Path(__file__).resolve().parent.parent


class ServeTest(unittest.TestCase):
    def test_predict_demo_customer(self):
        p = Predictor()
        hist = json.load(open(REPO / "data" / "history" / "bar-ponterosso.json"))
        catalog = {c["sku"] for c in json.load(open(REPO / "data" / "catalog.json"))}
        r = p.predict({"today": "2026-10-18", "customer": {"id": "bar-ponterosso", "kind": "bar"}, "history": hist})
        self.assertGreater(dt.date.fromisoformat(r["next_order_date"]), dt.date.fromisoformat(hist[-1]["date"]))
        self.assertEqual(r["days_since_last"], 10)
        self.assertTrue(0 <= r["p_churn"] <= 1 and r["expected_gap_days"] > 0 and r["days_overdue"] >= 0)
        self.assertTrue(r["basket"])
        for b in r["basket"]:
            self.assertIn(b["sku"], catalog)
            self.assertGreaterEqual(b["p"], 0.5)
            self.assertGreater(b["qty"], 0)
        self.assertEqual([b["p"] for b in r["basket"]], sorted((b["p"] for b in r["basket"]), reverse=True))
        with self.assertRaises(BadRequest):
            p.predict({"today": "nope", "history": hist})


if __name__ == "__main__":
    unittest.main()
