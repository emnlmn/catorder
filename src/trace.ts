// In-memory trace bus: the steps of the latest read of each message, streamed to the UI over SSE.
export interface TraceStep {
  at: number; // ms since the read started
  kind: "start" | "transcribe" | "vision" | "context" | "route" | "model" | "verify" | "match" | "usual" | "flag" | "draft" | "error";
  status: "run" | "ok" | "warn";
  title: string;
  detail?: string;
}
export type StepInput = Omit<TraceStep, "at">;
export interface TraceDone { order_id: string | null; error?: string }
export type TraceEvent = { step: TraceStep } | { done: TraceDone };

interface Entry { steps: TraceStep[]; done: TraceDone | null; t0: number; subs: Set<(e: TraceEvent) => void> }
const entries = new Map<string, Entry>();

function entry(id: string): Entry {
  let e = entries.get(id);
  if (!e) entries.set(id, e = { steps: [], done: null, t0: 0, subs: new Set() });
  return e;
}

/** A new read of this message: drop the old buffer, keep the listeners. */
export function begin(id: string): void {
  const e = entry(id);
  e.steps = []; e.done = null; e.t0 = Date.now();
}

export function push(id: string, s: StepInput): void {
  const e = entry(id);
  const step: TraceStep = { at: Date.now() - e.t0, ...s };
  e.steps.push(step);
  for (const f of e.subs) f({ step });
}

export function finish(id: string, done: TraceDone): void {
  const e = entry(id);
  e.done = done;
  for (const f of e.subs) f({ done });
}

/** Buffered steps of the latest read; `done` is null while it runs, `idle` when nothing was read yet. */
export function snapshot(id: string): { steps: TraceStep[]; done: TraceDone | null; idle: boolean } {
  const e = entry(id);
  return { steps: [...e.steps], done: e.done, idle: !e.steps.length && !e.done };
}

export function subscribe(id: string, f: (e: TraceEvent) => void): () => void {
  const e = entry(id);
  e.subs.add(f);
  return () => { e.subs.delete(f); };
}
