import type { HttpBenchmarkResults, RunResult, Strategy, STRATEGIES, STRATEGY_LABELS } from "../benchmarks/http-e2e";

function r2(n: number) { return Math.round(n * 100) / 100; }
function ms(n: number) {
  if (n >= 1000) return `${r2(n / 1000)}s`;
  if (n >= 1) return `${r2(n)}ms`;
  return `${Math.round(n * 1000)}us`;
}
function num(n: number) { return n.toLocaleString("en-US"); }
function rps(n: number) { return n >= 1000 ? `${r2(n / 1000)}k` : String(Math.round(n)); }
function toMB(bytes: number) { return r2(bytes / 1024 / 1024); }

function mdTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const head = "| " + headers.map((h, i) => h.padEnd(widths[i])).join(" | ") + " |";
  const body = rows.map(
    (row) => "| " + row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join(" | ") + " |"
  );
  return [head, sep, ...body].join("\n");
}

function find(results: RunResult[], strategy: Strategy, size: number): RunResult {
  return results.find((r) => r.strategy === strategy && r.payloadSize === size)!;
}

const LABELS: Record<Strategy, string> = {
  "buffered": "Buffered",
  "stream-cursor": "porsager cursor",
  "stream-foreach": "porsager forEach",
  "yield-cursor": "Elysia yield",
  "pg-query-stream": "pg-query-stream",
};

export function buildMarkdownReport(
  bench: HttpBenchmarkResults,
  meta: { platform: string; runtime: string; pgVersion: string; seedCount: number }
): string {
  const lines: string[] = [];
  const strats = bench.strategies;

  lines.push("# Benchmark Results");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Platform: ${meta.platform}`);
  lines.push(`> Runtime: ${meta.runtime}`);
  lines.push(`> PostgreSQL: ${meta.pgVersion}`);
  lines.push(`> DB rows: ${num(meta.seedCount)} | Concurrency: ${bench.concurrency}`);
  lines.push("");

  lines.push("## Strategies");
  lines.push("");
  lines.push("| Strategy | DB driver | DB access | HTTP response |");
  lines.push("| --- | --- | --- | --- |");
  lines.push("| **Buffered** | porsager/postgres | `SELECT ... LIMIT N` | JSON array |");
  lines.push("| **porsager cursor** | porsager/postgres | `.cursor(500)` | `ReadableStream` NDJSON |");
  lines.push("| **porsager forEach** | porsager/postgres | `.forEach(fn)` | `ReadableStream` NDJSON |");
  lines.push("| **Elysia yield** | porsager/postgres | `.cursor(500)` | Elysia `yield` generator |");
  lines.push("| **pg-query-stream** | node-postgres (pg) | cursor stream | `ReadableStream` NDJSON |");
  lines.push("");
  lines.push("DB driver benchmarks (mitata) are printed to stdout above.");
  lines.push("Below: HTTP E2E results with peak memory measurement.");
  lines.push("");
  lines.push("---");
  lines.push("");

  // Memory table
  lines.push("## Peak Memory (RSS delta from baseline)");
  lines.push("");
  const memHeaders = ["Rows", ...strats.map((s) => LABELS[s])];
  const memRows: string[][] = [];
  for (const size of bench.payloadSizes) {
    const row = [num(size)];
    for (const s of strats) {
      row.push(`+${find(bench.results, s, size).peakRssDeltaMB}MB`);
    }
    memRows.push(row);
  }
  lines.push(mdTable(memHeaders, memRows));
  lines.push("");

  // Throughput table
  lines.push("## Throughput (RPS)");
  lines.push("");
  const rpsHeaders = ["Rows", ...strats.map((s) => LABELS[s])];
  const rpsRows: string[][] = [];
  for (const size of bench.payloadSizes) {
    const row = [num(size)];
    for (const s of strats) {
      row.push(rps(find(bench.results, s, size).rps));
    }
    rpsRows.push(row);
  }
  lines.push(mdTable(rpsHeaders, rpsRows));
  lines.push("");

  // Latency table
  lines.push("## p95 Latency");
  lines.push("");
  const latHeaders = ["Rows", ...strats.map((s) => LABELS[s])];
  const latRows: string[][] = [];
  for (const size of bench.payloadSizes) {
    const row = [num(size)];
    for (const s of strats) {
      row.push(ms(find(bench.results, s, size).p95));
    }
    latRows.push(row);
  }
  lines.push(mdTable(latHeaders, latRows));
  lines.push("");

  // Absolute RSS
  lines.push("## Absolute Peak RSS (MB)");
  lines.push("");
  const absHeaders = ["Rows", ...strats.map((s) => LABELS[s])];
  const absRows: string[][] = [];
  for (const size of bench.payloadSizes) {
    const row = [num(size)];
    for (const s of strats) {
      row.push(String(toMB(find(bench.results, s, size).peakRss)));
    }
    absRows.push(row);
  }
  lines.push(mdTable(absHeaders, absRows));
  lines.push("");

  // Key takeaways
  lines.push("---");
  lines.push("");
  lines.push("## Key Takeaways");
  lines.push("");

  const largest = bench.payloadSizes[bench.payloadSizes.length - 1];
  const bufResult = find(bench.results, "buffered", largest);
  const streamStrats = strats.filter((s) => s !== "buffered");
  const streamResults = streamStrats.map((s) => find(bench.results, s, largest));
  const bestMem = streamResults.reduce((a, b) => a.peakRssDeltaMB < b.peakRssDeltaMB ? a : b);
  const bestRps = streamResults.reduce((a, b) => a.rps > b.rps ? a : b);

  const factor = bufResult.peakRssDeltaMB / Math.max(bestMem.peakRssDeltaMB, 0.01);
  lines.push(`- **All streaming strategies use ~${r2(factor)}x less memory** than buffered at ${num(largest)} rows`);
  lines.push(`- Buffered: +${bufResult.peakRssDeltaMB}MB vs best streaming (${LABELS[bestMem.strategy]}): +${bestMem.peakRssDeltaMB}MB`);

  const memSpread = Math.max(...streamResults.map((r) => r.peakRssDeltaMB)) - Math.min(...streamResults.map((r) => r.peakRssDeltaMB));
  if (memSpread < 30) {
    lines.push(`- All streaming strategies have **similar memory** (within ${r2(memSpread)}MB)`);
  }

  lines.push(`- Highest streaming RPS at ${num(largest)} rows: **${LABELS[bestRps.strategy]}** (${rps(bestRps.rps)})`);

  const streamPeaks = streamStrats.map((s) =>
    Math.max(...bench.payloadSizes.map((sz) => find(bench.results, s, sz).peakRss / 1024 / 1024))
  );
  const maxStreamRSS = Math.max(...streamPeaks);
  lines.push(`- With streaming, server RSS stays under ~${Math.ceil(maxStreamRSS)}MB — safe for container memory limits`);
  lines.push("");

  return lines.join("\n");
}
