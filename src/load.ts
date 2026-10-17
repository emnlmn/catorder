// Startup load of data/ into SQLite. Idempotent; tolerates a missing or incomplete data dir.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "./db.ts";

type J = Record<string, any>; // ponytail: data files are trusted JSON, loosely typed

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const stem = (f: string) => basename(f, ".json");
const jsonFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
const listOf = (x: any, key: string): J[] => (Array.isArray(x) ? x : (x?.[key] ?? []));

function loadProducts(db: Db, data: string): void {
  const f = join(data, "catalog.json");
  if (!existsSync(f)) return;
  const ins = db.prepare("INSERT OR REPLACE INTO products VALUES (?,?,?,?,?,?,?,?)");
  for (const p of listOf(readJson(f), "products"))
    ins.run(p.sku, p.name, JSON.stringify(p.aliases ?? []), p.category, p.sell_unit,
      p.pack_size ?? 1, p.pack_label, p.list_price);
}

function loadCustomers(db: Db, data: string): void {
  const ins = db.prepare("INSERT OR REPLACE INTO customers VALUES (?,?,?,?,?)");
  for (const f of jsonFiles(join(data, "customers"))) {
    const c = readJson(join(data, "customers", f));
    ins.run(stem(f), c.name, c.kind ?? "", c.context ?? "", JSON.stringify(c.terms ?? {}));
  }
}

function loadHistory(db: Db, data: string): void {
  const skus = new Set(db.prepare("SELECT sku FROM products").all().map((r) => r.sku));
  const del = db.prepare("DELETE FROM history WHERE customer_id=?");
  const ins = db.prepare("INSERT INTO history VALUES (?,?,?,?)");
  for (const f of jsonFiles(join(data, "history"))) {
    del.run(stem(f));
    for (const o of listOf(readJson(join(data, "history", f)), "orders"))
      for (const ln of o.lines) if (skus.has(ln.sku)) ins.run(stem(f), o.date, ln.sku, ln.qty);
  }
}

function loadMessages(db: Db, data: string): void {
  const dir = join(data, "messages");
  const ins = db.prepare("INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?)");
  for (const f of jsonFiles(dir)) {
    const m = readJson(join(dir, f));
    const text: string | null = m.text ?? null;
    const media: string | null = m.media ?? null;
    const blob = media && existsSync(join(dir, media)) ? readFileSync(join(dir, media)) : Buffer.from(text ?? "");
    ins.run(stem(f), m.customer_id || m.customer, m.channel, m.received_at, m.sender ?? "", text, media,
      createHash("sha256").update(blob).digest("hex"));
  }
}

export function loadData(db: Db, dataDir: string, samples = true): void {
  db.exec("BEGIN");
  try {
    loadProducts(db, dataDir);
    loadCustomers(db, dataDir);
    loadHistory(db, dataDir);
    if (samples) loadMessages(db, dataDir);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
