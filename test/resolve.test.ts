import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { golden } from "./parity.ts";
import type { Customer, HistoryOrder, Product, Terms, VerifiedRequest } from "../src/types.ts";

// Local fake of ./usual.ts (another builder writes it): a 1:1 port of server/usual.py.
vi.mock("../src/usual.ts", () => {
  const lastOrders = (h: HistoryOrder[], n = 6) => [...h].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, n);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  const computeUsual = (history: HistoryOrder[], products: Record<string, Product>) => {
    const orders = lastOrders(history);
    if (orders.length < 2) return [];
    const need = Math.max(2, Math.ceil(orders.length / 2));
    const qtys: Record<string, number[]> = {}, first: string[] = [];
    for (const o of orders) {
      const per: Record<string, number> = {};
      for (const l of o.lines) per[l.sku] = (per[l.sku] ?? 0) + l.qty;
      for (const [sku, q] of Object.entries(per)) {
        if (!(sku in qtys)) { first.push(sku); qtys[sku] = []; }
        qtys[sku].push(q);
      }
    }
    return first.filter((s) => qtys[s].length >= need && s in products).map((sku) => {
      const m = median(qtys[sku]);
      return { sku, qty: products[sku].sell_unit === "kg" ? Math.round(m * 2) / 2 : Math.max(1, Math.floor(m + 0.5)) };
    });
  };
  return { lastOrders, computeUsual };
});

const R = await import("../src/resolve.ts");
const { isClean, match, resolve, searchCatalog, unitPrice } = R;

// ---- fixtures (tests/fixtures.py) ----
function P(sku: string, name: string, aliases: string[], sell_unit: Product["sell_unit"] = "case", pack_size = 6,
  pack_label = "case of 6 × 75 cl", price = 40.0): Product {
  return { sku, name, aliases, category: "x", sell_unit, pack_size, pack_label, list_price: price };
}
const CATALOG: Product[] = [
  P("ROS1", "Rosso Colline 75cl", ["rosso colline", "colline"]),
  P("ROS2", "Roccafiera Rosso Superiore 75cl", ["roccafiera"]),
  P("BIA1", "Bianco Fiorito 75cl", ["bianco fiorito"]),
  P("PRO1", "Prosecco Brut Valdoro 75cl", ["prosecco valdoro"]),
  P("PRO2", "Prosecco Extra Dry Valdera 75cl", ["prosecco valdera"]),
  P("NAT1", "Fonte Brivio naturale 1L", ["acqua naturale", "brivio nat"], "case", 12, "case of 12 × 1 L", 6.0),
  P("FRI1", "Fonte Brivio frizzante 1L", ["acqua frizzante", "brivio friz"], "case", 12, "case of 12 × 1 L", 6.0),
  P("OLI1", "Olio extravergine Terre Alte 1L", ["olio"], "piece", 1, "bottle 1 L", 9.0),
  P("PRC1", "Prosciutto crudo stagionato", ["crudo", "prosciutto"], "kg", 1, "kg", 24.0),
];
const TERMS: Terms = { discount_pct: 5, payment_days: 30, free_delivery_min: 300, price_overrides: { OLI1: 7.5 } };
const CUSTOMER: Customer = { id: "bar", name: "Bar Test", kind: "bar", context: "", terms: TERMS };

function hist(n = 6): HistoryOrder[] {
  const out: HistoryOrder[] = [];
  for (let i = 0; i < n; i++) {
    const lines = [{ sku: "ROS1", qty: 6 }, { sku: "NAT1", qty: i % 2 ? 6 : 4 }];
    if (i < 4) lines.push({ sku: "FRI1", qty: 2 });
    if (i === 0) lines.push({ sku: "PRO1", qty: 1 });
    out.push({ date: `2026-0${i + 5}-10`, lines });
  }
  return out;
}
const HISTORY = hist();
const TODAY = "2026-10-16";

// fake of verify.parseUnit, enough for these tests
const UNITS: Record<string, VerifiedRequest["unit"]> = { cs: "case", casse: "case", bottiglie: "piece" };

interface Opts {
  quote?: string; product?: string; qty?: number | null; unit?: string | null; op?: "add" | "set"; sku?: string | null;
  value?: string | null; start?: number;
}
function req(kind: VerifiedRequest["kind"] = "item", o: Opts = {}): VerifiedRequest {
  const quote = o.quote || o.product || kind, start = o.start ?? 0, unit = o.unit ?? null;
  return {
    kind, quote, quote_start: start, quote_end: start + quote.length, product: o.product ?? "", sku: o.sku ?? null,
    qty: o.qty ?? null, unit_text: unit, unit: unit ? UNITS[unit] ?? null : null,
    op: kind === "item" ? o.op ?? "set" : null, value: o.value ?? null,
    date: kind === "delivery" ? o.value ?? null : null, status: "observed",
  };
}
const run = (requests: VerifiedRequest[], history = HISTORY, customer: Customer = CUSTOMER) =>
  resolve(requests, CATALOG, customer, history, TODAY);
