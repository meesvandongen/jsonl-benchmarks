/**
 * WebSocket Streaming Benchmark — compares WS vs NDJSON HTTP streaming.
 *
 * Drives load via WebSocket and HTTP in parallel, measuring throughput
 * and memory for each transport.
 */

const PORT = "3400";
const BASE = `http://localhost:${PORT}`;
const BENCH_DURATION_SEC = 6;
const CONCURRENCY = 10;
const MEMORY_POLL_MS = 50;
const SIZES = [1_000, 10_000, 100_000];

export interface WsResult {
  transport: string;
  size: number;
  totalRequests: number;
  rps: number;
  p95: number;
  peakRssDeltaMB: number;
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

async function driveHttpLoad(
  url: string,
  concurrency: number,
  durationSec: number,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
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
  return { latencies, errors };
}

async function driveWsLoad(
  wsUrl: string,
  limit: number,
  concurrency: number,
  durationSec: number,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let running = true;

  const worker = async () => {
    while (running) {
      const t = performance.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 30_000);
          ws.onopen = () => ws.send(JSON.stringify({ limit }));
          ws.onmessage = (ev) => {
            if (!running) { clearTimeout(timeout); try { ws.close(); } catch {} resolve(); return; }
            try {
              const data = JSON.parse(String(ev.data));
              if (data.__done) {
                clearTimeout(timeout);
                ws.close();
                resolve();
              }
            } catch {}
          };
          ws.onerror = () => { clearTimeout(timeout); reject(new Error("ws error")); };
          ws.onclose = () => { clearTimeout(timeout); resolve(); };
        });
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
  return { latencies, errors };
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
  await Bun.sleep(500);
  let mem: any = null;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${BASE}/memory`);
      mem = await res.json();
      if (mem?.rss) break;
    } catch {}
    await Bun.sleep(300);
  }
  return { proc, baselineRss: mem?.rss ?? 0 };
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}us`;
}

export async function runWebSocketBenchmark(): Promise<WsResult[]> {
  const results: WsResult[] = [];

  for (const size of SIZES) {
    console.log(`\n  ${size.toLocaleString()} rows:`);

    // HTTP NDJSON baseline
    {
      const { proc, baselineRss } = await startServer();
      try {
        const url = `${BASE}/stream-cursor?limit=${size}`;
        await driveHttpLoad(url, 3, 1); // warmup
        await Bun.sleep(100);
        const poller = startMemoryPoller();
        const raw = await driveHttpLoad(url, CONCURRENCY, BENCH_DURATION_SEC);
        const rssValues = poller.stop();
        const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
        const sorted = [...raw.latencies].sort((a, b) => a - b);
        const result: WsResult = {
          transport: "HTTP NDJSON",
          size,
          totalRequests: raw.latencies.length,
          rps: raw.latencies.length / BENCH_DURATION_SEC,
          p95: percentile(sorted, 0.95),
          peakRssDeltaMB: toMB(peakRss - baselineRss),
        };
        results.push(result);
        const rpsStr = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : String(Math.round(result.rps));
        console.log(`    HTTP NDJSON      ${rpsStr.padStart(6)} RPS   ${fmtMs(result.p95).padStart(8)} p95   +${String(result.peakRssDeltaMB).padStart(7)}MB`);
      } finally {
        proc.kill();
        await Bun.sleep(300);
      }
    }

    // WebSocket
    {
      const { proc, baselineRss } = await startServer();
      try {
        const wsUrl = `ws://localhost:${PORT}/ws-stream`;
        // warmup
        await driveWsLoad(wsUrl, size, 2, 1);
        await Bun.sleep(100);
        const poller = startMemoryPoller();
        const raw = await driveWsLoad(wsUrl, size, CONCURRENCY, BENCH_DURATION_SEC);
        const rssValues = poller.stop();
        const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
        const sorted = [...raw.latencies].sort((a, b) => a - b);
        const result: WsResult = {
          transport: "WebSocket",
          size,
          totalRequests: raw.latencies.length,
          rps: raw.latencies.length / BENCH_DURATION_SEC,
          p95: percentile(sorted, 0.95),
          peakRssDeltaMB: toMB(peakRss - baselineRss),
        };
        results.push(result);
        const rpsStr = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : String(Math.round(result.rps));
        console.log(`    WebSocket        ${rpsStr.padStart(6)} RPS   ${fmtMs(result.p95).padStart(8)} p95   +${String(result.peakRssDeltaMB).padStart(7)}MB`);
      } finally {
        proc.kill();
        await Bun.sleep(300);
      }
    }
  }

  return results;
}

if (import.meta.main) {
  console.log("\n  WebSocket vs HTTP NDJSON Streaming");
  console.log("  " + "─".repeat(68));
  const results = await runWebSocketBenchmark();
  console.log("\nDone.", results.length, "results collected.");
}
