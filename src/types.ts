// Shared types for CatOrder (SPEC §3, §8, §11.2, §13.6, §15). Shapes match the JSON the Python app returns.

export type SellUnit = "case" | "piece" | "kg";
export type Channel = "whatsapp" | "voice" | "photo" | "email";
export type OrderStatus = "draft" | "confirmed" | "superseded";
export type ReadingKind = "original" | "transcript" | "transcription";
export type ReadingSource = "message" | "model" | "cache" | "file";
export type LineState = "ok" | "check" | "flag" | "removed" | "confirmed";
export type Origin = "message" | "usual";
export type Stage = "transcribe" | "vision" | "extract" | "predict";

export interface Product {
  sku: string;
  name: string;
  aliases: string[];
  category: string;
  sell_unit: SellUnit;
  pack_size: number;
  pack_label: string;
  list_price: number;
}

export interface Terms {
  discount_pct: number;
  payment_days: number;
  free_delivery_min: number;
  price_overrides: Record<string, number>;
}

export interface Customer {
  id: string;
  name: string;
  kind: string;
  context: string;
  terms: Terms;
}

export interface HistoryLine { sku: string; qty: number }
export interface HistoryOrder { date: string; lines: HistoryLine[] }

/** A row of `messages` plus what the API adds. */
export interface Message {
  id: string;
  customer_id: string;
  channel: Channel;
  received_at: string; // ISO with offset, e.g. 2026-10-14T22:41:00+02:00
  sender: string;
  text: string | null;
  media: string | null;
  sha256: string;
}

// ---- Model output (§11.2) ----
export type RequestKind = "item" | "usual" | "remove" | "delivery" | "discount_request" | "price_request";
export type RequestStatus = "observed" | "inferred";

/** One element of the model's JSON array, unvalidated fields typed loosely on purpose. */
export interface Request {
  kind: RequestKind;
  quote: string;
  product: string | null;
  sku: string | null;
  quantity: string | null;
  unit: string | null;
  op: "add" | "set" | null;
  value: string | null;
  status: RequestStatus;
}

/** Output of verify (§12). `unit` is the normalised unit, `unit_text` as written. */
export interface VerifiedRequest {
  kind: RequestKind;
  quote: string;
  quote_start: number;
  quote_end: number;
  product: string; // "" when absent
  sku: string | null;
  qty: number | null;
  unit_text: string | null;
  unit: SellUnit | null;
  op: "add" | "set" | null;
  value: string | null;
  date: string | null; // delivery only, ISO date
  status: RequestStatus;
}

export type DropReason = "no_quote" | "short_quote" | "bad_kind";
export type VerifyResult =
  | { ok: true; request: VerifiedRequest }
  | { ok: false; reason: DropReason };

// ---- Resolution (§13) ----
export interface Candidate {
  sku: string;
  score: number;
  why: string;
  name?: string | null; // added by order_view
  pack_label?: string | null;
}

export type FlagKind =
  | "unknown_product" | "ambiguous_product" | "illegible" | "quantity_missing" | "pack_mismatch"
  | "converted" | "unusual_quantity" | "discount_beyond_terms" | "price_below_terms"
  | "delivery_in_past" | "no_history" | "not_in_order" | "discount_as_agreed" | "suggested";
export type FlagLevel = "line" | "order";
export type Severity = "high" | "medium" | "info";

export interface Flag {
  kind: FlagKind;
  level: FlagLevel;
  severity: Severity;
  message: string;
  check?: boolean; // pack_mismatch on a case unit: forces line state "check"
}

/** A line as stored (table `lines`, JSON columns parsed). */
export interface StoredLine {
  id: string;
  order_id: string;
  pos: number;
  origin: Origin;
  product_text: string;
  sku: string | null;
  qty: number | null;
  unit_text: string | null;
  state: LineState;
  candidates: Candidate[];
  flags: Flag[];
  quote: string;
  quote_start: number;
  quote_end: number;
  proposed_sku: string | null;
  proposed_qty: number | null;
  edited: 0 | 1;
}

/** A line as the API returns it: stored fields plus product fields and prices. */
export interface Line extends StoredLine {
  name: string | null;
  pack_label: string | null;
  sell_unit: SellUnit | null;
  unit_price: number | null;
  line_total: number | null; // null when no product, no qty, or removed
}

