// Client for the predictive model (model/serve.py, PyTorch; trained on an AMD Radeon Pro W7900D, serves on CPU): when a customer orders next and what.
// The model predicts; code only checks the answer's shape and that every SKU is in the catalogue.
import { cachedCall, ModelError, sha, type CacheOpts } from "./cache.ts";
import type { HistoryOrder, Product } from "./types.ts";

export interface PredictedLine { sku: string; name: string; qty: number; p: number }
export interface Prediction {
  customer_id: string;
  next_order_date: string;
  expected_gap_days: number;
  days_since_last: number;
  days_overdue: number;
  p_churn: number;
  basket: PredictedLine[];
  model: string;
  device: string;
  trained_on: string; // the GPU the weights were trained on
  latency_ms: number;
  cached: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse and check the service's JSON; throws ModelError on a malformed answer. Unknown SKUs are dropped. */
export function parsePrediction(text: string, customerId: string, products: Record<string, Product>): Omit<Prediction, "cached"> {
  let d: any;
  try { d = JSON.parse(text); } catch { throw new ModelError(200, `not JSON: ${text}`); }
  if (!d || !DATE.test(d.next_order_date) || !num(d.expected_gap_days) || !num(d.p_churn) || !Array.isArray(d.basket))
    throw new ModelError(200, `bad prediction: ${text}`);
  const basket = (d.basket as any[])
    .filter((b) => b && Object.hasOwn(products, b.sku) && num(b.qty) && b.qty > 0 && num(b.p))
    .map((b) => ({ sku: b.sku as string, name: products[b.sku].name, qty: b.qty as number, p: b.p as number }));
  return {
    customer_id: customerId, next_order_date: d.next_order_date, expected_gap_days: d.expected_gap_days,
    days_since_last: num(d.days_since_last) ? d.days_since_last : 0, days_overdue: num(d.days_overdue) ? d.days_overdue : 0,
    p_churn: d.p_churn, basket, model: String(d.model ?? "predictor"), device: String(d.device ?? ""), trained_on: String(d.trained_on ?? ""),
    latency_ms: num(d.latency_ms) ? d.latency_ms : 0,
  };
}

export class Predictor {
  constructor(private baseUrl: string, private token: string, private cache: CacheOpts, private timeoutS = 30) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async predict(customer: { id: string; kind: string }, history: HistoryOrder[], today: string,
    products: Record<string, Product>): Promise<Prediction> {
    const body = JSON.stringify({ today, customer: { id: customer.id, kind: customer.kind }, history });
    const r = await cachedCall(this.cache, "predict", "catorder-nbr-v1-w7900d", sha(customer.id), sha(body), async () => {
      if (!this.baseUrl) throw new ModelError(0, "PREDICT_BASE_URL is not set");
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/predict`, {
          method: "POST", body, signal: AbortSignal.timeout(this.timeoutS * 1000),
          headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        });
      } catch (e) { throw new ModelError(0, String(e)); }
      const text = await res.text();
      if (res.status >= 300) throw new ModelError(res.status, text);
      return [text, { prompt_tokens: 0, completion_tokens: 0 }];
    });
    return { ...parsePrediction(r.text, customer.id, products), cached: r.cached };
  }
}

/** Expected demand per SKU from the customers predicted to order within `days` of today: the sum of their baskets. */
export function demand(preds: Prediction[], today: string, days = 7): { sku: string; name: string; qty: number; customers: number }[] {
  const until = new Date(`${today}T00:00:00Z`).getTime() + days * 86_400_000;
  const by = new Map<string, { sku: string; name: string; qty: number; customers: number }>();
  for (const p of preds) {
    if (new Date(`${p.next_order_date}T00:00:00Z`).getTime() > until) continue;
    for (const b of p.basket) {
      const e = by.get(b.sku) ?? { sku: b.sku, name: b.name, qty: 0, customers: 0 };
      e.qty += b.qty; e.customers += 1;
      by.set(b.sku, e);
    }
  }
  return [...by.values()].sort((a, b) => b.qty - a.qty);
}
