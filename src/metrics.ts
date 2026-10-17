// Run rows, cost estimate, /api/metrics (SPEC §19). Port of server/metrics.py.
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "./db.ts";
import type { Metrics, Run, RunRow, Stage } from "./types.ts";

export function costUsd(tokensIn: number | null, tokensOut: number | null): number | null {
  const pin = Number(process.env.MODEL_PRICE_IN_PER_M || 0);
  const pout = Number(process.env.MODEL_PRICE_OUT_PER_M || 0);
  if (!pin && !pout) return null;
  const v = ((tokensIn ?? 0) * pin) / 1e6 + ((tokensOut ?? 0) * pout) / 1e6;
  return Math.round(v * 1e6) / 1e6;
}

export interface RunOpts {
  cached?: boolean;
  startedAt?: string;
  latencyMs?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  error?: string | null;
  proposed?: number;
  kept?: number;
  droppedNoQuote?: number;
  droppedShortQuote?: number;
  droppedSchema?: number;
  droppedBadKind?: number;
}

export function recordRun(db: DatabaseSync, messageId: string, stage: Stage, model: string,
  promptVersion: string, o: RunOpts = {}): RunRow {
  const cached = o.cached ?? false;
  const run: RunRow = {
    id: newId(), message_id: messageId, stage, model, prompt_version: promptVersion,
    cached: cached ? 1 : 0, started_at: o.startedAt ?? nowIso(), latency_ms: o.latencyMs ?? null,
    tokens_in: o.tokensIn ?? 0, tokens_out: o.tokensOut ?? 0,
    cost_usd: cached || stage === "transcribe" ? null : costUsd(o.tokensIn ?? 0, o.tokensOut ?? 0),
    proposed: o.proposed ?? 0, kept: o.kept ?? 0, dropped_no_quote: o.droppedNoQuote ?? 0,
    dropped_short_quote: o.droppedShortQuote ?? 0, dropped_schema: o.droppedSchema ?? 0,
    dropped_bad_kind: o.droppedBadKind ?? 0, error: o.error ?? null,
  };
  const keys = Object.keys(run);
  db.prepare(`INSERT INTO runs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...(Object.values(run) as (string | number | null)[]));
  return run;
}

export function publicRun(r: RunRow): Run {
  return { stage: r.stage, cached: !!r.cached, latency_ms: r.latency_ms, tokens_in: r.tokens_in,
    tokens_out: r.tokens_out, cost_usd: r.cost_usd, error: r.error };
}

export function aggregate(db: DatabaseSync): Metrics {
  const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(cached),0) cached, COALESCE(SUM(tokens_in),0) tin,
    COALESCE(SUM(tokens_out),0) tout, AVG(CASE WHEN cached=0 THEN latency_ms END) lat, SUM(cost_usd) cost,
    COALESCE(SUM(proposed),0) proposed, COALESCE(SUM(kept),0) kept,
    COALESCE(SUM(dropped_no_quote),0) d_nq, COALESCE(SUM(dropped_short_quote),0) d_sq,
    COALESCE(SUM(dropped_schema),0) d_sc, COALESCE(SUM(dropped_bad_kind),0) d_bk,
    COALESCE(SUM(error IS NOT NULL),0) errors FROM runs`).get() as Record<string, number | null>;
  const l = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(l.edited),0) edited FROM lines l
    JOIN orders o ON o.id=l.order_id WHERE o.status != 'superseded'`).get() as { n: number; edited: number };
  const confirmed = (db.prepare("SELECT COUNT(*) c FROM orders WHERE status='confirmed'").get() as { c: number }).c;
  return {
    runs: r.n!, cached: r.cached!, tokens_in: r.tin!, tokens_out: r.tout!,
    mean_latency_ms: r.lat ?? null, cost_usd: r.cost ?? null,
    requests_proposed: r.proposed!, requests_kept: r.kept!,
    dropped: { no_quote: r.d_nq!, short_quote: r.d_sq!, schema: r.d_sc!, bad_kind: r.d_bk! },
    errors: r.errors!, lines: l.n, lines_edited: l.edited,
    edit_rate: l.n ? l.edited / l.n : null, orders_confirmed: confirmed,
  };
}
