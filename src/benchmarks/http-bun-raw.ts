/**
 * HTTP Framework Overhead Benchmark — Bun.serve() raw vs Elysia.
 *
 * Spawns both server-raw.ts and server.ts, drives identical load on
 * matching endpoints, and compares RPS, p95, and peak RSS.
 */

const PORT_ELYSIA = "3200";
const PORT_RAW = "3201";
const BENCH_DURATION_SEC = 6;
const CONCURRENCY = 10;
const MEMORY_POLL_MS = 50;
const SIZES = [1_000, 10_000, 100_000];

const ENDPOINTS = [
  { name: "buffered", path: "buffered", isStream: false },
  { name: "stream-cursor", path: "stream-cursor", isStream: true },
  { name: "stream-foreach", path: "stream-foreach", isStream: true },
  { name: "mvd-stream", path: "mvd-stream", isStream: true },
] as const;

export interface FrameworkResult {
  framework: string;
  endpoint: string;
  size: number;
  rps: number;
  p95: number;
  peakRssDeltaMB: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

async function driveLoad(
  url: string,
  isStream: boolean,
  concurrency: number,
  durationSec: number,
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
            if (!running) { await reader.cancel(); break; }
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

function startMemoryPoller(base: string) {
  const rssValues: number[] = [];
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        const res = await fetch(`${base}/memory`);
        const data: any = await res.json();
        rssValues.push(data.rss);
      } catch {}
      await Bun.sleep(MEMORY_POLL_MS);
    }
  };
  poll();
  return { stop: () => { running = false; return rssValues; } };
}

async function startServer(
  script: string,
  port: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; baselineRss: number }> {
  const base = `http://localhost:${port}`;
  const proc = Bun.spawn(["bun", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: port },
  });
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(500);
  }
  await Bun.sleep(300);
  const res = await fetch(`${base}/memory`);
  const mem: any = await res.json();
  return { proc, baselineRss: mem.rss };
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

// ─── Main ─────────────────────────────────────────────────────────────

export async function runFrameworkBenchmark(): Promise<FrameworkResult[]> {
  const results: FrameworkResult[] = [];

  const servers = [
    { name: "Elysia", script: "src/server.ts", port: PORT_ELYSIA },
    { name: "Bun.serve raw", script: "src/server-raw.ts", port: PORT_RAW },
  ];

  for (const size of SIZES) {
    console.log(`\n  ${size.toLocaleString()} rows:`);

    for (const endpoint of ENDPOINTS) {
      console.log(`    ${endpoint.name}:`);

      for (const srv of servers) {
        const base = `http://localhost:${srv.port}`;
        const { proc, baselineRss } = await startServer(srv.script, srv.port);
        try {
          const url = `${base}/${endpoint.path}?limit=${size}`;
          // Warmup
          await driveLoad(url, endpoint.isStream, 3, 1);
          await Bun.sleep(100);

          const poller = startMemoryPoller(base);
          const raw = await driveLoad(url, endpoint.isStream, CONCURRENCY, BENCH_DURATION_SEC);
          const rssValues = poller.stop();
          const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
          const sorted = [...raw.latencies].sort((a, b) => a - b);

          const result: FrameworkResult = {
            framework: srv.name,
            endpoint: endpoint.name,
            size,
            rps: raw.latencies.length / BENCH_DURATION_SEC,
            p95: percentile(sorted, 0.95),
            peakRssDeltaMB: toMB(peakRss - baselineRss),
          };
          results.push(result);

          const rpsStr = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : String(Math.round(result.rps));
          console.log(`      ${srv.name.padEnd(16)} ${rpsStr.padStart(6)} RPS   ${fmtMs(result.p95).padStart(8)} p95   +${String(result.peakRssDeltaMB).padStart(7)}MB`);
        } finally {
          proc.kill();
          await Bun.sleep(300);
        }
      }
    }
  }

  return results;
}

if (import.meta.main) {
  console.log("\n  HTTP Framework Overhead: Elysia vs Bun.serve raw");
  console.log("  " + "─".repeat(68));
  const results = await runFrameworkBenchmark();
  console.log("\nDone.", results.length, "results collected.");
}
