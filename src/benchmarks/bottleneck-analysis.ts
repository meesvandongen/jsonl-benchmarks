/**
 * Streaming Bottleneck Analysis — consolidated HTTP benchmark runner.
 *
 * Spawns server-bottleneck.ts, then runs 4 test suites:
 *   1. HTTP Layer Isolation — where does streaming overhead come from?
 *   2. Enqueue Count Sweep — how does enqueue granularity affect RPS?
 *   3. Cursor Batch Size — DB roundtrip cost vs enqueue strategy
 *   4. Concurrency Scaling — proves event loop contention is the multiplier
 */

export interface BottleneckResult {
  section: string;
  name: string;
  concurrency: number;
  rps: number;
  p95: number;
  avgMs: number;
}

const PORT = "3350";
const BASE = `http://localhost:${PORT}`;
const BENCH_DURATION_SEC = 6;

// ─── Helpers ────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

async function driveLoad(
  url: string,
  concurrency: number,
  durationSec: number,
): Promise<{ rps: number; p95: number; avgMs: number }> {
  const latencies: number[] = [];
  let running = true;

  const worker = async () => {
    while (running) {
      const t = performance.now();
      try {
        const res = await fetch(url);
        const reader = res.body!.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
          if (!running) { await reader.cancel(); break; }
        }
        latencies.push(performance.now() - t);
      } catch {
        latencies.push(performance.now() - t);
      }
    }
  };

  // Warmup
  let wr = true;
  const ww = async () => {
    while (wr) {
      try {
        const r = await fetch(url);
        const rd = r.body!.getReader();
        while (true) { const { done } = await rd.read(); if (done) break; }
      } catch {}
    }
  };
  setTimeout(() => { wr = false; }, 1500);
  await Promise.all(Array.from({ length: Math.min(concurrency, 3) }, ww));
  await Bun.sleep(100);

  const stop = new Promise<void>((r) => setTimeout(() => { running = false; r(); }, durationSec * 1000));
  const hard = new Promise<void>((r) => setTimeout(r, (durationSec + 15) * 1000));
  await Promise.race([
    Promise.all([stop, ...Array.from({ length: concurrency }, worker)]),
    hard,
  ]);
  running = false;

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    rps: Math.round(latencies.length / durationSec),
    p95: percentile(sorted, 0.95),
    avgMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
  };
}

async function startServer(): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(["bun", "src/server-bottleneck.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT },
  });
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {}
    await Bun.sleep(500);
  }
  await Bun.sleep(300);
  return proc;
}

function printRow(name: string, r: { rps: number; p95: number; avgMs: number }, pad = 44) {
  console.log(`    ${name.padEnd(pad)} ${String(r.rps).padStart(6)}  ${fmtMs(r.p95).padStart(10)}  ${fmtMs(r.avgMs).padStart(10)}`);
}

// ─── Main runner ────────────────────────────────────────────────────────────

export async function runBottleneckAnalysis(): Promise<BottleneckResult[]> {
  const results: BottleneckResult[] = [];
  const proc = await startServer();

  try {
    // ── Suite 1: HTTP Layer Isolation ──────────────────────────────────
    console.log("\n  Suite 1: HTTP Layer Isolation (c=10)");
    console.log("  " + "─".repeat(72));

    const layerTests = [
      { name: "noop buffered (baseline)", path: "/noop-buffered" },
      { name: "noop stream (stream setup)", path: "/noop-stream" },
      { name: "buffered prebuilt (no DB)", path: "/buffered-prebuilt" },
      { name: "stream 1 enqueue (no DB)", path: "/stream-single" },
      { name: "stream 2 enqueues (no DB)", path: "/stream-prebuilt-batched" },
      { name: "stream 1k enqueues (no DB)", path: "/stream-prebuilt" },
      { name: "buffered (DB + JSON array)", path: "/buffered" },
      { name: "stream batch enqueue (DB cursor)", path: "/stream-batched" },
      { name: "stream per-row enqueue (DB cursor)", path: "/stream-per-row" },
    ];

    for (const t of layerTests) {
      const r = await driveLoad(`${BASE}${t.path}`, 10, BENCH_DURATION_SEC);
      results.push({ section: "http-layer", name: t.name, concurrency: 10, ...r });
      printRow(t.name, r);
    }

    // ── Suite 2: Enqueue Count Sweep ──────────────────────────────────
    console.log("\n  Suite 2: Enqueue Count Sweep — pre-built, no DB (c=10)");
    console.log("  " + "─".repeat(72));

    for (const n of [1, 2, 5, 10, 50, 100, 1000]) {
      const name = `${n} enqueue${n > 1 ? "s" : ""}`;
      const r = await driveLoad(`${BASE}/pre-${n}`, 10, BENCH_DURATION_SEC);
      results.push({ section: "enqueue-sweep", name, concurrency: 10, ...r });
      printRow(name, r);
    }

    // ── Suite 3: Cursor Batch Size ────────────────────────────────────
    console.log("\n  Suite 3: Cursor Batch Size — batch enqueue (c=10)");
    console.log("  " + "─".repeat(72));

    for (const bs of [50, 100, 250, 500, 1000]) {
      const batches = Math.ceil(1000 / bs);
      const name = `cursor(${bs}) → ${batches} enqueue${batches > 1 ? "s" : ""}`;
      const r = await driveLoad(`${BASE}/cursor-batch-${bs}`, 10, BENCH_DURATION_SEC);
      results.push({ section: "cursor-batch-size", name, concurrency: 10, ...r });
      printRow(name, r);
    }

    console.log("\n  Suite 3b: Cursor per-row enqueue (c=10)");
    console.log("  " + "─".repeat(72));

    for (const bs of [100, 500, 1000]) {
      const name = `cursor(${bs}) per-row → 1k enqueues`;
      const r = await driveLoad(`${BASE}/cursor-perrow-${bs}`, 10, BENCH_DURATION_SEC);
      results.push({ section: "cursor-perrow", name, concurrency: 10, ...r });
      printRow(name, r);
    }

    // ── Suite 4: Concurrency Scaling ──────────────────────────────────
    console.log("\n  Suite 4: Concurrency Scaling");
    console.log("  " + "─".repeat(72));

    const scalingEndpoints = [
      { name: "prebuilt per-row (no DB)", path: "/stream-prebuilt" },
      { name: "buffered (DB + JSON)", path: "/buffered" },
      { name: "buffered → per-row stream", path: "/buffered-then-perrow-stream" },
      { name: "cursor batch enqueue", path: "/stream-batched" },
      { name: "cursor per-row enqueue", path: "/stream-per-row" },
    ];

    for (const c of [1, 5, 10]) {
      console.log(`\n    concurrency = ${c}:`);
      for (const ep of scalingEndpoints) {
        const r = await driveLoad(`${BASE}${ep.path}`, c, BENCH_DURATION_SEC);
        results.push({ section: "concurrency-scaling", name: ep.name, concurrency: c, ...r });
        printRow(ep.name, r);
      }
    }

  } finally {
    proc.kill();
    await Bun.sleep(300);
  }

  return results;
}

if (import.meta.main) {
  console.log("\n  Streaming Bottleneck Analysis");
  console.log("  " + "═".repeat(72));
  const results = await runBottleneckAnalysis();
  console.log(`\n  Done. ${results.length} results collected.`);
  process.exit(0);
}
