// Resolution: verified requests -> lines and flags (SPEC §13). Pure: no database, no network.
import { computeUsual, lastOrders, median } from "./usual.ts";
import { parsePercent, relativeDate } from "./verify.ts";
import type {
  Candidate, Customer, DraftLine, Flag, FlagKind, HistoryOrder, LineState, Product, ResolveResult, Terms,
  VerifiedRequest,
} from "./types.ts";

const STOP_WORDS = new Set(["di", "del", "della", "quello", "quella", "il", "la", "le", "i", "gli", "da", "the", "of",
  "dell", "dello", "dei", "degli", "delle", "altra", "volta", "solito", "sempre", "quel", "e", "un", "una"]);
const COLOUR = new Set(["rosso", "bianco", "rosato"]);
const FIZZ_GROUP: Record<string, string> = {
  frizzante: "fizz", friz: "fizz", gasata: "fizz", naturale: "still", liscia: "still",
};
const FORMAT_RE = /^(?:\d+(?:[.,]\d+)?(?:cl|l|lt|ml|kg|g)|\d[.,]\d+)$/;
const CHECK_KINDS = new Set<string>(["ambiguous_product", "illegible", "quantity_missing"]);
const LINE_QTY_KINDS = new Set<string>(["unknown_product", "ambiguous_product", "pack_mismatch", "quantity_missing",
  "unusual_quantity", "converted"]);

const FLAG_TABLE: Record<FlagKind, [Flag["level"], Flag["severity"], string]> = {
  unknown_product: ["line", "high", "No product in the catalogue matches «{product_text}»."],
  ambiguous_product: ["line", "medium", "«{product_text}» could be {candidates}."],
  illegible: ["line", "medium", "Part of this line could not be read in the photo."],
  quantity_missing: ["line", "medium", "No quantity for «{product_text}»."],
  pack_mismatch: ["line", "medium", "{qty} {unit_text} of a product sold in {pack_label}."],
  unusual_quantity: ["line", "medium", "{qty} is far from this customer's usual {usual_qty} for {name}."],
  discount_beyond_terms: ["order", "high", "The customer asks for {asked}; the agreed discount is {agreed}."],
  price_below_terms: ["order", "high", "The customer expects {asked} for {name}; the agreed price is {agreed}."],
  delivery_in_past: ["order", "medium", "The delivery date {date} is before the message."],
  no_history: ["order", "medium", "No order history: «the usual» cannot be computed."],
  not_in_order: ["order", "info", "The customer asked to remove {product_text}; it was not in the order."],
  discount_as_agreed: ["order", "info", "The customer mentions {asked}, as agreed."],
  suggested: ["line", "info", "Suggested by the forecast model"],
  converted: ["line", "info", "{orig_qty} {unit_text} = {qty} cases ({pack_label})."],
};

export function makeFlag(kind: FlagKind, kw: Record<string, string> = {}): Flag {
  const [level, severity, tpl] = FLAG_TABLE[kind];
  return { kind, level, severity, message: tpl.replace(/\{(\w+)\}/g, (_, k: string) => kw[k] ?? "") };
}

/** Python's f"{x:g}" for the magnitudes we see (6 significant digits, no trailing zeros). */
export function g(x: number): string {
  return String(Number(x.toPrecision(6)));
}

// toFixed rounds the exact binary value, like Python's round(); only exact ties differ (half-even there).
const round = (x: number, d: number): number => Number(x.toFixed(d));

// ---- difflib.SequenceMatcher.ratio (no junk heuristics) --------------------

function longestMatch(a: string[], b2j: Map<string, number[]>, alo: number, ahi: number, blo: number, bhi: number) {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
    }
    j2len = newj2len;
  }
  return { i: besti, j: bestj, size: bestsize };
}

export function ratio(sa: string, sb: string): number {
  const a = Array.from(sa), b = Array.from(sb);
  if (a.length + b.length === 0) return 1;
  const b2j = new Map<string, number[]>();
  b.forEach((c, j) => { const l = b2j.get(c); if (l) l.push(j); else b2j.set(c, [j]); });
  let matched = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const m = longestMatch(a, b2j, alo, ahi, blo, bhi);
    if (!m.size) continue;
    matched += m.size;
    if (alo < m.i && blo < m.j) queue.push([alo, m.i, blo, m.j]);
    if (m.i + m.size < ahi && m.j + m.size < bhi) queue.push([m.i + m.size, ahi, m.j + m.size, bhi]);
  }
  return (2 * matched) / (a.length + b.length);
}

