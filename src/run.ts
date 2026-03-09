/**
 * Full benchmark orchestrator — runs all benchmarks and saves individual
 * report files to reports/.
 *
 *  1. Connect to PostgreSQL
 *  2. Seed all tables (records, records_text, users, orders)
 *  3. DB driver benchmark (mitata) → reports/db-drivers.txt
 *  4. DB driver variants (mitata) → reports/db-driver-variants.txt
 *  5. Serialization benchmark (mitata) → reports/serialization.txt
 *  6. JSON packages benchmark (mitata) → reports/json-packages.txt
 *  7. Write path benchmark (mitata) → reports/write-path.txt
 *  8. Real-world patterns (mitata) → reports/real-world.txt
 *  9. Memory & GC pressure analysis → reports/memory-gc.txt
 * 10. HTTP E2E memory benchmark → reports/http-e2e.json
 * 11. HTTP framework overhead → reports/framework.json
 * 12. HTTP compression benchmark → reports/compression.json
 * 13. HTTP WebSocket vs NDJSON → reports/websocket.json
 * 14. Concurrency & backpressure → reports/concurrency.json
 * 15. Streaming bottleneck analysis → reports/bottleneck.json
 * 16. Go backpressure benchmark → reports/go-backpressure.json
 * 17. @mvd/postgres bounded-memory benchmark → reports/mvd-memory-boundedness.json
 * 18. Save environment metadata → reports/meta.json
 */

import { sql, pool, waitForDb } from "./db/client";
import { setupTables, seedIfNeeded, seedTextIfNeeded, seedUsersAndOrders } from "./db/setup";
import { runHttpBenchmark } from "./benchmarks/http-e2e";
import { runFrameworkBenchmark } from "./benchmarks/http-bun-raw";
import { runCompressionBenchmark } from "./benchmarks/http-compression";
import { runWebSocketBenchmark } from "./benchmarks/http-websocket";
import { runConcurrencyBenchmark } from "./benchmarks/concurrency";
import { runBottleneckAnalysis } from "./benchmarks/bottleneck-analysis";
import { runGoBackpressureBenchmark } from "./benchmarks/go-backpressure";
import { runMvdMemoryBoundednessBenchmark } from "./benchmarks/mvd-memory-boundedness";

const REPORTS_DIR = "reports";
const SEED_COUNT = 100_000;
const TOTAL_STEPS = 18;

function step(n: number, msg: string) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  Step ${n}/${TOTAL_STEPS} — ${msg}`);
  console.log(`${"─".repeat(72)}`);
}

async function saveReport(name: string, data: unknown) {
  const path = `${REPORTS_DIR}/${name}.json`;
  const json = JSON.stringify(data, null, 2);
  await Bun.write(path, json);
  console.log(`  → ${path} (${(json.length / 1024).toFixed(1)} KB)`);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

async function runAndCapture(script: string, reportName: string): Promise<number> {
  const proc = Bun.spawn(["bun", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  // Stream stdout to terminal AND collect it
  const chunks: string[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    process.stdout.write(text);
    chunks.push(text);
  }

  const exitCode = await proc.exited;

  // Save ANSI-stripped output as plain text report
  const raw = chunks.join("");
  const clean = raw.replace(ANSI_RE, "");
  const path = `${REPORTS_DIR}/${reportName}.txt`;
  await Bun.write(path, clean);
  console.log(`  → ${path} (${(clean.length / 1024).toFixed(1)} KB)`);

  return exitCode;
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

// ─── Steps 3-8: mitata benchmarks — stdout captured to .txt reports ──────────

const mitataBenchmarks = [
  { step: 3, label: "DB driver benchmark (mitata)", script: "src/benchmarks/db-drivers.ts", report: "db-drivers" },
  { step: 4, label: "DB driver variants (mitata)", script: "src/benchmarks/db-driver-variants.ts", report: "db-driver-variants" },
  { step: 5, label: "Serialization benchmark (mitata)", script: "src/benchmarks/serialization.ts", report: "serialization" },
  { step: 6, label: "JSON packages benchmark (mitata)", script: "src/benchmarks/json-packages.ts", report: "json-packages" },
  { step: 7, label: "Write path benchmark (mitata)", script: "src/benchmarks/write-path.ts", report: "write-path" },
  { step: 8, label: "Real-world patterns (mitata)", script: "src/benchmarks/real-world.ts", report: "real-world" },
  { step: 9, label: "Memory & GC pressure analysis", script: "src/benchmarks/memory-gc.ts", report: "memory-gc" },
];

for (const mb of mitataBenchmarks) {
  step(mb.step, mb.label);
  const exitCode = await runAndCapture(mb.script, mb.report);
  if (exitCode !== 0) {
    console.error(`  WARNING: ${mb.script} exited with code ${exitCode}`);
  }
}

// ─── Step 9: HTTP E2E memory benchmark ───────────────────────────────────────

step(10, "HTTP E2E memory benchmark (6 core strategies)");
const httpResults = await runHttpBenchmark();
await saveReport("http-e2e", httpResults);

// ─── Step 10: Framework overhead ─────────────────────────────────────────────

step(11, "HTTP framework overhead (Elysia vs Bun.serve raw)");
const frameworkResults = await runFrameworkBenchmark();
await saveReport("framework", frameworkResults);

// ─── Step 11: Compression ────────────────────────────────────────────────────

step(12, "Compression benchmark (gzip vs uncompressed)");
const compressionResults = await runCompressionBenchmark();
await saveReport("compression", compressionResults);

// ─── Step 12: WebSocket ──────────────────────────────────────────────────────

step(13, "WebSocket vs HTTP NDJSON");
const wsResults = await runWebSocketBenchmark();
await saveReport("websocket", wsResults);

// ─── Step 13: Concurrency ────────────────────────────────────────────────────

step(14, "Concurrency & backpressure");
const concurrencyResults = await runConcurrencyBenchmark();
await saveReport("concurrency", concurrencyResults);

// ─── Step 14: Bottleneck analysis ─────────────────────────────────────────────

step(15, "Streaming bottleneck analysis");
const bottleneckResults = await runBottleneckAnalysis();
await saveReport("bottleneck", bottleneckResults);

// ─── Step 15: Go backpressure ────────────────────────────────────────────────

step(16, "Go pgx TCP backpressure benchmark");
const goResults = await runGoBackpressureBenchmark();
await saveReport("go-backpressure", goResults);

// ─── Step 16: @mvd bounded-memory benchmark ──────────────────────────────────

step(17, "@mvd/postgres bounded-memory benchmark");
const mvdMemoryResults = await runMvdMemoryBoundednessBenchmark();
await saveReport("mvd-memory-boundedness", mvdMemoryResults);

// ─── Step 17: Environment metadata ───────────────────────────────────────────

step(18, "Saving environment metadata");
await saveReport("meta", {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  runtime: `Bun ${Bun.version}`,
  pgVersion,
  seedCount: SEED_COUNT,
});

await sql.end();
await pool.end();

console.log(`\n${"═".repeat(72)}`);
console.log("  All done! JSON reports saved to reports/.");
console.log("  See REPORT_GUIDE.md for instructions on generating RESULTS.md.");
console.log(`${"═".repeat(72)}\n`);