const kinds = (flags: { kind: string }[]) => flags.map((f) => f.kind);

describe("matching", () => {
  it("certain match", () => {
    const [sku, cands] = match("acqua naturale", null, CATALOG, HISTORY);
    expect(sku).toBe("NAT1");
    expect(cands[0].sku).toBe("NAT1");
  });
  it("colour word disambiguates", () => {
    expect(match("acqua frizzante", null, CATALOG, [])[0]).toBe("FRI1");
    expect(match("bianco", null, CATALOG, [])[0]).toBe("BIA1");
  });
  it("history bonus makes 'quello rosso' resolve", () => {
    expect(match("quello rosso dell'altra volta", null, CATALOG, HISTORY)[0]).toBe("ROS1");
    const [sku2, cands2] = match("quello rosso dell'altra volta", null, CATALOG, []);
    expect(sku2).toBeNull();
    const set = new Set(cands2.map((c) => c.sku));
    expect(set.has("ROS1") && set.has("ROS2")).toBe(true);
  });
  it("two close products are check with both", () => {
    const ln = run([req("item", { product: "prosecco", qty: 2, unit: "cs" })], []).lines[0];
    expect(ln.state).toBe("check");
    expect(ln.sku).toBeNull();
    expect(new Set(ln.candidates.slice(0, 2).map((c) => c.sku))).toEqual(new Set(["PRO1", "PRO2"]));
    expect(kinds(ln.flags)).toContain("ambiguous_product");
  });
  it("unknown product", () => {
    const ln = run([req("item", { product: "birra artigianale nuova", qty: 3, unit: "cs" })]).lines[0];
    expect(ln.state).toBe("flag");
    expect(ln.candidates).toEqual([]);
    expect(ln.flags[0].kind).toBe("unknown_product");
  });
  it("invalid sku guess is ignored", () => {
    const [sku, , ignored] = match("acqua naturale", "NOPE", CATALOG, HISTORY);
    expect(sku).toBe("NAT1");
    expect(ignored).toBe(true);
  });
  it("valid sku guess adds score", () => {
    const plain = match("prosecco", null, CATALOG, [])[1];
    const guessed = match("prosecco", "PRO2", CATALOG, [])[1];
    expect(guessed[0].sku).toBe("PRO2");
    expect(guessed[0].score).toBeGreaterThan(plain[0].score);
  });
});

describe("usual, remove, add/set", () => {
  it("usual inserted", () => {
    const r = run([req("usual", { quote: "il solito" })]);
    expect(new Set(r.lines.map((l) => l.sku))).toEqual(new Set(["ROS1", "NAT1", "FRI1"]));
    expect(r.lines.every((l) => l.origin === "usual" && l.state === "ok")).toBe(true);
  });
  it("remove from usual", () => {
    const r = run([req("usual", { quote: "il solito" }), req("remove", { product: "acqua frizzante", quote: "niente frizzante" })]);
    const states = Object.fromEntries(r.lines.map((l) => [l.sku, l.state]));
    expect(states.FRI1).toBeUndefined();
    expect(states.ROS1).toBe("ok");
  });
  it("remove not in order", () => {
    const r = run([req("remove", { product: "prosciutto", quote: "senza prosciutto" })]);
    expect(kinds(r.flags)).toEqual(["not_in_order"]);
    expect(r.flags[0].severity).toBe("info");
  });
  it("add and set on a usual line", () => {
    let r = run([req("usual", { quote: "il solito" }),
      req("item", { product: "rosso colline", qty: 2, unit: "cs", op: "add", quote: "+2 rosso colline" })]);
    expect(r.lines.find((l) => l.sku === "ROS1")!.qty).toBe(8);
    r = run([req("usual", { quote: "il solito" }),
      req("item", { product: "rosso colline", qty: 4, unit: "cs", op: "set", quote: "4 rosso colline" })]);
    const ln = r.lines.find((l) => l.sku === "ROS1")!;
    expect(ln.qty).toBe(4);
    expect(ln.quote).toBe("4 rosso colline");
    expect(r.lines).toHaveLength(3);
  });
  it("no history", () => {
    const r = run([req("usual", { quote: "il solito" })], hist(1));
    expect(r.lines).toEqual([]);
    expect(kinds(r.flags)).toEqual(["no_history"]);
  });
});

