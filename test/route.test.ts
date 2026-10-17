import { describe, expect, it } from "vitest";
import { routeMessage, ruleRoute, type OpenDraft } from "../src/route.ts";
import type { Services } from "../src/read.ts";

const open: OpenDraft = { orderId: "o1", lastAt: "2026-10-17T10:00:00Z", texts: ["5 kg di prosciutto"], lines: [{ name: "prosciutto", qty: 5 }] };
const at = (min: number) => new Date(Date.parse(open.lastAt) + min * 60000).toISOString();
const svc = (out: string | Error) => ({ mock: false, chat: { name: "fake", generate: async () => { if (out instanceof Error) throw out; return [out, { prompt_tokens: 0, completion_tokens: 0 }]; } } }) as unknown as Services;

describe("route", () => {
  it("attaches a continuation soon after", () => {
    const d = ruleRoute("e anche i tovaglioli", at(5), open);
    expect(d).toMatchObject({ action: "attach", quote: "anche" });
  });
  it("new order on explicit request", () => {
    expect(ruleRoute("altro ordine 10 kg di prosciutto", at(5), open)).toMatchObject({ action: "new", quote: "altro ordine" });
  });
  it("question without a draft is none", () => {
    expect(ruleRoute("a che ora passate domani?", at(0), null).action).toBe("none");
  });
  it("attach without quote 3 h later becomes new", async () => {
    const d = await routeMessage(svc('{"action":"attach","quote":"boh","reason":"x"}'), "6 kg", at(180), open);
    expect(d).toMatchObject({ action: "new", quote: null, by: "rule" });
  });
  it("attach without a draft becomes new; quote kept when present", async () => {
    const d = await routeMessage(svc('{"action":"attach","quote":"ANCHE","reason":"x"}'), "e anche questo", at(1), null);
    expect(d).toMatchObject({ action: "new", quote: "ANCHE", by: "model" });
  });
  it("invalid JSON falls back to rules", async () => {
    expect(await routeMessage(svc("nope"), "e anche i tovaglioli", at(5), open)).toMatchObject({ action: "attach", by: "rule" });
  });
});