// ---- matching (13.1) -------------------------------------------------------

export function tokens(text: string): string[] {
  let s = text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  s = s.replace(/(\d)\s+(cl|l|lt|ml|kg|g)\b/g, "$1$2");
  return s.match(/\d+(?:[.,]\d+)?[a-z]*|[a-z]+/g) ?? [];
}

export function norm(text: string): string {
  return tokens(text).filter((t) => !STOP_WORDS.has(t)).join(" ");
}

const sumLen = (ts: string[]) => ts.reduce((n, t) => n + Array.from(t).length, 0);

/** Dice-style overlap where a text token counts for a label token it nearly equals (typos). */
export function tokenSim(ttoks: string[], ltoks: string[]): number {
  if (!ttoks.length || !ltoks.length) return 0;
  let matched = 0;
  for (const t of ttoks) {
    const r = Math.max(...ltoks.map((w) => ratio(t, w)));
    if (r >= 0.75) matched += Array.from(t).length * r;
  }
  return (2 * matched) / (sumLen(ttoks) + sumLen(ltoks));
}

export function similarity(textNorm: string, product: Product): number {
  // ponytail: whole-string difflib matched random letters in long texts; token overlap first, whole-string
  // ratio only for near-identical spellings. Embeddings if the eval shows misses.
  let best = 0;
  const ttoks = textNorm.split(/\s+/).filter(Boolean);
  for (const label of [product.name, ...(product.aliases ?? [])]) {
    const ln = norm(label);
    const ltoks = ln.split(/\s+/).filter(Boolean);
    let r = tokenSim(ttoks, ltoks);
    const whole = ratio(textNorm, ln);
    if (whole >= 0.8) r = Math.max(r, whole);
    if (ttoks.length && ttoks.every((t) => ltoks.includes(t))) {
      r = Math.max(r, 0.55 + 0.25 * Math.sqrt(ttoks.length / Math.max(1, ltoks.length)));
    }
    best = Math.max(best, r);
  }
  return best;
}

function wordsOf(product: Product): Set<string> {
  const out = new Set<string>();
  for (const label of [product.name, ...(product.aliases ?? [])]) {
    for (const t of tokens(label)) out.add(t.replace(/,/g, "."));
  }
  return out;
}

/** +0.1 when a colour, fizz or format word of the text is in the product, -0.2 when one contradicts it. */
export function attributeAdjust(ttoks: string[], product: Product): number {
  const pw = wordsOf(product);
  const pwList = [...pw];
  let plus = false, minus = false;
  for (const raw of ttoks) {
    const t = raw.replace(/,/g, ".");
    if (COLOUR.has(t)) {
      plus = plus || pw.has(t);
      minus = minus || (!pw.has(t) && pwList.some((w) => COLOUR.has(w)));
    } else if (t in FIZZ_GROUP) {
      const grp = new Set(pwList.filter((w) => w in FIZZ_GROUP).map((w) => FIZZ_GROUP[w]));
      plus = plus || grp.has(FIZZ_GROUP[t]);
      minus = minus || (!grp.has(FIZZ_GROUP[t]) && grp.size > 0);
    } else if (FORMAT_RE.test(t)) {
      const fmts = pwList.filter((w) => FORMAT_RE.test(w));
      const hit = fmts.some((w) => w.startsWith(t) || t.startsWith(w));
      plus = plus || hit;
      minus = minus || (fmts.length > 0 && !hit);
    }
  }
  return (plus ? 0.1 : 0) - (minus ? 0.2 : 0);
}

export function historyCounts(history: HistoryOrder[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of lastOrders(history)) {
    for (const sku of new Set(o.lines.map((l) => l.sku))) counts[sku] = (counts[sku] ?? 0) + 1;
  }
  return counts;
}

export function scoreAll(text: string, catalog: Product[], counts: Record<string, number>, guess?: string | null):
  [number, Product][] {
  const tn = norm(text);
  const ttoks = tokens(text);
  const out: [number, Product][] = catalog.map((p) => {
    const base = similarity(tn, p);
    let s = base + attributeAdjust(ttoks, p);
    if (counts[p.sku] && base >= 0.4) s += 0.15; // history breaks ties, it does not create candidates
    if (guess && p.sku === guess) s += 0.1;
    return [s, p];
  });
  return out.sort((x, y) => y[0] - x[0]); // stable, like Python's sorted
}

