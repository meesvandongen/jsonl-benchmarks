/**
 * Full benchmark orchestrator:
 *
 *  1. Connect to PostgreSQL
 *  2. Seed all tables (records, records_text, users, orders)
 *  3. DB driver benchmark (mitata — core read strategies)
 *  4. DB driver variants (mitata — .readable, pg-cursor, COPY, prepared)
 *  5. Serialization benchmark (mitata — JSON vs NDJSON vs msgpack, JSONB vs TEXT)
 *  6. Write path benchmark (mitata — INSERT strategies)
 *  7. Real-world patterns (mitata — filtered, pagination, transforms, JOINs)
 *  8. Memory & GC pressure analysis
 *  9. HTTP E2E memory benchmark (5 core strategies)
 * 10. HTTP framework overhead (Elysia vs Bun.serve raw)
 * 11. HTTP compression benchmark
 * 12. HTTP WebSocket vs NDJSON
 * 13. Concurrency & backpressure
 * 14. Write RESULTS.md
 */

import { sql, pool, waitForDb } from "./db/client";
import { setupTables, seedIfNeeded, seedTextIfNeeded, seedUsersAndOrders } from "./db/setup";
import { runHttpBenchmark, type HttpBenchmarkResults } from "./benchmarks/http-e2e";
import { runFrameworkBenchmark, type FrameworkResult } from "./benchmarks/http-bun-raw";
import { runCompressionBenchmark, type CompressionResult } from "./benchmarks/http-compression";
import { runWebSocketBenchmark, type WsResult } from "./benchmarks/http-websocket";
import { runConcurrencyBenchmark, type ConcurrencyResult } from "./benchmarks/concurrency";
import { buildMarkdownReport } from "./utils/md-report";

const OUT_FILE = "RESULTS.md";
const SEED_COUNT = 100_000;
const TOTAL_STEPS = 14;

function step(n: number, msg: string) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  Step ${n}/${TOTAL_STEPS} — ${msg}`);
  console.log(`${"─".repeat(72)}`);
}

// ─── Step 1: DB ──────────────────────────────────────────────────────────────

step(1, "Connecting to PostgreSQL");
await waitForDb();
const pgRows = await sql<{ version: string }[]>`SELECT version()`;
const pgVersion = pgRows[0]?.version?.match(/PostgreSQL ([\d.]+)/)?.[1] ?? "unknown";
console.log(`  PostgreSQL ${pgVersion} ready.`);

// ─── Step 2: Seed ────────────────────────────────────────────────────────────

step(2, "Seeding all tables");
await setupTables();
await seedIfNeeded(SEED_COUNT);
await seedTextIfNeeded(SEED_COUNT);
await seedUsersAndOrders(10_000, 3);
console.log("  Seed complete.");

// ─── Steps 3-7: mitata benchmarks (each spawned as subprocess) ───────────────

const mitataBenchmarks = [
  { step: 3, label: "DB driver benchmark (mitata)", script: "src/benchmarks/db-drivers.ts" },
  { step: 4, label: "DB driver variants (mitata)", script: "src/benchmarks/db-driver-variants.ts" },
  { step: 5, label: "Serialization benchmark (mitata)", script: "src/benchmarks/serialization.ts" },
  { step: 6, label: "Write path benchmark (mitata)", script: "src/benchmarks/write-path.ts" },
  { step: 7, label: "Real-world patterns (mitata)", script: "src/benchmarks/real-world.ts" },
];

for (const mb of mitataBenchmarks) {
  step(mb.step, mb.label);
  const proc = Bun.spawn(["bun", mb.script], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`  WARNING: ${mb.script} exited with code ${exitCode}`);
  }
}

// ─── Step 8: Memory & GC pressure ────────────────────────────────────────────

step(8, "Memory & GC pressure analysis");
{
  const proc = Bun.spawn(["bun", "src/benchmarks/memory-gc.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`  WARNING: memory-gc.ts exited with code ${exitCode}`);
  }
}

// ─── Step 9: HTTP E2E memory benchmark ───────────────────────────────────────

step(9, "HTTP E2E memory benchmark (5 core strategies)");
const httpResults: HttpBenchmarkResults = await runHttpBenchmark();

// ─── Step 10: Framework overhead ─────────────────────────────────────────────

step(10, "HTTP framework overhead (Elysia vs Bun.serve raw)");
const frameworkResults: FrameworkResult[] = await runFrameworkBenchmark();

// ─── Step 11: Compression ────────────────────────────────────────────────────

step(11, "Compression benchmark (gzip vs uncompressed)");
const compressionResults: CompressionResult[] = await runCompressionBenchmark();

// ─── Step 12: WebSocket ──────────────────────────────────────────────────────

step(12, "WebSocket vs HTTP NDJSON");
const wsResults: WsResult[] = await runWebSocketBenchmark();

// ─── Step 13: Concurrency ────────────────────────────────────────────────────

step(13, "Concurrency & backpressure");
const concurrencyResults: ConcurrencyResult[] = await runConcurrencyBenchmark();

// ─── Step 14: Report ─────────────────────────────────────────────────────────

step(14, "Writing RESULTS.md");
const report = buildMarkdownReport(httpResults, {
  platform: `${process.platform} ${process.arch}`,
  runtime: `Bun ${Bun.version}`,
  pgVersion,
  seedCount: SEED_COUNT,
  frameworkResults,
  compressionResults,
  wsResults,
  concurrencyResults,
});
await Bun.write(OUT_FILE, report);
console.log(`  Written to ${OUT_FILE} (${(report.length / 1024).toFixed(1)} KB)`);

await sql.end();
await pool.end();

console.log(`\n${"═".repeat(72)}`);
console.log("  All done! Open RESULTS.md to view the full report.");
console.log(`${"═".repeat(72)}\n`);
