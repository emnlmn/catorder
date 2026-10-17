// Port of tests/test_api.py: the API end to end over app.request(), with a fake model.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { FakeModel, FakeTranscriber, ModelError } from "../src/modelClient.ts";
import type { Services } from "../src/read.ts";
import type { SendWhatsApp } from "../src/reply.ts";
import type { Config } from "../src/types.ts";

type Msg = { role: string; content: unknown };

const P = (sku: string, name: string, aliases: string[], sell_unit = "case", pack_size = 6,
  pack_label = "case of 6 × 75 cl", list_price = 40) =>
  ({ sku, name, aliases, category: "x", sell_unit, pack_size, pack_label, list_price });
const CATALOG = [
  P("ROS1", "Rosso Colline 75cl", ["rosso colline", "colline"]),
  P("ROS2", "Roccafiera Rosso Superiore 75cl", ["roccafiera"]),
  P("BIA1", "Bianco Fiorito 75cl", ["bianco fiorito"]),
  P("PRO1", "Prosecco Brut Valdoro 75cl", ["prosecco valdoro"]),
  P("PRO2", "Prosecco Extra Dry Valdera 75cl", ["prosecco valdera"]),
  P("NAT1", "Fonte Brivio naturale 1L", ["acqua naturale", "brivio nat"], "case", 12, "case of 12 × 1 L", 6),
  P("FRI1", "Fonte Brivio frizzante 1L", ["acqua frizzante", "brivio friz"], "case", 12, "case of 12 × 1 L", 6),
  P("OLI1", "Olio extravergine Terre Alte 1L", ["olio"], "piece", 1, "bottle 1 L", 9),
  P("PRC1", "Prosciutto crudo stagionato", ["crudo", "prosciutto"], "kg", 1, "kg", 24),
];
const TERMS = { discount_pct: 5, payment_days: 30, free_delivery_min: 300, price_overrides: { OLI1: 7.5 } };
const HISTORY = Array.from({ length: 6 }, (_, i) => {
  const lines = [{ sku: "ROS1", qty: 6 }, { sku: "NAT1", qty: i % 2 ? 6 : 4 }];
  if (i < 4) lines.push({ sku: "FRI1", qty: 2 });
  if (i === 0) lines.push({ sku: "PRO1", qty: 1 });
  return { date: `2026-0${i + 5}-10`, lines };
});

const WA_TEXT = "ciao, il solito + 6 cs di quello rosso dell'altra volta, col solito 8% grazie";
const base = { value: null, status: "observed", product: null, sku: null, quantity: null, unit: null, op: null };
const WA_ANSWER = [
  { ...base, kind: "usual", quote: "il solito" },
  { ...base, kind: "item", quote: "6 cs di quello rosso dell'altra volta", product: "quello rosso dell'altra volta", quantity: "6", unit: "cs", op: "add" },
  { ...base, kind: "discount_request", quote: "col solito 8%", value: "8%" },
  { ...base, kind: "item", quote: "invented words not in the text", product: "x", quantity: "1", op: "set" },
];
const PHOTO_ANSWER = [{ ...base, kind: "item", quote: "2 cs rosso colline", product: "rosso colline", sku: "ROS1", quantity: "2", unit: "cs", op: "set" }];
const VOICE_ANSWER = [{ ...base, kind: "item", quote: "quattro casse di acqua naturale", product: "acqua naturale", quantity: "quattro", unit: "casse", op: "set" }];

function makeData(): string {
  const d = mkdtempSync(join(tmpdir(), "catorder-data-"));
  for (const s of ["customers", "history", "messages", "mock"]) mkdirSync(join(d, s), { recursive: true });
  const w = (p: string, v: unknown) => writeFileSync(join(d, p), typeof v === "string" ? v : JSON.stringify(v));
  w("catalog.json", CATALOG);
  w("customers/bar.json", { name: "Bar Test", kind: "bar", terms: TERMS });
  w("customers/new.json", { name: "Nuovo Alimentari", kind: "bar", terms: TERMS });
  w("history/bar.json", HISTORY);
  w("history/new.json", HISTORY.slice(0, 1));
  const msg = (id: string, extra: object, channel: string, customer = "bar") =>
    w(`messages/${id}.json`, { customer_id: customer, channel, received_at: "2026-10-16T08:12:00", sender: "x", ...extra });
  msg("wa-1", { text: WA_TEXT }, "whatsapp");
  msg("wa-2", { text: "a che ora passate domani?" }, "whatsapp");
  msg("v-1", { media: "v-1.mp3" }, "voice");
  w("messages/v-1.mp3", "ID3audio");
  w("messages/v-1.transcript.txt", "tre, anzi quattro casse di acqua naturale");
  msg("p-1", { media: "p-1.jpg" }, "photo");
  w("messages/p-1.jpg", "\xff\xd8jpeg");
  w("messages/p-1.transcription.txt", "2 cs rosso colline\n3 olio");
  w("mock/wa-1.json", WA_ANSWER);
  return d;
}

