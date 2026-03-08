/**
 * Go pgx TCP Backpressure Benchmark
 *
 * Tests whether Go's pgx simple-query + TCP backpressure can outperform
 * cursor-based streaming, and compares Go's net/http streaming vs Bun's
 * ReadableStream approach.
 *
 * Strategies tested (Go server):
 *   1. buffered         — SELECT all, JSON array response
 *   2. backpressure     — simple query, row-by-row write+flush (TCP backpressure)
 *   3. backpressure-batch — simple query, batch 500 rows per flush
 *   4. backpressure-nofflush — simple query, let Go bufio handle flushing
 *   5. backpressure-pipe — io.Pipe goroutine pattern
 *   6. cursor-perrow    — DECLARE/FETCH cursor, per-row write
 *   7. cursor-batch     — DECLARE/FETCH cursor, batch write per FETCH
 *
 * Also re-tests the Bun server for direct comparison at same concurrency.
 */

export interface GoBackpressureResult {
  section: string;
  name: string;
  size: number;
  concurrency: number;
  rps: number;
  p95: number;
  avgMs: number;
  peakRssDeltaMB?: number;
}

const GO_PORT = "3400";
const BUN_PORT = "3350";
const GO_BASE = `http://localhost:${GO_PORT}`;
const BUN_BASE = `http://localhost:${BUN_PORT}`;
const BENCH_DURATION_SEC = 6;
const MEMORY_POLL_MS = 50;
const SIZES = [1_000, 10_000, 100_000];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function startMemoryPoller(base: string) {
  const rssValues: number[] = [];
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        const res = await fetch(`${base}/memory`);
        const data: any = await res.json();
        if (data.rss) rssValues.push(data.rss);
      } catch {}
      await Bun.sleep(MEMORY_POLL_MS);
    }
  };
  poll();
  return { stop: () => { running = false; return rssValues; } };
}

