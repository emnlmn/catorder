// The read pipeline (SPEC §5): reading, extraction, verification, resolution, storage. Port of server/read.py.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as metrics from "./metrics.ts";
import * as orders from "./orders.ts";
import * as prompt from "./prompt.ts";
import * as resolve from "./resolve.ts";
import * as trace from "./trace.ts";
import { routeMessage, ruleRoute } from "./route.ts";
import type { OpenDraft, RouteDecision } from "./route.ts";
import { getCatalog, getCustomer, historyOrders } from "./db.ts";
import type { Db } from "./db.ts";
import { cachedCall as cachedCallRaw, ModelError, sha } from "./cache.ts";
import type { CallResult as Called, Usage } from "./cache.ts";
import type { ChatLike, TranscriberLike } from "./modelClient.ts";
import { recentSkus } from "./usual.ts";
import { verifyRequest } from "./verify.ts";
import type { Customer, Message, Order, Reading, ReadingKind, Request, ResolveResult, Run, RunRow, Stage, VerifiedRequest } from "./types.ts";

export class ReadError extends Error {
  constructor(public status: number, public message: string) { super(message); }
}

export interface Services {
  chat: ChatLike;
  transcriber?: TranscriberLike | null; // null = committed transcripts
  vision: boolean;                  // false: photos use the committed transcription
  offline: boolean;                 // never call a model: cache and committed files only
  refresh: boolean;                 // ignore the cache
  mock: boolean;                    // chat is the MockModel: no cache, no vision
  cacheDir?: string | null;
  dataDir: string;
  inboxDir?: string;                // live WhatsApp media, searched after data/messages
  hardware?: string;                // shown in the trace
}

export interface ReadOutput {
  order: Order | null;
  reading: Reading | null;
  runs: Run[];
  error?: string;
}

// ---- cache (11.5) and runs ----

/** cache.ts cachedCall with this request's services; mock never caches. */
export function cachedCall(svc: Services, stage: Stage, modelName: string, inputSha: string,
  contextSha: string, fn: () => Promise<[string, Usage]>): Promise<Called> {
  const dir = svc.cacheDir && !svc.mock ? svc.cacheDir : null;
  return cachedCallRaw({ dir, offline: svc.offline, refresh: svc.refresh }, stage, modelName, inputSha, contextSha, fn);
}

function addRun(db: Db, runs: RunRow[], messageId: string, stage: Stage, model: string,
  o: metrics.RunOpts & { usage?: Usage } = {}): void {
  const { usage, ...rest } = o;
  runs.push(metrics.recordRun(db, messageId, stage, model, prompt.PROMPT_VERSION,
    { ...rest, tokensIn: usage?.prompt_tokens ?? 0, tokensOut: usage?.completion_tokens ?? 0 }));
}

// ---- reading (10) ----

function fileReading(svc: Services, message: Message, suffix: string): string | null {
  const f = join(svc.dataDir, "messages", `${message.id}.${suffix}.txt`);
  return existsSync(f) ? readFileSync(f, "utf-8").trim() : null;
}

function media(svc: Services, message: Message): Buffer | null {
  if (!message.media) return null;
  const file = basename(message.media);
  for (const dir of [join(svc.dataDir, "messages"), svc.inboxDir]) {
    const f = dir && join(dir, file);
    if (f && existsSync(f) && statSync(f).isFile()) return readFileSync(f);
  }
  return null;
}

