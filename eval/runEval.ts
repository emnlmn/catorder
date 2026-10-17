// tsx eval/runEval.ts [--channels whatsapp,photo] [--repeat 3] [--refresh]   (SPEC §18)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { buildServices } from "../src/app.ts";
import { ROOT, loadConfig } from "../src/config.ts";
import { connect, rows } from "../src/db.ts";
import { loadData } from "../src/load.ts";
import { aggregate } from "../src/metrics.ts";
import { readMessage } from "../src/read.ts";
import type { Run } from "../src/types.ts";
import { scoreMessage, summarize, type ExpectedMessage, type MessageScore } from "./match.ts";

const RESULTS = join(ROOT, "eval", "results");
const MOCK_LABEL = "mock (hand-written model answers), not a model measurement";
const TODAY = "2026-10-18";

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function runStats(runs: Run[]) {
  const live = runs.filter((r) => !r.cached && r.latency_ms !== null);
  const costs = runs.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  return {
    runs: runs.length, cached: runs.filter((r) => r.cached).length,
    tokens_in: sum(runs.map((r) => r.tokens_in ?? 0)), tokens_out: sum(runs.map((r) => r.tokens_out ?? 0)),
    mean_latency_ms: live.length ? Math.round(sum(live.map((r) => r.latency_ms as number)) / live.length) : null,
    cost_usd: costs.length ? Math.round(sum(costs) * 10000) / 10000 : null,
    errors: runs.filter((r) => r.error).length,
  };
}

export async function evaluate(channels: Set<string> | null = null, repeat = 1, refresh = false) {
  process.env.CATORDER_TODAY = process.env.CATORDER_TODAY || TODAY;
  const cfg = loadConfig();
  const expected: Record<string, ExpectedMessage> =
    JSON.parse(readFileSync(join(cfg.dataDir, "expected.json"), "utf8")).messages;
  const svc = buildServices(cfg);
  const results: MessageScore[] = [];
  const perMsgRuns = new Map<string, Run[]>();
  const dropped: Record<string, number> = {};
  const tmp = mkdtempSync(join(tmpdir(), "catorder-eval-"));
  try {
    for (let i = 0; i < repeat; i++) {
      svc.refresh = svc.refresh || refresh || i > 0; // a repeat that hits the cache measures nothing
      const db = connect(join(tmp, `eval${i}.db`));
      loadData(db, cfg.dataDir);
      const chan = new Map(rows<{ id: string; channel: string }>(db, "SELECT id, channel FROM messages").map((r) => [r.id, r.channel]));
      for (const mid of Object.keys(expected).sort()) {
        if (channels && !channels.has(chan.get(mid) ?? "")) continue;
        const out = await readMessage(db, svc, mid);
        const res = scoreMessage(expected[mid], out.order, chan.get(mid) ?? "");
        res.id = mid;
        res.run = i;
        results.push(res);
        perMsgRuns.set(mid, [...(perMsgRuns.get(mid) ?? []), ...out.runs]);
      }
      for (const [k, v] of Object.entries(aggregate(db).dropped)) dropped[k] = (dropped[k] ?? 0) + v;
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const channelNames = [...new Set(results.map((r) => r.channel))].sort();
  const allRuns = [...perMsgRuns.values()].flat();
  const byChannel: Record<string, ReturnType<typeof summarize> & ReturnType<typeof runStats>> = {};
  for (const c of channelNames) {
    const ids = new Set(results.filter((r) => r.channel === c).map((r) => r.id as string));
    byChannel[c] = {
      ...summarize(results.filter((r) => r.channel === c)),
      ...runStats([...ids].flatMap((m) => perMsgRuns.get(m) ?? [])),
    };
  }
  return {
    model: svc.chat.name, mock: svc.mock, hardware: process.env.MODEL_HARDWARE ?? "", today: process.env.CATORDER_TODAY,
    repeat, label: svc.mock ? MOCK_LABEL : "",
    overall: { ...summarize(results), ...runStats(allRuns), dropped },
    by_channel: byChannel, messages: results,
  };
}
type Report = Awaited<ReturnType<typeof evaluate>>;
type Stats = Report["overall"] | Report["by_channel"][string];

export function table(rep: Report): string {
  const head = "| | messages | line precision | line recall | orders right | candidate hit | flags found | false flags | unverified | tokens in/out | mean latency |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|\n";
  const row = (name: string, s: Stats): string => {
    const lat = s.mean_latency_ms === null ? "n/a" : `${s.mean_latency_ms} ms`;
    return `| ${name} | ${s.messages} | ${pct(s.line_precision)} (${s.lines_matched}/${s.lines_produced}) ` +
      `| ${pct(s.line_recall)} (${s.lines_matched}/${s.lines_expected}) ` +
      `| ${s.orders_right}/${s.orders_right_of} | ${pct(s.candidate_hit)} ` +
      `| ${s.flags_found}/${s.flags_expected} | ${s.false_flags} | ${s.unverified_lines} ` +
      `| ${s.tokens_in}/${s.tokens_out} | ${lat} |\n`;
  };
  let out = head + row("**overall**", rep.overall);
  for (const [c, s] of Object.entries(rep.by_channel)) out += row(c, s);
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values: a } = parseArgs({
    args: argv,
    options: { channels: { type: "string", default: "" }, repeat: { type: "string", default: "1" }, refresh: { type: "boolean", default: false } },
  });
  const chans = new Set((a.channels as string).split(",").filter(Boolean));
  const rep = await evaluate(chans.size ? chans : null, Number(a.repeat), !!a.refresh);
  const label = rep.label || `${rep.model} ${rep.hardware}`.trim();
  console.log(`CatOrder eval, ${rep.today}, ${rep.overall.messages} message reads: ${label}\n`);
  console.log(table(rep));
  const o = rep.overall;
  console.log(`non-order messages with a line or flag: ${o.non_order_violations}; dropped requests: ${JSON.stringify(o.dropped)}; ` +
    `read failures: ${o.read_failures}`);
  for (const m of rep.messages) {
    if (m.misses.length || m.extras.length || m.false_flags.length) {
      console.log(`  ${m.id}: missed ${JSON.stringify(m.misses)} extra ${JSON.stringify(m.extras)} false flags ${JSON.stringify(m.false_flags)}`);
    }
  }
  mkdirSync(RESULTS, { recursive: true });
  const f = join(RESULTS, `${rep.today}-${rep.model.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  writeFileSync(f, JSON.stringify(rep, null, 1), "utf8");
  console.log(`\nwrote ${relative(ROOT, f)}`);
  if (o.unverified_lines) {
    console.error("unverified lines found: the verbatim rule is broken");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
