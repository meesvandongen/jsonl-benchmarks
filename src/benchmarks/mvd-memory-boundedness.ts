/**
 * @mvd/postgres bounded-memory benchmark.
 *
 * Goal:
 *   Measure peak RSS for @mvd/postgres `.stream()` under realistic HTTP
 *   streaming load so we can make clear statements about boundedness.
 *
 * Scenarios:
 *   1. buffered control (100k rows, c=10)
 *   2. mvd-stream concurrency sweep (100k rows, c=1/10/50/100)
 *   3. mvd-stream slow-consumer sweep (10k rows, c=10, 0/5/10/50ms read delay)
 *   4. mvd-stream soak test (100k rows, c=10, 30s)
 */

const PORT = "3110";
const BASE = `http://localhost:${PORT}`;
const MEMORY_POLL_MS = 50;
const WARMUP_SEC = 1;
const BENCH_DURATION_SEC = 8;

export interface MvdMemoryResult {
  scenario: string;
  strategy: "buffered" | "mvd-stream";
  payloadSize: number;
  concurrency: number;
  slowReadMs: number;
  durationSec: number;
  totalRequests: number;
  errors: number;
  rps: number;
  p95: number;
  baselineRss: number;
  peakRss: number;
  peakRssDeltaMB: number;
  endRss: number;
  endRssDeltaMB: number;
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

async function getMemory(): Promise<{ rss: number }> {
  const res = await fetch(`${BASE}/memory`);
  return res.json() as Promise<{ rss: number }>;
}

function startMemoryPoller() {
  const rssValues: number[] = [];
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        rssValues.push((await getMemory()).rss);
      } catch {}
      await Bun.sleep(MEMORY_POLL_MS);
    }
  };
  poll();
  return { stop: () => { running = false; return rssValues; } };
}

async function driveLoad(
  url: string,
  isStream: boolean,
  concurrency: number,
  durationSec: number,
  slowReadMs = 0,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let running = true;

  const worker = async () => {
    while (running) {
      const t = performance.now();
      try {
        const res = await fetch(url);
        if (isStream) {
          const reader = res.body!.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
            if (!running) {
              await reader.cancel();
              break;
            }
            if (slowReadMs > 0) await Bun.sleep(slowReadMs);
          }
        } else {
          await res.arrayBuffer();
        }
        latencies.push(performance.now() - t);
      } catch {
        errors++;
        latencies.push(performance.now() - t);
      }
    }
  };

  const stop = new Promise<void>((resolve) =>
    setTimeout(() => {
      running = false;
      resolve();
    }, durationSec * 1000),
  );
  const hardTimeout = new Promise<void>((resolve) =>
    setTimeout(resolve, (durationSec + 20) * 1000),
  );

  await Promise.race([
    Promise.all([stop, ...Array.from({ length: concurrency }, worker)]),
    hardTimeout,
  ]);
  running = false;

  return { latencies, errors };
}

async function startServer(): Promise<{ proc: ReturnType<typeof Bun.spawn>; baselineRss: number }> {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT },
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

async function runScenario(args: {
  scenario: string;
  strategy: "buffered" | "mvd-stream";
  payloadSize: number;
  concurrency: number;
  slowReadMs?: number;
  durationSec?: number;
  baselineRss: number;
}): Promise<MvdMemoryResult> {
  const {
    scenario,
    strategy,
    payloadSize,
    concurrency,
    slowReadMs = 0,
    durationSec = BENCH_DURATION_SEC,
    baselineRss,
  } = args;

  const url = `${BASE}/${strategy}?limit=${payloadSize}`;
  const isStream = strategy !== "buffered";

  await driveLoad(url, isStream, Math.min(concurrency, 3), WARMUP_SEC, slowReadMs);
  await Bun.sleep(100);

  const poller = startMemoryPoller();
  const raw = await driveLoad(url, isStream, concurrency, durationSec, slowReadMs);
  const rssValues = poller.stop();
  const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
  const endRss = rssValues.length > 0 ? rssValues[rssValues.length - 1] : peakRss;
  const sorted = [...raw.latencies].sort((a, b) => a - b);

  return {
    scenario,
    strategy,
    payloadSize,
    concurrency,
    slowReadMs,
    durationSec,
    totalRequests: raw.latencies.length,
    errors: raw.errors,
    rps: raw.latencies.length / durationSec,
    p95: percentile(sorted, 0.95),
    baselineRss,
    peakRss,
    peakRssDeltaMB: toMB(peakRss - baselineRss),
    endRss,
    endRssDeltaMB: toMB(endRss - baselineRss),
  };
}

function printResult(result: MvdMemoryResult) {
  const rps = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : String(Math.round(result.rps));
  console.log(
    `    ${result.scenario.padEnd(28)} ${rps.padStart(6)} RPS   ${fmtMs(result.p95).padStart(8)} p95   +${String(result.peakRssDeltaMB).padStart(7)}MB peak   +${String(result.endRssDeltaMB).padStart(7)}MB end`,
  );
}

export async function runMvdMemoryBoundednessBenchmark(): Promise<MvdMemoryResult[]> {
  const results: MvdMemoryResult[] = [];

  console.log("\n  @mvd/postgres Bounded-Memory Benchmark");
  console.log("  " + "─".repeat(68));

  // Buffered control
  console.log("\n  Buffered control (100k rows, c=10):");
  {
    const { proc, baselineRss } = await startServer();
    try {
      const result = await runScenario({
        scenario: "buffered control",
        strategy: "buffered",
        payloadSize: 100_000,
        concurrency: 10,
        baselineRss,
      });
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  // mvd-stream concurrency sweep
  console.log("\n  mvd-stream concurrency sweep (100k rows):");
  for (const concurrency of [1, 10, 50, 100]) {
    const { proc, baselineRss } = await startServer();
    try {
      const result = await runScenario({
        scenario: `mvd concurrency=${concurrency}`,
        strategy: "mvd-stream",
        payloadSize: 100_000,
        concurrency,
        baselineRss,
      });
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  // mvd-stream slow consumer sweep
  console.log("\n  mvd-stream slow-consumer sweep (10k rows, c=10):");
  for (const slowReadMs of [0, 5, 10, 50]) {
    const { proc, baselineRss } = await startServer();
    try {
      const result = await runScenario({
        scenario: `mvd slow=${slowReadMs}ms`,
        strategy: "mvd-stream",
        payloadSize: 10_000,
        concurrency: 10,
        slowReadMs,
        baselineRss,
      });
      printResult(result);
      results.push(result);
    } finally {
      proc.kill();
      await Bun.sleep(300);
    }
  }

  // mvd-stream soak test
  console.log("\n  mvd-stream soak test (100k rows, c=10, 30s):");
  {
    const { proc, baselineRss } = await startServer();
    try {
      const result = await runScenario({
        scenario: "mvd soak 30s",
        strategy: "mvd-stream",
        payloadSize: 100_000,
        concurrency: 10,
        durationSec: 30,
        baselineRss,
      });
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
  const results = await runMvdMemoryBoundednessBenchmark();
  await Bun.write("reports/mvd-memory-boundedness.json", JSON.stringify(results, null, 2));
  console.log(`\nDone. ${results.length} results collected.`);
}
