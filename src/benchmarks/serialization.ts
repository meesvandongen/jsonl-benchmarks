import { bench, group, run } from "mitata";
import { sql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded, seedTextIfNeeded } from "../db/setup";
import { Packr } from "msgpackr";

const packr = new Packr();

const sizes = [1_000, 10_000, 100_000];

for (const size of sizes) {
  group(`Serialization format — ${size} rows`, () => {
    bench("JSON.stringify(array)", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      JSON.stringify(rows);
    });

    bench("NDJSON one-by-one", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      const lines: string[] = [];
      for (const row of rows) {
        lines.push(JSON.stringify(row) + "\n");
      }
      lines.join("");
    });

    bench("Streaming JSON array", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      const parts: string[] = ["["];
      for (let i = 0; i < rows.length; i++) {
        parts.push(JSON.stringify(rows[i]));
        if (i < rows.length - 1) {
          parts.push(",");
        }
      }
      parts.push("]");
      parts.join("");
    });

    bench("MessagePack encode", async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      const packed: Buffer[] = [];
      for (const row of rows) {
        packed.push(packr.pack(row));
      }
    });
  });
}

for (const size of sizes) {
  group(`JSONB vs TEXT — ${size} rows`, () => {
    bench("JSONB column", async () => {
      await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
    });

    bench("TEXT column", async () => {
      await sql`SELECT data FROM records_text ORDER BY id LIMIT ${size}`;
    });

    bench("TEXT + JSON.parse", async () => {
      const rows = await sql`SELECT data FROM records_text ORDER BY id LIMIT ${size}`;
      for (const row of rows) {
        JSON.parse(row.data);
      }
    });
  });
}

if (import.meta.main) {
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);
  await seedTextIfNeeded(100_000);
  await run();
  await sql.end();
  await pool.end();
}
