# Report Generation Guide

After running `bun src/run.ts`, individual report files are saved to `reports/`. Use this guide to combine them into a single polished `RESULTS.md`.

## Report files

There are two kinds of report files:

### Text reports (mitata stdout capture, ANSI-stripped)

These contain the raw mitata benchmark output — timing tables with avg/min/max/p75/p99 and memory allocation stats. The format is human-readable plain text.

| File | Contents |
|---|---|
| `reports/db-drivers.txt` | Core DB read strategies: porsager buffered, `.cursor(500)`, `.forEach()`, pg buffered, pg-query-stream. Sizes: 100, 1K, 10K, 100K rows. |
| `reports/db-driver-variants.txt` | Extended variants: pg-cursor raw, porsager prepared, pg prepared. Sizes: 1K, 10K, 100K rows. |
| `reports/serialization.txt` | Serialization formats: JSON.stringify, NDJSON line-by-line, streaming JSON build, MessagePack, JSONB vs TEXT column. Sizes: 1K, 10K, 100K rows. |
| `reports/json-packages.txt` | JSON npm package comparison: stringify (JSON.stringify, fast-json-stringify, manual template, json-stringify-safe), parse (JSON.parse, destr, secure-json-parse), binary encode (msgpackr, @msgpack/msgpack), NDJSON construction methods. Sizes: 1K, 10K, 100K rows. Pre-loaded rows (no DB in hot path). |
| `reports/write-path.txt` | INSERT strategies: row-by-row, unnest batches (100/500/1K/5K), COPY FROM STDIN. Sizes: 1K, 5K, 10K rows. |
| `reports/real-world.txt` | Real-world patterns: filtered queries (buffered vs cursor), pagination vs cursor, transforms (redact), JOINs. |
| `reports/memory-gc.txt` | Memory & GC pressure: heap delta/retained for buffered vs streaming, ArrayBuffer allocation strategies. |

### JSON reports (structured data)

| File | Contents | Schema |
|---|---|---|
| `reports/meta.json` | Environment: platform, runtime, PG version, seed count, timestamp | `{ generatedAt, platform, runtime, pgVersion, seedCount }` |
| `reports/http-e2e.json` | Core HTTP E2E — 5 strategies x multiple row counts. RPS, p95, peak RSS, memory delta | `{ ranAt, payloadSizes: number[], strategies: string[], concurrency, results: [{ strategy, payloadSize, rps, p95, peakRss, peakRssDeltaMB, throughputBytes, ... }] }` |
| `reports/framework.json` | Elysia vs Bun.serve raw overhead | `[{ framework, endpoint, size, rps, p95, peakRssDeltaMB }]` |
| `reports/compression.json` | Gzip vs uncompressed streaming | `[{ endpoint, size, rps, p95, peakRssDeltaMB, throughputBytesPerSec }]` |
| `reports/websocket.json` | WebSocket vs HTTP NDJSON transport | `[{ transport, size, totalRequests, rps, p95, peakRssDeltaMB }]` |
| `reports/concurrency.json` | Concurrency scaling and backpressure | `[{ test, concurrency, totalRequests, errors, rps, p95, peakRssDeltaMB, baselineRss, peakRss }]` |
| `reports/bottleneck.json` | Streaming bottleneck analysis — 4 suites | `[{ section, name, concurrency, rps, p95, avgMs }]` sections: `http-layer`, `enqueue-sweep`, `cursor-batch-size`, `cursor-perrow`, `concurrency-scaling` |
| `reports/go-backpressure.json` | Go pgx TCP backpressure vs Bun — 3 suites, multiple sizes | `[{ section, name, size, concurrency, rps, p95, avgMs, peakRssDeltaMB? }]` sections: `go-strategies`, `go-vs-bun`, `go-concurrency-scaling`. Sizes: 1K, 10K, 100K rows. |

## How to generate RESULTS.md

Give an LLM (Claude, etc.) all the report files with the prompt below. Or just tell Claude Code:

> Read all files in reports/ and follow REPORT_GUIDE.md to write RESULTS.md

---

**Prompt:**

You are writing a technical benchmark report in Markdown. Read ALL the report files below (both .txt and .json) and produce a single `RESULTS.md` that flows naturally as a technical document. Every report file must be represented — do not skip any data.

### 1. Header
- Title: "# PostgreSQL Streaming Benchmark Results"
- Metadata from `meta.json`: generated date, platform, runtime, PG version, row count

### 2. Strategies Overview
A brief table describing the 5 core HTTP strategies (buffered, porsager cursor, porsager forEach, Elysia yield, pg-query-stream) — what DB driver, access method, and response format each uses.

### 3. DB Driver Performance (from `db-drivers.txt`)
Parse the mitata output. For each row count group (100, 1K, 10K, 100K), create a table with columns: Driver, avg, p75, p99. Highlight the fastest driver per group. Add 1-2 sentences of analysis.

