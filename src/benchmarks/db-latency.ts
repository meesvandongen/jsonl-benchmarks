/**
 * Database latency benchmark (opt-in).
 *
 * Simulates PostgreSQL network RTT using Toxiproxy so we can compare how
 * cursor-driven streaming, buffered fetching, and @mvd/postgres .stream()
 * behave as database latency increases.
 *
 * This benchmark is intentionally NOT wired into src/run.ts because it is
 * slower and requires the optional toxiproxy service.
 *
 * Requirements:
 *   docker compose up -d postgres toxiproxy
 *
 * Toxiproxy setup used by this benchmark:
 *   API:        http://127.0.0.1:8474
 *   Proxy port: 127.0.0.1:15432 -> upstream PostgreSQL
 *
 * RTT model:
 *   For an RTT target of N ms, this benchmark applies N/2 ms latency in the
 *   upstream direction and N/2 ms in the downstream direction.
 */

const PORT = "3120";
const BASE = `http://localhost:${PORT}`;
const TOXI_BASE = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:8474";
const TOXI_PROXY_NAME = "pg-latency-bench";
const TOXI_PROXY_LISTEN = process.env.TOXIPROXY_LISTEN ?? "0.0.0.0:15432";
const TOXI_CLIENT_HOST = process.env.TOXIPROXY_CLIENT_HOST ?? "127.0.0.1";
const TOXI_CLIENT_PORT = process.env.TOXIPROXY_CLIENT_PORT ?? "15432";
const DB_UPSTREAM_HOST = process.env.LATENCY_DB_UPSTREAM_HOST ?? "postgres";
const DB_UPSTREAM_PORT = process.env.LATENCY_DB_UPSTREAM_PORT ?? process.env.DB_PORT ?? "5432";
const WARMUP_REQUESTS = 1;
const SAMPLES_PER_RUN = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const MEMORY_POLL_MS = 50;
const CONCURRENCY = 1;
const PAYLOAD_SIZES = [1_000, 10_000] as const;
const RTT_LEVELS_MS = [0, 10, 50, 100] as const;

const STRATEGIES = [
  { key: "buffered", label: "Buffered", isStream: false },
  { key: "stream-cursor", label: "porsager cursor+RS", isStream: true },
  { key: "stream-foreach", label: "porsager forEach+RS", isStream: true },
  { key: "mvd-stream", label: "@mvd/postgres stream+RS", isStream: true },
  { key: "pg-query-stream", label: "pg-query-stream+RS", isStream: true },
] as const;

type StrategyKey = (typeof STRATEGIES)[number]["key"];

export interface DbLatencyResult {
  rttMs: number;
  payloadSize: number;
  strategy: StrategyKey;
  samples: number;
  totalRequests: number;
  errors: number;
  avgMs: number;
  rps: number;
  p95: number;
  throughputBytes: number;
  baselineRss: number;
  peakRss: number;
  peakRssDeltaMB: number;
}

