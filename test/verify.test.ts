import { describe, expect, it } from "vitest";
import { fixWeightQty, locate, parseDate, parseQuantity, parseUnit, relativeDate, settleStatus, verifyRequest } from "../src/verify.ts";
import { golden } from "./parity.ts";

function v(reading: string, extra: Record<string, unknown>) {
  return verifyRequest(reading, { kind: "item", quote: "x", status: "observed", ...extra });
}
const okReq = (r: ReturnType<typeof v>) => {
  if (!r.ok) throw new Error(`dropped: ${r.reason}`);
  return r.request;
};

describe("verify", () => {
  it("exact quote and slice", () => {
    const text = "ciao, 6 cs acqua naturale grazie";
    const out = okReq(v(text, { quote: "6 cs acqua naturale" }));
    expect(out.quote).toBe("6 cs acqua naturale");
    expect(text.slice(out.quote_start, out.quote_end)).toBe(out.quote);
  });

  it("case, curly quotes and whitespace", () => {
    const reading = "Quello rosso  dell’altra\n volta";
    expect(okReq(v(reading, { quote: "quello rosso dell'altra volta" })).quote).toBe(reading);
  });

  it("not found and short", () => {
    expect(v("ciao 6 cs", { quote: "7 cs" })).toEqual({ ok: false, reason: "no_quote" });
    expect(v("ciao 6 cs", { quote: "6" })).toEqual({ ok: false, reason: "short_quote" });
  });

  it("no fuzzy matching", () => {
    expect(v("sei casse di acqua", { quote: "6 casse di acqua" })).toEqual({ ok: false, reason: "no_quote" });
  });

  it("bad kind, status, quote", () => {
    const bad = { ok: false, reason: "bad_kind" };
    expect(verifyRequest("abc def", { kind: "buy", quote: "abc", status: "observed" })).toEqual(bad);
    expect(verifyRequest("abc def", { kind: "item", quote: "abc", status: "maybe" })).toEqual(bad);
    expect(verifyRequest("abc def", { kind: "item", quote: 5, status: "observed" })).toEqual(bad);
    expect(verifyRequest("abc def", "nope")).toEqual(bad);
  });

  it("quantities", () => {
    expect(parseQuantity("6")).toBe(6);
    expect(parseQuantity("6,5")).toBe(6.5);
    expect(parseQuantity("0.5")).toBe(0.5);
    expect(parseQuantity("sei")).toBe(6);
    expect(parseQuantity("Venti")).toBe(20);
    expect(parseQuantity("trenta")).toBe(30);
    expect(parseQuantity("mezza")).toBe(0.5);
    expect(parseQuantity("un")).toBe(1);
    expect(parseQuantity("un paio")).toBe(2);
    expect(parseQuantity("tanto")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity("constructor")).toBeNull();
  });

  it("units", () => {
    expect(parseUnit("casse")).toBe("case");
    expect(parseUnit("cs")).toBe("case");
    expect(parseUnit("CF")).toBe("case");
    expect(parseUnit("bottiglie")).toBe("piece");
    expect(parseUnit("pz.")).toBe("piece");
    expect(parseUnit("kg")).toBe("kg");
    expect(parseUnit("chili")).toBe("kg");
    expect(parseUnit("scatole")).toBeNull();
    expect(parseUnit(null)).toBeNull();
  });

  it("delivery date", () => {
    const r = v("per venerdi 2026-10-16", { kind: "delivery", quote: "per venerdi", value: "2026-10-16" });
    expect(okReq(r).date).toBe("2026-10-16");
    expect(parseDate("venerdi")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate("2026-02-30")).toBeNull();
  });

  it("status settlement", () => {
    expect(settleStatus("observed", "6", 6, "6 cs acqua")).toBe("observed");
    expect(settleStatus("observed", "sei", 6, "sei casse")).toBe("observed");
    expect(settleStatus("observed", "6", 6, "il solito")).toBe("inferred");
    expect(settleStatus("inferred", "6", 6, "6 cs")).toBe("inferred");
  });

  it("locate offsets through whitespace collapse", () => {
    const [s, e] = locate("a   b  c d", "b c") as [number, number];
    expect("a   b  c d".slice(s, e)).toBe("b  c");
  });

  it("offsets stay correct after an emoji", () => {
    const text = "ciao 😀 6 cs vino";
    const out = okReq(v(text, { quote: "6 cs vino" }));
    expect(text.slice(out.quote_start, out.quote_end)).toBe("6 cs vino");
  });
});

