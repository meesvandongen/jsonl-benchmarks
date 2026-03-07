/**
 * Benchmark server — four response strategies, all backed by PostgreSQL:
 *
 *   GET /buffered?limit=N        — SELECT all rows, JSON array response
 *   GET /stream-cursor?limit=N   — .cursor(500) + ReadableStream NDJSON
 *   GET /stream-foreach?limit=N  — .forEach(fn) + ReadableStream NDJSON
 *   GET /yield-cursor?limit=N    — .cursor(500) + Elysia native yield
 *   GET /health                  — healthcheck
 *   GET /memory                  — process memory snapshot
 */

import { Elysia } from "elysia";
import { sql } from "./db/client";

const PORT = parseInt(process.env.PORT ?? "3000");
const enc = new TextEncoder();

const app = new Elysia()
  .get("/health", () => ({ ok: true }))

  .get("/memory", () => {
    const mem = process.memoryUsage();
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };
  })

  // Strategy 1: Buffer everything — load all rows, serialize, send
  .get("/buffered", async ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`;
    const records = rows.map((r: { data: unknown }) => r.data);
    return new Response(JSON.stringify(records), {
      headers: { "Content-Type": "application/json" },
    });
  })

  // Strategy 2: Cursor + ReadableStream — batch cursor, manual stream
  .get("/stream-cursor", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.cursor(500);
          for await (const batch of cursor) {
            for (const row of batch) {
              controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
            }
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  })

  // Strategy 3: forEach + ReadableStream — postgres instant iteration, manual stream
  .get("/stream-foreach", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`
            .forEach((row: { data: unknown }) => {
              controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
            });
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  })

  // Strategy 4: Cursor + Elysia native yield — async generator streaming
  .get("/yield-cursor", async function* ({ query, set }) {
    set.headers["content-type"] = "application/x-ndjson";
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.cursor(500);
    for await (const batch of cursor) {
      for (const row of batch) {
        yield JSON.stringify(row.data) + "\n";
      }
    }
  })

  .listen(PORT);

console.log(`[server] listening on http://localhost:${PORT}`);