/** Voice or photo through a model, with the cache. -> [text, source] or null on failure. */
async function liveReading(svc: Services, message: Message, kind: ReadingKind, runs: RunRow[],
  db: Db): Promise<[string, "cache" | "model"] | null> {
  const data = media(svc, message);
  if (!data) return null;
  let stage: Stage, model: string, fn: () => Promise<[string, Usage]>;
  if (kind === "transcript") {
    if (!svc.transcriber || svc.mock) return null;
    const t = svc.transcriber;
    stage = "transcribe"; model = t.name;
    fn = () => t.transcribe(data, message.media!);
  } else {
    if (!svc.vision || svc.mock) return null;
    stage = "vision"; model = svc.chat.name;
    const mime = message.media!.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    fn = () => svc.chat.generate(prompt.visionMessages(data, mime));
  }
  let c: Called;
  try {
    c = await cachedCall(svc, stage, model, sha(data), "", fn);
  } catch (e) {
    if (!(e instanceof ModelError)) throw e;
    addRun(db, runs, message.id, stage, model, { error: String(e.message) });
    return null;
  }
  addRun(db, runs, message.id, stage, model, { usage: c.usage, latencyMs: c.latency_ms, cached: c.cached });
  return [c.text.trim(), c.cached ? "cache" : "model"];
}

/** -> Reading, or null when no reading can be had. */
export async function getReading(db: Db, svc: Services, message: Message, runs: RunRow[]): Promise<Reading | null> {
  if (message.channel === "whatsapp" || message.channel === "email")
    return { kind: "original", source: "message", text: message.text ?? "" };
  const kind: ReadingKind = message.channel === "voice" ? "transcript" : "transcription";
  const live = await liveReading(svc, message, kind, runs, db);
  if (live) return { kind, source: live[1], text: live[0] };
  const text = fileReading(svc, message, kind);
  return text !== null ? { kind, source: "file", text } : null;
}

// ---- extraction (11) ----

