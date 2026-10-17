import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flag, FlagKind, Line, Order, ResolveResult } from "../src/types.ts";

// resolve.ts is built by someone else: local fake with the same contract.
vi.mock("../src/resolve.ts", () => ({
  unitPrice: (p: any, t: any) => t.price_overrides?.[p.sku] ?? Number((p.list_price * (1 - (t.discount_pct || 0) / 100)).toFixed(2)),
  isClean: (lines: Line[], flags: Flag[]) =>
    !lines.some((l) => l.state === "check" || l.state === "flag") && !flags.some((f) => f.severity === "high" || f.severity === "medium"),
  recomputeLine: (ln: any) => ({ ...ln, state: "ok" }),
  lineState: (flags: Flag[]) => (flags.some((f) => f.kind === "ambiguous_product") ? "check" : "ok"),
  g: (x: number) => String(Number(x.toPrecision(6))),
}));

import { connect, type Db } from "../src/db.ts";
import { loadData } from "../src/load.ts";
import * as orders from "../src/orders.ts";

const flag = (kind: FlagKind, severity: Flag["severity"], level: Flag["level"] = "order"): Flag =>
  ({ kind, level, severity, message: kind });
const dl = (pos: number, sku: string | null, qty: number | null, state: any = "ok", flags: Flag[] = []) => ({
  pos, origin: "message" as const, product_text: `p${pos}`, sku, qty, unit_text: null, state, candidates: [], flags,
  quote: "q", quote_start: 0, quote_end: 1, proposed_sku: sku, proposed_qty: qty, edited: 0 as const,
});

let db: Db;
const msg = { id: "m1", customer_id: "c1" };
const reading = { kind: "original", source: "message", text: "hello" } as const;

function seed(): void {
  db.exec(`INSERT INTO products VALUES ('A','Alpha','["a"]','x','case',6,'case of 6',10),
    ('B','Beta','[]','x','kg',1,'kg',4),('C','Gamma','[]','x','piece',1,'bottle',9);
    INSERT INTO customers VALUES ('c1','Bar','bar','', '{"discount_pct":5,"payment_days":30,"free_delivery_min":0,"price_overrides":{"C":7.5}}');
    INSERT INTO messages VALUES ('m1','c1','whatsapp','2026-10-16T08:00:00','x','hello',NULL,'h');`);
}
function store(result: Partial<ResolveResult> = {}): Order {
  const r: ResolveResult = { lines: [dl(0, "A", 2), dl(1, "B", 3), dl(2, "C", 1)], flags: [], delivery_date: "2026-10-20", ...result };
  return orders.orderView(db, orders.storeOrder(db, msg, reading, r))!;
}

beforeEach(() => { db = connect(":memory:"); seed(); });

describe("review fixes", () => {
  it("an un-removed line with no product goes back to check, not ok", () => {
    const o = store({ lines: [dl(0, null, 2, "check", [flag("ambiguous_product", "high", "line")])] });
    const id = o.lines[0].id;
    orders.patchLine(db, id, { removed: true });
    const back = orders.patchLine(db, id, { qty: 3 });
    expect(back.lines[0].state).toBe("check");
    expect(() => orders.confirm(db, o.id, ["ambiguous_product"])).toThrow("cannot be confirmed");
  });
  it("storeOrder refuses a message whose order is already confirmed", () => {
    const o = store();
    orders.confirm(db, o.id, []);
    expect(() => store()).toThrow("confirmed");
    expect(orders.latestOrderId(db, "m1")).toBe(o.id);
  });
});

describe("view", () => {
  it("enriches lines and totals", () => {
    const o = store();
    expect(o.lines.map((l) => [l.name, l.unit_price, l.line_total])).toEqual([["Alpha", 9.5, 19], ["Beta", 3.8, 11.4], ["Gamma", 7.5, 7.5]]);
    expect(o.total).toBe(37.9);
    expect(o.clean).toBe(true);
  });
  it("unknown sku has null price; removed lines are not counted", () => {
    const o = store({ lines: [dl(0, null, 2, "check"), dl(1, "A", 1, "removed")] });
    expect(o.lines[0].unit_price).toBeNull();
    expect(o.lines[1].line_total).toBeNull();
    expect(o.total).toBe(0);
    expect(o.clean).toBe(false);
  });
  it("a new order supersedes the draft", () => {
    const a = store(), b = store();
    expect(orders.orderView(db, a.id)!.status).toBe("superseded");
    expect(orders.latestOrderId(db, "m1")).toBe(b.id);
    expect(orders.latestOrderId(db, "none")).toBeNull();
  });
});

