// Verification of one request against the reading (SPEC §12). Pure.
// Offsets are UTF-16 indices into the reading, so reading.slice(start, end) is the quote.
import type { DropReason, RequestKind, SellUnit, VerifiedRequest, VerifyResult } from "./types.ts";

const KINDS = new Set<string>(["item", "usual", "remove", "delivery", "discount_request", "price_request"]);
const STATUSES = new Set<string>(["observed", "inferred"]);
const CHARS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "\u00a0": " ",
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, un: 1, uno: 1, una: 1, one: 1, due: 2, two: 2, tre: 3, three: 3,
  quattro: 4, four: 4, cinque: 5, five: 5, sei: 6, six: 6, sette: 7, seven: 7,
  otto: 8, eight: 8, nove: 9, nine: 9, dieci: 10, ten: 10, undici: 11, eleven: 11,
  dodici: 12, twelve: 12, tredici: 13, thirteen: 13, quattordici: 14, fourteen: 14,
  quindici: 15, fifteen: 15, sedici: 16, sixteen: 16, diciassette: 17, seventeen: 17,
  diciotto: 18, eighteen: 18, diciannove: 19, nineteen: 19, venti: 20, twenty: 20,
  trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, cento: 100,
  mezza: 0.5, mezzo: 0.5, mezzi: 0.5, half: 0.5, "un paio": 2,
};
const UNITS: Record<SellUnit, string[]> = {
  case: ["cassa", "casse", "cs", "cartone", "cartoni", "cf", "confezione", "confezioni", "case", "cases"],
  piece: ["bottiglia", "bottiglie", "bt", "pezzi", "pezzo", "pz", "lattine", "lattina", "pieces", "piece", "bottles", "bottle"],
  kg: ["kg", "chili", "chilo", "kili", "kilo"],
};
const UNIT_MAP = new Map<string, SellUnit>(
  (Object.entries(UNITS) as [SellUnit, string[]][]).flatMap(([u, ws]) => ws.map((w) => [w, u] as const)),
);

/** Normalised text and, for each of its characters, the span [start, end) in the original. */
function normWithMap(text: string): { text: string; start: number[]; end: number[] } {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  for (const ch of text) {
    const next = i + ch.length;
    for (const c of ch.normalize("NFKC")) {
      for (let c2 of (CHARS[c] ?? c).toLowerCase().split("")) { // per UTF-16 unit, so indexes line up with indexOf
        if (/\s/.test(c2)) {
          if (out.length && out[out.length - 1] === " ") continue;
          c2 = " ";
        }
        out.push(c2);
        start.push(i);
        end.push(next);
      }
    }
    i = next;
  }
  return { text: out.join(""), start, end };
}

/** [start, end) of the quote in the reading, "short" for a quote under 3 characters, or null. */
export function locate(reading: string, quote: string): [number, number] | "short" | null {
  const nq = normWithMap(quote).text.trim();
  if ([...nq].length < 3) return "short";
  const r = normWithMap(reading);
  const at = r.text.indexOf(nq);
  if (at < 0) return null;
  // the map is per UTF-16 unit of the normalised text, so `at` and nq.length index it directly
  return [r.start[at]!, r.end[at + nq.length - 1]!];
}

export function parseQuantity(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+(?:[.,]\d+)?$/.test(s)) return parseFloat(s.replace(",", "."));
  if (Object.hasOwn(NUMBER_WORDS, s)) return NUMBER_WORDS[s]!;
  const m = /^(\d+(?:[.,]\d+)?)\b/.exec(s);
  return m ? parseFloat(m[1]!.replace(",", ".")) : null;
}

/** Weight phrasings the model reads loosely: "2 etti" -> 0.2 kg, "2 kg e mezzo" -> 2.5, "mezzo chilo" -> 0.5.
 *  Only applied when the model's qty is the bare number (or missing); otherwise it already did the arithmetic. */
export function fixWeightQty(quote: string, qty: number | null): { qty: number; unit: SellUnit } | null {
  const q = quote.toLowerCase();
  const num = (t: string) => parseQuantity(t);
  let m = /(\d+(?:[.,]\d+)?)\s*(?:etti|etto|hg)\b/.exec(q);
  if (m && qty === num(m[1]!)) return { qty: Math.round(qty! * 100) / 1000, unit: "kg" };
  m = /\b(\d+(?:[.,]\d+)?|un|uno|una)\s*(?:kg|chili|chilo)?\s+e\s+mezz[oa]\b/.exec(q);
  if (m && (qty === null || qty === num(m[1]!))) return { qty: num(m[1]!)! + 0.5, unit: "kg" };
  if (/\bmezzo\s+(?:chilo|kg)\b/.test(q) && (qty === null || qty === 0.5 || qty === 1)) return { qty: 0.5, unit: "kg" };
  if (qty === null && /\b(?:un|uno)\s+(?:chilo|kg)\b/.test(q)) return { qty: 1, unit: "kg" };
  return null;
}

