// The eval matcher (pure) and the verbatim rule over data/ (SPEC §20).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreMessage, summarize, type ExpectedMessage, type ScoreLine, type ScoreOrder } from "../eval/match.ts";
import { ROOT } from "../src/config.ts";

const line = (sku: string | null, qty: number | null, o: Partial<ScoreLine> & { cands?: string[] } = {}): ScoreLine => ({
  sku, qty, state: "ok", flags: [], product_text: "x", quote: "x", quote_start: 0, quote_end: 1,
  candidates: (o.cands ?? []).map((sku) => ({ sku })), ...o,
});
const flag = (kind: string, severity = "medium") => ({ kind, severity }) as ScoreLine["flags"][number];
const order = (lines: ScoreLine[], flags: ScoreOrder["flags"] = [], delivery: string | null = null, reading = "x"): ScoreOrder =>
  ({ lines, flags, delivery_date: delivery, reading });

const EXP: ExpectedMessage = {
  order: true, lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }], removed: [], delivery_date: null, candidates: [], flags: [],
};

describe("scoreMessage", () => {
  it("line match precision recall", () => {
    const r = scoreMessage(EXP, order([line("A", 2), line("B", 5), line("C", 1)]));
    expect([r.produced, r.matched, r.expected_lines]).toEqual([3, 1, 2]);
    expect(r.misses).toEqual(["B x1"]);
    expect(r.order_right).toBe(false);
    const s = summarize([r]);
    expect(s.line_precision).toBe(Math.round(1000 / 3) / 1000);
    expect(s.line_recall).toBe(0.5);
  });

  it("order entirely right needs removed and date", () => {
    const exp = { ...EXP, removed: ["Z"], delivery_date: "2026-10-19" };
    const good = order([line("A", 2), line("B", 1), line("Z", 3, { state: "removed" })], [], "2026-10-19");
    expect(scoreMessage(exp, good).order_right).toBe(true);
    expect(scoreMessage(exp, order([line("A", 2), line("B", 1)], [], "2026-10-19")).order_right).toBe(false);
    expect(scoreMessage(exp, { ...good, delivery_date: "2026-10-20" }).order_right).toBe(false);
  });

  it("a check line counts with its top candidate", () => {
    const r = scoreMessage(EXP, order([line("A", 2), line(null, 1, { state: "check", cands: ["B", "C"] })]));
    expect(r.matched).toBe(2);
    expect(r.order_right).toBe(true);
  });

  it("null sku is not held against precision when ambiguous or unknown was expected", () => {
    const amb = { ...EXP, lines: [], candidates: [{ text_contains: "prosecco", skus: ["P1", "P2"] }] };
    const r = scoreMessage(amb, order([line(null, 4, { state: "check", cands: ["P1", "P2"], product_text: "prosecco" })]));
    expect([r.produced, r.skipped, r.cand_hit, r.cand_total]).toEqual([0, 1, 1, 1]);
    const miss = order([line(null, 4, { state: "check", cands: ["P1", "X"], product_text: "prosecco" })]);
    expect(scoreMessage(amb, miss).cand_hit).toBe(0);
    const unk = { ...EXP, lines: [], flags: [{ kind: "unknown_product" }] };
    const r2 = scoreMessage(unk, order([line(null, 3, { state: "flag", flags: [flag("unknown_product", "high")] })]));
    expect([r2.produced, r2.flags_found]).toEqual([0, 1]);
    expect(scoreMessage(EXP, order([line(null, 3, { state: "flag", flags: [flag("unknown_product", "high")] })])).produced).toBe(1);
  });

  it("false flags ignore info", () => {
    const r = scoreMessage({ ...EXP, flags: [{ kind: "unusual_quantity" }] },
      order([line("A", 2, { flags: [flag("unusual_quantity")] }), line("B", 1, { flags: [flag("converted", "info")] })],
        [flag("discount_beyond_terms", "high"), flag("not_in_order", "info")]));
    expect(r.flags_found).toBe(1);
    expect(r.false_flags).toEqual(["discount_beyond_terms"]);
  });

  it("non-order message", () => {
    const exp: ExpectedMessage = { order: false, lines: [], flags: [] };
    expect(scoreMessage(exp, order([])).order_right).toBe(true);
    const r = scoreMessage(exp, order([line("A", 1)], [flag("no_history")]));
    expect([r.non_order_lines, r.non_order_flags, r.order_right]).toEqual([1, 1, false]);
  });

  it("unverified line and failed read", () => {
    expect(scoreMessage(EXP, order([line("A", 2, { quote: "nope", quote_start: 0, quote_end: 2 })], [], null, "ciao")).unverified).toBe(1);
    const r = scoreMessage(EXP, null);
    expect(r.read_failed).toBe(true);
    expect(r.misses).toHaveLength(2);
  });
});

const D = join(ROOT, "data");
const json = (p: string) => JSON.parse(readFileSync(join(D, p), "utf8"));

function reading(mid: string, channel: string): string {
  if (channel === "whatsapp" || channel === "email") return json(`messages/${mid}.json`).text;
  const suffix = channel === "voice" ? "transcript" : "transcription";
  return readFileSync(join(D, "messages", `${mid}.${suffix}.txt`), "utf8");
}

it("expected quotes are verbatim in the reading", () => {
  const expected: Record<string, ExpectedMessage> = json("expected.json").messages;
  const bad: [string, string][] = [];
  for (const [mid, e] of Object.entries(expected)) {
    const text = reading(mid, json(`messages/${mid}.json`).channel);
    for (const s of [...(e.quotes ?? []), ...(e.candidates ?? []).map((c) => c.text_contains)]) {
      if (!text.includes(s)) bad.push([mid, s]);
    }
  }
  expect(bad).toEqual([]);
});
