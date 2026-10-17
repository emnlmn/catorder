// Compare TS output with the Python goldens: normalise() drops volatile fields (see golden/README.md).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VOLATILE_KEYS = new Set(["id", "order_id", "created_at", "confirmed_at", "latency_ms"]);
const HEX32 = /^[0-9a-f]{32}$/;

/** Deep copy without volatile keys; also hex32 ids inside strings (CSV rows) are masked. */
export function normalise(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(normalise);
  if (json && typeof json === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      if (VOLATILE_KEYS.has(k) && !(k === "id" && isMessageOrCustomerId(json))) continue;
      out[k] = normalise(v);
    }
    return out;
  }
  return json;
}

// ponytail: message and customer rows keep their id (stable, from file names); order, line and run ids are uuid hex.
function isMessageOrCustomerId(o: object): boolean {
  const id = (o as { id?: unknown }).id;
  return typeof id === "string" && !HEX32.test(id);
}

export const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "golden");

export function golden(name: string): unknown {
  const text = readFileSync(join(goldenDir, name), "utf8");
  return name.endsWith(".json") ? JSON.parse(text) : text;
}

/** CSV: mask the order id (first column). */
export function normaliseCsv(csv: string): string {
  return csv.replace(/^[0-9a-f]{32},/gm, "<order>,");
}
