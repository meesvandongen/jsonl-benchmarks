import postgres from "postgres";
import pg from "pg";

const DB_HOST = process.env.DB_HOST ?? "localhost";
const DB_PORT = parseInt(process.env.DB_PORT ?? "5432");
const DB_NAME = process.env.DB_NAME ?? "benchmark";
const DB_USER = process.env.DB_USER ?? "postgres";
const DB_PASS = process.env.DB_PASS ?? "postgres";

// porsager/postgres driver
export const sql = postgres({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  username: DB_USER,
  password: DB_PASS,
  max: parseInt(process.env.DB_POOL_MAX ?? "20"),
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
});

// node-postgres (pg) pool
export const pool = new pg.Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASS,
  max: parseInt(process.env.DB_POOL_MAX ?? "20"),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export async function waitForDb(retries = 20, delayMs = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch {
      if (i < retries - 1) {
        process.stdout.write(`  Waiting for database... (${i + 1}/${retries})\r`);
        await Bun.sleep(delayMs);
      }
    }
  }
  throw new Error("Database not reachable after retries");
}