export function parseUnit(raw: unknown): SellUnit | null {
  const s = String(raw || "").trim().toLowerCase().replace(/\.+$/, "");
  return UNIT_MAP.get(s) ?? null;
}

export function parseDate(raw: unknown): string | null {
  const s = String(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === s ? s : null; // rejects 2026-02-30
}

const DAY_OFFSET: Record<string, number> = { oggi: 0, today: 0, domani: 1, tomorrow: 1, dopodomani: 2 };
const WEEKDAYS: Record<string, number> = {
  domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** A relative day in the quote ("x venerdì", "per domani") resolved against the message date (YYYY-MM-DD).
 *  A weekday means its next occurrence after the message day. null when the quote names no relative day. */
export function relativeDate(quote: string, messageDate: string): string | null {
  const words = quote.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z]+/g) ?? [];
  const base = new Date(messageDate + "T00:00:00Z");
  if (Number.isNaN(base.getTime())) return null;
  let add: number | null = null;
  for (const w of words) {
    if (w in DAY_OFFSET) { add = DAY_OFFSET[w]!; break; }
    if (w in WEEKDAYS) { add = ((WEEKDAYS[w]! - base.getUTCDay() + 6) % 7) + 1; break; }
  }
  if (add === null) return null;
  base.setUTCDate(base.getUTCDate() + add);
  return base.toISOString().slice(0, 10);
}

export function parsePercent(raw: unknown): number | null {
  const m = /\d+(?:[.,]\d+)?/.exec(String(raw || ""));
  return m ? parseFloat(m[0].replace(",", ".")) : null;
}

export function parseMoney(raw: unknown): number | null {
  return parsePercent(raw); // ponytail: first number in the text; currency words ignored, parse locales if needed
}

/** observed stands only if the quantity's digits or number word occur in the quote. */
export function settleStatus(
  status: "observed" | "inferred",
  quantityRaw: unknown,
  qty: number | null,
  quote: string,
): "observed" | "inferred" {
  if (status !== "observed" || qty === null) return status;
  const toks = new Set(normWithMap(quote).text.match(/[a-zà-ÿ]+|\d+(?:[.,]\d+)?/g) ?? []);
  const raw = String(quantityRaw).trim().toLowerCase();
  const digits = String(qty); // ponytail: Python's :g, same for ordinary quantities
  return toks.has(raw) || toks.has(digits) || toks.has(digits.replace(".", ",")) ? "observed" : "inferred";
}

const drop = (reason: DropReason): VerifyResult => ({ ok: false, reason });

export function verifyRequest(reading: string, req: unknown): VerifyResult {
  if (!req || typeof req !== "object" || Array.isArray(req)) return drop("bad_kind");
  const r = req as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind) || typeof r.status !== "string"
    || !STATUSES.has(r.status) || typeof r.quote !== "string") return drop("bad_kind");
  const loc = locate(reading, r.quote);
  if (loc === "short") return drop("short_quote");
  if (loc === null) return drop("no_quote");
  const [start, end] = loc;
  const quote = reading.slice(start, end);
  const parsed = parseQuantity(r.quantity);
  const fix = r.kind === "item" ? fixWeightQty(quote, parsed) : null;
  const qty = fix ? fix.qty : parsed;
  const request: VerifiedRequest = {
    kind: r.kind as RequestKind,
    quote,
    quote_start: start,
    quote_end: end,
    product: (r.product as string) || "",
    sku: (r.sku as string) || null,
    qty,
    unit_text: (r.unit as string | null | undefined) ?? null,
    unit: fix ? fix.unit : parseUnit(r.unit),
    op: r.op === "add" || r.op === "set" ? r.op : null,
    value: (r.value as string | null | undefined) ?? null,
    date: r.kind === "delivery" ? parseDate(r.value) : null,
    status: settleStatus(r.status as "observed" | "inferred", r.quantity, parsed, quote),
  };
  return { ok: true, request };
}
