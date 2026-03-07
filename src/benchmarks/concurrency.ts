/**
 * Concurrency & Backpressure Benchmark
 *
 * Tests:
 *   1. Varying concurrency (1, 10, 50, 100) on stream-cursor with 100k rows
 *   2. Slow client simulation — throttled reader
 *   3. Connection pool saturation — max=5 with 50 concurrent requests
 *   4. Pull-based vs start-based ReadableStream
 */

const PORT = "3100";
const BASE = `http://localhost:${PORT}`;
const BENCH_DURATION_SEC = 6;
const MEMORY_POLL_MS = 50;

export interface ConcurrencyResult {
  test: string;
  concurrency: number;
  totalRequests: number;
  errors: number;
  rps: number;
  p95: number;
  peakRssDeltaMB: number;
  baselineRss: number;
  peakRss: number;
}

async function getMemory(): Promise<{ rss: number }> {
  const res = await fetch(`${BASE}/memory`);
  return res.json() as any;
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

async function driveLoad(
  url: string,
  concurrency: number,
  durationSec: number,
  slowReadMs = 0,
): Promise<{ latencies: number[]; bytes: number; errors: number }> {
  const latencies: number[] = [];
  let totalBytes = 0;
  let errors = 0;
  let running = true;

  const worker = async () => {
    while (running) {
      const t = performance.now();
      try {
        const res = await fetch(url);
        const reader = res.body!.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value?.byteLength ?? 0;
          if (!running) { await reader.cancel(); break; }
          if (slowReadMs > 0) await Bun.sleep(slowReadMs);
        }
        latencies.push(performance.now() - t);
      } catch {
        errors++;
        latencies.push(performance.now() - t);
      }
    }
  };

  const stop = new Promise<void>((resolve) =>
    setTimeout(() => { running = false; resolve(); }, durationSec * 1000),
  );
  const hardTimeout = new Promise<void>((resolve) =>
    setTimeout(resolve, (durationSec + 15) * 1000),
  );
  await Promise.race([
    Promise.all([stop, ...Array.from({ length: concurrency }, worker)]),
    hardTimeout,
  ]);
  running = false;
  return { latencies, bytes: totalBytes, errors };
}

function startMemoryPoller() {
  const rssValues: number[] = [];
  let running = true;
  const poll = async () => {
    while (running) {
      try { rssValues.push((await getMemory()).rss); } catch {}
      await Bun.sleep(MEMORY_POLL_MS);
    }
  };
  poll();
  return { stop: () => { running = false; return rssValues; } };
}

async function startServer(envOverrides: Record<string, string> = {}): Promise<{ proc: ReturnType<typeof Bun.spawn>; baselineRss: number }> {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT, ...envOverrides },
  });
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(500);
  }
  await Bun.sleep(300);
  const baselineRss = (await getMemory()).rss;
  return { proc, baselineRss };
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

async function runTest(
  label: string,
  url: string,
  concurrency: number,
  durationSec: number,
  baselineRss: number,
  slowReadMs = 0,
): Promise<ConcurrencyResult> {
  await driveLoad(url, Math.min(concurrency, 3), 1, slowReadMs);
  await Bun.sleep(100);

  const poller = startMemoryPoller();
  const raw = await driveLoad(url, concurrency, durationSec, slowReadMs);
  const rssValues = poller.stop();
  const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
  const sorted = [...raw.latencies].sort((a, b) => a - b);

  return {
    test: label,
    concurrency,
    totalRequests: raw.latencies.length,
    errors: raw.errors,
    rps: raw.latencies.length / durationSec,
    p95: percentile(sorted, 0.95),
    peakRssDeltaMB: toMB(peakRss - baselineRss),
    baselineRss,
    peakRss,
  };
}

function printResult(r: ConcurrencyResult) {
  const rpsStr = String(Math.round(r.rps)).padStart(6);
  console.log(`${rpsStr} RPS   ${fmtMs(r.p95).padStart(8)} p95   +${String(r.peakRssDeltaMB).padStart(7)}MB`);
}

export async function runConcurrencyBenchmark(): Promise<ConcurrencyResult[]> {
  const results: ConcurrencyResult[] = [];

  // Test 1: Varying concurrency
  console.log("\n  Varying concurrency (stream-cursor, 100k rows):");
  console.log("  " + "─".repeat(68));
  for (const c of [1, 10, 50, 100]) {
    const { proc, baselineRss } = await startServer();
    try {
      process.stdout.write(`    concurrency=${String(c).padStart(3)}  `);
      const result = await runTest(`concurrency=${c}`, `${BASE}/stream-cursor?limit=100000`, c, BENCH_DURATION_SEC, baselineRss);
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  // Test 2: Slow client
  console.log("\n  Slow client simulation (stream-cursor, 10k rows):");
  console.log("  " + "─".repeat(68));
  for (const delay of [0, 5, 10, 50]) {
    const { proc, baselineRss } = await startServer();
    try {
      process.stdout.write(`    delay=${String(delay).padStart(2)}ms        `);
      const result = await runTest(`slow_${delay}ms`, `${BASE}/stream-cursor?limit=10000`, 10, BENCH_DURATION_SEC, baselineRss, delay);
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  // Test 3: Pool saturation
  console.log("\n  Pool saturation (max=5, 50 concurrent, 10k rows):");
  console.log("  " + "─".repeat(68));
  {
    const { proc, baselineRss } = await startServer({ DB_POOL_MAX: "5" });
    try {
      process.stdout.write(`    pool_max=5, c=50  `);
      const result = await runTest("pool_saturated", `${BASE}/stream-cursor?limit=10000`, 50, BENCH_DURATION_SEC, baselineRss);
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  // Test 4: Pull-based vs start-based
  console.log("\n  Pull-based vs start-based ReadableStream (100k rows):");
  console.log("  " + "─".repeat(68));
  for (const [label, endpoint] of [["start-based", "stream-cursor"], ["pull-based", "stream-cursor-pull"]] as const) {
    const { proc, baselineRss } = await startServer();
    try {
      process.stdout.write(`    ${label.padEnd(14)}  `);
      const result = await runTest(label, `${BASE}/${endpoint}?limit=100000`, 10, BENCH_DURATION_SEC, baselineRss);
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  return results;
}

if (import.meta.main) {
  console.log("\n  Concurrency & Backpressure Benchmark");
  const results = await runConcurrencyBenchmark();
  console.log("\nDone.", results.length, "results collected.");
}
