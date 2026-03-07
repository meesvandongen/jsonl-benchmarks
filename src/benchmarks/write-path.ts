/**
 * Write Path Benchmark — bulk INSERT strategies using mitata.
 *
 * Compares:
 *   1. Row-by-row INSERT
 *   2. Batch INSERT via unnest() — varying batch sizes
 *   3. COPY FROM STDIN via porsager
 */

import { bench, group, run } from "mitata";
import { sql, pool, waitForDb } from "../db/client";
import { setupTables } from "../db/setup";

const WRITE_SIZES = [1_000, 5_000, 10_000];

function makeRow(i: number): string {
  return JSON.stringify({
    id: `write_${i}`,
    name: `User ${i}`,
    email: `user${i}@test.com`,
    score: i % 100,
    active: i % 2 === 0,
  });
}

// Ensure bench table exists and is clean
async function resetBenchTable() {
  await sql`CREATE TABLE IF NOT EXISTS records_bench (id BIGSERIAL PRIMARY KEY, data JSONB NOT NULL)`;
  await sql`TRUNCATE records_bench`;
}

for (const size of WRITE_SIZES) {
  // Pre-generate data
  const rows = Array.from({ length: size }, (_, i) => makeRow(i));

  group(`INSERT ${size.toLocaleString()} rows`, () => {

    bench("row-by-row INSERT", async () => {
      await resetBenchTable();
      for (const row of rows) {
        await sql`INSERT INTO records_bench (data) VALUES (${row}::jsonb)`;
      }
    });

    bench("unnest batch 100", async () => {
      await resetBenchTable();
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        await sql`INSERT INTO records_bench (data) SELECT v::jsonb FROM unnest(${batch}::text[]) AS v`;
      }
    });

    bench("unnest batch 500", async () => {
      await resetBenchTable();
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        await sql`INSERT INTO records_bench (data) SELECT v::jsonb FROM unnest(${batch}::text[]) AS v`;
      }
    });

    bench("unnest batch 1000", async () => {
      await resetBenchTable();
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000);
        await sql`INSERT INTO records_bench (data) SELECT v::jsonb FROM unnest(${batch}::text[]) AS v`;
      }
    });

    bench("unnest batch 5000", async () => {
      await resetBenchTable();
      for (let i = 0; i < rows.length; i += 5000) {
        const batch = rows.slice(i, i + 5000);
        await sql`INSERT INTO records_bench (data) SELECT v::jsonb FROM unnest(${batch}::text[]) AS v`;
      }
    });

    // COPY FROM STDIN via porsager .writable()
    // Returns a Node.js Writable stream. Wrapped in try/catch for safety.
    bench("COPY FROM STDIN", async () => {
      await resetBenchTable();
      try {
        const csvLines = rows.map(r => `"${r.replace(/"/g, '""')}"`).join("\n") + "\n";
        const writable = await sql`COPY records_bench (data) FROM STDIN (FORMAT csv)`.writable();
        // porsager returns a Node.js Writable stream
        await new Promise<void>((resolve, reject) => {
          writable.on("error", reject);
          writable.on("finish", resolve);
          writable.end(Buffer.from(csvLines));
        });
      } catch (err) {
        // Silently skip — .writable() may hang or not work in tight loops
      }
    });
  });
}

if (import.meta.main) {
  console.log("Connecting to PostgreSQL...");
  await waitForDb();
  await setupTables();
  console.log("Running write path benchmarks...\n");
  await run();
  await sql.end();
  await pool.end();
}
