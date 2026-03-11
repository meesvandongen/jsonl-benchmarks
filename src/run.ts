import { sql, pool, waitForDb } from "./db/client";
import { setupTables, seedIfNeeded } from "./db/setup";
import { runHttpBenchmark } from "./benchmarks/http-e2e";
import { runDbLatencyBenchmark } from "./benchmarks/db-latency";

const REPORTS_DIR = "reports";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

async function saveJsonReport(name: string, data: unknown) {
  const path = `${REPORTS_DIR}/${name}.json`;
  await Bun.write(path, JSON.stringify(data, null, 2));
  console.log(`  → ${path}`);
}

async function runAndCaptureTextReport(script: string, reportName: string): Promise<void> {
  const proc = Bun.spawn(["bun", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const decoder = new TextDecoder();

  const stdoutReader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await stdoutReader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    process.stdout.write(text);
    stdoutChunks.push(text);
  }

  const stderrReader = proc.stderr.getReader();
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    process.stderr.write(text);
    stderrChunks.push(text);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${script} exited with code ${exitCode}\n${stderrChunks.join("")}`);
  }

  const clean = stdoutChunks.join("").replace(ANSI_RE, "");
  await Bun.write(`${REPORTS_DIR}/${reportName}.txt`, clean);
  console.log(`  → ${REPORTS_DIR}/${reportName}.txt`);
}

console.log("\nPreparing benchmark environment...");
await waitForDb();
await setupTables();
await seedIfNeeded(100_000);

console.log("\nRunning DB driver benchmark...");
await runAndCaptureTextReport("src/benchmarks/db-drivers.ts", "db-drivers");

console.log("\nRunning HTTP E2E benchmark...");
const httpResults = await runHttpBenchmark();
await saveJsonReport("http-e2e", httpResults);

console.log("\nRunning DB latency benchmark...");
const latencyResults = await runDbLatencyBenchmark();
await saveJsonReport("db-latency", latencyResults);

await sql.end();
await pool.end();

console.log("\nDone. Reports refreshed in reports/.");
