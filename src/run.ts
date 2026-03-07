/**
 * Full benchmark orchestrator:
 *
 * 1. Verify PostgreSQL, seed data
 * 2. Run DB driver benchmark (mitata — porsager vs pg vs pg-query-stream)
 * 3. Run HTTP E2E memory benchmark (server per strategy, memory polling)
 * 4. Write RESULTS.md
 */

import { bench, group, run as mitataRun } from "mitata";
import { sql, pool, waitForDb } from "./db/client";
import { setupTables, seedIfNeeded } from "./db/setup";
import { runHttpBenchmark, type HttpBenchmarkResults } from "./benchmarks/http-e2e";
import { buildMarkdownReport } from "./utils/md-report";
import QueryStream from "pg-query-stream";

const OUT_FILE = "RESULTS.md";
const SEED_COUNT = 100_000;
const DB_SIZES = [100, 1_000, 10_000, 100_000];

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

step(2, 4, `Seeding ${SEED_COUNT.toLocaleString()} rows`);
await setupTables();
await seedIfNeeded(SEED_COUNT);
console.log("  Seed complete.");

// ─── Step 2: DB driver benchmark (mitata) ────────────────────────────────────

step(3, 4, "DB driver benchmark (mitata)");

for (const size of DB_SIZES) {
  group(`${size.toLocaleString()} rows`, () => {
    bench("porsager buffered", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      if (rows.length !== size) throw new Error("bad count");
    });

    bench("porsager .cursor(500)", async () => {
      let n = 0;
      for await (const batch of sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500)) {
        n += batch.length;
      }
      if (n !== size) throw new Error("bad count");
    });

    bench("porsager .forEach()", async () => {
      let n = 0;
      await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.forEach(() => { n++; });
      if (n !== size) throw new Error("bad count");
    });

    bench("pg buffered", async () => {
      const res = await pool.query("SELECT data FROM records ORDER BY id LIMIT $1", [size]);
      if (res.rows.length !== size) throw new Error("bad count");
    });

    bench("pg-query-stream", async () => {
      const client = await pool.connect();
      try {
        let n = 0;
        const qs = new QueryStream("SELECT data FROM records ORDER BY id LIMIT $1", [size], { batchSize: 500 });
        for await (const _ of client.query(qs)) { n++; }
        if (n !== size) throw new Error("bad count");
      } finally {
        client.release();
      }
    });
  });
}

await mitataRun();

// Close DB connections before HTTP benchmark (server will open its own)
await sql.end();
await pool.end();

// ─── Step 3: HTTP E2E memory benchmark ───────────────────────────────────────

step(3, 4, "HTTP E2E memory benchmark");
const httpResults: HttpBenchmarkResults = await runHttpBenchmark();

// ─── Step 4: Report ──────────────────────────────────────────────────────────

step(4, 4, "Writing RESULTS.md");
const report = buildMarkdownReport(httpResults, {
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