### 4. DB Driver Variants (from `db-driver-variants.txt`)
Same approach — parse mitata output into tables per group. Compare pg-cursor, prepared statements, etc.

### 5. Serialization (from `serialization.txt`)
Parse mitata output into tables. Compare JSON vs NDJSON vs MessagePack vs streaming JSON. JSONB vs TEXT column type. Highlight winners.

### 6. JSON Package Comparison (from `json-packages.txt`)
Parse mitata output into tables per group. Four sub-sections:
- **Stringify** — compare JSON.stringify, fast-json-stringify (schema-based), manual template literal, json-stringify-safe at 1K/10K/100K rows
- **Parse** — compare JSON.parse, destr, secure-json-parse at 1K/10K/100K rows
- **Binary encode** — compare JSON.stringify→Buffer, msgpackr, @msgpack/msgpack, fast-json-stringify→Buffer at 1K/10K/100K rows
- **NDJSON construction** — compare join vs concat strategies with different stringifiers

### 7. Write Path (from `write-path.txt`)
Parse mitata output. Compare INSERT strategies (row-by-row, unnest batches, COPY). Show how batch size affects throughput.

### 8. Real-World Patterns (from `real-world.txt`)
Parse mitata output. Cover filtered queries, pagination vs cursor, transforms, JOINs.

### 9. Memory & GC Pressure (from `memory-gc.txt`)
Parse the output. Show heap delta/retained for buffered vs streaming approaches. Cover ArrayBuffer allocation findings.

### 10. HTTP E2E Results (from `http-e2e.json`)
Three tables:
- **Throughput (RPS)** — rows x strategies
- **p95 Latency** — same layout
- **Peak Memory (RSS delta)** — same layout

Write 2-3 sentences of analysis after each table.

### 11. Framework Overhead (from `framework.json`)
Table comparing Elysia vs Bun.serve raw RPS/p95. One sentence on overhead percentage.

### 12. Compression (from `compression.json`)
Table with RPS, p95, memory, throughput for gzip vs uncompressed.

### 13. Transport Comparison (from `websocket.json`)
Table comparing WebSocket vs HTTP NDJSON.

### 14. Concurrency & Backpressure (from `concurrency.json`)
Table with test x concurrency x RPS/p95/memory.

### 15. Streaming Bottleneck Deep Dive (from `bottleneck.json`)
The most important analytical section. Structure as a narrative:
- **HTTP Layer Isolation** — table + analysis
- **Enqueue Count Sweep** — table showing RPS degradation as enqueues increase
- **Cursor Batch Size** — batch vs per-row enqueue
- **Concurrency Scaling** — c=1/5/10 proving event loop contention
- **Root Cause** — prose explanation: per-row `controller.enqueue()` causes event loop contention under concurrent load. Include the code fix (batch enqueues by cursor batch).

### 16. Go pgx TCP Backpressure (from `go-backpressure.json`)
Another important analytical section:
- **Go Strategies** — tables ranking all Go approaches at c=10 for each row size (1K, 10K, 100K), including RPS, p95, and memory delta
- **Go vs Bun Head-to-Head** — comparison tables at each row size, with memory columns showing RSS delta for both runtimes
- **Go Concurrency Scaling** — c=1/5/10/20
- **Analysis** — explain TCP backpressure (no cursor overhead, OS handles flow control), why Go outperforms Bun for streaming (goroutines vs event loop), quantify differences at each row size, compare memory usage patterns

### 17. Key Takeaways
8-12 bulleted conclusions drawn from ALL the data:
- DB driver performance differences
- Serialization format impact
- Write path best practices
- Memory: streaming vs buffered savings
- Throughput: which strategies win and why
- The enqueue bottleneck and its fix
- Go vs Bun performance gap and root cause
- TCP backpressure as superior to cursors
- Practical recommendations

### Formatting rules:
- Use Markdown tables (pipe-separated)
- Bold key numbers and strategy names
- Consistent units: RPS for throughput, ms for latency, MB for memory
- Commas for thousands (1,000 not 1000)
- Keep prose concise — data speaks, highlight the non-obvious
- No emojis
- For mitata .txt data: extract the avg timing and present in clean tables (don't paste raw mitata output)

---

## Quick generation

```bash
# Concatenate all report files for LLM input
for f in reports/meta.json reports/db-drivers.txt reports/db-driver-variants.txt \
         reports/serialization.txt reports/json-packages.txt reports/write-path.txt \
         reports/real-world.txt reports/memory-gc.txt reports/http-e2e.json \
         reports/framework.json reports/compression.json reports/websocket.json \
         reports/concurrency.json reports/bottleneck.json reports/go-backpressure.json; do
  echo "=== $f ==="; cat "$f"; echo
done
```

Or just tell Claude Code: "Read all files in reports/ and follow REPORT_GUIDE.md to write RESULTS.md"
