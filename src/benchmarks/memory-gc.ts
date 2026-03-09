/**
 * Memory & GC Pressure Benchmark — measures heap impact and GC reclaim.
 *
 * Compares:
 *   1. Buffered vs streaming heap usage (manual measurement)
 *   2. @mvd/postgres .stream() heap usage under streaming backpressure
 *   2. ArrayBuffer reuse vs fresh allocation per row
 *   3. GC reclaimable memory after buffered vs streaming
 */

import { bench, group, run } from "mitata";
import { sql, mvdSql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded } from "../db/setup";

const SIZES = [10_000, 100_000];
const enc = new TextEncoder();

async function measurePeakHeap<T>(fn: () => Promise<T>): Promise<{ peakDeltaMB: number; retainedMB: number; result: T }> {
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  let maxHeap = heapBefore;

  const poller = setInterval(() => {
    const current = process.memoryUsage().heapUsed;
    if (current > maxHeap) maxHeap = current;
  }, 5);

  try {
    const result = await fn();
    const current = process.memoryUsage().heapUsed;
    if (current > maxHeap) maxHeap = current;
    Bun.gc(true);
    const heapPostGc = process.memoryUsage().heapUsed;

    return {
      peakDeltaMB: toMB(Math.max(0, maxHeap - heapBefore)),
      retainedMB: toMB(Math.max(0, heapPostGc - heapBefore)),
      result,
    };
  } finally {
    clearInterval(poller);
  }
}

// ─── GC Pressure measurement (manual, outside mitata) ─────────────────

async function measureGcPressure() {
  console.log("\n  GC Pressure Analysis");
  console.log("  " + "─".repeat(68));

  for (const size of SIZES) {
    console.log(`\n  ${size.toLocaleString()} rows:`);

    // Buffered: load all into memory
    const buffered = await measurePeakHeap(async () => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      const serialized = rows.map((r) => JSON.stringify((r as { data: unknown }).data));
      return serialized.length;
    });
    console.log(`    buffered:         heap +${buffered.peakDeltaMB}MB peak, ${buffered.retainedMB}MB retained after GC`);

    // Streaming via cursor: process row by row
    const cursorStream = await measurePeakHeap(async () => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          JSON.stringify(row.data);
          count++;
        }
      }
      return count;
    });
    console.log(`    porsager cursor:  heap +${cursorStream.peakDeltaMB}MB peak, ${cursorStream.retainedMB}MB retained after GC (${cursorStream.result} rows)`);

    // Streaming via @mvd/postgres .stream()
    const mvdStream = await measurePeakHeap(async () => {
      let count = 0;
      for await (const row of mvdSql`SELECT data FROM records ORDER BY id LIMIT ${size}`.stream()) {
        JSON.stringify(row.data);
        count++;
      }
      return count;
    });
    console.log(`    mvd .stream():    heap +${mvdStream.peakDeltaMB}MB peak, ${mvdStream.retainedMB}MB retained after GC (${mvdStream.result} rows)`);
  }
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

// ─── ArrayBuffer pooling benchmark (mitata) ────────────────────────────

class BufferPool {
  private pool: Uint8Array[] = [];
  private size: number;

  constructor(count: number, size: number) {
    this.size = size;
    for (let i = 0; i < count; i++) {
      this.pool.push(new Uint8Array(size));
    }
  }

  acquire(): Uint8Array {
    return this.pool.pop() ?? new Uint8Array(this.size);
  }

  release(buf: Uint8Array) {
    if (this.pool.length < 100) {
      this.pool.push(buf);
    }
  }
}

for (const size of SIZES) {
  group(`ArrayBuffer allocation — ${size.toLocaleString()} rows`, () => {
    bench("fresh TextEncoder.encode()", async () => {
      let bytes = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          const encoded = enc.encode(JSON.stringify(row.data) + "\n");
          bytes += encoded.byteLength;
        }
      }
      if (bytes === 0) throw new Error("no data");
    });

    bench("pre-allocated buffer pool", async () => {
      let bytes = 0;
      const bufPool = new BufferPool(50, 2048);
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        for (const row of batch) {
          const str = JSON.stringify(row.data) + "\n";
          const buf = bufPool.acquire();
          const result = enc.encodeInto(str, buf);
          bytes += result.written ?? 0;
          bufPool.release(buf);
        }
      }
      if (bytes === 0) throw new Error("no data");
    });
  });
}

if (import.meta.main) {
  console.log("Connecting to PostgreSQL...");
  await waitForDb();
  await setupTables();
  await seedIfNeeded(100_000);

  // Run GC pressure analysis first
  await measureGcPressure();

  // Then mitata benchmarks
  console.log("\nRunning allocation benchmarks...\n");
  await run();

  await mvdSql.end();
  await sql.end();
  await pool.end();
}
