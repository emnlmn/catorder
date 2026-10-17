// Cache per SPEC §11.5. Same key and file format as the Python app (server/read.py cached_call).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import type { Stage } from "./types.ts";

export interface Usage { prompt_tokens: number; completion_tokens: number }
export type CallResult = { text: string; usage: Usage; latency_ms: number; cached: boolean };

export class ModelError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: unknown = "") {
    const b = String(body).slice(0, 500);
    super(`model error ${status}: ${b}`);
    this.status = status;
    this.body = b;
  }
}

/** sha256 over parts, each followed by a NUL byte (like Python `sha`). */
export function sha(...parts: (string | Uint8Array | number)[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(typeof p === "string" || typeof p === "number" ? Buffer.from(String(p), "utf8") : p);
    h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}

export function cacheDir(dataDir = join(ROOT, "data")): string {
  return process.env.CATORDER_CACHE_DIR || join(dataDir, "cache");
}

export interface CacheOpts {
  dir: string | null; // null = no cache (mock)
  offline: boolean;
  refresh: boolean;
}

export async function cachedCall(
  opts: CacheOpts, stage: Stage, modelName: string, inputSha: string, contextSha: string,
  fn: () => Promise<[string, Usage]>,
): Promise<CallResult> {
  const key = sha(stage, PROMPT_VERSION, modelName, inputSha, contextSha);
  const f = opts.dir ? join(opts.dir, `${key}.json`) : null;
  if (f && existsSync(f) && !opts.refresh) {
    const c = JSON.parse(readFileSync(f, "utf8"));
    return { text: c.text, usage: c.usage, latency_ms: c.latency_ms, cached: true };
  }
  if (opts.offline) throw new ModelError(0, "offline and not in the cache");
  const t0 = performance.now();
  const [text, usage] = await fn();
  const latency_ms = Math.floor(performance.now() - t0);
  if (f) {
    mkdirSync(opts.dir!, { recursive: true });
    writeFileSync(f, JSON.stringify({ text, usage, latency_ms, model: modelName, recorded_at: new Date().toISOString() }), "utf8");
  }
  return { text, usage, latency_ms, cached: false };
}