describe("verify parity with Python goldens", () => {
  it("locate", () => {
    const g = golden("python-unit/locate.json") as { reading: string; cases: { quote: string; out: unknown }[] };
    for (const c of g.cases) expect(locate(g.reading, c.quote)).toEqual(c.out);
  });

  it("parse_quantity and parse_unit", () => {
    for (const c of golden("python-unit/parse_quantity.json") as { in: unknown; out: unknown }[])
      expect(parseQuantity(c.in)).toEqual(c.out);
    for (const c of golden("python-unit/parse_unit.json") as { in: unknown; out: unknown }[])
      expect(parseUnit(c.in)).toEqual(c.out);
  });

  it("verify_request", () => {
    const g = golden("python-unit/verify_request.json") as { reading: string; cases: { req: unknown; out: [string, unknown] }[] };
    for (const c of g.cases) {
      const r = verifyRequest(g.reading, c.req);
      const got = r.ok ? ["ok", r.request] : ["drop", r.reason];
      expect(got).toEqual(c.out);
    }
  });
});

describe("relativeDate", () => {
  // 2026-10-16 is a Friday
  it("resolves weekdays to their next occurrence after the message day", () => {
    expect(relativeDate("6 bt di olio x sabato", "2026-10-16")).toBe("2026-10-17");
    expect(relativeDate("x venerdì", "2026-10-14")).toBe("2026-10-16");
    expect(relativeDate("per venerdi", "2026-10-16")).toBe("2026-10-23");
    expect(relativeDate("x lunedi", "2026-10-16")).toBe("2026-10-19");
  });
  it("resolves oggi, domani, dopodomani", () => {
    expect(relativeDate("per domani", "2026-10-14")).toBe("2026-10-15");
    expect(relativeDate("Per oggi", "2026-10-14")).toBe("2026-10-14");
    expect(relativeDate("dopodomani", "2026-10-31")).toBe("2026-11-02");
  });
  it("returns null without a relative day", () => {
    expect(relativeDate("il 24", "2026-10-14")).toBeNull();
  });
});

describe("fixWeightQty", () => {
  it("etti, e mezzo and mezzo chilo become kg quantities", () => {
    expect(fixWeightQty("2 etti di bresaola", 2)).toEqual({ qty: 0.2, unit: "kg" });
    expect(fixWeightQty("3 etti di salame", 3)).toEqual({ qty: 0.3, unit: "kg" });
    expect(fixWeightQty("2 kg e mezzo di taleggio", 2)).toEqual({ qty: 2.5, unit: "kg" });
    expect(fixWeightQty("un kg e mezzo di gorgonzola", null)).toEqual({ qty: 1.5, unit: "kg" });
    expect(fixWeightQty("mezzo chilo di pecorino", null)).toEqual({ qty: 0.5, unit: "kg" });
    expect(fixWeightQty("un chilo di pecorino", null)).toEqual({ qty: 1, unit: "kg" });
    expect(fixWeightQty("mezzo kg di provolone", 1)).toEqual({ qty: 0.5, unit: "kg" });
  });

  it("leaves already-correct and unrelated quantities alone", () => {
    expect(fixWeightQty("2 etti di bresaola", 0.2)).toBeNull();
    expect(fixWeightQty("2 kg di asiago e mezzo kg di provolone", 2)).toBeNull();
    expect(fixWeightQty("6 cs acqua", 6)).toBeNull();
  });

  it("applies through verifyRequest", () => {
    const r = okReq(v("2 etti di bresaola x giovedi", { quote: "2 etti di bresaola", quantity: 2, unit: "etti" }));
    expect([r.qty, r.unit]).toEqual([0.2, "kg"]);
  });
});
