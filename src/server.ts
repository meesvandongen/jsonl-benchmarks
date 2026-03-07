/**
 * Benchmark server — five response strategies backed by PostgreSQL:
 *
 *   GET /buffered?limit=N         — porsager SELECT all, JSON array
 *   GET /stream-cursor?limit=N    — porsager .cursor(500) + ReadableStream NDJSON
 *   GET /stream-foreach?limit=N   — porsager .forEach(fn) + ReadableStream NDJSON
 *   GET /yield-cursor?limit=N     — porsager .cursor(500) + Elysia yield
 *   GET /pg-query-stream?limit=N  — pg-query-stream cursor + ReadableStream NDJSON
 *   GET /health                   — healthcheck
 *   GET /memory                   — process memory snapshot
 */

import { Elysia } from "elysia";
import { sql, pool } from "./db/client";
import QueryStream from "pg-query-stream";

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

  // Strategy 1: porsager buffered — load all rows, JSON array
  .get("/buffered", async ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`;
    const records = rows.map((r: { data: unknown }) => r.data);
    return new Response(JSON.stringify(records), {
      headers: { "Content-Type": "application/json" },
    });
  })

  // Strategy 2: porsager cursor + ReadableStream
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

  // Strategy 3: porsager forEach + ReadableStream
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

  // Strategy 4: porsager cursor + Elysia yield
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

  // Strategy 5: pg-query-stream + ReadableStream
  .get("/pg-query-stream", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const stream = new ReadableStream({
      async start(controller) {
        const client = await pool.connect();
        try {
          const qs = new QueryStream(
            "SELECT data FROM records ORDER BY id LIMIT $1",
            [limit],
            { batchSize: 500 }
          );
          const pgStream = client.query(qs);
          for await (const row of pgStream) {
            controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        } finally {
          client.release();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  })

  .listen(PORT);

console.log(`[server] listening on http://localhost:${PORT}`);
