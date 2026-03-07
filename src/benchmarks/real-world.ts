/**
 * Real-World Patterns Benchmark — practical query patterns using mitata.
 *
 * Compares:
 *   1. Filtered queries (WHERE clause) — buffered vs streaming
 *   2. Pagination (OFFSET/LIMIT) vs cursor streaming — total time
 *   3. Transform during streaming — overhead of map/filter
 *   4. Multi-table JOINs — streaming larger composite rows
 */

import { bench, group, run } from "mitata";
import { sql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded, seedUsersAndOrders } from "../db/setup";

const SIZES = [1_000, 10_000, 100_000];

// ── Filtered queries ───────────────────────────────────────────────────
for (const size of SIZES) {
  group(`Filtered — ${size.toLocaleString()} rows`, () => {
    bench("buffered + WHERE", async () => {
      const rows = await sql`
        SELECT data FROM records
        WHERE data->>'active' = 'true'
        ORDER BY id LIMIT ${size}
      `;
      if (rows.length === 0) throw new Error("no rows");
    });

    bench("cursor + WHERE", async () => {
      let count = 0;
      const cursor = sql`
        SELECT data FROM records
        WHERE data->>'active' = 'true'
        ORDER BY id LIMIT ${size}
      `.cursor(500);
      for await (const batch of cursor) {
        count += batch.length;
      }
      if (count === 0) throw new Error("no rows");
    });
  });
}

// ── Pagination vs cursor ──────────────────────────────────────────────
for (const size of [10_000, 100_000]) {
  group(`Pagination vs cursor — ${size.toLocaleString()} rows`, () => {
    bench("OFFSET/LIMIT pages (1000)", async () => {
      let total = 0;
      const pageSize = 1000;
      for (let offset = 0; offset < size; offset += pageSize) {
        const rows = await sql`
          SELECT data FROM records ORDER BY id LIMIT ${pageSize} OFFSET ${offset}
        `;
        total += rows.length;
      }
      if (total !== size) throw new Error("unexpected count");
    });

    bench("single cursor stream", async () => {
      let count = 0;
      const cursor = sql`
        SELECT data FROM records ORDER BY id LIMIT ${size}
      `.cursor(500);
      for await (const batch of cursor) {
        count += batch.length;
      }
      if (count !== size) throw new Error("unexpected count");
    });
  });
}

// ── Transform during streaming ─────────────────────────────────────────
for (const size of SIZES) {
  group(`Transform — ${size.toLocaleString()} rows`, () => {
    bench("cursor raw (no transform)", async () => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          JSON.stringify(row.data);
        }
        count += batch.length;
      }
      if (count !== size) throw new Error("bad count");
    });

    bench("cursor + redact transform", async () => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          const data = row.data as Record<string, unknown>;
          const redacted = { ...data, email: "***@***.com" };
          JSON.stringify(redacted);
        }
        count += batch.length;
      }
      if (count !== size) throw new Error("bad count");
    });

    bench("cursor + filter active", async () => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          const data = row.data as Record<string, unknown>;
          if (data.active) {
            JSON.stringify(data);
            count++;
          }
        }
      }
      if (count === 0) throw new Error("no rows");
    });
  });
}

// ── Multi-table JOINs ─────────────────────────────────────────────────
for (const size of [1_000, 10_000, 30_000]) {
  group(`JOIN — ${size.toLocaleString()} rows`, () => {
    bench("JOIN buffered", async () => {
      const rows = await sql`
        SELECT u.name, u.email, o.amount, o.status
        FROM users u
        JOIN orders o ON o.user_id = u.id
        ORDER BY u.id, o.id
        LIMIT ${size}
      `;
      if (rows.length !== size) throw new Error("unexpected count");
    });

    bench("JOIN cursor", async () => {
      let count = 0;
      const cursor = sql`
        SELECT u.name, u.email, o.amount, o.status
        FROM users u
        JOIN orders o ON o.user_id = u.id
        ORDER BY u.id, o.id
        LIMIT ${size}
      `.cursor(500);
      for await (const batch of cursor) {
        count += batch.length;
      }
      if (count !== size) throw new Error("unexpected count");
    });
  });
}

if (import.meta.main) {
  console.log("Connecting to PostgreSQL...");
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);
  await seedUsersAndOrders(10_000, 3);
  console.log("Running real-world pattern benchmarks...\n");
  await run();
  await sql.end();
  await pool.end();
}