export function parseArray(text: string): unknown[] {
  const t = text.replace(/```(?:json)?/g, "");
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("no JSON array found");
  let data: unknown;
  try {
    data = JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new Error("invalid JSON"); // V8 quotes the input in its message: never let model text through (SPEC §16)
  }
  if (!Array.isArray(data)) throw new Error("not an array");
  return data;
}

export interface Extracted { raw: Request[]; usage: Usage; ms: number; cached: boolean }

/** -> raw requests, or null after a recorded failure. */
export async function extract(db: Db, svc: Services, message: Message, customer: Customer,
  catalog: ReturnType<typeof getCatalog>, history: ReturnType<typeof historyOrders>, reading: Reading,
  runs: RunRow[]): Promise<Extracted | null> {
  const bySku = new Map(catalog.map((p) => [p.sku, p]));
  const recent = recentSkus(history).flatMap((s) => (bySku.has(s) ? [bySku.get(s)!] : []));
  const ctxSha = sha(prompt.extractContext(catalog, recent));
  let msgs = prompt.extractMessages(customer, catalog, recent, message, reading.kind, reading.text);
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  let msSum = 0, cachedAll = true, err = "";
  let raw: unknown[] | null = null;
  for (const attempt of [0, 1]) {
    let c: Called;
    const m = msgs;
    try {
      c = await cachedCall(svc, "extract", svc.chat.name, sha(reading.text, attempt, err), ctxSha, () => svc.chat.generate(m));
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      addRun(db, runs, message.id, "extract", svc.chat.name, { error: String(e.message) });
      return null;
    }
    usage.prompt_tokens += c.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += c.usage?.completion_tokens ?? 0;
    msSum += c.latency_ms;
    cachedAll = cachedAll && c.cached;
    try {
      raw = parseArray(c.text);
      break;
    } catch (e) {
      err = (e as Error).message;
      msgs = prompt.extractMessages(customer, catalog, recent, message, reading.kind, reading.text, err, c.text);
    }
  }
  if (raw === null) {
    addRun(db, runs, message.id, "extract", svc.chat.name,
      { usage, latencyMs: msSum, cached: cachedAll, error: `unparseable model answer: ${err}`, droppedSchema: 1 });
    return null;
  }
  return { raw: raw as Request[], usage, ms: msSum, cached: cachedAll };
}

export function verifyAll(readingText: string, raw: Request[]):
  { verified: VerifiedRequest[]; drops: Record<"no_quote" | "short_quote" | "bad_kind", number> } {
  const verified: VerifiedRequest[] = [];
  const drops = { no_quote: 0, short_quote: 0, bad_kind: 0 };
  for (const req of raw) {
    const r = verifyRequest(readingText, req);
    if (r.ok) verified.push(r.request);
    else drops[r.reason] += 1;
  }
  verified.sort((a, b) => a.quote_start - b.quote_start); // stable, like Python's sort
  return { verified, drops };
}

// ---- the pipeline (5) ----

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const CHANNEL: Record<string, string> = { whatsapp: "a WhatsApp message", voice: "a voice note", photo: "a photo", email: "an email" };

/** Reads a message and feeds the trace bus; each read resets the message's buffer. */
export async function readMessage(db: Db, svc: Services, messageId: string, force?: "new" | "attach"): Promise<ReadOutput> {
  let message = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as unknown as Message | undefined;
  if (!message) throw new ReadError(404, "No such message.");
  const prev = orders.latestOrderId(db, messageId);
  const pv = prev ? orders.orderView(db, prev) : null;
  if (pv?.status === "confirmed") throw new ReadError(409, "This order is confirmed and cannot be read again.");
  // re-reading an earlier message of a group re-reads the whole group through its last message, so none is left without an order
  const last = pv?.message_ids?.at(-1);
  if (!force && last && last !== messageId)
    message = db.prepare("SELECT * FROM messages WHERE id=?").get(last) as unknown as Message;
  trace.begin(messageId);
  const step = (s: trace.StepInput) => trace.push(messageId, s);
  const keep = () => db.prepare("INSERT OR REPLACE INTO traces (message_id, steps) VALUES (?,?)").run(messageId, JSON.stringify(trace.snapshot(messageId).steps));
  try {
    const out = await run(db, svc, message, step, force);
    if (out.error) step({ kind: "error", status: "warn", title: out.error });
    trace.finish(messageId, { order_id: out.order?.id ?? null, ...(out.error ? { error: out.error } : {}) });
    keep();
    return out;
  } catch (e) {
    const error = e instanceof ReadError ? e.message : "The read failed.";
    if (!(e instanceof ReadError)) console.error("read failed for", messageId, e);
    step({ kind: "error", status: "warn", title: error });
    trace.finish(messageId, { order_id: null, error });
    keep();
    throw e;
  }
}

async function run(db: Db, svc: Services, message: Message, step: (s: trace.StepInput) => void,
  force?: "new" | "attach"): Promise<ReadOutput> {
  const messageId = message.id;
  const runs: RunRow[] = [];
  const pub = () => runs.map(metrics.publicRun);
  const customer = getCustomer(db, message.customer_id);
  if (!customer) throw new ReadError(404, "No such customer.");
  step({ kind: "start", status: "ok", title: `Reading ${CHANNEL[message.channel] ?? "a message"} from ${customer.name}` });
  const isMedia = message.channel === "voice" || message.channel === "photo";
  const rk = message.channel === "voice" ? "transcribe" : "vision";
  const t = Date.now();
  if (isMedia) step({ kind: rk, status: "run", title: rk === "transcribe"
    ? `Transcribing the voice note with ${svc.transcriber?.name ?? "the committed transcript"}…` : `Reading the photo with ${svc.chat.name}…` });
  const reading = await getReading(db, svc, message, runs);
  if (isMedia && reading) {
    const from = reading.source === "model" ? `in ${secs(Date.now() - t)}` : reading.source === "cache" ? "from cache" : "from the committed file";
    step({ kind: rk, status: "ok", title: `${rk === "transcribe" ? "Transcribed" : "Read"} ${from}` });
  }
  if (!reading) {
    const error = message.channel === "voice" && !svc.transcriber
      ? "No transcription model is set up, so this voice note cannot be read yet. Play it in the chat."
      : "The message could not be read and there is no committed reading.";
    if (isMedia) step({ kind: rk, status: "warn", title: rk === "transcribe" ? "Could not transcribe the voice note" : "Could not read the photo" });
    return { order: null, reading: null, runs: pub(), error };
  }
  // the customer's open draft: messages before this one, not including it
  const prevId = orders.latestOrderId(db, messageId);
  const open = openDraft(db, message);
  let decision: RouteDecision = force && open ? { action: force, quote: null, reason: "set by the operator", by: "rule" }
    : force ? { action: "new", quote: null, reason: "set by the operator", by: "rule" }
    : open ? await routeMessage(svc, reading.text, message.received_at, open.draft) : ruleRoute(reading.text, message.received_at, null);
  if (!open && decision.action === "attach") decision = { ...decision, action: "new" };
  const model = decision.by === "rule" ? " · rule" : ` · ${svc.chat.name}`;
  const q = decision.quote ? `«${decision.quote}» → ` : "";
  step(decision.action === "attach"
    ? { kind: "route", status: "ok", title: `${q}adds to the open order · ${Math.max(0, Math.round((Date.parse(message.received_at) - Date.parse(open!.draft.lastAt)) / 60000))} min after`, detail: decision.reason + model }
    : decision.action === "none" ? { kind: "route", status: "warn", title: "Not an order: a question, no products", detail: decision.reason + model }
    : { kind: "route", status: "ok", title: `${q}Starts a new order`, detail: decision.reason + model });
  const attach = decision.action === "attach" && open ? open : null;
  let segments: orders.Segment[] | undefined;
  if (attach) {
    const text = [...attach.texts, reading.text].join("\n\n");
    let at = 0;
    segments = [...attach.ids, messageId].map((id, i) => {
      const len = [...attach.texts, reading.text][i].length;
      const sg = { message_id: id, start: at, end: at + len };
      at += len + 2;
      return sg;
    });
    reading.text = text;
  }
  const catalog = getCatalog(db);
  const history = historyOrders(db, message.customer_id);
  step({ kind: "context", status: "ok", title: `Loaded ${n(history.length, "past order")} and ${n(catalog.length, "product")} from the ERP` });
  step({ kind: "model", status: "run", title: svc.mock ? "Demo mode: using scripted answers…"
    : `Asking ${svc.chat.name} on ${svc.hardware ?? "AMD"}…` });
  let got: Extracted | null;
  if (decision.action === "none") got = { raw: [], usage: { prompt_tokens: 0, completion_tokens: 0 }, ms: 0, cached: true };
  else if (attach && svc.mock) { // mock answers are keyed by message id: one call per message, requests concatenated
    got = { raw: [], usage: { prompt_tokens: 0, completion_tokens: 0 }, ms: 0, cached: true };
    for (const sg of segments!) {
      const m = db.prepare("SELECT * FROM messages WHERE id=?").get(sg.message_id) as unknown as Message;
      const g1 = await extract(db, svc, m, customer, catalog, history, { ...reading, text: reading.text.slice(sg.start, sg.end) }, runs);
      if (g1) got.raw.push(...g1.raw); else { got = null; break; }
    }
  } else got = await extract(db, svc, message, customer, catalog, history, reading, runs);
  if (!got) return { order: null, reading, runs: pub(), error: "The model answer could not be used." };
  step(svc.mock ? { kind: "model", status: "ok", title: `Mock answer: ${n(got.raw.length, "request")}`, detail: "No inference in demo mode" }
    : { kind: "model", status: "ok", title: `${svc.chat.name} proposed ${n(got.raw.length, "request")} in ${secs(got.ms)}${
      got.cached ? " (cached)" : ""}`, detail: `${(got.usage.prompt_tokens + got.usage.completion_tokens).toLocaleString("en-US")} tokens` });
  const { verified, drops } = verifyAll(reading.text, got.raw);
  addRun(db, runs, messageId, "extract", svc.chat.name, {
    usage: got.usage, latencyMs: got.ms, cached: got.cached, proposed: got.raw.length, kept: verified.length,
    droppedNoQuote: drops.no_quote, droppedShortQuote: drops.short_quote, droppedBadKind: drops.bad_kind });
  const dropped = got.raw.length - verified.length;
  step(dropped ? { kind: "verify", status: "warn", title: `Dropped ${n(dropped, "request")} with no quote in the message` }
    : { kind: "verify", status: "ok", title: got.raw.length === 1 ? "The request cites the customer's exact words"
      : `All ${got.raw.length} cite the customer's exact words` });
  const result = resolve.resolve(verified, catalog, customer, history, message.received_at.slice(0, 10));
  traceResult(result, catalog, step);
  const oid = orders.storeOrder(db, message, reading, result, segments, [...(attach ? [attach.draft.orderId] : []), ...(prevId ? [prevId] : [])]);
  const live = result.lines.filter((l) => l.state !== "removed");
  const check = live.filter((l) => l.state !== "ok").length;
  step({ kind: "draft", status: "ok", title: `Draft order ready · ${n(live.length, "line")}, ${check} to check` });
  return { order: orders.orderView(db, oid), reading, runs: pub() };
}

/** The customer's latest draft whose messages all came before this one and don't include it. */
function openDraft(db: Db, message: Message): { draft: OpenDraft; ids: string[]; texts: string[] } | null {
  const o = db.prepare("SELECT id, reading FROM orders WHERE customer_id=? AND status='draft' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(message.customer_id) as { id: string; reading: string } | undefined;
  if (!o) return null;
  let segs = orders.segmentsOf(db, o.id);
  const i = segs.findIndex((s) => s.message_id === message.id);
  if (i >= 0) segs = segs.slice(0, i); // a re-read: only what precedes this message
  if (!segs.length) return null;
  const found = segs.map((s) => db.prepare("SELECT received_at FROM messages WHERE id=?").get(s.message_id) as { received_at: string } | undefined);
  if (found.some((f) => !f)) return null; // a draft pointing at a deleted message cannot be extended
  const at = found.map((f) => f!.received_at);
  if (at.some((a) => a >= message.received_at)) return null;
  const texts = segs.map((s) => o.reading.slice(s.start, s.end));
  const view = orders.orderView(db, o.id)!;
  const lines = view.lines.filter((l) => l.state !== "removed").map((l) => ({ name: l.name ?? l.product_text, qty: l.qty }));
  return { draft: { orderId: o.id, lastAt: at[at.length - 1], texts, lines }, ids: segs.map((s) => s.message_id), texts };
}

function traceResult(result: ResolveResult, catalog: ReturnType<typeof getCatalog>, step: (s: trace.StepInput) => void): void {
  const name = (sku: string | null) => catalog.find((p) => p.sku === sku)?.name ?? sku ?? "?";
  const usual = result.lines.filter((l) => l.origin === "usual");
  if (usual.length) step({ kind: "usual", status: "ok", title: `«il solito» → ${n(usual.length, "line")} from the last orders` });
  let shown = 0;
  for (const l of result.lines) {
    if (l.origin === "usual" || l.state === "removed") continue;
    if (l.sku === null) {
      const c = l.candidates.slice(0, 2).map((x) => name(x.sku));
      step({ kind: "match", status: "warn", title: c.length > 1
        ? `«${l.product_text}» → ${n(l.candidates.length, "candidate")}: ${c.join(" or ")}` : `«${l.product_text}» → no product found` });
    } else if (shown++ < 6) step({ kind: "match", status: "ok", title: `«${l.product_text}» → ${name(l.sku)}` });
  }
  const flags = [...result.flags, ...result.lines.filter((l) => l.state !== "removed").flatMap((l) => l.flags)];
  for (const f of flags.filter((f) => f.severity !== "info" && f.kind !== "ambiguous_product" && f.kind !== "unknown_product"))
    step({ kind: "flag", status: "warn", title: f.message });
}
