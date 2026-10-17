import { describe, expect, it } from "vitest";
import { connect } from "../src/db.ts";
import { loadData } from "../src/load.ts";
import { loadConfig } from "../src/config.ts";
import { FakeModel, ModelError } from "../src/modelClient.ts";
import { aggregate, publicRun } from "../src/metrics.ts";
import { parseArray, readMessage, verifyAll, ReadError } from "../src/read.ts";
import type { Services } from "../src/read.ts";
import type { Request } from "../src/types.ts";

const dataDir = loadConfig().dataDir;

function setup(chat: FakeModel, over: Partial<Services> = {}) {
  const db = connect(":memory:");
  loadData(db, dataDir);
  const svc: Services = { chat, transcriber: null, vision: false, offline: false, refresh: false, mock: true, dataDir, ...over };
  return { db, svc };
}

const item = (quote: string): Request => ({ kind: "item", quote, product: "prosecco", sku: null, quantity: "2", unit: "cs", op: null, value: null, status: "observed" });

describe("read", () => {
  it("parseArray strips fences and rejects non-arrays", () => {
    expect(parseArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(() => parseArray("nope")).toThrow("no JSON array found");
    expect(() => parseArray("[Sure, here it is]")).toThrow(/^invalid JSON$/);
  });

  it("verifyAll sorts by quote_start and counts drops", () => {
    const { verified, drops } = verifyAll("due casse di prosecco", [item("prosecco"), item("zzzzzz"), item("due casse")]);
    expect(verified.map((v) => v.quote)).toEqual(["due casse", "prosecco"]);
    expect(drops.no_quote).toBe(1);
  });

  it("reads a message: one extract run, a draft order, metrics", async () => {
    const m = new FakeModel(JSON.stringify([item("6 cs di quello rosso")]));
    const { db, svc } = setup(m);
    const out = await readMessage(db, svc, "wa-001");
    expect(out.order?.status).toBe("draft");
    expect(out.reading?.kind).toBe("original");
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ stage: "extract", cached: false, tokens_in: 10, tokens_out: 5 });
    expect(aggregate(db)).toMatchObject({ runs: 1, requests_proposed: 1, tokens_in: 10 });
  });

  it("a second read supersedes the first draft", async () => {
    const { db, svc } = setup(new FakeModel("[]"));
    const a = await readMessage(db, svc, "wa-001");
    const b = await readMessage(db, svc, "wa-001");
    expect(b.order!.id).not.toBe(a.order!.id);
    const st = db.prepare("SELECT status FROM orders WHERE id=?").get(a.order!.id) as { status: string };
    expect(st.status).toBe("superseded");
  });

  it("retries once on unparseable output, then reports failure", async () => {
    const m = new FakeModel(["junk", "more junk"]);
    const { db, svc } = setup(m);
    const out = await readMessage(db, svc, "wa-001");
    expect(m.calls).toHaveLength(2);
    expect(out.order).toBeNull();
    expect(out.error).toBe("The model answer could not be used.");
    expect(out.runs[0].error).toMatch(/unparseable/);
    expect(aggregate(db).dropped.schema).toBe(1);
  });

  it("a model error is recorded and gives no order", async () => {
    const { db, svc } = setup(new FakeModel(new ModelError(500, "boom")));
    const out = await readMessage(db, svc, "wa-001");
    expect(out.order).toBeNull();
    expect(out.runs[0].error).toMatch(/500/);
    expect(aggregate(db).errors).toBe(1);
  });

  it("voice falls back to the committed transcript", async () => {
    const { db, svc } = setup(new FakeModel("[]"));
    const out = await readMessage(db, svc, "vo-001");
    expect(out.reading).toMatchObject({ kind: "transcript", source: "file" });
  });

  it("404 on an unknown message", async () => {
    const { db, svc } = setup(new FakeModel());
    await expect(readMessage(db, svc, "nope")).rejects.toBeInstanceOf(ReadError);
  });

  it("publicRun maps cached to a boolean", () => {
    const r = publicRun({ stage: "extract", cached: 1, latency_ms: 1, tokens_in: 0, tokens_out: 0, cost_usd: null, error: null } as never);
    expect(r.cached).toBe(true);
  });
});