describe("patch", () => {
  it("edit marks edited and keeps proposal", () => {
    const o = store();
    const n = orders.patchLine(db, o.lines[0].id, { qty: 8 });
    expect(n.lines[0]).toMatchObject({ qty: 8, edited: 1, proposed_qty: 2, proposed_sku: "A" });
  });
  it("validates", () => {
    const o = store();
    expect(() => orders.patchLine(db, o.lines[0].id, { sku: "NOPE" })).toThrow(/catalogue/);
    expect(() => orders.patchLine(db, o.lines[0].id, { qty: "x" as any })).toThrow(/number/);
    expect(() => orders.patchLine(db, o.lines[0].id, { qty: -1 })).toThrow(/number/);
    expect(() => orders.patchLine(db, "zz", {})).toThrow(orders.OrderError);
  });
  it("remove, and refuse on confirmed", () => {
    const o = store();
    expect(orders.patchLine(db, o.lines[1].id, { removed: true }).lines[1].state).toBe("removed");
    orders.confirm(db, o.id, []);
    try { orders.patchLine(db, o.lines[0].id, { qty: 1 }); expect.unreachable(); }
    catch (e) { expect((e as orders.OrderError).status).toBe(409); }
  });
});

describe("confirm and export", () => {
  it("needs decisions and acknowledgement of high flags", () => {
    const o = store({ lines: [dl(0, "A", 2), dl(1, null, 1, "check")], flags: [flag("discount_beyond_terms", "high")] });
    try { orders.confirm(db, o.id, []); expect.unreachable(); }
    catch (e) {
      const err = e as orders.OrderError;
      expect(err.status).toBe(409);
      expect(err.reasons).toEqual(["A line needs a decision: «p1».", "Flag not acknowledged: discount_beyond_terms."]);
    }
  });
  it("confirms, keeps removed, refuses a second confirm", () => {
    const o = store({ flags: [flag("discount_beyond_terms", "high")] });
    orders.patchLine(db, o.lines[1].id, { removed: true });
    const c = orders.confirm(db, o.id, ["discount_beyond_terms"]);
    expect(c.status).toBe("confirmed");
    expect(c.confirmed_at).toBeTruthy();
    expect(c.lines.map((l) => l.state)).toEqual(["confirmed", "removed", "confirmed"]);
    expect(() => orders.confirm(db, o.id, [])).toThrow(/draft/);
  });
  it("exports only confirmed; csv and json", () => {
    const o = store();
    expect(() => orders.exportOrder(db, o.id, "csv")).toThrow(/confirmed/);
    orders.confirm(db, o.id, []);
    const csv = orders.exportOrder(db, o.id, "csv");
    expect(csv.mediaType).toBe("text/csv");
    expect(csv.content.split("\r\n")[0]).toBe(orders.CSV_COLUMNS.join(","));
    expect(csv.content.split("\r\n")[1]).toBe(`${o.id},c1,2026-10-20,A,Alpha,2,case,9.50,19.00`);
    const j = JSON.parse(orders.exportOrder(db, o.id, "json").content);
    expect(j.status).toBe("confirmed");
    expect(csv.filename).toBe(`order-${o.id.slice(0, 8)}.csv`);
  });
});

describe("loadData", () => {
  it("loads the shared data dir idempotently", () => {
    const d = connect(":memory:");
    const dir = new URL("../data", import.meta.url).pathname;
    loadData(d, dir);
    loadData(d, dir);
    expect((d.prepare("SELECT count(*) n FROM messages").get() as any).n).toBe(20);
    expect((d.prepare("SELECT count(*) n FROM customers").get() as any).n).toBe(5);
  });
});
