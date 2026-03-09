/**
 * DB Driver Benchmark — pure read iteration performance using mitata.
 *
 * Compares five strategies for reading N rows from PostgreSQL:
 *   1. porsager/postgres  — buffered SELECT (all rows at once)
 *   2. porsager/postgres  — .cursor(500) async iteration
 *   3. porsager/postgres  — .forEach(fn) instant iteration
 *   4. @mvd/postgres      — buffered SELECT (all rows at once)
 *   5. @mvd/postgres      — .cursor(500) async iteration
 *   6. @mvd/postgres      — .stream() async iteration with backpressure
 *   7. node-postgres (pg) — client.query() buffered
 *   8. pg-query-stream    — cursor-based ReadableStream
 */

import { bench, group, run, boxplot } from "mitata";
import { sql, mvdSql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded } from "../db/setup";
import QueryStream from "pg-query-stream";

const SIZES = [100, 1_000, 10_000, 100_000];

// ── porsager/postgres: buffered ──────────────────────────────────────────────

for (const size of SIZES) {
  group(`${size.toLocaleString()} rows`, () => {
    bench("porsager buffered", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      if (rows.length !== size) throw new Error("unexpected row count");
    });

    bench("porsager .cursor(500)", async () => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        count += batch.length;
      }
      if (count !== size) throw new Error("unexpected row count");
    });

    bench("porsager .forEach()", async () => {
      let count = 0;
      await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`
        .forEach(() => { count++; });
      if (count !== size) throw new Error("unexpected row count");
    });

    bench("mvd buffered", async () => {
      const rows = await mvdSql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      if (rows.length !== size) throw new Error("unexpected row count");
    });

    bench("mvd .cursor(500)", async () => {
      let count = 0;
      const cursor = mvdSql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        count += batch.length;
      }
      if (count !== size) throw new Error("unexpected row count");
    });

    bench("mvd .stream()", async () => {
      let count = 0;
      for await (const _row of mvdSql`SELECT data FROM records ORDER BY id LIMIT ${size}`.stream()) {
        count++;
      }
      if (count !== size) throw new Error("unexpected row count");
    });

    bench("pg buffered", async () => {
      const res = await pool.query("SELECT data FROM records ORDER BY id LIMIT $1", [size]);
      if (res.rows.length !== size) throw new Error("unexpected row count");
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

  await mvdSql.end();
  await sql.end();
  await pool.end();
}
