/**
 * DB Driver Variants Benchmark — advanced read strategies using mitata.
 *
 * Compares:
 *   1. pg-cursor (raw) — direct cursor without stream abstraction
 *   2. porsager prepared — auto-prepared buffered SELECT
 *   3. @mvd/postgres prepared — auto-prepared buffered SELECT
 *   4. pg prepared (named) — pg named/prepared query
 */

import { bench, group, run } from "mitata";
import { sql, mvdSql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded } from "../db/setup";
import Cursor from "pg-cursor";

const SIZES = [1_000, 10_000, 100_000];

for (const size of SIZES) {
  group(`${size.toLocaleString()} rows — driver variants`, () => {

    // pg-cursor raw — use pg-cursor directly without stream wrapper
    bench("pg-cursor raw", async () => {
      const client = await pool.connect();
      try {
        const cursor = client.query(
          new Cursor("SELECT data FROM records ORDER BY id LIMIT $1", [size])
        );
        let count = 0;
        while (true) {
          const rows = await cursor.read(500);
          if (rows.length === 0) break;
          count += rows.length;
        }
        await cursor.close();
        if (count !== size) throw new Error("unexpected row count");
      } finally {
        client.release();
      }
    });

    // porsager prepared — porsager auto-prepares after first execution
    bench("porsager prepared", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      if (rows.length !== size) throw new Error("unexpected row count");
    });

    bench("mvd prepared", async () => {
      const rows = await mvdSql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      if (rows.length !== size) throw new Error("unexpected row count");
    });

    // pg prepared (named) — pg named/prepared query
    bench("pg prepared (named)", async () => {
      const res = await pool.query({
        text: "SELECT data FROM records ORDER BY id LIMIT $1",
        values: [size],
        name: `bench_read_${size}`,
      });
      if (res.rows.length !== size) throw new Error("unexpected row count");
    });
  });
}

// ── Bootstrap & run ──────────────────────────────────────────────────────────

if (import.meta.main) {
  console.log("Connecting to PostgreSQL...");
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);
  console.log("Running DB driver variant benchmarks...\n");

  await run();

  await mvdSql.end();
  await sql.end();
  await pool.end();
}
