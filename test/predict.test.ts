import { describe, expect, it } from "vitest";
import { ModelError } from "../src/cache.ts";
import { demand, parsePrediction, type Prediction } from "../src/predict.ts";
import type { Product } from "../src/types.ts";

const P = (sku: string, name: string) =>
  ({ sku, name, aliases: [], category: "x", sell_unit: "case", pack_size: 6, pack_label: "", list_price: 1 }) as Product;
const PRODUCTS = { NAT1: P("NAT1", "Acqua naturale"), CAF1: P("CAF1", "Caffè") };

describe("parsePrediction", () => {
  it("keeps catalogue SKUs, drops invented ones", () => {
    const text = JSON.stringify({
      next_order_date: "2026-10-22", expected_gap_days: 14, days_since_last: 10, days_overdue: 0, p_churn: 0.05,
      basket: [{ sku: "NAT1", qty: 6, p: 0.97 }, { sku: "GHOST", qty: 2, p: 0.9 }, { sku: "CAF1", qty: 0, p: 0.8 }],
      model: "catorder-nbr-v1", device: "AMD Instinct MI300X",
    });
    const p = parsePrediction(text, "bar", PRODUCTS);
    expect(p.basket).toEqual([{ sku: "NAT1", name: "Acqua naturale", qty: 6, p: 0.97 }]);
    expect(p.device).toBe("AMD Instinct MI300X");
  });

  it("rejects a malformed answer", () => {
    expect(() => parsePrediction("nope", "bar", PRODUCTS)).toThrow(ModelError);
    expect(() => parsePrediction(JSON.stringify({ next_order_date: "22/10", expected_gap_days: 1, p_churn: 0, basket: [] }), "bar", PRODUCTS))
      .toThrow(ModelError);
  });
});

describe("demand", () => {
  it("sums the baskets of customers due within the window", () => {
    const pred = (customer_id: string, next_order_date: string, qty: number) =>
      ({ customer_id, next_order_date, basket: [{ sku: "NAT1", name: "Acqua naturale", qty, p: 0.9 }] }) as Prediction;
    const d = demand([pred("a", "2026-10-20", 6), pred("b", "2026-10-25", 4), pred("c", "2026-11-10", 99)], "2026-10-18");
    expect(d).toEqual([{ sku: "NAT1", name: "Acqua naturale", qty: 10, customers: 2 }]);
  });
});
