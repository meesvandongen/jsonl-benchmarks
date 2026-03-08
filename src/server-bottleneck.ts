/**
 * Bottleneck analysis server — isolated endpoints for profiling streaming overhead.
 *
 * All endpoints return the same ~284KB payload (1000 rows) but via different paths
 * to isolate each layer of the streaming pipeline.
 */

import { sql } from "./db/client";

const PORT = parseInt(process.env.PORT ?? "3300");
const SIZE = 1_000;
const enc = new TextEncoder();

// Pre-built payloads (populated at startup)
let prebuiltChunks: Uint8Array[] = [];
let prebuiltFull: Uint8Array;
let prebuiltJson: string;

// Pre-fetch and pre-serialize
const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`;
prebuiltChunks = rows.map((r: any) => enc.encode(JSON.stringify(r.data) + "\n"));
const totalLen = prebuiltChunks.reduce((s, c) => s + c.length, 0);
prebuiltFull = new Uint8Array(totalLen);
let offset = 0;
for (const c of prebuiltChunks) { prebuiltFull.set(c, offset); offset += c.length; }
prebuiltJson = JSON.stringify(rows.map((r: any) => r.data));

// Pre-build batched buffers at various enqueue counts
function buildBatches(count: number): Uint8Array[] {
  const per = Math.ceil(prebuiltChunks.length / count);
  const result: Uint8Array[] = [];
  for (let i = 0; i < prebuiltChunks.length; i += per) {
    const slice = prebuiltChunks.slice(i, i + per);
    const len = slice.reduce((s, c) => s + c.length, 0);
    const buf = new Uint8Array(len);
    let o = 0;
    for (const c of slice) { buf.set(c, o); o += c.length; }
    result.push(buf);
  }
  return result;
}

const batchMap: Record<string, Uint8Array[]> = {
  "/pre-1": [prebuiltFull],
  "/pre-2": buildBatches(2),
  "/pre-5": buildBatches(5),
  "/pre-10": buildBatches(10),
  "/pre-50": buildBatches(50),
  "/pre-100": buildBatches(100),
  "/pre-1000": prebuiltChunks,
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") return Response.json({ ok: true });
    if (p === "/memory") {
      const mem = process.memoryUsage();
      return Response.json({ rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers });
    }

    // ─── HTTP Layer Isolation ─────────────────────────────────────────
    if (p === "/noop-buffered") return new Response("ok");
    if (p === "/noop-stream") return new Response(new ReadableStream({ start(c) { c.close(); } }));
    if (p === "/buffered-prebuilt") return new Response(prebuiltJson, { headers: { "Content-Type": "application/json" } });

    if (p === "/stream-single") {
      return new Response(new ReadableStream({ start(c) { c.enqueue(prebuiltFull); c.close(); } }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (p === "/stream-prebuilt-batched") {
      const b = batchMap["/pre-2"];
      return new Response(new ReadableStream({ start(c) { for (const ch of b) c.enqueue(ch); c.close(); } }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (p === "/stream-prebuilt") {
      return new Response(new ReadableStream({ start(c) { for (const ch of prebuiltChunks) c.enqueue(ch); c.close(); } }), { headers: { "Content-Type": "application/x-ndjson" } });
    }

    // Real DB endpoints
    if (p === "/buffered") {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`;
      return new Response(JSON.stringify(rows.map((r: any) => r.data)), { headers: { "Content-Type": "application/json" } });
    }
    if (p === "/stream-batched") {
      return new Response(new ReadableStream({
        async start(controller) {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(500);
          for await (const batch of cursor) {
            let chunk = "";
            for (const row of batch) chunk += JSON.stringify(row.data) + "\n";
            controller.enqueue(enc.encode(chunk));
          }
          controller.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (p === "/stream-per-row") {
      return new Response(new ReadableStream({
        async start(controller) {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(500);
          for await (const batch of cursor) {
            for (const row of batch) controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
          }
          controller.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }

    // ─── Enqueue count sweep (pre-built) ─────────────────────────────
    if (batchMap[p]) {
      const chunks = batchMap[p];
      return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }), { headers: { "Content-Type": "application/x-ndjson" } });
    }

    // ─── DB cursor with batch size variation ─────────────────────────
    if (p.startsWith("/cursor-batch-")) {
      const bs = parseInt(p.slice(14));
      return new Response(new ReadableStream({
        async start(controller) {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(bs);
          for await (const batch of cursor) {
            let chunk = "";
            for (const row of batch) chunk += JSON.stringify(row.data) + "\n";
            controller.enqueue(enc.encode(chunk));
          }
          controller.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (p.startsWith("/cursor-perrow-")) {
      const bs = parseInt(p.slice(15));
      return new Response(new ReadableStream({
        async start(controller) {
          const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(bs);
          for await (const batch of cursor) {
            for (const row of batch) controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
          }
          controller.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }

    // ─── Concurrency isolation endpoints ─────────────────────────────
    if (p === "/buffered-then-perrow-stream") {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`;
      return new Response(new ReadableStream({
        start(c) { for (const row of rows) c.enqueue(enc.encode(JSON.stringify(row.data) + "\n")); c.close(); },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[server-bottleneck] listening on http://localhost:${PORT}`);
