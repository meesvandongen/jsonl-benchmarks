import { sql, waitForDb } from "./client";

export async function setupTables(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS records (
      id        BIGSERIAL PRIMARY KEY,
      data      JSONB NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_records_id ON records (id)`;
}

export async function dropTables(): Promise<void> {
  await sql`DROP TABLE IF EXISTS records`;
}

export async function getRowCount(): Promise<number> {
  const rows = await sql<{ cnt: string }[]>`SELECT COUNT(*) AS cnt FROM records`;
  return parseInt(rows[0].cnt);
}

export async function seedIfNeeded(targetCount: number): Promise<void> {
  const current = await getRowCount();
  if (current >= targetCount) return;

  const needed = targetCount - current;
  const BATCH = 5_000;
  const batches = Math.ceil(needed / BATCH);

  for (let b = 0; b < batches; b++) {
    const size = Math.min(BATCH, needed - b * BATCH);
    const offset = current + b * BATCH;
    const values: string[] = [];
    for (let i = 0; i < size; i++) {
      const idx = offset + i;
      values.push(JSON.stringify({
        id: `rec_${String(idx).padStart(10, "0")}`,
        user_id: idx,
        name: `User ${idx}`,
        email: `user${idx}@example.com`,
        age: 18 + (idx % 62),
        score: Math.round(((idx * 7919) % 10000) / 100),
        active: idx % 3 !== 0,
        tags: ["premium", "active", "verified", "new"].slice(0, (idx % 4) + 1),
        address: {
          city: ["New York", "London", "Tokyo", "Paris", "Sydney"][idx % 5],
          country: ["US", "UK", "JP", "FR", "AU"][idx % 5],
          zip: `${10000 + (idx % 89999)}`,
        },
        metadata: {
          created_at: new Date(Date.now() - idx * 60_000).toISOString(),
          source: ["web", "mobile", "api", "import"][idx % 4],
          version: (idx % 5) + 1,
        },
      }));
    }
    await sql`
      INSERT INTO records (data)
      SELECT v::jsonb FROM unnest(${values}::text[]) AS v
    `;
    if ((b + 1) % 10 === 0 || b === batches - 1) {
      process.stdout.write(`\r  Seeded ${Math.min(current + (b + 1) * BATCH, targetCount).toLocaleString()} / ${targetCount.toLocaleString()} rows`);
    }
  }
  console.log();
}

if (import.meta.main) {
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);
  console.log("Done.");
  process.exit(0);
}