/** -> [sku | null, candidates, guessIgnored] */
export function match(productText: string, skuGuess: string | null, catalog: Product[], history: HistoryOrder[]):
  [string | null, Candidate[], boolean] {
  const skus = new Set(catalog.map((p) => p.sku));
  const ignored = !!skuGuess && !skus.has(skuGuess);
  const counts = historyCounts(history);
  const nOrders = lastOrders(history).length;
  const ranked = scoreAll(productText, catalog, counts, ignored ? null : skuGuess);
  const cands: Candidate[] = [];
  for (const [s, p] of ranked.slice(0, 3)) {
    if (s < 0.4) continue;
    let why = counts[p.sku] ? `in their last ${counts[p.sku]} orders` : "name match";
    if (counts[p.sku] === 1 && nOrders) why = nOrders === 1 ? "in their last order" : "in 1 of their last orders";
    cands.push({ sku: p.sku, score: round(s, 3), why });
  }
  // Certainty is judged without the model's guess: a guess may raise a doubt (it disagrees), never settle one.
  const plain = scoreAll(productText, catalog, counts, null).filter(([s]) => s >= 0.4);
  const guess = ignored ? null : skuGuess;
  const certain = plain.length > 0 && plain[0][0] >= 0.75 &&
    (plain.length === 1 || plain[0][0] - plain[1][0] >= 0.15) &&
    (!guess || guess === plain[0][1].sku);
  return [certain ? plain[0][1].sku : null, cands, ignored];
}

export function searchCatalog(q: string, catalog: Product[], limit = 20): Product[] {
  if (!q.trim()) return [...catalog].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit);
  const ranked = scoreAll(q, catalog, {});
  const qn = q.trim().toLowerCase();
  return ranked.filter(([s, p]) => s >= 0.4 || p.name.toLowerCase().includes(qn)).map(([, p]) => p).slice(0, limit);
}

// ---- terms and prices ------------------------------------------------------

export function unitPrice(product: Product, terms: Partial<Terms>): number {
  const override = terms.price_overrides?.[product.sku];
  if (override !== undefined && override !== null) return Number(override);
  return round(product.list_price * (1 - (terms.discount_pct || 0) / 100), 2);
}

export function termsFlags(req: VerifiedRequest, catalog: Product[], terms: Partial<Terms>, history: HistoryOrder[]):
  Flag[] {
  if (req.kind === "discount_request") {
    const asked = parsePercent(req.value), agreed = terms.discount_pct || 0;
    if (asked === null) return [];
    if (asked > agreed) {
      return [makeFlag("discount_beyond_terms", { asked: g(asked) + "%", agreed: agreed ? g(agreed) + "%" : "none" })];
    }
    if (asked === agreed) return [makeFlag("discount_as_agreed", { asked: g(asked) + "%" })];
    return [];
  }
  const asked = parsePercent(req.value);
  const text = req.product || req.quote;
  const [sku, cands] = match(text, req.sku, catalog, history);
  const top = sku ?? (cands.length && cands[0].score >= 0.6 ? cands[0].sku : null);
  if (asked === null || top === null) return [];
  const p = catalog.find((x) => x.sku === top)!;
  const expected = unitPrice(p, terms);
  if (asked < expected * 0.99) {
    return [makeFlag("price_below_terms", { asked: `€${asked.toFixed(2)}`, name: p.name, agreed: `€${expected.toFixed(2)}` })];
  }
  return [];
}

// ---- lines (13.3, 13.4) ----------------------------------------------------

/** A draft line plus the working fields that never leave this module. */
type WorkLine = DraftLine & { _unit_flags: Flag[]; _set: boolean };

function newLine(origin: DraftLine["origin"], productText: string, req: VerifiedRequest, sku: string | null = null,
  qty: number | null = null, candidates: Candidate[] = []): WorkLine {
  return {
    pos: 0, origin, product_text: productText, sku, qty, unit_text: req.unit_text ?? null, state: "ok",
    candidates: [...candidates], flags: [], quote: req.quote, quote_start: req.quote_start, quote_end: req.quote_end,
    proposed_sku: sku, proposed_qty: qty, edited: 0, _unit_flags: [], _set: false,
  };
}

