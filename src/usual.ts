// The usual: products in at least half of the last six orders (SPEC §13.2). Pure.
import type { HistoryOrder, Product, SellUnit } from "./types.ts";

export interface UsualEntry { sku: string; qty: number }

/** Python's round(): halves go to the even neighbour. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export function roundQty(qty: number, sellUnit: SellUnit | string): number {
  if (sellUnit === "kg") return pyRound(qty * 2) / 2;
  return Math.max(1, Math.floor(qty + 0.5));
}

/** The n most recent orders, newest first (stable for equal dates). */
export function lastOrders(history: HistoryOrder[], n = 6): HistoryOrder[] {
  return [...history].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, n);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Items in the order of their first appearance in the most recent order; [] with fewer than 2 orders. */
export function computeUsual(
  history: HistoryOrder[],
  products: Record<string, Pick<Product, "sell_unit">>,
): UsualEntry[] {
  const orders = lastOrders(history);
  if (orders.length < 2) return [];
  const need = Math.max(2, Math.ceil(orders.length / 2));
  const qtys = new Map<string, number[]>(); // Map keeps first-seen order
  for (const o of orders) {
    const perOrder = new Map<string, number>(); // a sku twice in one order counts once, quantities summed
    for (const ln of o.lines) perOrder.set(ln.sku, (perOrder.get(ln.sku) ?? 0) + ln.qty);
    for (const [sku, q] of perOrder) {
      const list = qtys.get(sku);
      if (list) list.push(q);
      else qtys.set(sku, [q]);
    }
  }
  const out: UsualEntry[] = [];
  for (const [sku, list] of qtys) {
    const p = Object.hasOwn(products, sku) ? products[sku] : undefined;
    if (list.length >= need && p) out.push({ sku, qty: roundQty(median(list), p.sell_unit) });
  }
  return out;
}

export function recentSkus(history: HistoryOrder[], n = 6): string[] {
  const seen = new Set<string>();
  for (const o of lastOrders(history, n)) for (const ln of o.lines) seen.add(ln.sku);
  return [...seen];
}
