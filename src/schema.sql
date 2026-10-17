CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',   -- JSON list
  category TEXT NOT NULL, sell_unit TEXT NOT NULL CHECK (sell_unit IN ('case','piece','kg')),
  pack_size INTEGER NOT NULL DEFAULT 1, pack_label TEXT NOT NULL, list_price REAL NOT NULL);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL);                                -- JSON: discount_pct, payment_days, free_delivery_min, price_overrides

CREATE TABLE IF NOT EXISTS history (
  customer_id TEXT NOT NULL REFERENCES customers(id), date TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES products(sku), qty REAL NOT NULL);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','voice','photo','email')),
  received_at TEXT NOT NULL, sender TEXT NOT NULL,
  text TEXT, media TEXT, sha256 TEXT NOT NULL);       -- text for whatsapp/email; media file name for voice/photo

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('transcribe','vision','extract')),
  model TEXT NOT NULL, prompt_version TEXT NOT NULL, cached INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  proposed INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0,
  dropped_no_quote INTEGER NOT NULL DEFAULT 0, dropped_short_quote INTEGER NOT NULL DEFAULT 0,
  dropped_schema INTEGER NOT NULL DEFAULT 0, dropped_bad_kind INTEGER NOT NULL DEFAULT 0, error TEXT);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','confirmed','superseded')),
  reading_kind TEXT NOT NULL CHECK (reading_kind IN ('original','transcript','transcription')),
  reading_source TEXT NOT NULL CHECK (reading_source IN ('message','model','cache','file')),
  reading TEXT NOT NULL,                               -- the text every quote is located in
  delivery_date TEXT, flags TEXT NOT NULL DEFAULT '[]', -- JSON, order-level flags (§13.6)
  created_at TEXT NOT NULL, confirmed_at TEXT);

CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), pos INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('message','usual')),
  product_text TEXT NOT NULL,                          -- as written, or the product name for a usual line
  sku TEXT REFERENCES products(sku), qty REAL,
  unit_text TEXT,                                      -- as written
  state TEXT NOT NULL CHECK (state IN ('ok','check','flag','removed','confirmed')),
  candidates TEXT NOT NULL DEFAULT '[]',               -- JSON [{sku, score, why}]
  flags TEXT NOT NULL DEFAULT '[]',                    -- JSON (§13.6)
  quote TEXT NOT NULL, quote_start INTEGER NOT NULL, quote_end INTEGER NOT NULL,
  proposed_sku TEXT, proposed_qty REAL,                -- what the pipeline proposed, kept when a person edits
  edited INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS lines_order ON lines(order_id, pos);

-- the number a live WhatsApp message came from, so the reply can go back to it (unknown senders included); never committed
CREATE TABLE IF NOT EXISTS senders (message_id TEXT PRIMARY KEY REFERENCES messages(id), number TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  text TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','sent')),
  via TEXT CHECK (via IN ('whatsapp','demo')),           -- demo: no WhatsApp number, nothing was delivered
  model TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT);

CREATE TABLE IF NOT EXISTS order_messages (
  order_id TEXT NOT NULL, message_id TEXT NOT NULL, pos INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  PRIMARY KEY (order_id, message_id));