describe("units and quantities", () => {
  it("bottles to cases convertible", () => {
    const ln = run([req("item", { product: "acqua naturale", qty: 24, unit: "bottiglie" })]).lines[0];
    expect(ln.qty).toBe(2);
    expect(ln.state).toBe("ok");
    expect(ln.flags[0].kind).toBe("converted");
    expect(ln.flags[0].message).toContain("24 bottiglie = 2 cases");
  });
  it("bottles not convertible is pack_mismatch", () => {
    const ln = run([req("item", { product: "acqua naturale", qty: 10, unit: "bottiglie" })]).lines[0];
    expect(ln.qty).toBe(10);
    expect(ln.state).toBe("flag");
    expect(kinds(ln.flags)).toContain("pack_mismatch");
    expect(ln.flags[0].message).toBe("10 bottiglie of a product sold in case of 12 × 1 L.");
  });
  it("case unit on piece product is check", () => {
    const ln = run([req("item", { product: "olio", qty: 2, unit: "casse" })]).lines[0];
    expect(ln.state).toBe("check");
    expect(ln.flags[0].kind).toBe("pack_mismatch");
  });
  it("quantity missing", () => {
    const ln = run([req("item", { product: "acqua naturale", qty: null })]).lines[0];
    expect(ln.state).toBe("check");
    expect(ln.flags[0].kind).toBe("quantity_missing");
  });
  it("unusual quantity", () => {
    const ln = run([req("item", { product: "acqua naturale", qty: 60, unit: "cs" })]).lines[0];
    expect(ln.state).toBe("flag");
    expect(ln.flags[0].kind).toBe("unusual_quantity");
    expect(ln.flags[0].message).toBe("60 is far from this customer's usual 5 for Fonte Brivio naturale 1L.");
  });
  it("unusual low quantity only for set", () => {
    let r = run([req("item", { product: "acqua naturale", qty: 0.5, unit: "cs", op: "set" })]);
    expect(r.lines[0].flags[0].kind).toBe("unusual_quantity");
    r = run([req("usual", { quote: "il solito" }), req("item", { product: "acqua naturale", qty: 0.5, unit: "cs", op: "add" })]);
    expect(r.lines.flatMap((l) => l.flags).some((f) => f.kind === "unusual_quantity")).toBe(false);
  });
  it("illegible line is check", () => {
    const ln = run([req("item", { product: "rosso colline", qty: 2, unit: "cs", quote: "2 cs rosso [?]" })]).lines[0];
    expect(ln.state).toBe("check");
    expect(kinds(ln.flags)).toContain("illegible");
  });
  it("a person's edit settles an illegible line", () => {
    const ln = run([req("item", { product: "rosso colline", qty: 2, unit: "cs", quote: "2 cs rosso [?]" })]).lines[0];
    expect(ln.state).toBe("check");
    const edited = R.recomputeLine({ ...ln, sku: "ROS1" }, Object.fromEntries(CATALOG.map((p) => [p.sku, p])), HISTORY);
    expect(edited.state).toBe("ok");
    expect(kinds(edited.flags)).not.toContain("illegible");
  });
});

describe("terms and delivery", () => {
  it("discount beyond / equal / none", () => {
    const f = run([req("discount_request", { value: "8%", quote: "col solito 8%" })]).flags;
    expect(kinds(f)).toEqual(["discount_beyond_terms"]);
    expect(f[0].message).toBe("The customer asks for 8%; the agreed discount is 5%.");
    expect(kinds(run([req("discount_request", { value: "5%" })]).flags)).toEqual(["discount_as_agreed"]);
    const none = { ...CUSTOMER, terms: { ...TERMS, discount_pct: 0 } };
    const f2 = run([req("discount_request", { value: "3%" })], HISTORY, none).flags;
    expect(f2[0].kind).toBe("discount_beyond_terms");
    expect(f2[0].message).toContain("none");
  });
  it("price below terms with override and discount", () => {
    let f = run([req("price_request", { product: "olio", value: "7 euro", quote: "l'olio a 7 euro" })]).flags;
    expect(kinds(f)).toEqual(["price_below_terms"]);
    expect(f[0].message).toContain("€7.00");
    expect(f[0].message).toContain("€7.50");
    f = run([req("price_request", { product: "prosciutto", value: "22 euro" })]).flags;
    expect(kinds(f)).toEqual(["price_below_terms"]);
    expect(f[0].message).toContain("€22.80");
    expect(run([req("price_request", { product: "prosciutto", value: "23 euro" })]).flags).toEqual([]);
  });
  it("unit price", () => {
    expect(unitPrice(CATALOG[7], TERMS)).toBe(7.5);
    expect(unitPrice(CATALOG[8], TERMS)).toBe(22.8);
  });
  it("delivery date and in the past", () => {
    let r = run([req("delivery", { value: "2026-10-23", quote: "per venerdi" })]);
    expect(r.delivery_date).toBe("2026-10-23");
    expect(r.flags).toEqual([]);
    r = run([req("delivery", { value: "2026-10-10" }), req("delivery", { value: "2026-10-12" })]);
    expect(r.delivery_date).toBe("2026-10-12");
    expect(kinds(r.flags)).toEqual(["delivery_in_past"]);
  });
});

