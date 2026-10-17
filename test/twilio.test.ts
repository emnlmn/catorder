// The Twilio WhatsApp webhook over app.request(): signature, storage, media, idempotency. Fake numbers only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { FakeModel, FakeTranscriber } from "../src/modelClient.ts";
import type { Services } from "../src/read.ts";
import { maskNumber, parsePhoneMap, twilioSignature } from "../src/twilio.ts";
import type { Download } from "../src/twilio.ts";
import type { Config } from "../src/types.ts";

const TOKEN = "testtoken", PUBLIC = "https://example.test", PATH = "/webhook/whatsapp";
const MAPPED = "+15005550006";

describe("twilioSignature", () => {
  it("matches a vector computed by hand", () => {
    const url = "https://example.test/webhook/whatsapp";
    const params = { To: "whatsapp:+14155238886", Body: "ciao", From: "whatsapp:+15005550006" };
    const data = url + "Body" + "ciao" + "From" + "whatsapp:+15005550006" + "To" + "whatsapp:+14155238886";
    expect(twilioSignature(url, params, TOKEN)).toBe(createHmac("sha1", TOKEN).update(data).digest("base64"));
    expect(twilioSignature(url, params, "other")).not.toBe(twilioSignature(url, params, TOKEN));
  });
  it("parses the phone map and masks numbers", () => {
    expect(parsePhoneMap("+15005550006=deli-mulino, +15005550007=bar-ponterosso")).toEqual({ [MAPPED]: "deli-mulino", "+15005550007": "bar-ponterosso" });
    expect(maskNumber("+15005550009")).toBe("+********009");
  });
});

function setup(opts: { token?: string; download?: Download; transcriber?: FakeTranscriber; send?: (to: string, body: string) => Promise<void> } = {}) {
  const base = mkdtempSync(join(tmpdir(), "catorder-wa-"));
  const dataDir = join(base, "data"), inboxDir = join(base, "inbox");
  for (const s of ["customers", "history", "messages", "mock"]) mkdirSync(join(dataDir, s), { recursive: true });
  writeFileSync(join(dataDir, "customers/deli-mulino.json"), JSON.stringify({ name: "Deli Test", kind: "deli", terms: { discount_pct: 5 } }));
  const cfg = { db: ":memory:", dataDir, inboxDir, today: "2026-10-16", mock: false, port: 0,
    twilioAccountSid: "ACtest", twilioAuthToken: opts.token ?? TOKEN, publicUrl: PUBLIC,
    whatsappPhoneMap: { [MAPPED]: "deli-mulino" } } as unknown as Config;
  const svc = { chat: new FakeModel("[]"), transcriber: opts.transcriber ?? null, vision: false, offline: false, refresh: false, mock: false,
    cacheDir: null, dataDir, inboxDir } as Services;
  const app = createApp(cfg, svc, opts.download, opts.send);
  const post = (params: Record<string, string>, sig?: string) => app.request(PATH, {
    method: "POST", body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": sig ?? twilioSignature(PUBLIC + PATH, params, TOKEN) },
  });
  const json = async (p: string) => (await app.request(p)).json() as Promise<any>;
  return { app, post, json, inboxDir, db: app.db };
}
const msg = (sid: string, extra: Record<string, string> = {}) =>
  ({ MessageSid: sid, From: "whatsapp:" + MAPPED, To: "whatsapp:+14155238886", Body: "2 casse di rosso", NumMedia: "0", ...extra });
const count = (db: any, id: string) => db.prepare("SELECT COUNT(*) n FROM messages WHERE id=?").get(id).n;

