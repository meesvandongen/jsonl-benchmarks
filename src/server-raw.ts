/**
 * Raw Bun.serve() benchmark server — no Elysia framework.
 * Purpose: measure Elysia framework overhead against identical endpoints.
 *
 *   GET /health              — healthcheck
 *   GET /memory              — process memory snapshot
 *   GET /buffered?limit=N    — porsager SELECT all, JSON array
 *   GET /stream-cursor?limit=N  — porsager .cursor(500) + ReadableStream NDJSON
 *   GET /stream-foreach?limit=N — porsager .forEach() + ReadableStream NDJSON
 *   GET /mvd-stream?limit=N         — @mvd/postgres .stream() + ReadableStream NDJSON
 */

import { sql, mvdSql } from "./db/client";

const PORT = parseInt(process.env.PORT ?? "3000");
const enc = new TextEncoder();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    // GET /health
    if (pathname === "/health") {
      return Response.json({ ok: true });
    }

    // GET /memory
    if (pathname === "/memory") {
      const mem = process.memoryUsage();
      return Response.json({
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      });
    }

    // GET /buffered?limit=N — porsager SELECT all, JSON array
    if (pathname === "/buffered") {
      const limit = parseInt(searchParams.get("limit") ?? "1000");
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${limit}`;
      const records = rows.map((r: { data: unknown }) => r.data);
      return new Response(JSON.stringify(records), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /stream-cursor?limit=N — porsager .cursor(500) + ReadableStream NDJSON
    if (pathname === "/stream-cursor") {
      const limit = parseInt(searchParams.get("limit") ?? "1000");
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
    }

    // GET /stream-foreach?limit=N — porsager .forEach() + ReadableStream NDJSON
    if (pathname === "/stream-foreach") {
      const limit = parseInt(searchParams.get("limit") ?? "1000");
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
    }

    // GET /mvd-stream?limit=N — @mvd/postgres .stream() + ReadableStream NDJSON
    if (pathname === "/mvd-stream") {
      const limit = parseInt(searchParams.get("limit") ?? "1000");
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const row of mvdSql`SELECT data FROM records ORDER BY id LIMIT ${limit}`.stream()) {
              controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
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
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[server-raw] listening on http://localhost:${PORT}`);
