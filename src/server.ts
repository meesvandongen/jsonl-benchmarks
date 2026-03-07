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

  // Strategy 6: cursor + gzip compression
  .get("/stream-cursor-gzip", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const raw = new ReadableStream({
      async start(controller) {
        try {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.cursor(500);
          for await (const batch of cursor) {
            for (const row of batch) {
              controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
            }
          }
          controller.close();
        } catch (e) { controller.error(e); }
      },
    });
    const compressed = raw.pipeThrough(new CompressionStream("gzip"));
    return new Response(compressed, {
      headers: { "Content-Type": "application/x-ndjson", "Content-Encoding": "gzip" },
    });
  })

  // Strategy 7: pull-based ReadableStream
  .get("/stream-cursor-pull", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.cursor(500);
    const iter = cursor[Symbol.asyncIterator]();
    let batch: any[] = [];
    let idx = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        while (idx >= batch.length) {
          const next = await iter.next();
          if (next.done) { controller.close(); return; }
          batch = next.value;
          idx = 0;
        }
        controller.enqueue(enc.encode(JSON.stringify(batch[idx++].data) + "\n"));
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  })

  // Strategy 8: NDJSON ingest
  .post("/ingest", async ({ request }) => {
    const body = await request.text();
    const lines = body.split("\n").filter(Boolean);
    const values = lines.map(l => l);
    await sql`
      CREATE TABLE IF NOT EXISTS records_bench (id BIGSERIAL PRIMARY KEY, data JSONB NOT NULL)
    `;
    await sql`
      INSERT INTO records_bench (data)
      SELECT v::jsonb FROM unnest(${values}::text[]) AS v
    `;
    return { inserted: lines.length };
  })

  // Strategy 9: filtered streaming with WHERE clause
  .get("/filtered", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const cursor = sql`SELECT data FROM records WHERE data->>'active' = 'true' ORDER BY id LIMIT ${limit}`.cursor(500);
          for await (const batch of cursor) {
            for (const row of batch) {
              controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
            }
          }
          controller.close();
        } catch (e) { controller.error(e); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  })

  // Strategy 10: OFFSET/LIMIT pagination
  .get("/paginated", async ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const pageSize = parseInt((query as Record<string, string>).page_size ?? "1000");
    const allRecords: unknown[] = [];
    for (let offset = 0; offset < limit; offset += pageSize) {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`;
      for (const row of rows) allRecords.push(row.data);
    }
    return new Response(JSON.stringify(allRecords), {
      headers: { "Content-Type": "application/json" },
    });
  })

  // Strategy 11: cursor stream with transform (redact email)
  .get("/stream-transform", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const source = new ReadableStream({
      async start(controller) {
        try {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.cursor(500);
          for await (const batch of cursor) {
            for (const row of batch) {
              controller.enqueue(row.data);
            }
          }
          controller.close();
        } catch (e) { controller.error(e); }
      },
    });
    const transform = new TransformStream({
      transform(record: any, controller) {
        const redacted = { ...record, email: "***@***.com" };
        controller.enqueue(enc.encode(JSON.stringify(redacted) + "\n"));
      },
    });
    const stream = source.pipeThrough(transform);
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  })

  // Strategy 12: stream JOIN query results
  .get("/stream-join", ({ query }) => {
    const limit = parseInt((query as Record<string, string>).limit ?? "1000");
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const cursor = sql`
            SELECT u.name, u.email, o.amount, o.status
            FROM users u
            JOIN orders o ON o.user_id = u.id
            ORDER BY u.id, o.id
            LIMIT ${limit}
          `.cursor(500);
          for await (const batch of cursor) {
            for (const row of batch) {
              controller.enqueue(enc.encode(JSON.stringify(row) + "\n"));
            }
          }
          controller.close();
        } catch (e) { controller.error(e); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  })

  // Strategy 13: WebSocket streaming
  .ws("/ws-stream", {
    async message(ws, message) {
      const parsed = typeof message === "string" ? JSON.parse(message) : message;
      const limit = parsed.limit ?? 1000;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          ws.send(JSON.stringify(row.data));
        }
      }
      ws.send(JSON.stringify({ __done: true }));
    },
  })

  .listen(PORT);

console.log(`[server] listening on http://localhost:${PORT}`);
