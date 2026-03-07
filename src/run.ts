/**
 * E2E benchmark orchestrator.
 *
 * 1. Verify PostgreSQL is up
 * 2. Seed data (100k rows)
 * 3. Run the benchmark (fresh server per strategy, measuring memory + throughput)
 * 4. Write RESULTS.md
 */

import { sql, waitForDb } from "./db/client";
import { setupTables, seedIfNeeded } from "./db/setup";
import { runE2eBenchmark, type E2eBenchmarkResults } from "./benchmarks/e2e";
import { buildMarkdownReport } from "./utils/md-report";

const OUT_FILE = "RESULTS.md";
const SEED_COUNT = 100_000;

function step(n: number, total: number, msg: string) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  Step ${n}/${total} — ${msg}`);
  console.log(`${"─".repeat(72)}`);
}

// ─── Step 1: DB ──────────────────────────────────────────────────────────────

step(1, 4, "Connecting to PostgreSQL");
await waitForDb();
const pgRows = await sql<{ version: string }[]>`SELECT version()`;
const pgVersion = pgRows[0]?.version?.match(/PostgreSQL ([\d.]+)/)?.[1] ?? "unknown";
console.log(`  PostgreSQL ${pgVersion} ready.`);

// ─── Step 2: Seed ────────────────────────────────────────────────────────────

step(2, 4, `Seeding ${SEED_COUNT.toLocaleString()} rows`);
await setupTables();
await seedIfNeeded(SEED_COUNT);
console.log("  Seed complete.");
await sql.end();

// ─── Step 3: Benchmark ──────────────────────────────────────────────────────

step(3, 4, "Running E2E benchmark (buffered vs streamed)");
const results: E2eBenchmarkResults = await runE2eBenchmark();

// ─── Step 4: Report ──────────────────────────────────────────────────────────

step(4, 4, "Writing RESULTS.md");
const report = buildMarkdownReport(results, {
  platform: `${process.platform} ${process.arch}`,
  runtime: `Bun ${Bun.version}`,
  pgVersion,
  seedCount: SEED_COUNT,
});
await Bun.write(OUT_FILE, report);
console.log(`  Written to ${OUT_FILE} (${(report.length / 1024).toFixed(1)} KB)`);

console.log(`\n${"═".repeat(72)}`);
console.log("  All done! Open RESULTS.md to view the full report.");
console.log(`${"═".repeat(72)}\n`);
