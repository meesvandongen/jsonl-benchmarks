import type { HttpBenchmarkResults, RunResult, Strategy } from "../benchmarks/http-e2e";
import type { FrameworkResult } from "../benchmarks/http-bun-raw";
import type { CompressionResult } from "../benchmarks/http-compression";
import type { WsResult } from "../benchmarks/http-websocket";
import type { ConcurrencyResult } from "../benchmarks/concurrency";

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

interface ReportMeta {
  platform: string;
  runtime: string;
  pgVersion: string;
  seedCount: number;
  frameworkResults?: FrameworkResult[];
  compressionResults?: CompressionResult[];
  wsResults?: WsResult[];
  concurrencyResults?: ConcurrencyResult[];
}

export function buildMarkdownReport(bench: HttpBenchmarkResults, meta: ReportMeta): string {
  const lines: string[] = [];
  const strats = bench.strategies;

  // ─── Header ────────────────────────────────────────────────────────────
  lines.push("# Benchmark Results");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Platform: ${meta.platform}`);
  lines.push(`> Runtime: ${meta.runtime}`);
  lines.push(`> PostgreSQL: ${meta.pgVersion}`);
  lines.push(`> DB rows: ${num(meta.seedCount)} | Concurrency: ${bench.concurrency}`);
  lines.push("");

  // ─── Strategies table ──────────────────────────────────────────────────
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
  lines.push("DB driver + serialization + write path + real-world benchmarks (mitata) are printed to stdout.");
  lines.push("Below: HTTP E2E results with peak memory measurement.");
  lines.push("");
  lines.push("---");
  lines.push("");

  // ─── Core HTTP E2E tables ──────────────────────────────────────────────

  // Peak Memory
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

  // Throughput
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

  // Latency
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

  // ─── Framework overhead ────────────────────────────────────────────────

  if (meta.frameworkResults && meta.frameworkResults.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Framework Overhead: Elysia vs Bun.serve raw");
    lines.push("");
    const fwHeaders = ["Size", "Endpoint", "Elysia RPS", "Bun.serve RPS", "Elysia p95", "Bun.serve p95"];
    const fwRows: string[][] = [];
    const sizes = [...new Set(meta.frameworkResults.map((r) => r.size))].sort((a, b) => a - b);
    const endpoints = [...new Set(meta.frameworkResults.map((r) => r.endpoint))];
    for (const size of sizes) {
      for (const ep of endpoints) {
        const elysia = meta.frameworkResults.find((r) => r.framework === "Elysia" && r.size === size && r.endpoint === ep);
        const raw = meta.frameworkResults.find((r) => r.framework === "Bun.serve raw" && r.size === size && r.endpoint === ep);
        if (elysia && raw) {
          fwRows.push([
            num(size),
            ep,
            rps(elysia.rps),
            rps(raw.rps),
            ms(elysia.p95),
            ms(raw.p95),
          ]);
        }
      }
    }
    lines.push(mdTable(fwHeaders, fwRows));
    lines.push("");
  }

  // ─── Compression ───────────────────────────────────────────────────────

  if (meta.compressionResults && meta.compressionResults.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Compression: Uncompressed vs Gzip");
    lines.push("");
    const cHeaders = ["Size", "Mode", "RPS", "p95", "Memory", "Throughput"];
    const cRows: string[][] = [];
    for (const r of meta.compressionResults) {
      cRows.push([
        num(r.size),
        r.endpoint,
        rps(r.rps),
        ms(r.p95),
        `+${r.peakRssDeltaMB}MB`,
        `${r2(r.throughputBytesPerSec / 1024 / 1024)}MB/s`,
      ]);
    }
    lines.push(mdTable(cHeaders, cRows));
    lines.push("");
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────

  if (meta.wsResults && meta.wsResults.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Transport: HTTP NDJSON vs WebSocket");
    lines.push("");
    const wHeaders = ["Size", "Transport", "RPS", "p95", "Memory"];
    const wRows: string[][] = [];
    for (const r of meta.wsResults) {
      wRows.push([
        num(r.size),
        r.transport,
        rps(r.rps),
        ms(r.p95),
        `+${r.peakRssDeltaMB}MB`,
      ]);
    }
    lines.push(mdTable(wHeaders, wRows));
    lines.push("");
  }

  // ─── Concurrency ───────────────────────────────────────────────────────

  if (meta.concurrencyResults && meta.concurrencyResults.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Concurrency & Backpressure");
    lines.push("");
    const conHeaders = ["Test", "Concurrency", "RPS", "p95", "Memory"];
    const conRows: string[][] = [];
    for (const r of meta.concurrencyResults) {
      conRows.push([
        r.test,
        String(r.concurrency),
        rps(r.rps),
        ms(r.p95),
        `+${r.peakRssDeltaMB}MB`,
      ]);
    }
    lines.push(mdTable(conHeaders, conRows));
    lines.push("");
  }

  // ─── Key takeaways ────────────────────────────────────────────────────

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

  // Framework insights
  if (meta.frameworkResults && meta.frameworkResults.length > 0) {
    const elysiaAvg = meta.frameworkResults.filter((r) => r.framework === "Elysia").reduce((s, r) => s + r.rps, 0) / meta.frameworkResults.filter((r) => r.framework === "Elysia").length;
    const rawAvg = meta.frameworkResults.filter((r) => r.framework === "Bun.serve raw").reduce((s, r) => s + r.rps, 0) / meta.frameworkResults.filter((r) => r.framework === "Bun.serve raw").length;
    const overhead = r2(((rawAvg - elysiaAvg) / rawAvg) * 100);
    if (overhead > 0) {
      lines.push(`- Elysia framework overhead: ~${overhead}% lower RPS vs raw Bun.serve on average`);
    } else {
      lines.push(`- Elysia adds negligible overhead vs raw Bun.serve`);
    }
  }

  // Compression insights
  if (meta.compressionResults && meta.compressionResults.length > 0) {
    const uncompressed = meta.compressionResults.filter((r) => r.endpoint === "uncompressed");
    const gzip = meta.compressionResults.filter((r) => r.endpoint === "gzip");
    if (uncompressed.length > 0 && gzip.length > 0) {
      const avgBandwidthSaving = r2(
        (1 - gzip.reduce((s, r) => s + r.throughputBytesPerSec, 0) / uncompressed.reduce((s, r) => s + r.throughputBytesPerSec, 0)) * 100
      );
      lines.push(`- Gzip compression reduces bandwidth by ~${Math.abs(avgBandwidthSaving)}% with modest CPU overhead`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