function client(chat: FakeModel, extra: Partial<Services> = {}, cfgExtra: Partial<Config> = {}, sendWa?: SendWhatsApp | null) {
  const dir = mkdtempSync(join(tmpdir(), "catorder-t-"));
  const dataDir = makeData();
  const cfg = { db: ":memory:", dataDir, today: "2026-10-16", mock: false, port: 0, ...cfgExtra } as Config;
  const svc = { chat, transcriber: null, vision: true, offline: false, refresh: false, mock: false,
    cacheDir: join(dir, "cache"), dataDir, ...extra } as Services;
  const app = createApp(cfg, svc, undefined, sendWa);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON (csv) */ }
    return { status: res.status, json, text };
  };
  return { get: (p: string) => call("GET", p), post: (p: string, b?: unknown) => call("POST", p, b),
    patch: (p: string, b: unknown) => call("PATCH", p, b), chat };
}

const answerByMessage = (messages: Msg[]): string => {
  const text = messages[messages.length - 1].content;
  if (typeof text !== "string") return "2 cs rosso colline\n3 olio [?]"; // a vision call
  if (text.includes('<message id="p-1"')) return JSON.stringify(PHOTO_ANSWER);
  if (text.includes('<message id="v-1"')) return JSON.stringify(VOICE_ANSWER);
  return JSON.stringify(WA_ANSWER);
};

