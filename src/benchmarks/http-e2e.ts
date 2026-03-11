/**
 * E2E HTTP Memory Benchmark — measures peak RSS per strategy.
 *
 * Spawns a fresh server for each (strategy, size) pair, drives concurrent
 * load while polling /memory, and records peak RSS delta from baseline.
 *
 * Strategies:
 *   buffered         — postgres SELECT all + JSON array
 *   stream-cursor    — postgres .cursor(500) + ReadableStream
 *   stream-foreach   — postgres .forEach() + ReadableStream
 *   pg-query-stream  — pg-query-stream + ReadableStream
 */

const PORT = process.env.PORT ?? "3100";
const BASE = `http://localhost:${PORT}`;
const WARMUP_SEC = 1;
const BENCH_DURATION_SEC = 6;
const CONCURRENCY = 10;
const PAYLOAD_SIZES = [1_000, 10_000, 100_000];
const MEMORY_POLL_MS = 50;

export const STRATEGIES = [
  "buffered",
  "stream-cursor",
  "stream-foreach",
  "pg-query-stream",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const STRATEGY_LABELS: Record<Strategy, string> = {
  "buffered": "Buffered",
  "stream-cursor": "postgres cursor+RS",
  "stream-foreach": "postgres forEach+RS",
  "pg-query-stream": "pg-query-stream+RS",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface RunResult {
  strategy: Strategy;
  payloadSize: number;
  totalRequests: number;
  errors: number;
  rps: number;
  p95: number;
  throughputBytes: number;
  baselineRss: number;
  peakRss: number;
  peakRssDeltaMB: number;
}

export interface HttpBenchmarkResults {
  ranAt: string;
  payloadSizes: number[];
  strategies: Strategy[];
  concurrency: number;
  results: RunResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getMemory(): Promise<MemorySnapshot> {
  const res = await fetch(`${BASE}/memory`);
  return res.json() as Promise<MemorySnapshot>;
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

// ─── Load driver ─────────────────────────────────────────────────────────────

async function driveLoad(
  url: string,
  isStream: boolean,
  concurrency: number,
  durationSec: number
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
        if (isStream) {
          const reader = res.body!.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value?.byteLength ?? 0;
          }
        } else {
          const buf = await res.arrayBuffer();
          totalBytes += buf.byteLength;
        }
        latencies.push(performance.now() - t);
      } catch {
        errors++;
        latencies.push(performance.now() - t);
      }
    }
  };

  const stop = new Promise<void>((resolve) =>
    setTimeout(() => { running = false; resolve(); }, durationSec * 1000)
  );
  await Promise.all([stop, ...Array.from({ length: concurrency }, worker)]);
  return { latencies, bytes: totalBytes, errors };
}

// ─── Memory poller ───────────────────────────────────────────────────────────

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

// ─── Server lifecycle ────────────────────────────────────────────────────────

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

// ─── Single run ──────────────────────────────────────────────────────────────

async function runSingle(strategy: Strategy, size: number, baselineRss: number): Promise<RunResult> {
  const url = `${BASE}/${strategy}?limit=${size}`;
  const isStream = strategy !== "buffered";

  await driveLoad(url, isStream, Math.min(CONCURRENCY, 3), WARMUP_SEC);
  await Bun.sleep(100);

  const poller = startMemoryPoller();
  const raw = await driveLoad(url, isStream, CONCURRENCY, BENCH_DURATION_SEC);
  const rssValues = poller.stop();

  const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
  const sorted = [...raw.latencies].sort((a, b) => a - b);

  return {
    strategy,
    payloadSize: size,
    totalRequests: raw.latencies.length,
    errors: raw.errors,
    rps: raw.latencies.length / BENCH_DURATION_SEC,
    p95: percentile(sorted, 0.95),
    throughputBytes: raw.bytes / BENCH_DURATION_SEC,
    baselineRss,
    peakRss,
    peakRssDeltaMB: toMB(peakRss - baselineRss),
  };
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runHttpBenchmark(): Promise<HttpBenchmarkResults> {
  console.log("\n  HTTP E2E Memory Benchmark");
  console.log("  " + "─".repeat(68));

  const results: RunResult[] = [];

  for (const size of PAYLOAD_SIZES) {
    console.log(`\n  ${size.toLocaleString()} rows:`);

    for (const strategy of STRATEGIES) {
      const { proc, baselineRss } = await startServer();
      try {
        process.stdout.write(`    ${STRATEGY_LABELS[strategy].padEnd(22)}`);
        const result = await runSingle(strategy, size, baselineRss);
        const rpsStr = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : String(Math.round(result.rps));
        console.log(`${rpsStr.padStart(6)} RPS   ${fmtMs(result.p95).padStart(8)} p95   +${String(result.peakRssDeltaMB).padStart(7)}MB`);
        results.push(result);
      } finally {
        proc.kill();
        await Bun.sleep(300);
      }
    }
  }

  return {
    ranAt: new Date().toISOString(),
    payloadSizes: PAYLOAD_SIZES,
    strategies: [...STRATEGIES],
    concurrency: CONCURRENCY,
    results,
  };
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

if (import.meta.main) {
  const results = await runHttpBenchmark();
  console.log("\nDone.", results.results.length, "results collected.");
}
