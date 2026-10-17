// Hono app: JSON API under /api, media under /media, the static page at / (SPEC §15).
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { cacheDir } from "./cache.ts";
import { ROOT } from "./config.ts";
import { connect, getCatalog, getCustomer, historyOrders, nowIso, row, rows } from "./db.ts";
import { loadData } from "./load.ts";
import { aggregate } from "./metrics.ts";
import { ChatModel, MockModel, Transcriber } from "./modelClient.ts";
import * as orders from "./orders.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import { ReadError, readMessage } from "./read.ts";
import type { Services } from "./read.ts";
import { searchCatalog } from "./resolve.ts";
import { ReplyError, draftReply, editReply, latestReply, sendReply, twilioSender } from "./reply.ts";
import type { SendWhatsApp } from "./reply.ts";
import * as trace from "./trace.ts";
import { EMPTY_TWIML, assignNumber, downloadMedia, ensureUnknownSender, rateLimited, storeWhatsApp, validSignature } from "./twilio.ts";
import type { Download } from "./twilio.ts";
import { computeUsual, lastOrders } from "./usual.ts";
import { Predictor, demand } from "./predict.ts";
import { ModelError } from "./cache.ts";
import type { Config, CustomerDetail, FlagKind, PatchLineBody, Health, MessageDetail, MessageSummary } from "./types.ts";

const inboxOf = (cfg: Config) => cfg.inboxDir ?? join(cfg.dataDir, "inbox");

export const PUBLIC_DIR = join(ROOT, "public");

export function buildServices(cfg: Config): Services {
  if (!cfg.mock && !cfg.modelName) console.error("warning: MODEL_BASE_URL is set but MODEL_NAME is empty");
  const chat = cfg.mock
    ? new MockModel(join(cfg.dataDir, "mock"))
    : new ChatModel(cfg.modelBaseUrl, cfg.modelApiKey, cfg.modelName, cfg.modelTimeoutS, cfg.modelReasoningEffort);
  const transcriber = cfg.transcribeBaseUrl && !cfg.mock
    ? new Transcriber(cfg.transcribeBaseUrl, cfg.transcribeApiKey, cfg.transcribeModel, cfg.modelTimeoutS)
    : null;
  if (cfg.mock) console.error("CatOrder: mock model (no inference); set MODEL_BASE_URL for a real one");
  return {
    chat, transcriber, vision: cfg.modelVision, offline: cfg.offline, refresh: cfg.refresh, mock: cfg.mock,
    cacheDir: cacheDir(cfg.dataDir), dataDir: cfg.dataDir, inboxDir: inboxOf(cfg),
    hardware: cfg.modelHardware || undefined,
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".amr": "audio/amr", ".webp": "image/webp", ".ico": "image/x-icon", ".map": "application/json", ".woff2": "font/woff2",
};

// range: iOS Safari will not play audio or video unless the server answers byte ranges with 206
function sendFile(path: string, range?: string | null): Response | null {
  try {
    if (!statSync(path).isFile()) return null;
    const buf = readFileSync(path), headers: Record<string, string> = { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "content-length": String(buf.length) };
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      if (start > end || start >= buf.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${buf.length}` } });
      return new Response(buf.subarray(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${buf.length}`, "content-length": String(end - start + 1) } });
    }
    return new Response(buf, { headers });
  } catch { return null; }
}

const err = (c: Context, status: number, error: string, extra: object = {}) =>
  c.json({ error, ...extra }, status as 400);

function preview(m: { channel: string; text: string | null }): string {
  if (m.channel === "voice") return "Voice note";
  if (m.channel === "photo") return "Photo";
  return (m.text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 90);
}

/** Body must be a JSON object (FastAPI answered 422 otherwise). */
async function jsonObject(c: Context, optional: boolean): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (!text.trim()) return optional ? {} : null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const INVALID = "The request is not valid.";

