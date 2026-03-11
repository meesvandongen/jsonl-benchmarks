/**
 * Memory & GC Pressure Benchmark — measures heap impact and GC reclaim.
 *
 * Compares:
 *   1. Buffered vs streaming heap usage (manual measurement)
 *   2. porsager .cursor(500) vs .forEach() vs @mvd/postgres .stream()
 *   3. ArrayBuffer reuse vs fresh allocation per row
 *   4. GC reclaimable memory after buffered vs streaming
 */

import { bench, group, run } from "mitata";
import { sql, mvdSql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded } from "../db/setup";

const SIZES = [10_000, 100_000];
const enc = new TextEncoder();

async function measurePeakHeap<T>(fn: (sampleHeap: () => void) => Promise<T>): Promise<{ peakDeltaBytes: number; retainedBytes: number; result: T }> {
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  let maxHeap = heapBefore;

  const sampleHeap = () => {
    const current = process.memoryUsage().heapUsed;
    if (current > maxHeap) maxHeap = current;
  };

  const poller = setInterval(() => {
    sampleHeap();
  }, 1);

  try {
    const result = await fn(sampleHeap);
    sampleHeap();
    Bun.gc(true);
    const heapPostGc = process.memoryUsage().heapUsed;

    return {
      peakDeltaBytes: Math.max(0, maxHeap - heapBefore),
      retainedBytes: Math.max(0, heapPostGc - heapBefore),
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
    const buffered = await measurePeakHeap(async (sampleHeap) => {
      const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
      sampleHeap();
      const serialized = rows.map((r) => JSON.stringify((r as { data: unknown }).data));
      sampleHeap();
      return serialized.length;
    });
    console.log(`    buffered:         heap +${fmtMemory(buffered.peakDeltaBytes)} peak, ${fmtMemory(buffered.retainedBytes)} retained after GC`);

    // Streaming via cursor: process row by row
    const cursorStream = await measurePeakHeap(async (sampleHeap) => {
      let count = 0;
      const cursor = sql`SELECT data FROM records ORDER BY id LIMIT ${size}`.cursor(500);
      for await (const batch of cursor) {
        sampleHeap();
        for (const row of batch) {
          const serialized = JSON.stringify(row.data);
          sampleHeap();
          if (serialized.length === 0) throw new Error("unexpected empty serialization");
          count++;
        }
      }
      return count;
    });
    console.log(`    porsager cursor:  heap +${fmtMemory(cursorStream.peakDeltaBytes)} peak, ${fmtMemory(cursorStream.retainedBytes)} retained after GC (${cursorStream.result} rows)`);

    // Streaming via porsager .forEach()
    const forEachStream = await measurePeakHeap(async (sampleHeap) => {
      let count = 0;
      await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`
        .forEach((row) => {
          const serialized = JSON.stringify((row as { data: unknown }).data);
          sampleHeap();
          if (serialized.length === 0) throw new Error("unexpected empty serialization");
          count++;
        });
      return count;
    });
    console.log(`    porsager forEach: heap +${fmtMemory(forEachStream.peakDeltaBytes)} peak, ${fmtMemory(forEachStream.retainedBytes)} retained after GC (${forEachStream.result} rows)`);

    // Streaming via @mvd/postgres .stream()
    const mvdStream = await measurePeakHeap(async (sampleHeap) => {
      let count = 0;
      for await (const row of mvdSql`SELECT data FROM records ORDER BY id LIMIT ${size}`.stream()) {
        const serialized = JSON.stringify(row.data);
        sampleHeap();
        if (serialized.length === 0) throw new Error("unexpected empty serialization");
        count++;
      }
      return count;
    });
    console.log(`    mvd .stream():    heap +${fmtMemory(mvdStream.peakDeltaBytes)} peak, ${fmtMemory(mvdStream.retainedBytes)} retained after GC (${mvdStream.result} rows)`);
  }
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function toKB(bytes: number): number {
  return Math.round((bytes / 1024) * 100) / 100;
}

function fmtMemory(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${toMB(bytes)}MB`;
  if (bytes >= 1024) return `${toKB(bytes)}KB`;
  return `${bytes}B`;
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
