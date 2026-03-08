/**
 * Streaming Bottleneck Deep Dive
 *
 * Systematically isolates each layer to find where streaming loses time:
 *
 *  Layer 1: Pure DB read — cursor vs buffered (no serialization, no HTTP)
 *  Layer 2: Serialization — JSON.stringify per-row vs bulk array
 *  Layer 3: TextEncoder — per-row encode vs single encode
 *  Layer 4: ReadableStream — enqueue overhead (no HTTP, just stream creation + drain)
 *  Layer 5: HTTP response — streaming vs buffered via localhost fetch
 *  Layer 6: Cursor batch size impact — 50, 100, 500, 1000, 5000
 *  Layer 7: Chunking strategy — per-row enqueue vs batched enqueue
 */

import { bench, group, run, boxplot } from "mitata";
import { sql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded } from "../db/setup";

const enc = new TextEncoder();
const SIZE = 1_000; // Match the 1k row case from RESULTS.md

// ─── Layer 1: Pure DB read ──────────────────────────────────────────────────

group("Layer 1: Pure DB read (1k rows)", () => {
  bench("buffered SELECT", async () => {
    const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`;
    if (rows.length !== SIZE) throw new Error("bad");
  });

  bench("cursor(500) iterate", async () => {
    let n = 0;
    const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(500);
    for await (const batch of cursor) {
      n += batch.length;
    }
    if (n !== SIZE) throw new Error("bad");
  });

  bench("cursor(1000) iterate", async () => {
    let n = 0;
    const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(1000);
    for await (const batch of cursor) {
      n += batch.length;
    }
    if (n !== SIZE) throw new Error("bad");
  });

  bench("forEach iterate", async () => {
    let n = 0;
    await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`
      .forEach(() => { n++; });
    if (n !== SIZE) throw new Error("bad");
  });
});

// ─── Layer 2: Serialization ─────────────────────────────────────────────────

// Pre-fetch rows for serialization benchmarks
let prefetched: any[] = [];

group("Layer 2: Serialization (1k rows, pre-fetched)", () => {
  bench("JSON.stringify(array) — single call", () => {
    const out = JSON.stringify(prefetched.map(r => r.data));
    if (out.length === 0) throw new Error("bad");
  });

  bench("JSON.stringify per-row + concat", () => {
    let out = "";
    for (const row of prefetched) {
      out += JSON.stringify(row.data) + "\n";
    }
    if (out.length === 0) throw new Error("bad");
  });

  bench("JSON.stringify per-row into array + join", () => {
    const parts: string[] = [];
    for (const row of prefetched) {
      parts.push(JSON.stringify(row.data));
    }
    const out = parts.join("\n");
    if (out.length === 0) throw new Error("bad");
  });
});

// ─── Layer 3: TextEncoder ───────────────────────────────────────────────────

let serializedLines: string[] = [];

group("Layer 3: TextEncoder (1k NDJSON lines)", () => {
  bench("encode entire string at once", () => {
    const full = serializedLines.join("\n") + "\n";
    const buf = enc.encode(full);
    if (buf.length === 0) throw new Error("bad");
  });

  bench("encode per-line (1k calls)", () => {
    let total = 0;
    for (const line of serializedLines) {
      const buf = enc.encode(line + "\n");
      total += buf.length;
    }
    if (total === 0) throw new Error("bad");
  });
});

// ─── Layer 4: ReadableStream overhead ───────────────────────────────────────

let encodedChunks: Uint8Array[] = [];

group("Layer 4: ReadableStream enqueue + drain (1k chunks, no HTTP)", () => {
  bench("enqueue per-row (1k enqueues)", async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of encodedChunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const reader = stream.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
    }
    if (total === 0) throw new Error("bad");
  });

  bench("enqueue single large buffer", async () => {
    const full = new Uint8Array(encodedChunks.reduce((s, c) => s + c.length, 0));
    let offset = 0;
    for (const c of encodedChunks) {
      full.set(c, offset);
      offset += c.length;
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(full);
        controller.close();
      },
    });
    const reader = stream.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
    }
    if (total === 0) throw new Error("bad");
  });

  bench("enqueue batched (2 enqueues of ~500 rows)", async () => {
    const mid = Math.floor(encodedChunks.length / 2);
    const batch1Size = encodedChunks.slice(0, mid).reduce((s, c) => s + c.length, 0);
    const batch2Size = encodedChunks.slice(mid).reduce((s, c) => s + c.length, 0);
    const buf1 = new Uint8Array(batch1Size);
    const buf2 = new Uint8Array(batch2Size);
    let off = 0;
    for (let i = 0; i < mid; i++) { buf1.set(encodedChunks[i], off); off += encodedChunks[i].length; }
    off = 0;
    for (let i = mid; i < encodedChunks.length; i++) { buf2.set(encodedChunks[i], off); off += encodedChunks[i].length; }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(buf1);
        controller.enqueue(buf2);
        controller.close();
      },
    });
    const reader = stream.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
    }
    if (total === 0) throw new Error("bad");
  });
});

