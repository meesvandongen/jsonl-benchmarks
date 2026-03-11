/**
 * DB Driver Benchmark — pure read iteration performance using mitata.
 *
 * Compares the four article strategies for reading N rows from PostgreSQL:
 *   1. buffered reads
 *   2. postgres .cursor(500)
 *   3. postgres .forEach()
 *   4. pg-query-stream
 */

import { bench, group, run, boxplot } from "mitata";
import { sql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded } from "../db/setup";
import QueryStream from "pg-query-stream";

const SIZES = [100, 1_000, 10_000, 100_000];

// ── article strategies ──────────────────────────────────────────────────────

for (const size of SIZES) {
  group(`${size.toLocaleString()} rows`, () => {
    bench("buffered reads", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      if (rows.length !== size) throw new Error("unexpected row count");
    });

    bench("postgres .cursor(500)", async () => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        count += batch.length;
      }
      if (count !== size) throw new Error("unexpected row count");
    });

    bench("postgres .forEach()", async () => {
      let count = 0;
      await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`
        .forEach(() => { count++; });
      if (count !== size) throw new Error("unexpected row count");
    });

    bench("pg-query-stream", async () => {
      const client = await pool.connect();
      try {
        let count = 0;
        const qs = new QueryStream(
          "SELECT data FROM records ORDER BY id LIMIT $1",
          [size],
          { batchSize: 500 }
        );
        const stream = client.query(qs);
        for await (const _row of stream) {
          count++;
        }
        if (count !== size) throw new Error("unexpected row count");
      } finally {
        client.release();
      }
    });
  });
}

// ── Bootstrap & run ──────────────────────────────────────────────────────────

if (import.meta.main) {
  console.log("Connecting to PostgreSQL...");
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);
  console.log("Running DB driver benchmarks...\n");

  await run();

  await sql.end();
  await pool.end();
}