describe("API", () => {
  it("drafts a reply with the model, edits it, sends it once over WhatsApp", async () => {
    const sent: [string, string][] = [];
    const c = client(new FakeModel([JSON.stringify(WA_ANSWER), "Ciao! Lo sconto concordato è il 5%."]),
      {}, { whatsappPhoneMap: { "+39333000111": "bar" } }, async (to, body) => { sent.push([to, body]); });
    expect((await c.post("/api/messages/wa-1/reply")).status).toBe(409); // no order yet
    await c.post("/api/messages/wa-1/read");
    const d = (await c.post("/api/messages/wa-1/reply")).json;
    expect(d).toMatchObject({ status: "draft", text: "Ciao! Lo sconto concordato è il 5%.", model: "fake" });
    const prompt = c.chat.calls[1][1].content as string;
    expect(prompt).toContain("Agreed discount: 5%");
    expect(prompt).toContain("Rosso Colline");
    expect((await c.get("/api/messages/wa-1")).json.reply.id).toBe(d.id);
    expect((await c.patch("/api/replies/" + d.id, { text: "  Ciao, a domani  " })).json.text).toBe("Ciao, a domani");
    const s = (await c.post("/api/replies/" + d.id + "/send")).json;
    expect(s).toMatchObject({ status: "sent", via: "whatsapp" });
    expect(sent).toEqual([["+39333000111", "Ciao, a domani"]]);
    expect((await c.post("/api/replies/" + d.id + "/send")).status).toBe(409);
    expect((await c.patch("/api/replies/" + d.id, { text: "x" })).status).toBe(409);
  });

  it("health", async () => {
    const h = (await client(new FakeModel()).get("/api/health")).json;
    expect(h.ok).toBe(true);
    expect(h.model).toBe("fake");
    expect(h.prompt_version).toBeTruthy();
    expect(h.today).toBe("2026-10-16");
  });

  it("inbox and message", async () => {
    const c = client(new FakeModel());
    const inbox = (await c.get("/api/messages")).json;
    expect(inbox.map((m: any) => m.id).sort()).toEqual(["p-1", "v-1", "wa-1", "wa-2"]);
    expect(inbox[0].order).toBeNull();
    const m = (await c.get("/api/messages/v-1")).json;
    expect(m.message.media_url).toBe("/media/v-1.mp3");
    expect(m.order).toBeNull();
    expect((await c.get("/media/v-1.mp3")).status).toBe(200);
    expect((await c.get("/media/v-1.transcript.txt")).status).toBe(404);
    expect((await c.get("/api/messages/nope")).status).toBe(404);
  });

  it("reads a text message end to end", async () => {
    const c = client(new FakeModel(JSON.stringify(WA_ANSWER)));
    const r = await c.post("/api/messages/wa-1/read");
    expect(r.status).toBe(200);
    const o = r.json.order;
    expect(r.json.reading.kind).toBe("original");
    expect(o.status).toBe("draft");
    const skus = Object.fromEntries(o.lines.map((l: any) => [l.sku, l]));
    expect(skus.ROS1.qty).toBe(12);
    expect(Object.keys(skus).sort()).toEqual(["FRI1", "NAT1", "ROS1"]);
    expect(o.flags.map((f: any) => f.kind)).toEqual(["discount_beyond_terms"]);
    const run = r.json.runs[0];
    expect(run.stage).toBe("extract");
    expect(run.tokens_in).toBe(10);
    expect(run.error).toBeNull();
    expect((await c.get("/api/metrics")).json.dropped.no_quote).toBe(1);
    for (const l of o.lines) expect(o.reading.slice(l.quote_start, l.quote_end)).toBe(l.quote);
    const inbox = Object.fromEntries((await c.get("/api/messages")).json.map((m: any) => [m.id, m]));
    expect(inbox["wa-1"].order).toEqual({ id: o.id, status: "draft", clean: false, message_ids: ["wa-1"] });
  });

  it("a non-order message gives an empty clean order", async () => {
    const o = (await client(new FakeModel("[]")).post("/api/messages/wa-2/read")).json.order;
    expect(o.lines).toEqual([]);
    expect(o.flags).toEqual([]);
    expect(o.clean).toBe(true);
  });

  it("reads a photo and a voice note", async () => {
    const chat = new FakeModel(answerByMessage);
    const c = client(chat, { transcriber: new FakeTranscriber("quattro casse di acqua naturale") } );
    const p = (await c.post("/api/messages/p-1/read")).json;
    expect(p.reading.kind).toBe("transcription");
    expect(p.reading.source).toBe("model");
    expect(p.runs.map((r: any) => r.stage)).toEqual(["vision", "extract"]);
    const sawImage = chat.calls.some((call) => call.some((m) => Array.isArray(m.content)
      && (m.content[0] as any).image_url.url.startsWith("data:image/jpeg;base64,")));
    expect(sawImage).toBe(true);
    const v = (await c.post("/api/messages/v-1/read")).json;
    expect(v.reading.kind).toBe("transcript");
    expect(v.order.lines[0].sku).toBe("NAT1");
    expect(v.order.lines[0].qty).toBe(4);
  });

  it("a failed transcription falls back to the file", async () => {
    const c = client(new FakeModel(answerByMessage), { transcriber: new FakeTranscriber(new ModelError(500, "down")) } );
    const v = (await c.post("/api/messages/v-1/read")).json;
    expect(v.reading.source).toBe("file");
    expect(v.runs[0].error).toBeTruthy();
    expect(v.order.lines[0].sku).toBe("NAT1");
  });

  it("second read hits the cache", async () => {
    const chat = new FakeModel(JSON.stringify(WA_ANSWER));
    const c = client(chat);
    await c.post("/api/messages/wa-1/read");
    const r = (await c.post("/api/messages/wa-1/read")).json;
    expect(r.runs[0].cached).toBe(true);
    expect(chat.calls.length).toBe(1);
  });

  it("a malformed answer is a run with an error", async () => {
    const chat = new FakeModel("this is not json");
    const r = await client(chat).post("/api/messages/wa-1/read");
    expect(r.status).toBe(200);
    expect(r.json.order).toBeNull();
    expect(r.json.runs[0].error).toBeTruthy();
    expect(chat.calls.length).toBe(2); // one retry
    expect(chat.calls[1].at(-1)!.content as string).toContain("not valid JSON");
  });

  it("a malformed answer then a valid retry works", async () => {
    const c = client(new FakeModel(["```oops", JSON.stringify(WA_ANSWER)]));
    expect((await c.post("/api/messages/wa-1/read")).json.order).not.toBeNull();
  });

  it("a model failure is a 200", async () => {
    const r = await client(new FakeModel(new ModelError(503, "overloaded"))).post("/api/messages/wa-1/read");
    expect(r.status).toBe(200);
    expect(r.json.order).toBeNull();
    expect(r.json.runs[0].error).toContain("503");
  });

  it("a second read supersedes the draft", async () => {
    const c = client(new FakeModel(JSON.stringify(WA_ANSWER)), { refresh: true });
    const a = (await c.post("/api/messages/wa-1/read")).json.order.id;
    const b = (await c.post("/api/messages/wa-1/read")).json.order.id;
    expect(a).not.toBe(b);
    expect((await c.get("/api/messages/wa-1")).json.order.id).toBe(b);
    expect((await c.get(`/api/orders/${a}/export`)).status).toBe(409);
  });

  it("edit, confirm, export", async () => {
    const c = client(new FakeModel(JSON.stringify(WA_ANSWER)));
    const o = (await c.post("/api/messages/wa-1/read")).json.order;
    const r = await c.post(`/api/orders/${o.id}/confirm`, { acknowledged: [] });
    expect(r.status).toBe(409);
    expect(r.json.reasons.length).toBeGreaterThan(0);
    const ln = o.lines.find((x: any) => x.sku === "NAT1");
    expect((await c.patch(`/api/lines/${ln.id}`, { qty: 7 })).json.lines[1].qty).toBe(7);
    const ok = await c.post(`/api/orders/${o.id}/confirm`, { acknowledged: ["discount_beyond_terms"] });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("confirmed");
    expect((await c.post("/api/messages/wa-1/read")).status).toBe(409);
    const csv = await c.get(`/api/orders/${o.id}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text.startsWith("order_id,customer_id")).toBe(true);
    expect((await c.patch(`/api/lines/${ln.id}`, { qty: 1 })).status).toBe(409);
    expect((await c.get("/api/metrics")).json.orders_confirmed).toBe(1);
  });

  it("customer and catalog", async () => {
    const c = client(new FakeModel());
    const cu = (await c.get("/api/customers/bar")).json;
    expect(cu.usual.map((u: any) => u.sku).sort()).toEqual(["FRI1", "NAT1", "ROS1"]);
    expect(cu.terms.discount_pct).toBe(5);
    expect((await c.get("/api/customers/nope")).status).toBe(404);
    expect((await c.get("/api/catalog?q=prosecco")).json[0].sku.startsWith("PRO")).toBe(true);
    expect((await c.get("/api/metrics")).status).toBe(200);
  });

  it("rejects a bad export format and a bad body", async () => {
    const c = client(new FakeModel());
    expect((await c.get("/api/orders/x/export?format=xml")).status).toBe(400);
    expect((await c.patch("/api/lines/x", [1])).status).toBe(422);
  });
});

describe("suggestions", () => {
  it("adds a forecast-suggested line to a draft, refuses bad input and confirmed orders, counts feedback", async () => {
    const c = client(new FakeModel([JSON.stringify(WA_ANSWER)]));
    await c.post("/api/messages/wa-1/read");
    const oid = (await c.get("/api/messages/wa-1")).json.order.id as string;
    const before = (await c.get("/api/messages/wa-1")).json.order.lines.length;
    const r = await c.post(`/api/orders/${oid}/lines`, { sku: "PRC1", qty: 2 });
    expect(r.status).toBe(200);
    expect(r.json.lines).toHaveLength(before + 1);
    expect(r.json.lines.at(-1)).toMatchObject({ sku: "PRC1", qty: 2, state: "ok", origin: "usual" });
    expect(r.json.lines.at(-1).flags[0].message).toBe("Suggested by the forecast model");
    expect((await c.post(`/api/orders/${oid}/lines`, { sku: "NOPE", qty: 1 })).status).toBe(400);
    expect((await c.post(`/api/orders/${oid}/lines`, { sku: "PRC1", qty: 0 })).status).toBe(400);
    expect((await c.get("/api/suggestions/feedback/count")).json).toEqual({ added: 0, dismissed: 0, total: 0 });
    const fb = { customer_id: "bar", order_id: oid, sku: "PRC1", qty: 2, p: 0.7 };
    expect((await c.post("/api/suggestions/feedback", { ...fb, action: "added" })).status).toBe(200);
    expect((await c.post("/api/suggestions/feedback", { ...fb, action: "dismissed" })).status).toBe(200);
    expect((await c.post("/api/suggestions/feedback", { ...fb, action: "maybe" })).status).toBe(422);
    expect((await c.get("/api/suggestions/feedback/count")).json).toEqual({ added: 1, dismissed: 1, total: 2 });
    await c.patch(`/api/lines/${r.json.lines[0].id}`, { removed: true });
    for (const l of r.json.lines.slice(1)) if (l.state !== "ok") await c.patch(`/api/lines/${l.id}`, { removed: true });
    const cf = await c.post(`/api/orders/${oid}/confirm`, { acknowledged: ["discount_beyond_terms", "unusual_quantity", "price_below_terms"] });
    if (cf.status === 200) expect((await c.post(`/api/orders/${oid}/lines`, { sku: "PRC1", qty: 1 })).status).toBe(409);
  });
});