/** A line produced by resolve, before storage (no id, order_id). */
export type DraftLine = Omit<StoredLine, "id" | "order_id">;

export interface ResolveResult {
  lines: DraftLine[];
  flags: Flag[];
  delivery_date: string | null;
}

export interface Order {
  id: string;
  message_id: string;
  customer_id: string;
  status: OrderStatus;
  reading_kind: ReadingKind;
  reading_source: ReadingSource;
  reading: string;
  delivery_date: string | null;
  flags: Flag[];
  created_at: string;
  confirmed_at: string | null;
  message_ids: string[];
  segments: { message_id: string; start: number; end: number }[];
  lines: Line[];
  total: number;
  clean: boolean;
}

export interface Run {
  stage: Stage;
  cached: boolean;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  error: string | null;
}

/** A `runs` row as stored (§8). */
export interface RunRow {
  id: string;
  message_id: string;
  stage: Stage;
  model: string;
  prompt_version: string;
  cached: 0 | 1;
  started_at: string;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  proposed: number;
  kept: number;
  dropped_no_quote: number;
  dropped_short_quote: number;
  dropped_schema: number;
  dropped_bad_kind: number;
  error: string | null;
}

export interface Reading { kind: ReadingKind; source: ReadingSource; text: string }
/** Response of POST /api/messages/:id/read. `order` is null when the model failed. */
export interface ReadResult { order: Order | null; reading: Reading; runs: Run[] }

// ---- API shapes (§15) ----
export interface Health {
  ok: true;
  model: string;
  transcribe_model: string;
  hardware: string;
  offline: boolean;
  vision: boolean;
  mock: boolean;
  today: string;
  prompt_version: string;
}

export interface MessageSummary {
  id: string;
  customer: { id: string; name: string };
  channel: Channel;
  received_at: string;
  preview: string;
  order: { id: string; status: OrderStatus; clean: boolean; message_ids: string[] } | null;
}

export interface MessageDetail {
  message: Message & { customer: { id: string; name: string }; media_url: string | null };
  order: Order | null;
  reply: import("./reply.ts").Reply | null;
}

export interface UsualItem { sku: string; name: string; qty: number }
export interface RecentOrder { date: string; lines: (HistoryLine & { name: string })[] }
export interface CustomerDetail {
  customer: Pick<Customer, "id" | "name" | "kind" | "context">;
  terms: Terms;
  usual: UsualItem[];
  recent_orders: RecentOrder[];
}

export type CatalogResult = Product[]; // same scoring as §13.1, no history

export interface PatchLineBody { sku?: string; qty?: number; removed?: boolean }
export interface ConfirmBody { acknowledged?: FlagKind[] }

export interface ApiError { error: string; reasons?: string[] } // confirm 409 adds reasons

export interface Metrics {
  runs: number;
  cached: number;
  tokens_in: number;
  tokens_out: number;
  mean_latency_ms: number | null;
  cost_usd: number | null;
  requests_proposed: number;
  requests_kept: number;
  dropped: { no_quote: number; short_quote: number; schema: number; bad_kind: number };
  errors: number;
  lines: number;
  lines_edited: number;
  edit_rate: number | null;
  orders_confirmed: number;
}

export interface Config {
  noSamples?: boolean; // true = the sample messages are not loaded: the inbox starts empty
  modelBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  modelVision: boolean;
  modelReasoningEffort: string;
  modelTimeoutS: number;
  modelHardware: string;
  transcribeBaseUrl: string;
  transcribeApiKey: string;
  transcribeModel: string;
  db: string;
  today: string; // "" = real date
  offline: boolean;
  refresh: boolean;
  mock: boolean; // CATORDER_MOCK=1 or no MODEL_BASE_URL
  port: number;
  dataDir: string;
  inboxDir?: string; // live WhatsApp media; default <dataDir>/inbox
  twilioAccountSid?: string;
  twilioAuthToken?: string; // "" = the webhook is off
  publicUrl?: string; // https origin Twilio posts to
  whatsappPhoneMap?: Record<string, string>; // E.164 -> customer id
  whatsappContentSid?: string; // HX… template that carries the reply as {{1}}
  whatsappFrom?: string; // E.164 number replies are sent from
  predictBaseUrl?: string; // model/serve.py on the MI300X; "" = cached predictions only
  predictToken?: string;
}
