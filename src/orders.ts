// Storing, viewing, editing, confirming and exporting orders (SPEC §14).
import type { SQLInputValue } from "node:sqlite";
import { getCatalog, getCustomer, historyOrders, newId, nowIso, row, rows, type Db } from "./db.ts";
import { g, isClean, lineState, recomputeLine, unitPrice } from "./resolve.ts";
import type {
  Candidate, Flag, FlagKind, Line, Order, PatchLineBody, Product, Reading, ResolveResult, StoredLine,
} from "./types.ts";

export class OrderError extends Error {
  constructor(public status: number, message: string, public reasons: string[] = []) {
    super(message);
  }
}

/** Supersede the message's draft, insert the new order and its lines. Returns the new order id. */
export interface Segment { message_id: string; start: number; end: number }

export function storeOrder(
  db: Db, message: { id: string; customer_id: string }, reading: Reading, result: ResolveResult,
  segments: Segment[] = [{ message_id: message.id, start: 0, end: reading.text.length }], supersede: string[] = [],
): string {
  const oid = newId();
  db.exec("BEGIN");
  try {
    if (row(db, "SELECT 1 FROM orders WHERE message_id=? AND status='confirmed'", message.id))
      throw new OrderError(409, "This order is confirmed and cannot be read again."); // a confirm landed mid-read
    db.prepare("UPDATE orders SET status='superseded' WHERE message_id=? AND status='draft'").run(message.id);
    for (const id of supersede) db.prepare("UPDATE orders SET status='superseded' WHERE id=? AND status='draft'").run(id);
    db.prepare(`INSERT INTO orders (id, message_id, customer_id, status, reading_kind, reading_source, reading,
        delivery_date, flags, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(oid, message.id, message.customer_id, "draft", reading.kind, reading.source, reading.text,
        result.delivery_date, JSON.stringify(result.flags), nowIso());
    segments.forEach((sg, i) => db.prepare("INSERT INTO order_messages (order_id, message_id, pos, start, end) VALUES (?,?,?,?,?)")
      .run(oid, sg.message_id, i, sg.start, sg.end));
    const ins = db.prepare(`INSERT INTO lines (id, order_id, pos, origin, product_text, sku, qty, unit_text, state,
        candidates, flags, quote, quote_start, quote_end, proposed_sku, proposed_qty, edited)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const ln of result.lines)
      ins.run(newId(), oid, ln.pos, ln.origin, ln.product_text, ln.sku, ln.qty, ln.unit_text, ln.state,
        JSON.stringify(ln.candidates), JSON.stringify(ln.flags), ln.quote, ln.quote_start, ln.quote_end,
        ln.proposed_sku, ln.proposed_qty, 0);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return oid;
}

export function latestOrderId(db: Db, messageId: string): string | null {
  const r = row<{ id: string }>(db,
    `SELECT id FROM orders WHERE status != 'superseded' AND (message_id=?
       OR id IN (SELECT order_id FROM order_messages WHERE message_id=?)) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    messageId, messageId);
  return r ? r.id : null;
}

/** The messages of an order, oldest first, with their [start,end) in the combined reading. */
export function segmentsOf(db: Db, orderId: string): Segment[] {
  const s = rows<Segment>(db, "SELECT message_id, start, end FROM order_messages WHERE order_id=? ORDER BY pos", orderId);
  if (s.length) return s;
  const o = row<{ message_id: string; reading: string }>(db, "SELECT message_id, reading FROM orders WHERE id=?", orderId);
  return o ? [{ message_id: o.message_id, start: 0, end: o.reading.length }] : [];
}

type RawLine = Omit<StoredLine, "candidates" | "flags"> & { candidates: string; flags: string };

function parseLine(r: RawLine): StoredLine {
  return { ...r, candidates: JSON.parse(r.candidates), flags: JSON.parse(r.flags) };
}

export function orderView(db: Db, orderId: string): Order | null {
  const o = row<Omit<Order, "flags" | "lines" | "total" | "clean"> & { flags: string }>(
    db, "SELECT * FROM orders WHERE id=?", orderId);
  if (!o) return null;
  const products = new Map<string, Product>(getCatalog(db).map((p) => [p.sku, p]));
  const terms = getCustomer(db, o.customer_id)!.terms;
  let total = 0;
  const lines: Line[] = rows<RawLine>(db, "SELECT * FROM lines WHERE order_id=? ORDER BY pos", orderId).map((r) => {
    const ln = parseLine(r);
    const p = ln.sku ? products.get(ln.sku) : undefined;
    const price = p ? unitPrice(p, terms) : null;
    const counted = p && ln.qty && ln.state !== "removed";
    const lineTotal = counted && price !== null ? Number((price * ln.qty!).toFixed(2)) : null;
    total += lineTotal ?? 0;
    const candidates: Candidate[] = ln.candidates.map((c) => {
      const cp = products.get(c.sku);
      return { ...c, name: cp ? cp.name : null, pack_label: cp ? cp.pack_label : null };
    });
    return {
      ...ln, candidates, name: p?.name ?? null, pack_label: p?.pack_label ?? null,
      sell_unit: p?.sell_unit ?? null, unit_price: price, line_total: lineTotal,
    };
  });
  const flags: Flag[] = JSON.parse(o.flags);
  const segments = segmentsOf(db, orderId);
  return { ...o, flags, lines, message_ids: segments.map((x) => x.message_id), segments, total: Number(total.toFixed(2)), clean: isClean(lines, flags) };
}

function orderRow(db: Db, orderId: string) {
  const o = row<{ id: string; status: string; customer_id: string }>(db, "SELECT * FROM orders WHERE id=?", orderId);
  if (!o) throw new OrderError(404, "No such order.");
  return o;
}

export function patchLine(db: Db, lineId: string, body: PatchLineBody): Order {
  const r = row<RawLine>(db, "SELECT * FROM lines WHERE id=?", lineId);
  if (!r) throw new OrderError(404, "No such line.");
  const o = orderRow(db, r.order_id);
  if (o.status !== "draft") throw new OrderError(409, "Only a draft order can be edited.");
  let ln = parseLine(r);
  const products = new Map<string, Product>(getCatalog(db).map((p) => [p.sku, p]));
  if (body.sku != null) {
    if (!products.has(body.sku)) throw new OrderError(400, "That product is not in the catalogue.");
    ln.sku = body.sku;
  }
  if ("qty" in body) {
    const q = body.qty as unknown;
    if (q != null && (typeof q !== "number" || !Number.isFinite(q) || q < 0))
      throw new OrderError(400, "The quantity must be a number.");
    ln.qty = (q as number | null | undefined) ?? null;
  }
  if (body.removed === true) ln.state = "removed";
  // Deviation from server/orders.py: a line without a product keeps the state its flags give it
  // (check/flag), never "ok", so an un-removed ambiguous line still blocks confirm.
  else if (ln.state === "removed" || ln.sku !== null) ln.state = ln.sku !== null ? "ok" : lineState(ln.flags);
  if (ln.sku !== null && ln.state !== "removed")
    ln = recomputeLine(ln, Object.fromEntries(products), historyOrders(db, o.customer_id));
  db.prepare("UPDATE lines SET sku=?, qty=?, state=?, flags=?, edited=1 WHERE id=?")
    .run(ln.sku, ln.qty, ln.state, JSON.stringify(ln.flags), lineId);
  return orderView(db, r.order_id)!;
}

export function confirmReasons(view: Order, acknowledged: readonly FlagKind[]): string[] {
  const live = view.lines.filter((l) => l.state !== "removed");
  const reasons = live.filter((l) => l.state === "check")
    .map((l) => `A line needs a decision: «${l.product_text}».`);
  const highs = new Set<string>();
  for (const f of [...view.flags, ...live.flatMap((l) => l.flags)]) if (f.severity === "high") highs.add(f.kind);
  for (const k of [...highs].sort()) if (!acknowledged.includes(k as FlagKind)) reasons.push(`Flag not acknowledged: ${k}.`);
  return reasons;
}

export function confirm(db: Db, orderId: string, acknowledged: readonly FlagKind[] = []): Order {
  if (orderRow(db, orderId).status !== "draft") throw new OrderError(409, "Only a draft order can be confirmed.");
  const reasons = confirmReasons(orderView(db, orderId)!, acknowledged);
  if (reasons.length) throw new OrderError(409, "The order cannot be confirmed yet.", reasons);
  db.prepare("UPDATE orders SET status='confirmed', confirmed_at=? WHERE id=?").run(nowIso(), orderId);
  db.prepare("UPDATE lines SET state='confirmed' WHERE order_id=? AND state != 'removed'").run(orderId);
  return orderView(db, orderId)!;
}

export const CSV_COLUMNS = ["order_id", "customer_id", "delivery_date", "sku", "name", "qty", "sell_unit",
  "unit_price", "line_total"];

// Python's csv.writer: quote a field containing , " or a newline.
const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** Confirmed orders only. */
export function exportOrder(db: Db, orderId: string, fmt: string): { content: string; mediaType: string; filename: string } {
  if (orderRow(db, orderId).status !== "confirmed") throw new OrderError(409, "Only a confirmed order can be exported.");
  const view = orderView(db, orderId)!;
  const base = `order-${orderId.slice(0, 8)}`;
  if (fmt === "json")
    return { content: JSON.stringify(view, null, 2), mediaType: "application/json", filename: `${base}.json` };
  const out = [CSV_COLUMNS.join(",")];
  for (const ln of view.lines) {
    if (ln.state === "removed" || !ln.qty || !ln.sku) continue;
    out.push([orderId, view.customer_id, view.delivery_date ?? "", ln.sku, ln.name ?? "", g(ln.qty),
      ln.sell_unit ?? "", ln.unit_price!.toFixed(2), ln.line_total!.toFixed(2)].map(csvField).join(","));
  }
  return { content: out.join("\r\n") + "\r\n", mediaType: "text/csv", filename: `${base}.csv` };
}