describe("clean and search", () => {
  it("clean order", () => {
    let r = run([req("usual", { quote: "il solito" })]);
    expect(isClean(r.lines, r.flags)).toBe(true);
    r = run([req("usual", { quote: "il solito" }), req("discount_request", { value: "8%" })]);
    expect(isClean(r.lines, r.flags)).toBe(false);
    r = run([req("remove", { product: "prosciutto" })]);
    expect(isClean(r.lines, r.flags)).toBe(true);
  });
  it("catalog search", () => {
    expect(searchCatalog("prosecco", CATALOG).slice(0, 3).map((p) => p.sku)).toContain("PRO1");
    expect(searchCatalog("", CATALOG)).toHaveLength(CATALOG.length);
  });
});

// ---- parity with the Python oracle goldens ----
const DATA = join(import.meta.dirname, "..", "data");
const json = (p: string) => JSON.parse(readFileSync(join(DATA, p), "utf8"));
// the app reads the catalogue ordered by sku (ties in scores keep that order)
const realCatalog: Product[] = (json("catalog.json") as Product[]).sort((a, b) => (a.sku < b.sku ? -1 : 1));

function approx(actual: unknown, expected: unknown, path = ""): void {
  if (typeof expected === "number") {
    expect(actual, path).toBeCloseTo(expected, 3);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, i) => approx((actual as unknown[])[i], e, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) approx((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
  } else expect(actual, path).toEqual(expected);
}

describe("golden parity", () => {
  it("tokens and norm", () => {
    for (const c of golden("python-unit/tokens_norm.json") as { in: string; tokens: string[]; norm: string }[]) {
      expect(R.tokens(c.in)).toEqual(c.tokens);
      expect(R.norm(c.in)).toBe(c.norm);
    }
  });
  it("similarity", () => {
    for (const c of golden("python-unit/similarity.json") as { text: string; scores: Record<string, number> }[]) {
      for (const p of realCatalog) expect(R.similarity(R.norm(c.text), p), `${c.text} ${p.sku}`).toBeCloseTo(c.scores[p.sku], 3);
    }
  });
  it("match", () => {
    for (const c of golden("python-unit/match.json") as
      { customer: string; text: string; guess: string | null; sku: string | null; candidates: unknown[]; guess_ignored: boolean }[]) {
      const [sku, cands, ign] = match(c.text, c.guess, realCatalog, json(`history/${c.customer}.json`));
      expect(sku, c.text).toBe(c.sku);
      approx(cands, c.candidates, c.text);
      expect(ign).toBe(c.guess_ignored);
    }
  });
  it("search_catalog", () => {
    const g = golden("python-unit/search_catalog.json") as Record<string, string[]>;
    for (const [q, skus] of Object.entries(g)) expect(searchCatalog(q, realCatalog).map((p) => p.sku), q).toEqual(skus);
  });
  it("unit_price", () => {
    const g = golden("python-unit/unit_price.json") as Record<string, Record<string, number>>;
    for (const [cust, prices] of Object.entries(g)) {
      const terms = json(`customers/${cust}.json`).terms;
      for (const p of realCatalog) expect(unitPrice(p, terms), `${cust} ${p.sku}`).toBeCloseTo(prices[p.sku], 2);
    }
  });
  it("resolve on the mock readings of all 20 messages", () => {
    const g = golden("python-unit/resolve_mock.json") as Record<string, { verified: VerifiedRequest[]; result: unknown }>;
    for (const [id, c] of Object.entries(g)) {
      const msg = json(`messages/${id}.json`);
      const out = resolve(c.verified, realCatalog, json(`customers/${msg.customer_id}.json`),
        json(`history/${msg.customer_id}.json`), msg.received_at.slice(0, 10));
      approx(JSON.parse(JSON.stringify(out)), c.result, id);
    }
  });
});

describe("model guess never settles a doubt", () => {
  it("keeps two close products in check even when the model names one", () => {
    const catalog = [
      { sku: "P1", name: "Prosecco Valdoro DOC 75cl", aliases: ["prosecco"], category: "wine", sell_unit: "case" as const, pack_size: 6, pack_label: "case of 6", list_price: 40 },
      { sku: "P2", name: "Prosecco Colfondo DOC 75cl", aliases: ["prosecco"], category: "wine", sell_unit: "case" as const, pack_size: 6, pack_label: "case of 6", list_price: 42 },
    ];
    const [sku, cands] = match("prosecco", "P2", catalog, []);
    expect(sku).toBeNull();
    expect(cands.map((c) => c.sku).sort()).toEqual(["P1", "P2"]);
  });
});
