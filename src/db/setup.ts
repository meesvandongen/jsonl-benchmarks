import { sql, waitForDb } from "./client";

export async function setupTables(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS records (
      id        BIGSERIAL PRIMARY KEY,
      data      JSONB NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_records_id ON records (id)`;

  // TEXT column variant for JSONB vs TEXT serialization benchmark
  await sql`
    CREATE TABLE IF NOT EXISTS records_text (
      id        BIGSERIAL PRIMARY KEY,
      data      TEXT NOT NULL
    )
  `;

  // Parent table for JOIN benchmarks
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id        BIGSERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      email     TEXT NOT NULL,
      active    BOOLEAN NOT NULL DEFAULT true
    )
  `;

  // Child table for JOIN benchmarks
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      id         BIGSERIAL PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id),
      amount     NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status     TEXT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`;
}

export async function dropTables(): Promise<void> {
  await sql`DROP TABLE IF EXISTS orders`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS records_text`;
  await sql`DROP TABLE IF EXISTS records`;
}

export async function getRowCount(): Promise<number> {
  const rows = await sql<{ cnt: string }[]>`SELECT COUNT(*) AS cnt FROM records`;
  return parseInt(rows[0].cnt);
}

function makeRecordJson(idx: number): string {
  return JSON.stringify({
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
  });
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
      values.push(makeRecordJson(offset + i));
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

export async function seedTextIfNeeded(targetCount: number): Promise<void> {
  const rows = await sql<{ cnt: string }[]>`SELECT COUNT(*) AS cnt FROM records_text`;
  const current = parseInt(rows[0].cnt);
  if (current >= targetCount) return;

  const needed = targetCount - current;
  const BATCH = 5_000;
  const batches = Math.ceil(needed / BATCH);

  for (let b = 0; b < batches; b++) {
    const size = Math.min(BATCH, needed - b * BATCH);
    const offset = current + b * BATCH;
    const values: string[] = [];
    for (let i = 0; i < size; i++) {
      values.push(makeRecordJson(offset + i));
    }
    // Insert as TEXT, not JSONB — no ::jsonb cast
    await sql`
      INSERT INTO records_text (data)
      SELECT v FROM unnest(${values}::text[]) AS v
    `;
    if ((b + 1) % 10 === 0 || b === batches - 1) {
      process.stdout.write(`\r  Seeded records_text ${Math.min(current + (b + 1) * BATCH, targetCount).toLocaleString()} / ${targetCount.toLocaleString()} rows`);
    }
  }
  console.log();
}

export async function seedUsersAndOrders(userCount: number, ordersPerUser: number): Promise<void> {
  const rows = await sql<{ cnt: string }[]>`SELECT COUNT(*) AS cnt FROM users`;
  const current = parseInt(rows[0].cnt);
  if (current >= userCount) return;

  const BATCH = 1_000;
  const batches = Math.ceil(userCount / BATCH);

  for (let b = 0; b < batches; b++) {
    const size = Math.min(BATCH, userCount - b * BATCH);
    const offset = b * BATCH;
    const names: string[] = [];
    const emails: string[] = [];
    const actives: string[] = [];
    for (let i = 0; i < size; i++) {
      const idx = offset + i;
      names.push(`User ${idx}`);
      emails.push(`user${idx}@example.com`);
      actives.push(idx % 3 !== 0 ? "true" : "false");
    }
    await sql`
      INSERT INTO users (name, email, active)
      SELECT n, e, a::boolean FROM unnest(
        ${names}::text[],
        ${emails}::text[],
        ${actives}::text[]
      ) AS t(n, e, a)
    `;

    // Insert orders for each user in this batch
    const userIds = await sql<{ id: string }[]>`
      SELECT id FROM users ORDER BY id OFFSET ${offset} LIMIT ${size}
    `;
    const oUserIds: number[] = [];
    const oAmounts: string[] = [];
    const oStatuses: string[] = [];
    const statusOptions = ["pending", "completed", "cancelled", "refunded"];
    for (const u of userIds) {
      for (let o = 0; o < ordersPerUser; o++) {
        oUserIds.push(parseInt(u.id));
        oAmounts.push((Math.round(((parseInt(u.id) * 31 + o * 7) % 50000)) / 100).toFixed(2));
        oStatuses.push(statusOptions[(parseInt(u.id) + o) % 4]);
      }
    }
    await sql`
      INSERT INTO orders (user_id, amount, status)
      SELECT * FROM unnest(
        ${oUserIds}::bigint[],
        ${oAmounts}::numeric[],
        ${oStatuses}::text[]
      )
    `;

    if ((b + 1) % 5 === 0 || b === batches - 1) {
      process.stdout.write(`\r  Seeded ${Math.min((b + 1) * BATCH, userCount).toLocaleString()} users + ${(Math.min((b + 1) * BATCH, userCount) * ordersPerUser).toLocaleString()} orders`);
    }
  }
  console.log();
}

if (import.meta.main) {
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);
  await seedTextIfNeeded(100_000);
  await seedUsersAndOrders(10_000, 3);
  console.log("Done.");
  process.exit(0);
}