// ─── Layer 5: Full pipeline (DB + serialize + encode + stream) — no HTTP ────

group("Layer 5: Full pipeline, no HTTP (1k rows)", () => {
  bench("buffered: SELECT + JSON.stringify(array)", async () => {
    const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`;
    const body = JSON.stringify(rows.map((r: any) => r.data));
    if (body.length === 0) throw new Error("bad");
  });

  bench("cursor: iterate + per-row stringify + encode + enqueue", async () => {
    const stream = new ReadableStream({
      async start(controller) {
        const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(500);
        for await (const batch of cursor) {
          for (const row of batch) {
            controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
          }
        }
        controller.close();
      },
    });
    const reader = stream.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
    }
    if (total === 0) throw new Error("bad");
  });

  bench("cursor: iterate + BATCH stringify+encode per cursor batch", async () => {
    const stream = new ReadableStream({
      async start(controller) {
        const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(500);
        for await (const batch of cursor) {
          let chunk = "";
          for (const row of batch) {
            chunk += JSON.stringify(row.data) + "\n";
          }
          controller.enqueue(enc.encode(chunk));
        }
        controller.close();
      },
    });
    const reader = stream.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
    }
    if (total === 0) throw new Error("bad");
  });
});

// ─── Layer 6: Cursor batch size impact ──────────────────────────────────────

group("Layer 6: Cursor batch size (1k rows, DB only)", () => {
  for (const batchSize of [50, 100, 250, 500, 1000]) {
    bench(`cursor(${batchSize})`, async () => {
      let n = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`.cursor(batchSize);
      for await (const batch of cursor) {
        n += batch.length;
      }
      if (n !== SIZE) throw new Error("bad");
    });
  }
});

// ─── Layer 7: Cursor roundtrips — measure async iteration overhead ──────────

group("Layer 7: Async iteration cost (1k items)", () => {
  bench("for loop over array (baseline)", () => {
    let n = 0;
    for (const row of prefetched) {
      n++;
    }
    if (n !== SIZE) throw new Error("bad");
  });

  bench("for-await over async generator (1k yields)", async () => {
    async function* gen() {
      for (const row of prefetched) {
        yield row;
      }
    }
    let n = 0;
    for await (const _ of gen()) {
      n++;
    }
    if (n !== SIZE) throw new Error("bad");
  });

  bench("for-await over async generator (2 batch yields)", async () => {
    async function* gen() {
      const mid = Math.floor(prefetched.length / 2);
      yield prefetched.slice(0, mid);
      yield prefetched.slice(mid);
    }
    let n = 0;
    for await (const batch of gen()) {
      n += batch.length;
    }
    if (n !== SIZE) throw new Error("bad");
  });
});

// ─── Bootstrap & run ────────────────────────────────────────────────────────

if (import.meta.main) {
  console.log("Connecting to PostgreSQL...");
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);

  // Pre-fetch data for layers 2-4
  console.log("Pre-fetching 1k rows for isolation benchmarks...");
  prefetched = await sql`SELECT data FROM records ORDER BY id LIMIT ${SIZE}`;
  serializedLines = prefetched.map(r => JSON.stringify(r.data));
  encodedChunks = serializedLines.map(l => enc.encode(l + "\n"));

  console.log(`  Row payload sample size: ${serializedLines[0].length} bytes`);
  console.log(`  Total NDJSON size: ${encodedChunks.reduce((s, c) => s + c.length, 0)} bytes`);
  console.log("\nRunning bottleneck analysis...\n");

  await run();

  await sql.end();
  await pool.end();
}