/** Convert pieces to cases or flag a mismatch. Returns the effective qty. */
function applyUnits(line: WorkLine, req: VerifiedRequest, product: Product | undefined): number | null {
  const qty = line.qty, unit = req.unit;
  line._unit_flags = [];
  if (qty === null || qty <= 0 || !product) return qty;
  if (product.sell_unit === "case" && unit === "piece") {
    const size = product.pack_size;
    if (size > 1 && qty % size === 0) {
      const cases = qty / size;
      line._unit_flags.push(makeFlag("converted", {
        orig_qty: g(qty), unit_text: req.unit_text || "pieces", qty: g(cases), pack_label: product.pack_label,
      }));
      return cases;
    }
    line._unit_flags.push(makeFlag("pack_mismatch", {
      qty: g(qty), unit_text: req.unit_text || "pieces", pack_label: product.pack_label,
    }));
  } else if ((product.sell_unit === "piece" || product.sell_unit === "kg") && unit === "case") {
    const f = makeFlag("pack_mismatch", { qty: g(qty), unit_text: req.unit_text || "cases", pack_label: product.pack_label });
    f.check = true;
    line._unit_flags.push(f);
  }
  return qty;
}

const historyQtys = (history: HistoryOrder[], sku: string): number[] =>
  history.flatMap((o) => o.lines.filter((l) => l.sku === sku).map((l) => l.qty));


/** quantity_missing and unusual_quantity for a line with a known sku/qty. */
function quantityFlags(line: { qty: number | null; sku: string | null; product_text: string; _set?: boolean },
  product: Product | undefined, history: HistoryOrder[], usualQty: number | undefined): Flag[] {
  const qty = line.qty;
  if (qty === null || qty <= 0) return [makeFlag("quantity_missing", { product_text: line.product_text })];
  const past = line.sku ? historyQtys(history, line.sku) : [];
  if (past.length) {
    const hi = Math.max(...past);
    if (qty > 3 * hi || (line._set && qty < hi / 5)) {
      const usual = usualQty ?? median(past);
      return [makeFlag("unusual_quantity", { qty: g(qty), usual_qty: g(usual), name: product!.name })];
    }
  }
  return [];
}

export function lineState(flags: Flag[]): LineState {
  if (flags.some((f) => CHECK_KINDS.has(f.kind) || f.check)) return "check";
  return flags.some((f) => f.severity === "high" || f.severity === "medium") ? "flag" : "ok";
}

const joinOr = (items: string[]): string =>
  items.length === 1 ? items[0] : items.slice(0, -1).join(", ") + " or " + items[items.length - 1];

function matchFlags(line: WorkLine, names: Record<string, string>): Flag[] {
  if (line.sku !== null) return [];
  if (!line.candidates.length) return [makeFlag("unknown_product", { product_text: line.product_text })];
  return [makeFlag("ambiguous_product", {
    product_text: line.product_text, candidates: joinOr(line.candidates.map((c) => names[c.sku])),
  })];
}

function finishLine(line: WorkLine, products: Record<string, Product>, history: HistoryOrder[],
  usualQtys: Record<string, number>): DraftLine {
  const product = line.sku ? products[line.sku] : undefined;
  const names = Object.fromEntries(Object.entries(products).map(([s, p]) => [s, p.name]));
  const flags = [...line._unit_flags, ...matchFlags(line, names)];
  if (line.quote.includes("[?]")) flags.push(makeFlag("illegible"));
  if (line.sku !== null) flags.push(...quantityFlags(line, product, history, usualQtys[line.sku]));
  line.flags = flags;
  line.state = lineState(flags);
  return strip(line);
}

function strip(line: WorkLine | DraftLine): DraftLine {
  const { _unit_flags, _set, ...rest } = line as WorkLine;
  void _unit_flags; void _set;
  return rest;
}

/** After a person's edit: the sku is certain, units are already sell units. */
export function recomputeLine<T extends DraftLine>(line: T, products: Record<string, Product>, history: HistoryOrder[]): T {
  // a person's sku is never check (SPEC §14): choosing it also settles what could not be read
  const keep = line.flags.filter((f) => !LINE_QTY_KINDS.has(f.kind) && f.kind !== "illegible");
  if (line.state === "removed") return line;
  const usual = Object.fromEntries(computeUsual(history, products).map((u) => [u.sku, u.qty]));
  const probe = { ...line, _set: line.origin === "message" };
  const flags = [...keep, ...quantityFlags(probe, products[line.sku!], history, usual[line.sku!])];
  return { ...line, flags, state: lineState(flags) };
}