export function createApp(cfg: Config, svc?: Services, download: Download = downloadMedia, sendWa?: SendWhatsApp | null): Hono & { db: DatabaseSync } {
  const services = svc ?? buildServices(cfg);
  const conn = connect(cfg.db);
  loadData(conn, cfg.dataDir, !cfg.noSamples);
  ensureUnknownSender(conn);
  const todayStr = () => cfg.today || new Date().toLocaleDateString("sv"); // sv = YYYY-MM-DD in local time
  const app = new Hono() as Hono & { db: DatabaseSync };
  app.db = conn;
  const predictor = new Predictor(cfg.predictBaseUrl ?? "", cfg.predictToken ?? "",
    { dir: services.cacheDir ?? null, offline: cfg.offline, refresh: cfg.refresh });
  const predictOne = (id: string) => {
    const cu = getCustomer(conn, id)!;
    const products = Object.fromEntries(getCatalog(conn).map((p) => [p.sku, p]));
    return predictor.predict(cu, historyOrders(conn, id), todayStr(), products);
  };

  app.onError((e, c) => {
    if (e instanceof orders.OrderError) return err(c, e.status, e.message, e.reasons?.length ? { reasons: e.reasons } : {});
    if (e instanceof ReadError || e instanceof ReplyError) return err(c, e.status, e.message);
    console.error(e);
    return err(c, 500, "Internal server error.");
  });
  app.notFound((c) => err(c, 404, "Not Found"));

  app.get("/api/health", (c) => {
    const h: Health = {
      ok: true, model: services.mock ? "mock (hand-written answers)" : services.chat.name,
      transcribe_model: services.transcriber ? services.transcriber.name : "",
      hardware: services.mock ? "no inference" : cfg.modelHardware, offline: services.offline,
      vision: services.vision && !services.mock, mock: services.mock, today: todayStr(), prompt_version: PROMPT_VERSION,
    };
    return c.json(h);
  });

  app.get("/api/messages", (c) => {
    const all = rows<Record<string, string | null>>(conn, "SELECT m.*, c.name cname FROM messages m"
      + " JOIN customers c ON c.id=m.customer_id ORDER BY (m.id LIKE 'wa-live-%') DESC, m.received_at DESC, m.id DESC");
    const out: MessageSummary[] = [];
    for (const m of all) {
      const oid = orders.latestOrderId(conn, m.id as string);
      const v = oid ? orders.orderView(conn, oid) : null;
      out.push({
        id: m.id, customer: { id: m.customer_id, name: m.cname }, channel: m.channel, received_at: m.received_at,
        preview: preview({ channel: m.channel as string, text: m.text }),
        order: v ? { id: v.id, status: v.status, clean: v.clean, message_ids: v.message_ids } : null,
        ...(m.customer_id === "unknown-sender" ? { sender: row<{ number: string }>(conn, "SELECT number FROM senders WHERE message_id=?", m.id as string)?.number ?? null } : {}),
      } as MessageSummary);
    }
    return c.json(out);
  });

  app.get("/api/messages/:id", (c) => {
    const id = c.req.param("id");
    const m = row<Record<string, unknown>>(conn, "SELECT * FROM messages WHERE id=?", id);
    if (!m) return err(c, 404, "No such message.");
    const cust = getCustomer(conn, m.customer_id as string);
    const message = { ...m, customer: { id: m.customer_id, name: cust?.name }, media_url: m.media ? `/media/${m.media}` : null };
    const oid = orders.latestOrderId(conn, id);
    return c.json({ message, order: oid ? orders.orderView(conn, oid) : null, reply: latestReply(conn, id) } as MessageDetail);
  });

  app.get("/api/messages/:id/trace", (c) => {
    const id = c.req.param("id");
    const fresh = c.req.query("fresh") === "1"; // ignore a finished read: wait for the next one
    return streamSSE(c, async (stream) => {
      const queue: { ev: string; data: unknown; slow: boolean }[] = [];
      let wake = () => {}, closed = false, ended = false;
      let seen = false;
      const put = (ev: string, data: unknown, slow: boolean) => { seen = true; queue.push({ ev, data, slow }); wake(); };
      const onEvent = (e: trace.TraceEvent) => {
        if ("step" in e) put("step", e.step, services.mock);
        else { put("done", e.done, services.mock); ended = true; }
      };
      stream.onAbort(() => { closed = true; wake(); });
      const snap = trace.snapshot(id);
      const replay = !snap.idle && !(fresh && snap.done);
      if (replay) {
        for (const s of snap.steps) put("step", s, true);
        if (snap.done) { put("done", snap.done, true); ended = true; }
      }
      const unsub = trace.subscribe(id, onEvent);
      const idle = setTimeout(() => { if (!seen) { put("idle", {}, false); ended = true; } }, 3000);
      let last = 0;
      try {
        while (!closed) {
          const item = queue.shift();
          if (!item) {
            if (ended) break;
            await new Promise<void>((r) => { wake = r; });
            continue;
          }
          if (item.slow) await stream.sleep(Math.max(0, 220 - (Date.now() - last)));
          if (closed) break;
          await stream.writeSSE({ event: item.ev, data: JSON.stringify(item.data) });
          last = Date.now();
          if (item.ev === "idle") break;
        }
      } finally {
        clearTimeout(idle); unsub();
      }
    });
  });

  app.post("/api/messages/:id/read", async (c) => c.json(await readMessage(conn, services, c.req.param("id"))));

  // empties one customer's chat (messages, orders, reads, replies) so the demo can start over; the number stays assigned
  app.delete("/api/customers/:id/messages", (c) => {
    const ids = rows<{ id: string }>(conn, "SELECT id FROM messages WHERE customer_id=?", c.req.param("id")).map((m) => m.id);
    const marks = ids.map(() => "?").join(",");
    if (ids.length) {
      const oids = "SELECT id FROM orders WHERE message_id IN (" + marks + ")";
      conn.prepare("DELETE FROM lines WHERE order_id IN (" + oids + ")").run(...ids);
      conn.prepare("DELETE FROM order_messages WHERE message_id IN (" + marks + ") OR order_id IN (" + oids + ")").run(...ids, ...ids);
      for (const t of ["orders", "replies", "runs", "senders", "traces"]) conn.prepare("DELETE FROM " + t + " WHERE " + "message_id" + " IN (" + marks + ")").run(...ids);
      conn.prepare("DELETE FROM messages WHERE id IN (" + marks + ")").run(...ids);
    }
    return c.json({ cleared: ids.length });
  });

  app.post("/api/messages/:id/assign", async (c) => {
    const { customer_id } = await c.req.json().catch(() => ({})) as { customer_id?: string };
    if (!customer_id || customer_id === "unknown-sender" || !getCustomer(conn, customer_id)) return err(c, 400, "Pick a customer.");
    return assignNumber(conn, c.req.param("id"), customer_id) ? c.json({ ok: true }) : err(c, 404, "That message has no phone number.");
  });

  app.post("/api/messages/:id/route", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { to?: string };
    if (body.to !== "new" && body.to !== "attach") return err(c, 400, "to must be \"new\" or \"attach\".");
    return c.json(await readMessage(conn, services, c.req.param("id"), body.to));
  });

  app.get("/api/customers", (c) => {
    const products = Object.fromEntries(getCatalog(conn).map((p) => [p.sku, p]));
    return c.json(rows<{ id: string }>(conn, "SELECT id FROM customers ORDER BY name").map(({ id }) => {
      const cu = getCustomer(conn, id)!;
      const hist = historyOrders(conn, id); // raw ERP history: "the usual" is worked out only when a message asks for it
      return {
        id: cu.id, name: cu.name, kind: cu.kind, context: cu.context, terms: cu.terms, order_count: hist.length,
        phone: Object.entries(cfg.whatsappPhoneMap ?? {}).find(([, cid]) => cid === id)?.[0]
          ?? row<{ number: string }>(conn, "SELECT s.number FROM senders s JOIN messages m ON m.id=s.message_id WHERE m.customer_id=? LIMIT 1", id)?.number ?? null,
        recent_orders: lastOrders(hist).map((o) => ({ date: o.date, lines: o.lines.map((ln) => ({ ...ln, name: products[ln.sku].name })) })),
      };
    }));
  });

  app.get("/api/history", (c) => {
    const products = Object.fromEntries(getCatalog(conn).map((p) => [p.sku, p]));
    const out = rows<{ id: string; name: string }>(conn, "SELECT id, name FROM customers ORDER BY name").flatMap((cu) =>
      historyOrders(conn, cu.id).map((o) => ({
        customer: { id: cu.id, name: cu.name }, date: o.date,
        lines: o.lines.map((ln) => ({ ...ln, name: products[ln.sku].name, list_price: products[ln.sku].list_price })),
      })));
    return c.json(out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)));
  });

  app.get("/api/customers/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!getCustomer(conn, id)) return err(c, 404, "No such customer.");
    return c.json(rows<Record<string, string | null>>(conn, "SELECT * FROM messages WHERE customer_id=? ORDER BY received_at, id", id).map((m) => {
      const oid = orders.latestOrderId(conn, m.id as string);
      const v = oid ? orders.orderView(conn, oid) : null;
      const sg = v?.segments.find((x) => x.message_id === m.id);
      const tr = row<{ steps: string }>(conn, "SELECT steps FROM traces WHERE message_id=?", m.id as string);
      return {
        id: m.id, channel: m.channel, received_at: m.received_at, text: m.text, media_url: m.media ? `/media/${m.media}` : null,
        order: v ? { id: v.id, status: v.status, lines: v.lines.filter((l) => l.state !== "removed").length, clean: v.clean, message_ids: v.message_ids } : null,
        reply: latestReply(conn, m.id as string),
        // the words this message gave its order, so every bubble shows what was taken from it
        words: v && sg ? { text: v.reading.slice(sg.start, sg.end), quotes: v.lines.filter((l) => l.state !== "removed" && l.quote_start >= sg.start && l.quote_end <= sg.end)
          .map((l) => ({ id: l.id, quote: l.quote, quote_start: l.quote_start - sg.start, quote_end: l.quote_end - sg.start })) } : null,
        trace: tr ? JSON.parse(tr.steps) : null,
      };
    }));
  });

  app.get("/api/customers/:id", (c) => {
    const id = c.req.param("id");
    const cu = getCustomer(conn, id);
    if (!cu) return err(c, 404, "No such customer.");
    const products = Object.fromEntries(getCatalog(conn).map((p) => [p.sku, p]));
    const hist = historyOrders(conn, id);
    const out: CustomerDetail = {
      customer: { id: cu.id, name: cu.name, kind: cu.kind, context: cu.context }, terms: cu.terms,
      usual: computeUsual(hist, products).map((u) => ({ sku: u.sku, name: products[u.sku].name, qty: u.qty })),
      recent_orders: lastOrders(hist).map((o) => ({
        date: o.date, lines: o.lines.map((ln) => ({ ...ln, name: products[ln.sku].name })),
      })),
    };
    return c.json(out);
  });

  app.get("/api/customers/:id/prediction", async (c) => {
    const id = c.req.param("id");
    if (!getCustomer(conn, id)) return err(c, 404, "No such customer.");
    if (historyOrders(conn, id).length < 2) return err(c, 409, "Not enough order history to predict.");
    try { return c.json(await predictOne(id)); }
    catch (e) { if (e instanceof ModelError) return err(c, 503, "The prediction model is not reachable."); throw e; }
  });

  // Every customer with enough history: who is due or late first, plus next week's expected demand per product.
  app.get("/api/predictions", async (c) => {
    const ids = rows<{ id: string }>(conn, "SELECT id FROM customers ORDER BY name").map((r) => r.id)
      .filter((id) => historyOrders(conn, id).length >= 2);
    const preds = [], failed: string[] = [];
    for (const id of ids) {
      try { preds.push(await predictOne(id)); }
      catch (e) { if (e instanceof ModelError) failed.push(id); else throw e; }
    }
    preds.sort((a, b) => b.days_overdue - a.days_overdue || a.next_order_date.localeCompare(b.next_order_date));
    return c.json({ today: todayStr(), customers: preds, demand_7d: demand(preds, todayStr()), failed });
  });

  app.get("/api/catalog", (c) => c.json(searchCatalog(c.req.query("q") ?? "", getCatalog(conn), c.req.query("all") ? Infinity : 20)));

  app.patch("/api/lines/:id", async (c) => {
    const body = await jsonObject(c, false);
    if (!body) return err(c, 422, INVALID);
    return c.json(orders.patchLine(conn, c.req.param("id"), body as PatchLineBody));
  });

  app.post("/api/orders/:id/lines", async (c) => {
    const body = await jsonObject(c, false);
    if (!body) return err(c, 422, INVALID);
    return c.json(orders.addLine(conn, c.req.param("id"), body));
  });

  app.post("/api/suggestions/feedback", async (c) => {
    const b = await jsonObject(c, false);
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    if (!b || (b.action !== "added" && b.action !== "dismissed") || typeof b.sku !== "string"
      || typeof b.customer_id !== "string" || (b.order_id != null && typeof b.order_id !== "string")) return err(c, 422, INVALID);
    conn.prepare("INSERT INTO suggestion_feedback (customer_id, order_id, sku, qty, p, action, at) VALUES (?,?,?,?,?,?,?)")
      .run(b.customer_id, (b.order_id as string | null) ?? null, b.sku, num(b.qty), num(b.p), b.action, nowIso());
    return c.json({ ok: true });
  });

  app.get("/api/suggestions/feedback/count", (c) => {
    const n = (a: string) => row<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM suggestion_feedback WHERE action=?", a)!.n;
    const added = n("added"), dismissed = n("dismissed");
    return c.json({ added, dismissed, total: added + dismissed });
  });

  app.post("/api/orders/:id/confirm", async (c) => {
    const body = await jsonObject(c, true);
    if (!body) return err(c, 422, INVALID);
    const ack = body.acknowledged ?? [];
    if (!Array.isArray(ack)) return err(c, 422, INVALID);
    return c.json(orders.confirm(conn, c.req.param("id"), ack as FlagKind[]));
  });

  app.get("/api/orders/:id/export", async (c) => {
    const format = c.req.query("format") ?? "csv";
    if (format !== "csv" && format !== "json") return err(c, 400, "The format must be csv or json.");
    const { content, mediaType, filename: name } = orders.exportOrder(conn, c.req.param("id"), format);
    return new Response(content, { headers: { "content-type": mediaType, "content-disposition": `attachment; filename="${name}"` } });
  });

  // the reply to the customer: drafted by the model, edited and sent by the operator
  const send = sendWa !== undefined ? sendWa
    : cfg.twilioAccountSid && cfg.twilioAuthToken ? twilioSender(cfg.twilioAccountSid, cfg.twilioAuthToken, cfg.whatsappFrom ?? "+14155238886", cfg.whatsappContentSid) : null;
  const numberOf = (cid: string) => Object.entries(cfg.whatsappPhoneMap ?? {}).find(([, id]) => id === cid)?.[0];
  app.post("/api/messages/:id/reply", async (c) => c.json(await draftReply(conn, services, c.req.param("id"))));
  app.patch("/api/replies/:id", async (c) => {
    const body = await jsonObject(c, false);
    if (!body || typeof body.text !== "string") return err(c, 422, INVALID);
    return c.json(editReply(conn, c.req.param("id"), body.text));
  });
  app.post("/api/replies/:id/send", async (c) => c.json(await sendReply(conn, c.req.param("id"), numberOf, send)));

  app.get("/api/metrics", (c) => c.json(aggregate(conn)));

  app.post("/webhook/whatsapp", async (c) => {
    const token = cfg.twilioAuthToken;
    if (!token) return err(c, 503, "WhatsApp webhook is not configured.");
    const p = new URLSearchParams(await c.req.text());
    const url = (cfg.publicUrl ?? "") + c.req.path + (new URL(c.req.url).search);
    if (!validSignature(c.req.header("x-twilio-signature"), url, Object.fromEntries(p), token)) return err(c, 403, "Bad signature.");
    const sid = p.get("MessageSid") ?? "";
    if (!/^[A-Za-z0-9]{1,64}$/.test(sid)) return err(c, 400, INVALID);
    if (rateLimited(p.get("From") ?? "")) return err(c, 429, "Too many messages.");
    const id = await storeWhatsApp(conn, p, {
      accountSid: cfg.twilioAccountSid ?? "", authToken: token, publicUrl: cfg.publicUrl ?? "",
      phoneMap: cfg.whatsappPhoneMap ?? {}, inboxDir: inboxOf(cfg) }, download);
    // answer first: Twilio gives up after 15 s and a model read can take longer; the sid is the only thing logged
    if (id) void readMessage(conn, services, id).catch(() => console.error("read failed for", sid));
    return c.body(EMPTY_TWIML, 200, { "content-type": "text/xml" });
  });

  app.get("/media/:file", (c) => {
    const file = basename(c.req.param("file"));
    const ext = extname(file);
    const res = ext === ".json" || ext === ".txt" ? null
      : sendFile(join(cfg.dataDir, "messages", file), c.req.header("range")) ?? sendFile(join(inboxOf(cfg), file), c.req.header("range"));
    return res ?? err(c, 404, "No such file.");
  });

  app.get("*", (c) => { // static page: index.html and its css/js at /
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, "");
    const full = resolve(PUBLIC_DIR, rel || ".");
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + "/")) return err(c, 404, "Not Found");
    const target = rel === "" || rel.endsWith("/") ? join(full, "index.html") : full;
    const res = sendFile(target);
    if (!res) return err(c, 404, "Not Found");
    res.headers.set("Cache-Control", "no-cache"); // revalidate: a stale app.css next to a new page is a bug the operator cannot see
    return res;
  });

  return app;
}
