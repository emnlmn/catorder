import { describe, expect, it } from "vitest";
import type { HistoryOrder, SellUnit } from "../src/types.ts";
import { computeUsual, recentSkus, roundQty } from "../src/usual.ts";
import { golden } from "./parity.ts";

const unit: Record<string, SellUnit> = { ROS1: "case", NAT1: "case", FRI1: "case", PRO1: "case", PRC1: "kg" };
const PRODUCTS = Object.fromEntries(Object.entries(unit).map(([k, u]) => [k, { sell_unit: u }]));

function order(day: number, lines: Record<string, number>): HistoryOrder {
  return { date: `2026-0${day}-01`, lines: Object.entries(lines).map(([sku, qty]) => ({ sku, qty })) };
}

describe("usual", () => {
  it("half of last six", () => {
    const h = [1, 2, 3, 4, 5, 6].map((i) => order(i, { ROS1: 6, NAT1: 4 }));
    h.forEach((o, i) => { if (i < 3) o.lines.push({ sku: "FRI1", qty: 2 }); });
    h[0]!.lines.push({ sku: "PRO1", qty: 1 });
    expect(new Set(computeUsual(h, PRODUCTS).map((u) => u.sku))).toEqual(new Set(["ROS1", "NAT1", "FRI1"]));
  });

  it("only last six count", () => {
    const old = [order(1, { PRO1: 3 }), order(2, { PRO1: 3 })];
    const nw: HistoryOrder[] = [3, 4, 5, 6, 7, 8].map((i) => ({ date: `2026-0${i}-15`, lines: [{ sku: "ROS1", qty: 6 }] }));
    expect(computeUsual([...old, ...nw], PRODUCTS).map((u) => u.sku)).toEqual(["ROS1"]);
  });

  it("at least two orders with the product", () => {
    expect(computeUsual([order(1, { ROS1: 6 }), order(2, { NAT1: 6 }), order(3, { FRI1: 1 })], PRODUCTS)).toEqual([]);
  });

  it("fewer than two orders gives none", () => {
    expect(computeUsual([order(1, { ROS1: 6 })], PRODUCTS)).toEqual([]);
    expect(computeUsual([], PRODUCTS)).toEqual([]);
  });

  it("median and rounding", () => {
    const h = [order(1, { ROS1: 4, PRC1: 2.0 }), order(2, { ROS1: 6, PRC1: 2.5 }), order(3, { ROS1: 5, PRC1: 3.0 }), order(4, { ROS1: 9, PRC1: 2.2 })];
    const u = Object.fromEntries(computeUsual(h, PRODUCTS).map((x) => [x.sku, x.qty]));
    expect(u.ROS1).toBe(6);
    expect(u.PRC1).toBe(2.5);
  });

  it("round_qty", () => {
    expect(roundQty(2.4, "case")).toBe(2);
    expect(roundQty(0.2, "piece")).toBe(1);
    expect(roundQty(2.3, "kg")).toBe(2.5);
    expect(roundQty(3.25, "kg")).toBe(3); // Python banker's rounding on 6.5
  });

  it("sku twice in one order counts once with summed qty", () => {
    const h = [{ date: "2026-05-01", lines: [{ sku: "PRO1", qty: 2 }, { sku: "PRO1", qty: 3 }] }, order(2, { ROS1: 6 }), order(3, { ROS1: 6 }), order(4, { ROS1: 6 })];
    expect(computeUsual(h, PRODUCTS).map((x) => x.sku)).not.toContain("PRO1");
    const h2 = [1, 2].map((i) => ({ date: `2026-0${i}-01`, lines: [{ sku: "PRO1", qty: 2 }, { sku: "PRO1", qty: 3 }] }));
    expect(computeUsual(h2, PRODUCTS)).toEqual([{ sku: "PRO1", qty: 5 }]);
  });
});

describe("usual parity with Python goldens", () => {
  it("round_qty", () => {
    for (const c of golden("python-unit/round_qty.json") as { in: [number, SellUnit]; out: number }[])
      expect(roundQty(...c.in)).toBe(c.out);
  });
});
