import type { E2eBenchmarkResults, RunResult, Strategy } from "../benchmarks/e2e";
import { STRATEGIES, toMB } from "../benchmarks/e2e";

function r2(n: number) { return Math.round(n * 100) / 100; }
function ms(n: number) {
  if (n >= 1000) return `${r2(n / 1000)}s`;
  if (n >= 1) return `${r2(n)}ms`;
  return `${Math.round(n * 1000)}us`;
}
function num(n: number) { return n.toLocaleString("en-US"); }
function mbps(bps: number) { return `${r2(bps / 1_000_000)}MB/s`; }
function rps(n: number) { return n >= 1000 ? `${r2(n / 1000)}k` : String(Math.round(n)); }

const LABELS: Record<Strategy, string> = {
  buffered: "Buffered",
  "stream-cursor": "Cursor+RS",
  "stream-foreach": "forEach+RS",
  "yield-cursor": "Yield+Cursor",
};

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

export function buildMarkdownReport(
  bench: E2eBenchmarkResults,
  meta: { platform: string; runtime: string; pgVersion: string; seedCount: number }
): string {
  const lines: string[] = [];
  const strats = bench.strategies;

  lines.push("# E2E Benchmark: Response Strategies from PostgreSQL");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Platform: ${meta.platform}`);
  lines.push(`> Runtime: ${meta.runtime}`);
  lines.push(`> PostgreSQL: ${meta.pgVersion}`);
  lines.push(`> DB rows: ${num(meta.seedCount)} | Concurrency: ${bench.concurrency}`);
  lines.push("");

  lines.push("## Strategies");
  lines.push("");
  lines.push("| Strategy | DB access | HTTP response | Memory model |");
  lines.push("| --- | --- | --- | --- |");
  lines.push("| **Buffered** | `SELECT ... LIMIT N` (all at once) | JSON array | Grows with N |");
  lines.push("| **Cursor+RS** | `.cursor(500)` batched iteration | `ReadableStream` NDJSON | Flat |");
  lines.push("| **forEach+RS** | `.forEach(fn)` instant row callback | `ReadableStream` NDJSON | Flat |");
  lines.push("| **Yield+Cursor** | `.cursor(500)` batched iteration | Elysia `yield` generator | Flat |");
  lines.push("");
  lines.push("Primary metric: **peak memory (RSS)**. Secondary: throughput, latency.");
  lines.push("");
  lines.push("---");
  lines.push("");

  // Memory table
  lines.push("## Peak Memory (RSS delta from baseline)");
  lines.push("");
  lines.push("How much *extra* memory above the server's idle baseline during concurrent load.");
  lines.push("");

  const memHeaders = ["Rows", ...strats.map((s) => LABELS[s])];
  const memTableRows: string[][] = [];
  for (const size of bench.payloadSizes) {
    const row = [num(size)];
    for (const s of strats) {
      row.push(`+${find(bench.results, s, size).peakRssDeltaMB}MB`);
    }
    memTableRows.push(row);
  }
  lines.push(mdTable(memHeaders, memTableRows));
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
      row.push(ms(find(bench.results, s, size).latency.p95));
    }
    latRows.push(row);
  }
  lines.push(mdTable(latHeaders, latRows));
  lines.push("");

  // Absolute memory
  lines.push("## Absolute Peak RSS (MB)");
  lines.push("");
  const absHeaders = ["Rows", ...strats.map((s) => LABELS[s])];
  const absRows: string[][] = [];
  for (const size of bench.payloadSizes) {
    const row = [num(size)];
    for (const s of strats) {
      row.push(String(r2(find(bench.results, s, size).peakMemory.rss / 1024 / 1024)));
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
  const streamResults = strats.filter((s) => s !== "buffered").map((s) => find(bench.results, s, largest));
  const bestStream = streamResults.reduce((a, b) => a.peakRssDeltaMB < b.peakRssDeltaMB ? a : b);
  const worstStream = streamResults.reduce((a, b) => a.peakRssDeltaMB > b.peakRssDeltaMB ? a : b);

  // Memory comparison
  if (bestStream.peakRssDeltaMB < bufResult.peakRssDeltaMB) {
    const factor = bufResult.peakRssDeltaMB / Math.max(bestStream.peakRssDeltaMB, 0.01);
    lines.push(`- **All streaming strategies use dramatically less memory than buffered** at ${num(largest)} rows`);
    lines.push(`- Best streaming (${LABELS[bestStream.strategy]}): +${bestStream.peakRssDeltaMB}MB vs buffered: +${bufResult.peakRssDeltaMB}MB (~${r2(factor)}x less)`);
  }

  // Streaming comparison
  const memSpread = worstStream.peakRssDeltaMB - bestStream.peakRssDeltaMB;
  if (memSpread < 20) {
    lines.push(`- All three streaming strategies have **similar memory profiles** (within ${r2(memSpread)}MB of each other)`);
  } else {
    lines.push(`- Among streaming strategies, ${LABELS[bestStream.strategy]} uses the least memory (+${bestStream.peakRssDeltaMB}MB)`);
  }

  // RPS comparison between streaming strategies
  const fastestStream = streamResults.reduce((a, b) => a.rps > b.rps ? a : b);
  const slowestStream = streamResults.reduce((a, b) => a.rps < b.rps ? a : b);
  if (fastestStream.rps > slowestStream.rps * 1.2) {
    lines.push(`- **${LABELS[fastestStream.strategy]}** has the highest streaming RPS at ${num(largest)} rows (${rps(fastestStream.rps)} vs ${rps(slowestStream.rps)})`);
  } else {
    lines.push(`- Streaming RPS is similar across all three strategies at ${num(largest)} rows`);
  }

  // forEach vs cursor insight
  const cursorR = find(bench.results, "stream-cursor", largest);
  const forEachR = find(bench.results, "stream-foreach", largest);
  if (forEachR.rps > cursorR.rps * 1.15) {
    lines.push(`- **forEach is faster than cursor** for DB iteration (${rps(forEachR.rps)} vs ${rps(cursorR.rps)} RPS) — less overhead per row`);
  } else if (cursorR.rps > forEachR.rps * 1.15) {
    lines.push(`- **cursor is faster than forEach** for DB iteration (${rps(cursorR.rps)} vs ${rps(forEachR.rps)} RPS)`);
  } else {
    lines.push(`- cursor and forEach have similar throughput — choose based on API ergonomics`);
  }

  // yield vs ReadableStream insight
  const yieldR = find(bench.results, "yield-cursor", largest);
  if (yieldR.rps > cursorR.rps * 1.15) {
    lines.push(`- **Elysia yield is faster** than manual ReadableStream (${rps(yieldR.rps)} vs ${rps(cursorR.rps)} RPS) — less boilerplate, better performance`);
  } else if (cursorR.rps > yieldR.rps * 1.15) {
    lines.push(`- **ReadableStream is faster** than Elysia yield (${rps(cursorR.rps)} vs ${rps(yieldR.rps)} RPS)`);
  } else {
    lines.push(`- Elysia yield and ReadableStream have similar throughput — yield is cleaner code`);
  }

  // Container recommendation
  const streamPeaks = strats.filter((s) => s !== "buffered").map((s) => {
    return Math.max(...bench.payloadSizes.map((sz) =>
      find(bench.results, s, sz).peakMemory.rss / 1024 / 1024
    ));
  });
  const maxStreamRSS = Math.max(...streamPeaks);
  lines.push(`- With any streaming strategy, RSS stays under ~${Math.ceil(maxStreamRSS)}MB even at ${num(largest)} rows`);
  lines.push("");

  return lines.join("\n");
}
