// Scoring of one read message against data/expected.json (SPEC §18). Pure: no I/O, no model.
import type { Candidate, LineState } from "../src/types.ts";
import { g } from "../src/resolve.ts";

const INFO = "info";
type ScoreFlag = { kind: string; severity: string };

export interface ExpectedMessage {
  order: boolean;
  lines: { sku: string; qty: number }[];
  removed?: string[];
  delivery_date?: string | null;
  candidates?: { text_contains: string; skus: string[] }[];
  flags?: { kind: string }[];
  quotes?: string[];
}

/** The slice of an order_view result the matcher reads (types.ts Order satisfies it). */
export interface ScoreLine {
  sku: string | null;
  qty: number | null;
  state: LineState | string;
  flags: ScoreFlag[];
  product_text?: string | null;
  quote?: string | null;
  quote_start: number;
  quote_end: number;
  candidates: Pick<Candidate, "sku">[];
}
export interface ScoreOrder {
  lines: ScoreLine[];
  flags: ScoreFlag[];
  delivery_date: string | null;
  reading: string;
}

export interface MessageScore {
  channel: string;
  is_order: boolean;
  read_failed: boolean;
  produced: number;
  matched: number;
  expected_lines: number;
  skipped: number;
  cand_total: number;
  cand_hit: number;
  flags_expected: number;
  flags_found: number;
  false_flags: string[];
  non_order_lines: number;
  non_order_flags: number;
  unverified: number;
  order_right: boolean;
  misses: string[];
  extras: string[];
  id?: string;
  run?: number;
}

// Python's {x:g}: up to 6 significant digits, no trailing zeros.
const text = (ln: ScoreLine): string => `${ln.product_text || ""} ${ln.quote || ""}`.toLowerCase();

function covered(ln: ScoreLine, exp: ExpectedMessage): string | null {
  const t = text(ln);
  for (const c of exp.candidates ?? []) if (t.includes(c.text_contains.toLowerCase())) return "candidates";
  const wantsUnknown = (exp.flags ?? []).some((f) => f.kind === "unknown_product");
  if (wantsUnknown && ln.flags.some((f) => f.kind === "unknown_product")) return "unknown";
  return null;
}

const allFlags = (o: ScoreOrder) => [...(o.flags ?? []), ...o.lines.flatMap((ln) => ln.flags ?? [])];

export function scoreMessage(exp: ExpectedMessage, order: ScoreOrder | null, channel = ""): MessageScore {
  const r: MessageScore = {
    channel, is_order: !!exp.order, read_failed: order === null, produced: 0, matched: 0,
    expected_lines: exp.lines.length, skipped: 0, cand_total: 0, cand_hit: 0, flags_expected: 0, flags_found: 0,
    false_flags: [], non_order_lines: 0, non_order_flags: 0, unverified: 0, order_right: false, misses: [], extras: [],
  };
  if (order === null) {
    r.misses = exp.lines.map((x) => `${x.sku} x${g(x.qty)}`);
    return r;
  }
  const lines = order.lines;
  const live = lines.filter((ln) => ln.state !== "removed");
  r.unverified = lines.filter((ln) => order.reading.slice(ln.quote_start, ln.quote_end) !== ln.quote).length;

  if (!exp.order) {
    r.non_order_lines = lines.length;
    r.non_order_flags = allFlags(order).length;
    r.order_right = !lines.length && !allFlags(order).length;
    return r;
  }

  // line match: sku and qty equal, one to one
  const produced: [string | null, number | null][] = [];
  for (const ln of live) {
    const sku = ln.sku || (ln.candidates.length ? ln.candidates[0].sku : null);
    if (!ln.sku && covered(ln, exp)) {
      r.skipped++;
      continue;
    }
    produced.push([sku, ln.qty]);
  }
  const left: [string | null, number | null][] = exp.lines.map((x) => [x.sku, x.qty]);
  const extras: [string | null, number | null][] = [];
  for (const p of produced) {
    const i = left.findIndex((l) => l[0] === p[0] && l[1] === p[1]);
    if (i >= 0) {
      left.splice(i, 1);
      r.matched++;
    } else extras.push(p);
  }
  r.produced = produced.length;
  r.misses = left.map(([s, q]) => `${s} x${g(q as number)}`);
  r.extras = extras.map(([s, q]) => (q !== null ? `${s} x${g(q)}` : String(s)));

  // candidate hit: expected skus are among the candidates (or own sku) of a line that names the product
  for (const c of exp.candidates ?? []) {
    r.cand_total++;
    const pool = new Set<string>();
    for (const ln of live) {
      if (!text(ln).includes(c.text_contains.toLowerCase())) continue;
      ln.candidates.forEach((x) => pool.add(x.sku));
      if (ln.sku) pool.add(ln.sku);
    }
    if (c.skus.every((s) => pool.has(s))) r.cand_hit++;
  }

  // flags
  const kinds = new Set((exp.flags ?? []).map((f) => f.kind));
  const found = new Set(allFlags(order).map((f) => f.kind));
  r.flags_expected = kinds.size;
  r.flags_found = [...kinds].filter((k) => found.has(k)).length;
  r.false_flags = [...new Set(allFlags(order).filter((f) => f.severity !== INFO && !kinds.has(f.kind)).map((f) => f.kind))].sort();

  const removed = new Set(lines.filter((ln) => ln.state === "removed" && ln.sku).map((ln) => ln.sku as string));
  const wantRemoved = new Set(exp.removed ?? []);
  const removedOk = removed.size === wantRemoved.size && [...removed].every((s) => wantRemoved.has(s));
  r.order_right = !left.length && !extras.length && removedOk && order.delivery_date === (exp.delivery_date ?? null);
  return r;
}

const rate = (a: number, b: number): number | null => (b ? Math.round((a / b) * 1000) / 1000 : null);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Sum scoreMessage results into rates. Rates are null when the denominator is 0. */
export function summarize(results: MessageScore[]) {
  const orders = results.filter((x) => x.is_order);
  const produced = sum(orders.map((x) => x.produced));
  const matched = sum(orders.map((x) => x.matched));
  const expLines = sum(orders.map((x) => x.expected_lines));
  return {
    messages: results.length, orders: orders.length,
    line_precision: rate(matched, produced), line_recall: rate(matched, expLines),
    lines_produced: produced, lines_matched: matched, lines_expected: expLines,
    orders_right: results.filter((x) => x.order_right).length, orders_right_of: results.length,
    candidate_hit: rate(sum(orders.map((x) => x.cand_hit)), sum(orders.map((x) => x.cand_total))),
    flags_found: sum(orders.map((x) => x.flags_found)), flags_expected: sum(orders.map((x) => x.flags_expected)),
    false_flags: sum(orders.map((x) => x.false_flags.length)),
    non_order_violations: sum(results.filter((x) => !x.is_order).map((x) => x.non_order_lines + x.non_order_flags)),
    unverified_lines: sum(results.map((x) => x.unverified)),
    read_failures: results.filter((x) => x.read_failed).length,
  };
}