async function getBaselineRss(base: string): Promise<number> {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${base}/memory`);
      const data: any = await res.json();
      if (data.rss) return data.rss;
    } catch {}
    await Bun.sleep(200);
  }
  return 0;
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

function printRow(name: string, r: { rps: number; p95: number; avgMs: number; peakRssDeltaMB?: number }, pad = 44) {
  const mem = r.peakRssDeltaMB != null ? `  +${String(r.peakRssDeltaMB).padStart(7)}MB` : "";
  console.log(`    ${name.padEnd(pad)} ${String(r.rps).padStart(6)}  ${fmtMs(r.p95).padStart(10)}  ${fmtMs(r.avgMs).padStart(10)}${mem}`);
}

async function waitForServer(base: string, label: string, maxWait = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {}
    await Bun.sleep(300);
  }
  console.error(`  [WARN] ${label} not reachable after ${maxWait}ms`);
  return false;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runGoBackpressureBenchmark(): Promise<GoBackpressureResult[]> {
  const results: GoBackpressureResult[] = [];

  // Start Go server
  console.log("  Starting Go server...");
  const goProc = Bun.spawn(["go-bench/go-bench.exe"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: GO_PORT },
  });
  if (!await waitForServer(GO_BASE, "Go server")) {
    goProc.kill();
    throw new Error("Go server failed to start");
  }

  // Start Bun bottleneck server for comparison
  console.log("  Starting Bun server...");
  const bunProc = Bun.spawn(["bun", "src/server-bottleneck.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: BUN_PORT },
  });
  if (!await waitForServer(BUN_BASE, "Bun server")) {
    goProc.kill();
    bunProc.kill();
    throw new Error("Bun server failed to start");
  }

  try {
    // ── Suite 1: Go strategies at c=10, multiple sizes ──────────────────
    const goStrategies = [
      { name: "Go: buffered", path: "/buffered" },
      { name: "Go: backpressure per-row flush", path: "/backpressure" },
      { name: "Go: backpressure batch flush (500)", path: "/backpressure-batch" },
      { name: "Go: backpressure no explicit flush", path: "/backpressure-nofflush" },
      { name: "Go: backpressure io.Pipe", path: "/backpressure-pipe" },
      { name: "Go: cursor(500) per-row write", path: "/cursor-perrow" },
      { name: "Go: cursor(500) batch write", path: "/cursor-batch" },
    ];

    for (const size of SIZES) {
      console.log(`\n  Suite 1: Go pgx Strategies (${size.toLocaleString()} rows, c=10)`);
      console.log("  " + "─".repeat(72));
      console.log(`    ${"Endpoint".padEnd(44)} ${"RPS".padStart(6)}  ${"p95".padStart(10)}  ${"avg".padStart(10)}  ${"Mem".padStart(10)}`);
      console.log("    " + "─".repeat(84));

      for (const s of goStrategies) {
        const baselineRss = await getBaselineRss(GO_BASE);
        const poller = startMemoryPoller(GO_BASE);
        const r = await driveLoad(`${GO_BASE}${s.path}?limit=${size}`, 10, BENCH_DURATION_SEC);
        const rssValues = poller.stop();
        const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
        const peakRssDeltaMB = toMB(peakRss - baselineRss);
        const result = { section: "go-strategies", name: s.name, size, concurrency: 10, ...r, peakRssDeltaMB };
        results.push(result);
        printRow(s.name, result);
      }
    }

    // ── Suite 2: Go vs Bun head-to-head, multiple sizes ─────────────────
    for (const size of SIZES) {
      console.log(`\n  Suite 2: Go vs Bun — Head to Head (${size.toLocaleString()} rows, c=10)`);
      console.log("  " + "─".repeat(72));
      console.log(`    ${"Endpoint".padEnd(44)} ${"RPS".padStart(6)}  ${"p95".padStart(10)}  ${"avg".padStart(10)}  ${"Mem".padStart(10)}`);
      console.log("    " + "─".repeat(84));

      const headToHead = [
        { name: "Go: buffered", url: `${GO_BASE}/buffered?limit=${size}`, memBase: GO_BASE },
        { name: "Bun: buffered", url: `${BUN_BASE}/buffered?limit=${size}`, memBase: BUN_BASE },
        { name: "Go: backpressure batch flush", url: `${GO_BASE}/backpressure-batch?limit=${size}`, memBase: GO_BASE },
        { name: "Bun: cursor batch enqueue", url: `${BUN_BASE}/stream-batched?limit=${size}`, memBase: BUN_BASE },
        { name: "Go: backpressure per-row flush", url: `${GO_BASE}/backpressure?limit=${size}`, memBase: GO_BASE },
        { name: "Bun: cursor per-row enqueue", url: `${BUN_BASE}/stream-per-row?limit=${size}`, memBase: BUN_BASE },
      ];

      for (const t of headToHead) {
        const baselineRss = await getBaselineRss(t.memBase);
        const poller = startMemoryPoller(t.memBase);
        const r = await driveLoad(t.url, 10, BENCH_DURATION_SEC);
        const rssValues = poller.stop();
        const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
        const peakRssDeltaMB = toMB(peakRss - baselineRss);
        const result = { section: "go-vs-bun", name: t.name, size, concurrency: 10, ...r, peakRssDeltaMB };
        results.push(result);
        printRow(t.name, result);
      }
    }

    // ── Suite 3: Concurrency scaling (Go best strategies, 1k rows) ──────
    console.log("\n  Suite 3: Go Concurrency Scaling (1k rows)");
    console.log("  " + "─".repeat(72));

    const scalingEndpoints = [
      { name: "Go: buffered", url: `${GO_BASE}/buffered?limit=1000` },
      { name: "Go: backpressure batch flush", url: `${GO_BASE}/backpressure-batch?limit=1000` },
      { name: "Go: backpressure per-row flush", url: `${GO_BASE}/backpressure?limit=1000` },
      { name: "Go: cursor batch write", url: `${GO_BASE}/cursor-batch?limit=1000` },
      { name: "Go: backpressure io.Pipe", url: `${GO_BASE}/backpressure-pipe?limit=1000` },
    ];

    for (const c of [1, 5, 10, 20]) {
      console.log(`\n    concurrency = ${c}:`);
      for (const ep of scalingEndpoints) {
        const r = await driveLoad(ep.url, c, BENCH_DURATION_SEC);
        results.push({ section: "go-concurrency-scaling", name: ep.name, size: 1000, concurrency: c, ...r });
        printRow(ep.name, r);
      }
    }

  } finally {
    goProc.kill();
    bunProc.kill();
    await Bun.sleep(500);
  }

  return results;
}

if (import.meta.main) {
  console.log("\n  Go pgx TCP Backpressure Benchmark");
  console.log("  " + "═".repeat(72));
  const results = await runGoBackpressureBenchmark();
  console.log(`\n  Done. ${results.length} results collected.`);
  process.exit(0);
}
