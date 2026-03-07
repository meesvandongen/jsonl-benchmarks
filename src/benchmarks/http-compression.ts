/**
 * Compression Benchmark — measures impact of gzip compression on streaming.
 *
 * Compares:
 *   stream-cursor (uncompressed) vs stream-cursor-gzip
 * Across payload sizes, measuring RPS, p95, memory, and bytes transferred.
 */

const PORT = "3300";
const BASE = `http://localhost:${PORT}`;
const BENCH_DURATION_SEC = 6;
const CONCURRENCY = 10;
const MEMORY_POLL_MS = 50;
const SIZES = [1_000, 10_000, 100_000];

export interface CompressionResult {
  endpoint: string;
  size: number;
  rps: number;
  p95: number;
  peakRssDeltaMB: number;
  throughputBytesPerSec: number;
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
  await Promise.all([stop, ...Array.from({ length: concurrency }, worker)]);
  return { latencies, bytes: totalBytes, errors };
}

function startMemoryPoller() {
  const rssValues: number[] = [];
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        const res = await fetch(`${BASE}/memory`);
        const data: any = await res.json();
        rssValues.push(data.rss);
      } catch {}
      await Bun.sleep(MEMORY_POLL_MS);
    }
  };
  poll();
  return { stop: () => { running = false; return rssValues; } };
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
  const res = await fetch(`${BASE}/memory`);
  const mem: any = await res.json();
  return { proc, baselineRss: mem.rss };
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

export async function runCompressionBenchmark(): Promise<CompressionResult[]> {
  const results: CompressionResult[] = [];
  const endpoints = [
    { name: "uncompressed", path: "stream-cursor" },
    { name: "gzip", path: "stream-cursor-gzip" },
  ];

  for (const size of SIZES) {
    console.log(`\n  ${size.toLocaleString()} rows:`);

    for (const ep of endpoints) {
      const { proc, baselineRss } = await startServer();
      try {
        const url = `${BASE}/${ep.path}?limit=${size}`;
        // Warmup
        await driveLoad(url, 3, 1);
        await Bun.sleep(100);

        const poller = startMemoryPoller();
        const raw = await driveLoad(url, CONCURRENCY, BENCH_DURATION_SEC);
        const rssValues = poller.stop();
        const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
        const sorted = [...raw.latencies].sort((a, b) => a - b);

        const result: CompressionResult = {
          endpoint: ep.name,
          size,
          rps: raw.latencies.length / BENCH_DURATION_SEC,
          p95: percentile(sorted, 0.95),
          peakRssDeltaMB: toMB(peakRss - baselineRss),
          throughputBytesPerSec: raw.bytes / BENCH_DURATION_SEC,
        };
        results.push(result);

        const rpsStr = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : String(Math.round(result.rps));
        const mbps = (result.throughputBytesPerSec / 1024 / 1024).toFixed(1);
        console.log(`    ${ep.name.padEnd(16)} ${rpsStr.padStart(6)} RPS   ${fmtMs(result.p95).padStart(8)} p95   +${String(result.peakRssDeltaMB).padStart(7)}MB   ${mbps}MB/s`);
      } finally {
        proc.kill();
        await Bun.sleep(300);
      }
    }
  }

  return results;
}

if (import.meta.main) {
  console.log("\n  Compression Benchmark: Uncompressed vs Gzip");
  console.log("  " + "─".repeat(68));
  const results = await runCompressionBenchmark();
  console.log("\nDone.", results.length, "results collected.");
}