// ---- the whole resolution --------------------------------------------------

function findLine(lines: WorkLine[], sku: string): WorkLine | undefined {
  return lines.find((l) => l.sku === sku && l.state !== "removed");
}

function doUsual(req: VerifiedRequest, lines: WorkLine[], products: Record<string, Product>, history: HistoryOrder[]) {
  for (const u of computeUsual(history, products)) {
    if (findLine(lines, u.sku)) continue;
    const ln = newLine("usual", products[u.sku].name, req, u.sku, u.qty);
    ln.unit_text = null;
    lines.push(ln);
  }
}

function doRemove(req: VerifiedRequest, lines: WorkLine[], products: Record<string, Product>): Flag | null {
  const live = lines.filter((l) => l.sku && l.state !== "removed").map((l) => products[l.sku!]);
  const text = req.product || req.quote;
  // the customer's order is the result: matched lines leave the draft instead of showing struck through,
  // and "senza prosciutto" drops every prosciutto, not just the closest one
  const hits = scoreAll(text, live, {}).filter(([s]) => s >= 0.5);
  if (hits.length) {
    for (const [, p] of hits) lines.splice(lines.indexOf(findLine(lines, p.sku)!), 1);
    return null;
  }
  return makeFlag("not_in_order", { product_text: text });
}

function doItem(req: VerifiedRequest, lines: WorkLine[], catalog: Product[], products: Record<string, Product>,
  history: HistoryOrder[]) {
  const text = req.product || req.quote;
  const [sku, cands] = match(text, req.sku, catalog, history);
  const ln = newLine("message", text, req, sku, req.qty, cands);
  ln._set = req.op !== "add";
  ln.qty = applyUnits(ln, req, sku ? products[sku] : undefined);
  ln.proposed_qty = ln.qty;
  const existing = sku ? findLine(lines, sku) : undefined;
  if (!existing) lines.push(ln);
  else if (req.op === "add") {
    existing.qty = (existing.qty || 0) + (ln.qty || 0);
    existing.proposed_qty = existing.qty;
    existing._unit_flags = ln._unit_flags.length ? ln._unit_flags : existing._unit_flags;
  } else lines[lines.indexOf(existing)] = ln;
}

/** requests are verified, in reading order. */
export function resolve(requests: VerifiedRequest[], catalog: Product[], customer: Pick<Customer, "terms">,
  history: HistoryOrder[], messageDate: string): ResolveResult {
  const products = Object.fromEntries(catalog.map((p) => [p.sku, p]));
  const terms = customer.terms ?? {};
  const lines: WorkLine[] = [];
  const flags: Flag[] = [];
  let delivery: string | null = null;
  for (const req of requests) {
    if (req.kind === "usual") {
      if (history.length < 2) flags.push(makeFlag("no_history"));
      doUsual(req, lines, products, history);
    } else if (req.kind === "remove") {
      const f = doRemove(req, lines, products);
      if (f) flags.push(f);
    } else if (req.kind === "item") doItem(req, lines, catalog, products, history);
    else if (req.kind === "delivery") {
      const date = relativeDate(req.quote, messageDate) ?? req.date; // code resolves "venerdì", the model only as fallback
      if (date) delivery = date;
    } else flags.push(...termsFlags(req, catalog, terms, history));
  }
  if (delivery && delivery < messageDate) flags.push(makeFlag("delivery_in_past", { date: delivery }));
  const usualQtys = Object.fromEntries(computeUsual(history, products).map((u) => [u.sku, u.qty]));
  const out = lines.map((ln, i) => {
    const fin = ln.state === "removed" ? strip(ln) : finishLine(ln, products, history, usualQtys);
    fin.pos = i;
    return fin;
  });
  return { lines: out, flags: dedupe(flags), delivery_date: delivery };
}

function dedupe(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  const out = flags.filter((f) => {
    const k = f.kind + "\u0000" + f.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function isClean(lines: { state: LineState }[], flags: Flag[]): boolean {
  return !lines.some((l) => l.state === "check" || l.state === "flag") &&
    !flags.some((f) => f.severity === "high" || f.severity === "medium");
}