describe("POST /webhook/whatsapp", () => {
  it("stores a text message under the mapped customer, answers empty TwiML, then reads it", async () => {
    const t = setup();
    const res = await t.post(msg("SM1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const d = await t.json("/api/messages/wa-live-SM1");
    expect(d.message).toMatchObject({ customer_id: "deli-mulino", channel: "whatsapp", text: "2 casse di rosso", media: null });
    expect(d.message.received_at).toMatch(/T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(d.message.sender).toBe("+********006");
    await vi.waitFor(async () => expect((await t.json("/api/messages/wa-live-SM1")).order).not.toBeNull());
    expect((await t.json("/api/messages"))[0].id).toBe("wa-live-SM1");
  });

  it("uses ProfileName as the sender", async () => {
    const t = setup();
    await t.post(msg("SM2", { ProfileName: "Luca" }));
    expect((await t.json("/api/messages/wa-live-SM2")).message.sender).toBe("Luca");
  });

  it("rejects a bad or missing signature", async () => {
    const t = setup();
    const res = await t.post(msg("SM3"), "AAAA");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Bad signature." });
    const none = await t.app.request(PATH, { method: "POST", body: "MessageSid=SM3", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(none.status).toBe(403);
    expect(count(t.db, "wa-live-SM3")).toBe(0);
  });

  it("answers 503 without a token", async () => {
    const res = await setup({ token: "" }).post(msg("SM4"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "WhatsApp webhook is not configured." });
  });

  it("keeps an unknown number under unknown-sender and reads it without error", async () => {
    const t = setup();
    await t.post(msg("SM5", { From: "whatsapp:+15005550999" }));
    const d = await t.json("/api/messages/wa-live-SM5");
    expect(d.message.customer).toEqual({ id: "unknown-sender", name: "Numero sconosciuto" });
    const r = await t.app.request("/api/messages/wa-live-SM5/read", { method: "POST" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).order.status).toBe("draft");
    expect((await t.app.request("/api/customers/unknown-sender")).status).toBe(200);
  });

  it("assigns an unknown number to a customer: its messages move and the next one follows", async () => {
    const t = setup();
    const from = { From: "whatsapp:+15005550999" };
    await t.post(msg("SM6", from));
    const r = await t.app.request("/api/messages/wa-live-SM6/assign", { method: "POST", body: JSON.stringify({ customer_id: "deli-mulino" }) });
    expect(r.status).toBe(200);
    await t.post(msg("SM7", from));
    for (const id of ["SM6", "SM7"]) expect((await t.json("/api/messages/wa-live-" + id)).message.customer.id).toBe("deli-mulino");
    expect((await t.app.request("/api/messages/wa-live-SM6/assign", { method: "POST", body: JSON.stringify({ customer_id: "unknown-sender" }) })).status).toBe(400);
  });
  it("clears one customer's chat and keeps the others", async () => {
    const t = setup();
    await t.post(msg("SM8"));
    await t.app.request("/api/messages/wa-live-SM8/read", { method: "POST" });
    const r = await t.app.request("/api/customers/deli-mulino/messages", { method: "DELETE" });
    expect(await r.json()).toEqual({ cleared: 1 });
    expect(count(t.db, "wa-live-SM8")).toBe(0);
    expect((t.db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n).toBe(0);
  });
  it("sends the operator's reply back to the number the message came from, even an unknown one", async () => {
    const sent: [string, string][] = [];
    const t = setup({ send: async (to, body) => { sent.push([to, body]); } });
    await t.post(msg("SM6", { From: "whatsapp:+15005550999" }));
    await t.app.request("/api/messages/wa-live-SM6/read", { method: "POST" });
    const d = await (await t.app.request("/api/messages/wa-live-SM6/reply", { method: "POST" })).json() as any;
    await t.app.request("/api/replies/" + d.id, { method: "PATCH", body: JSON.stringify({ text: "Ciao, chi sei?" }), headers: { "content-type": "application/json" } });
    const s = await (await t.app.request("/api/replies/" + d.id + "/send", { method: "POST" })).json() as any;
    expect(s.via).toBe("whatsapp");
    expect(sent).toEqual([["+15005550999", "Ciao, chi sei?"]]);
  });

  it("stores a repeated MessageSid once", async () => {
    const t = setup();
    expect((await t.post(msg("SM6"))).status).toBe(200);
    const again = await t.post(msg("SM6", { Body: "changed" }));
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("<Response></Response>");
    expect(count(t.db, "wa-live-SM6")).toBe(1);
    expect((await t.json("/api/messages/wa-live-SM6")).message.text).toBe("2 casse di rosso");
  });

  it("downloads a voice note into the inbox and serves it", async () => {
    const bytes = Buffer.from("OggSfake");
    const calls: string[][] = [];
    const t = setup({ download: async (url, sid, token) => { calls.push([url, sid, token]); return bytes; } });
    await t.post(msg("SM7", { Body: "", NumMedia: "1", MediaUrl0: "https://api.twilio.test/m/1", MediaContentType0: "audio/ogg" }));
    expect(calls).toEqual([["https://api.twilio.test/m/1", "ACtest", TOKEN]]);
    const d = await t.json("/api/messages/wa-live-SM7");
    expect(d.message).toMatchObject({ channel: "voice", media: "wa-live-SM7.ogg", text: null, media_url: "/media/wa-live-SM7.ogg" });
    expect(readFileSync(join(t.inboxDir, "wa-live-SM7.ogg"))).toEqual(bytes);
    const media = await t.app.request("/media/wa-live-SM7.ogg");
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer())).toEqual(bytes);
    expect((await t.app.request("/media/..%2Fx")).status).toBe(404);
  });

  it("reads a stored voice note from the inbox", async () => {
    const transcriber = new FakeTranscriber("due casse di rosso");
    const t = setup({ transcriber, download: async () => Buffer.from("OggSfake") });
    await t.post(msg("SM10", { Body: "", NumMedia: "1", MediaUrl0: "https://api.twilio.test/m/4", MediaContentType0: "audio/ogg; codecs=opus" }));
    const r = await (await t.app.request("/api/messages/wa-live-SM10/read", { method: "POST" })).json() as any;
    expect(new Set(transcriber.calls)).toEqual(new Set(["wa-live-SM10.ogg"])); // the webhook read it too
    expect(r.reading).toMatchObject({ kind: "transcript", text: "due casse di rosso" });
  });

  it("stores a photo as a photo", async () => {
    const t = setup({ download: async () => Buffer.from("\xff\xd8jpeg") });
    await t.post(msg("SM8", { NumMedia: "1", MediaUrl0: "https://api.twilio.test/m/2", MediaContentType0: "image/jpeg" }));
    expect((await t.json("/api/messages/wa-live-SM8")).message).toMatchObject({ channel: "photo", media: "wa-live-SM8.jpg" });
  });

  it("turns an unsupported attachment into a text message", async () => {
    const download = vi.fn(async () => Buffer.from("x"));
    const t = setup({ download });
    await t.post(msg("SM9", { Body: "", NumMedia: "1", MediaUrl0: "https://api.twilio.test/m/3", MediaContentType0: "application/pdf" }));
    const d = await t.json("/api/messages/wa-live-SM9");
    expect(d.message).toMatchObject({ channel: "whatsapp", media: null, text: "[allegato non supportato: application/pdf]" });
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(t.inboxDir)).toBe(false);
  });

  it("answers 429 past 30 messages a minute from one number", async () => {
    const t = setup();
    const from = "whatsapp:+15005550123";
    for (let i = 0; i < 30; i++) expect((await t.post(msg("SMR" + i, { From: from }))).status).toBe(200);
    expect((await t.post(msg("SMR30", { From: from }))).status).toBe(429);
  });
});
