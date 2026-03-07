/**
 * E2E Benchmark: Four response strategies from PostgreSQL
 *
 *   buffered        — SELECT all + JSON array
 *   stream-cursor   — .cursor(500) + ReadableStream NDJSON
 *   stream-foreach  — .forEach(fn) + ReadableStream NDJSON
 *   yield-cursor    — .cursor(500) + Elysia native yield
 *
 * Each gets a fresh server process for clean memory measurement.
 */

import {
  printHeader,
  printSectionHeader,
  printTable,
  fmtMs,
  fmtNum,
  type TableRow,
} from "../utils/report";

const PORT = process.env.PORT ?? "3000";
const BASE = `http://localhost:${PORT}`;
const WARMUP_SEC = 1;
const BENCH_DURATION_SEC = 6;
const CONCURRENCY = 10;
const PAYLOAD_SIZES = [100, 1_000, 10_000, 50_000, 100_000];
const MEMORY_POLL_MS = 50;

export const STRATEGIES = ["buffered", "stream-cursor", "stream-foreach", "yield-cursor"] as const;
export type Strategy = (typeof STRATEGIES)[number];

const STRATEGY_LABELS: Record<Strategy, string> = {
  buffered: "Buffered",
  "stream-cursor": "Cursor+RS",
  "stream-foreach": "forEach+RS",
  "yield-cursor": "Yield+Cursor",
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
  concurrency: number;
  totalRequests: number;
  errors: number;
  rps: number;
  latency: { mean: number; p50: number; p95: number; p99: number };
  throughputBytes: number;
  baselineMemory: MemorySnapshot;
  peakMemory: MemorySnapshot;
  peakRssDeltaMB: number;
}

export interface E2eBenchmarkResults {
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

export function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
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

function startMemoryPoller(): { stop: () => MemorySnapshot[]; snapshots: MemorySnapshot[] } {
  const snapshots: MemorySnapshot[] = [];
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        snapshots.push(await getMemory());
      } catch {}
      await Bun.sleep(MEMORY_POLL_MS);
    }
  };
  poll();

  return {
    snapshots,
    stop: () => { running = false; return snapshots; },
  };
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

async function startServer(): Promise<{ proc: ReturnType<typeof Bun.spawn>; baseline: MemorySnapshot }> {
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
  const baseline = await getMemory();
  return { proc, baseline };
}

function stopServer(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill();
}

// ─── Single run ──────────────────────────────────────────────────────────────

async function runSingle(
  strategy: Strategy,
  payloadSize: number,
  baseline: MemorySnapshot
): Promise<RunResult> {
  const url = `${BASE}/${strategy}?limit=${payloadSize}`;
  const isStream = strategy !== "buffered";

  // Warmup
  await driveLoad(url, isStream, Math.min(CONCURRENCY, 3), WARMUP_SEC);
  await Bun.sleep(100);

  // Start memory polling + load
  const poller = startMemoryPoller();
  const raw = await driveLoad(url, isStream, CONCURRENCY, BENCH_DURATION_SEC);
  const allSnapshots = poller.stop();

  const peakSnapshot = allSnapshots.reduce(
    (best, s) => (s.rss > best.rss ? s : best),
    allSnapshots[0] ?? baseline
  );

  const sorted = [...raw.latencies].sort((a, b) => a - b);

  return {
    strategy,
    payloadSize,
    concurrency: CONCURRENCY,
    totalRequests: raw.latencies.length,
    errors: raw.errors,
    rps: raw.latencies.length / BENCH_DURATION_SEC,
    latency: {
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length || 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    },
    throughputBytes: raw.bytes / BENCH_DURATION_SEC,
    baselineMemory: baseline,
    peakMemory: peakSnapshot,
    peakRssDeltaMB: toMB(peakSnapshot.rss - baseline.rss),
  };
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runE2eBenchmark(): Promise<E2eBenchmarkResults> {
  printHeader("E2E: Buffered vs Cursor+RS vs forEach+RS vs Yield+Cursor");

  const results: RunResult[] = [];

  for (const size of PAYLOAD_SIZES) {
    printSectionHeader(`Payload: ${fmtNum(size)} rows`);

    for (const strategy of STRATEGIES) {
      const { proc, baseline } = await startServer();
      try {
        process.stdout.write(`    ${STRATEGY_LABELS[strategy].padEnd(14)} ...`);
        const result = await runSingle(strategy, size, baseline);
        console.log(` ${fmtMs(result.latency.p95).padStart(8)} p95  +${String(result.peakRssDeltaMB).padStart(7)}MB  (abs ${toMB(result.peakMemory.rss)}MB)`);
        results.push(result);
      } finally {
        stopServer(proc);
        await Bun.sleep(300);
      }
    }
  }

  // ── Summary tables ──
  console.log("\n");
  printHeader("Results");

  // Memory table
  printSectionHeader("Peak Memory (RSS delta from baseline)");
  const memHeaders = ["Rows", ...STRATEGIES.map((s) => STRATEGY_LABELS[s])];
  const memRows: TableRow[] = [];

  for (const size of PAYLOAD_SIZES) {
    const cells = [fmtNum(size)];
    const deltas = STRATEGIES.map((s) => results.find((r) => r.strategy === s && r.payloadSize === size)!.peakRssDeltaMB);
    const minDelta = Math.min(...deltas);
    for (const d of deltas) {
      cells.push(`+${d}MB`);
    }
    memRows.push({ cells, highlight: "neutral" });
  }
  printTable(memHeaders, memRows, ["right", ...STRATEGIES.map(() => "right" as const)]);

  // Throughput table
  printSectionHeader("Throughput (RPS)");
  const tpHeaders = ["Rows", ...STRATEGIES.map((s) => STRATEGY_LABELS[s])];
  const tpRows: TableRow[] = [];

  for (const size of PAYLOAD_SIZES) {
    const cells = [fmtNum(size)];
    for (const s of STRATEGIES) {
      const r = results.find((x) => x.strategy === s && x.payloadSize === size)!;
      cells.push(fmtRps(r.rps));
    }
    tpRows.push({ cells, highlight: "neutral" });
  }
  printTable(tpHeaders, tpRows, ["right", ...STRATEGIES.map(() => "right" as const)]);

  // Latency table
  printSectionHeader("p95 Latency");
  const latHeaders = ["Rows", ...STRATEGIES.map((s) => STRATEGY_LABELS[s])];
  const latRows: TableRow[] = [];

  for (const size of PAYLOAD_SIZES) {
    const cells = [fmtNum(size)];
    for (const s of STRATEGIES) {
      const r = results.find((x) => x.strategy === s && x.payloadSize === size)!;
      cells.push(fmtMs(r.latency.p95));
    }
    latRows.push({ cells, highlight: "neutral" });
  }
  printTable(latHeaders, latRows, ["right", ...STRATEGIES.map(() => "right" as const)]);

  return {
    ranAt: new Date().toISOString(),
    payloadSizes: PAYLOAD_SIZES,
    strategies: [...STRATEGIES],
    concurrency: CONCURRENCY,
    results,
  };
}

function fmtRps(rps: number): string {
  if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k`;
  return rps.toFixed(0);
}

if (import.meta.main) {
  const results = await runE2eBenchmark();
  console.log("\nDone.", results.results.length, "results collected.");
}
