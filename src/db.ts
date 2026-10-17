// SQLite connection (node:sqlite) and the small read helpers shared by the modules.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Customer, HistoryOrder, Product, Terms } from "./types.ts";

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;

const SCHEMA = new URL("./schema.sql", import.meta.url);

export function newId(): string {
  return randomUUID().replaceAll("-", "");
}

/** Local time, ISO seconds, no offset (like Python's datetime.now().isoformat(timespec="seconds")). */
export function nowIso(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function connect(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db;
}

/** All rows as plain objects (node:sqlite rows have a null prototype). */
export function rows<T = Row>(db: Db, sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args).map((r) => ({ ...r }) as T);
}

export function row<T = Row>(db: Db, sql: string, ...args: SQLInputValue[]): T | undefined {
  const r = db.prepare(sql).get(...args);
  return r ? ({ ...r } as T) : undefined;
}

export function getCatalog(db: Db): Product[] {
  return rows<Omit<Product, "aliases"> & { aliases: string }>(db, "SELECT * FROM products ORDER BY sku").map((p) => ({
    ...p,
    aliases: JSON.parse(p.aliases) as string[],
  }));
}

export function getCustomer(db: Db, id: string): Customer | null {
  const r = row<Omit<Customer, "terms"> & { terms: string }>(db, "SELECT * FROM customers WHERE id=?", id);
  return r ? { ...r, terms: JSON.parse(r.terms) as Terms } : null;
}

/** History rows grouped to [{date, lines: [{sku, qty}]}], dates ascending. */
export function historyOrders(db: Db, customerId: string): HistoryOrder[] {
  const byDate = new Map<string, HistoryOrder>();
  for (const r of rows<{ date: string; sku: string; qty: number }>(
    db, "SELECT date, sku, qty FROM history WHERE customer_id=? ORDER BY date", customerId)) {
    let o = byDate.get(r.date);
    if (!o) byDate.set(r.date, (o = { date: r.date, lines: [] }));
    o.lines.push({ sku: r.sku, qty: r.qty });
  }
  return [...byDate.values()];
}