export interface DbLatencyBenchmarkResults {
  ranAt: string;
  toxiproxyUrl: string;
  proxyName: string;
  proxyListen: string;
  upstream: string;
  rttLevelsMs: number[];
  payloadSizes: number[];
  concurrency: number;
  strategies: StrategyKey[];
  results: DbLatencyResult[];
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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function toxiproxyRequest(path: string, init?: RequestInit) {
  const res = await fetch(`${TOXI_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

async function assertToxiproxyAvailable(): Promise<void> {
  try {
    const res = await toxiproxyRequest("/version");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(
      `Toxiproxy is not reachable at ${TOXI_BASE}. Start it with 'docker compose up -d postgres toxiproxy' before running this benchmark. (${error})`,
    );
  }
}

async function recreateProxy(rttMs: number): Promise<void> {
  await toxiproxyRequest(`/proxies/${TOXI_PROXY_NAME}`, { method: "DELETE" }).catch(() => undefined);

  const createRes = await toxiproxyRequest("/proxies", {
    method: "POST",
    body: JSON.stringify({
      name: TOXI_PROXY_NAME,
      listen: TOXI_PROXY_LISTEN,
      upstream: `${DB_UPSTREAM_HOST}:${DB_UPSTREAM_PORT}`,
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`Failed to create Toxiproxy proxy: HTTP ${createRes.status} ${body}`);
  }

  if (rttMs <= 0) return;

  const oneWayMs = Math.floor(rttMs / 2);
  for (const [name, stream] of [["latency-upstream", "upstream"], ["latency-downstream", "downstream"]] as const) {
    const toxicRes = await toxiproxyRequest(`/proxies/${TOXI_PROXY_NAME}/toxics`, {
      method: "POST",
      body: JSON.stringify({
        name,
        type: "latency",
        stream,
        toxicity: 1,
        attributes: {
          latency: oneWayMs,
          jitter: 0,
        },
      }),
    });

    if (!toxicRes.ok) {
      const body = await toxicRes.text().catch(() => "");
      throw new Error(`Failed to create latency toxic (${stream}): HTTP ${toxicRes.status} ${body}`);
    }
  }
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

async function measureRequest(
  url: string,
  isStream: boolean,
): Promise<{ durationMs: number; bytes: number }> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    let bytes = 0;
    if (isStream) {
      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("Response body is missing");
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
      }
    } else {
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
    }

    return {
      durationMs: performance.now() - startedAt,
      bytes,
    };
  } finally {
    clearTimeout(abortTimer);
  }
}

async function startServer(): Promise<{ proc: ReturnType<typeof Bun.spawn>; baselineRss: number }> {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT,
      DB_HOST: TOXI_CLIENT_HOST,
      DB_PORT: TOXI_CLIENT_PORT,
    },
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

async function runSingle(strategy: StrategyKey, payloadSize: number, baselineRss: number): Promise<DbLatencyResult> {
  const url = `${BASE}/${strategy}?limit=${payloadSize}`;
  const def = STRATEGIES.find((x) => x.key === strategy)!;

  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    try {
      await measureRequest(url, def.isStream);
    } catch {}
  }
  await Bun.sleep(150);

  const poller = startMemoryPoller();
  const latencies: number[] = [];
  let totalBytes = 0;
  let errors = 0;

  for (let i = 0; i < SAMPLES_PER_RUN; i++) {
    try {
      const sample = await measureRequest(url, def.isStream);
      latencies.push(sample.durationMs);
      totalBytes += sample.bytes;
    } catch {
      errors++;
    }
  }

  const rssValues = poller.stop();
  const peakRss = rssValues.length > 0 ? Math.max(...rssValues) : baselineRss;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avgMs = average(latencies);
  const totalDurationMs = latencies.reduce((sum, ms) => sum + ms, 0);

  return {
    rttMs: 0,
    payloadSize,
    strategy,
    samples: SAMPLES_PER_RUN,
    totalRequests: latencies.length,
    errors,
    avgMs,
    rps: totalDurationMs > 0 ? latencies.length / (totalDurationMs / 1000) : 0,
    p95: percentile(sorted, 0.95),
    throughputBytes: totalDurationMs > 0 ? totalBytes / (totalDurationMs / 1000) : 0,
    baselineRss,
    peakRss,
    peakRssDeltaMB: toMB(peakRss - baselineRss),
  };
}

export async function runDbLatencyBenchmark(): Promise<DbLatencyBenchmarkResults> {
  await assertToxiproxyAvailable();

  const results: DbLatencyResult[] = [];

  console.log("\n  Database Latency Benchmark (via Toxiproxy)");
  console.log("  " + "─".repeat(68));
  console.log(`  Proxy: ${TOXI_CLIENT_HOST}:${TOXI_CLIENT_PORT} -> ${DB_UPSTREAM_HOST}:${DB_UPSTREAM_PORT}`);

  for (const rttMs of RTT_LEVELS_MS) {
    console.log(`\n  Simulated DB RTT: ${rttMs} ms`);
    await recreateProxy(rttMs);

    for (const payloadSize of PAYLOAD_SIZES) {
      console.log(`\n    ${payloadSize.toLocaleString()} rows:`);
      for (const strategy of STRATEGIES) {
        const { proc, baselineRss } = await startServer();
        try {
          process.stdout.write(`      ${strategy.label.padEnd(24)}`);
          const result = await runSingle(strategy.key, payloadSize, baselineRss);
          result.rttMs = rttMs;
          results.push(result);
          const rpsStr = result.rps >= 1000 ? `${(result.rps / 1000).toFixed(1)}k` : result.rps.toFixed(2);
          const errorSuffix = result.errors > 0 ? `   ${result.errors}/${result.samples} err` : "";
          console.log(`${fmtMs(result.avgMs).padStart(8)} avg   ${fmtMs(result.p95).padStart(8)} p95   ${rpsStr.padStart(7)} RPS   +${String(result.peakRssDeltaMB).padStart(7)}MB${errorSuffix}`);
        } finally {
          proc.kill();
          await Bun.sleep(300);
        }
      }
    }
  }

  return {
    ranAt: new Date().toISOString(),
    toxiproxyUrl: TOXI_BASE,
    proxyName: TOXI_PROXY_NAME,
    proxyListen: TOXI_PROXY_LISTEN,
    upstream: `${DB_UPSTREAM_HOST}:${DB_UPSTREAM_PORT}`,
    rttLevelsMs: [...RTT_LEVELS_MS],
    payloadSizes: [...PAYLOAD_SIZES],
    concurrency: CONCURRENCY,
    strategies: STRATEGIES.map((s) => s.key),
    results,
  };
}

if (import.meta.main) {
  const results = await runDbLatencyBenchmark();
  await Bun.write("reports/db-latency.json", JSON.stringify(results, null, 2));
  console.log(`\nDone. ${results.results.length} results collected.`);
}
