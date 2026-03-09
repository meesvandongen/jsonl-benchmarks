# PostgreSQL Streaming Benchmark Results

| | |
|---|---|
| **Generated** | 2026-03-09 |
| **Platform** | win32 x64 |
| **Runtime** | Bun 1.3.9 |
| **PostgreSQL** | 16.13 |
| **CPU** | AMD Ryzen 9 5900X 12-Core Processor |
| **Seed rows** | 100,000 |

---

## Strategies Overview

| Strategy | DB Driver | Access Method | Response Format |
|---|---|---|---|
| **buffered** | porsager/postgres | `SELECT` → full array | JSON array response |
| **stream-cursor** | porsager/postgres | `.cursor(500)` | NDJSON streaming |
| **stream-foreach** | porsager/postgres | `.forEach()` | NDJSON streaming |
| **mvd-stream** | @mvd/postgres | `.stream()` | NDJSON streaming |
| **yield-cursor** | porsager/postgres | `.cursor(500)` via Elysia yield | NDJSON streaming |
| **pg-query-stream** | node-pg + pg-query-stream | Node stream pipe | NDJSON streaming |

---

## DB Driver Performance

Raw driver-level query timings with no HTTP overhead. Each driver fetches rows and materializes them in-process.

### 100 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **porsager .forEach()** | **1.05 ms** | 1.09 ms | 1.73 ms |
| mvd .stream() | 1.07 ms | 1.09 ms | **1.61 ms** |
| mvd buffered | 1.07 ms | 1.10 ms | 1.93 ms |
| pg buffered | 1.10 ms | 1.15 ms | 2.01 ms |
| porsager buffered | 1.11 ms | 1.15 ms | 1.81 ms |
| mvd .cursor(500) | 1.56 ms | 1.62 ms | 2.49 ms |
| porsager .cursor(500) | 1.62 ms | 1.69 ms | 2.30 ms |
| pg-query-stream | 95.87 ms | 95.99 ms | 96.23 ms |

### 1,000 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **pg buffered** | **4.08 ms** | 4.42 ms | 5.88 ms |
| porsager .forEach() | 4.23 ms | 4.71 ms | 5.88 ms |
| mvd buffered | 4.25 ms | 4.75 ms | 6.02 ms |
| mvd .stream() | 4.30 ms | 4.77 ms | 5.98 ms |
| porsager buffered | 4.42 ms | 4.97 ms | 6.76 ms |
| porsager .cursor(500) | 5.83 ms | 6.21 ms | 7.86 ms |
| mvd .cursor(500) | 6.44 ms | 7.06 ms | 8.27 ms |
| pg-query-stream | 149.32 ms | 149.43 ms | 152.44 ms |

### 10,000 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **pg buffered** | **35.57 ms** | 37.85 ms | 38.85 ms |
| porsager .forEach() | 36.59 ms | 38.09 ms | 41.30 ms |
| mvd buffered | 37.39 ms | 39.34 ms | 42.42 ms |
| porsager buffered | 38.64 ms | 41.04 ms | 42.61 ms |
| mvd .stream() | 41.38 ms | 43.64 ms | 44.97 ms |
| porsager .cursor(500) | 51.24 ms | 52.36 ms | 53.16 ms |
| mvd .cursor(500) | 52.94 ms | 53.89 ms | 55.02 ms |
| pg-query-stream | 219.95 ms | 196.42 ms | 213.85 ms |

### 100,000 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **porsager .forEach()** | **371.42 ms** | 378.02 ms | 385.57 ms |
| pg buffered | 377.81 ms | 394.90 ms | 397.66 ms |
| porsager buffered | 384.04 ms | 394.20 ms | 411.02 ms |
| mvd buffered | 414.29 ms | 408.88 ms | 479.30 ms |
| mvd .stream() | 432.83 ms | 449.49 ms | 470.82 ms |
| porsager .cursor(500) | 627.30 ms | 587.87 ms | 857.09 ms |
| mvd .cursor(500) | 646.65 ms | 682.00 ms | 783.76 ms |
| pg-query-stream | 678.33 ms | 669.66 ms | 691.68 ms |

Across this run, `pg buffered` leads at 1K and 10K, while `porsager .forEach()` leads at 100K. `@mvd/postgres .stream()` tracks close to buffered read paths and is materially faster than cursor-based paths, while `pg-query-stream` remains the slowest.

---

## DB Driver Variants

Prepared statements and pg-cursor raw timings.

### 1,000 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **pg prepared (named)** | **4.10 ms** | 4.44 ms | 5.75 ms |
| mvd prepared | 4.42 ms | 4.88 ms | 6.57 ms |
| porsager prepared | 4.46 ms | 4.99 ms | 6.37 ms |
| pg-cursor raw | 148.77 ms | 148.53 ms | 150.80 ms |

### 10,000 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **pg prepared (named)** | **34.52 ms** | 35.95 ms | 41.64 ms |
| porsager prepared | 38.45 ms | 41.44 ms | 44.21 ms |
| mvd prepared | 40.44 ms | 41.85 ms | 45.50 ms |
| pg-cursor raw | 192.24 ms | 196.30 ms | 196.70 ms |

### 100,000 rows

| Driver | avg | p75 | p99 |
|---|---|---|---|
| **pg prepared (named)** | **336.33 ms** | 345.61 ms | 354.37 ms |
| mvd prepared | 382.79 ms | 399.89 ms | 405.11 ms |
| porsager prepared | 397.96 ms | 392.97 ms | 511.99 ms |
| pg-cursor raw | 652.41 ms | 659.69 ms | 663.31 ms |

Prepared statements are consistently strong, with `pg prepared (named)` winning all tested sizes in this run. `mvd prepared` is competitive with `porsager prepared`, and both are much faster than `pg-cursor raw`.

---

## Serialization

### Serialization Format

| Format | 1,000 rows | 10,000 rows | 100,000 rows |
|---|---|---|---|
| **Streaming JSON array** | **7.10 ms** | **61.22 ms** | 656.53 ms |
| **JSON.stringify(array)** | 7.11 ms | 63.88 ms | **644.80 ms** |
| NDJSON one-by-one | 7.73 ms | 66.97 ms | 622.44 ms |
| MessagePack encode | 8.34 ms | 71.91 ms | 775.77 ms |

At small sizes, all formats are within ~15% of each other. NDJSON edges ahead at 100K rows (**622 ms**), likely due to avoiding the overhead of building a single large string. MessagePack is consistently the slowest — the encoding overhead outweighs any wire-size savings. Streaming JSON and JSON.stringify are essentially equivalent.

### JSONB vs TEXT Column

| Column Type | 1,000 rows | 10,000 rows | 100,000 rows |
|---|---|---|---|
| **TEXT column** | **2.91 ms** | **20.10 ms** | **214.92 ms** |
| TEXT + JSON.parse | 4.85 ms | 38.79 ms | 459.99 ms |
| JSONB column | 5.35 ms | 45.80 ms | 491.91 ms |

Storing data as TEXT and skipping parse is **2.3x faster** than JSONB at 100K rows. If you need structured access, TEXT + JSON.parse in JS is still faster than JSONB deserialization from PostgreSQL.

---

## Write Path

### 1,000 rows

| Strategy | avg |
|---|---|
| **unnest batch 1000** | **10.59 ms** |
| unnest batch 5000 | 10.64 ms |
| unnest batch 100 | 17.04 ms |
| COPY FROM STDIN | 59.01 ms |
| unnest batch 500 | 103.13 ms |
| row-by-row INSERT | 688.02 ms |

### 5,000 rows

| Strategy | avg |
|---|---|
| **unnest batch 5000** | **41.43 ms** |
| unnest batch 1000 | 44.72 ms |
| unnest batch 100 | 75.10 ms |
| COPY FROM STDIN | 81.94 ms |
| unnest batch 500 | 506.94 ms |
| row-by-row INSERT | 3.38 s |

### 10,000 rows

| Strategy | avg |
|---|---|
| **unnest batch 5000** | **72.19 ms** |
| unnest batch 1000 | 95.69 ms |
| COPY FROM STDIN | 103.57 ms |
| unnest batch 100 | 135.37 ms |
| unnest batch 500 | 983.83 ms |
| row-by-row INSERT | 6.75 s |

Unnest batching with batch size >= row count is the fastest write strategy, outperforming even COPY FROM STDIN. The `unnest batch 500` anomaly (slower than batch 100 in some cases) suggests overhead from multiple batch executions with transaction coordination. Row-by-row INSERT is **65-94x slower** than the best unnest batch.

---

## Real-World Patterns

### Filtered Queries (buffered vs cursor with WHERE clause)

| Pattern | 1,000 rows | 10,000 rows | 100,000 rows |
|---|---|---|---|
| **buffered + WHERE** | **7.58 ms** | **56.26 ms** | **358.77 ms** |
| cursor + WHERE | 9.08 ms | 72.01 ms | 508.66 ms |

Buffered reads are consistently faster for filtered queries — the cursor overhead is not justified when the result set is already filtered server-side.

### Pagination vs Cursor

| Pattern | 10,000 rows | 100,000 rows |
|---|---|---|
| **single cursor stream** | **65.66 ms** | **684.06 ms** |
| OFFSET/LIMIT pages (1000) | 85.98 ms | 1.90 s |

Cursor streaming is **2.8x faster** than OFFSET/LIMIT pagination at 100K rows. OFFSET/LIMIT must re-scan previous rows for each page, while cursors maintain position.

### Transforms (cursor-based)

| Pattern | 1,000 rows | 10,000 rows | 100,000 rows |
|---|---|---|---|
| cursor + filter active | 7.96 ms | 103.24 ms | 866.58 ms |
| cursor raw (no transform) | 8.07 ms | 101.44 ms | 899.04 ms |
| cursor + redact transform | 8.16 ms | 69.49 ms | 894.10 ms |

Row-level transforms (redact, filter) add negligible overhead at small sizes and are essentially free relative to DB fetch time.

### JOINs

| Pattern | 1,000 rows | 10,000 rows | 30,000 rows |
|---|---|---|---|
| **JOIN buffered** | **2.72 ms** | **14.33 ms** | **42.38 ms** |
| JOIN cursor | 5.29 ms | 34.31 ms | 99.17 ms |

Buffered reads are ~2x faster than cursor for JOIN queries. The cursor DECLARE/FETCH overhead compounds with JOIN complexity.

---

## Memory & GC Pressure

### Heap Usage (buffered vs streaming)

| Row Count | Strategy | Peak Heap Delta | Retained After GC |
|---|---|---|---|
| 10,000 | buffered | +5.9 MB | +5.9 MB |
| 10,000 | porsager cursor | +0 MB | +0 MB |
| 10,000 | **mvd .stream()** | **+0 MB** | **+0 MB** |
| 100,000 | buffered | **+72.34 MB** | **+72.34 MB** |
| 100,000 | porsager cursor | +0 MB | +0 MB |
| 100,000 | **mvd .stream()** | **+3.28 MB** | **+3.28 MB** |

`@mvd/postgres .stream()` stays low-memory while streaming. At 100K rows, buffered retains **72.34 MB**, while `mvd .stream()` retains only **3.28 MB** after GC — over **22x lower** retained heap in this run.

### ArrayBuffer Allocation

| Strategy | 10,000 rows | 100,000 rows |
|---|---|---|
| fresh TextEncoder.encode() | 54.21 ms | 607.45 ms |
| pre-allocated buffer pool | 55.97 ms | 616.85 ms |

Pre-allocating buffer pools still does not improve performance materially. In this run, fresh `TextEncoder.encode()` remained slightly faster than the pool approach.

### `@mvd/postgres` bounded-memory validation (HTTP peak RSS)

Buffered control vs `mvd-stream`, using real HTTP streaming with RSS polling.

| Scenario | Rows | Concurrency | Slow Read | Errors | Peak RSS Delta | End RSS Delta |
|---|---|---|---|---|---|---|
| buffered control | 100,000 | 10 | 0 ms | 0 | **+1,320.64 MB** | **+1,312.94 MB** |
| mvd-stream | 100,000 | 1 | 0 ms | 0 | +93.11 MB | +77.54 MB |
| mvd-stream | 100,000 | 10 | 0 ms | 0 | +92.12 MB | +72.09 MB |
| mvd-stream | 100,000 | 50 | 0 ms | 0 | +92.70 MB | +67.82 MB |
| mvd-stream | 100,000 | 100 | 0 ms | 144 | +92.02 MB | +69.64 MB |

Even under HTTP load, `mvd-stream` remains bounded: across the clean concurrency runs (1/10/50), peak RSS stayed in a very narrow **~92–93 MB** band, while end-of-run RSS settled back to **~68–78 MB**. The buffered control, by contrast, stayed pinned above **1.3 GB**.

Slow-consumer sweep (`mvd-stream`, 10,000 rows, concurrency 10):

| Slow Read Delay | Errors | Peak RSS Delta | End RSS Delta | p95 |
|---|---|---|---|---|
| 0 ms | 0 | +89.79 MB | +79.60 MB | 3,975.5 ms |
| 5 ms | 0 | +92.77 MB | +65.83 MB | 3,842.3 ms |
| 10 ms | 0 | +87.28 MB | +70.57 MB | 3,760.9 ms |
| 50 ms | 0 | +89.63 MB | +71.09 MB | 3,697.3 ms |

This is the strongest boundedness evidence in the suite so far: slowing the consumer down did **not** cause memory to climb with time or payload. Peak RSS stayed essentially flat at **~87–93 MB**, which is exactly what you want from a backpressure-driven streaming path.

30-second soak (`mvd-stream`, 100,000 rows, concurrency 10):

| Duration | Errors | Peak RSS Delta | End RSS Delta | p95 |
|---|---|---|---|---|
| 30 s | 0 | +91.83 MB | +76.17 MB | 30,292.4 ms |

The soak run strengthens the boundedness claim: after **30 seconds** of continuous streaming load, `mvd-stream` still peaked at only **+91.83 MB** and ended at **+76.17 MB**. That looks like a stable plateau, not an upward memory drift.

Error source note: the `concurrency=100` failures are **not specific to `@mvd/postgres`**. A focused repro showed the same client-side error (`The socket connection was closed unexpectedly`) for `mvd-stream`, `stream-cursor`, and `stream-foreach`, with no server stderr output. That points to HTTP/socket saturation in the Bun server/load harness at extreme concurrency, rather than a unique `@mvd/postgres` streaming bug.

---

## HTTP E2E Results

End-to-end HTTP benchmark with 10 concurrent clients, 6-second runs per strategy/size combination.

### Throughput (RPS)

| Size | buffered | stream-cursor | stream-foreach | mvd-stream | yield-cursor | pg-query-stream |
|---|---|---|---|---|---|---|
| 1,000 | **178.3** | 37.7 | 94.3 | 105.8 | 31.0 | 27.7 |
| 10,000 | **20.8** | 5.0 | 5.2 | 4.5 | 3.8 | 3.3 |
| 100,000 | **3.3** | 1.7 | 1.7 | 1.7 | 1.7 | 1.7 |

Buffered still leads overall throughput. At 1K rows, `mvd-stream` outperforms both existing streaming paths (`stream-cursor`, `stream-foreach`) while retaining bounded memory.

### p95 Latency

| Size | buffered | stream-cursor | stream-foreach | mvd-stream | yield-cursor | pg-query-stream |
|---|---|---|---|---|---|---|
| 1,000 | **86.9 ms** | 313.6 ms | 262.7 ms | 180.7 ms | 384.8 ms | 498.9 ms |
| 10,000 | **593.5 ms** | 3,003.5 ms | 3,397.2 ms | 3,897.3 ms | 3,391.8 ms | 3,533.4 ms |
| 100,000 | **5,484.8 ms** | 29,544.8 ms | 28,066.3 ms | 30,995.0 ms | 33,665.1 ms | 36,009.1 ms |

At 1K rows, `mvd-stream` has the best p95 among streaming options. At larger payloads, all streaming paths cluster in the multi-second range while keeping memory bounded.

### Peak Memory (RSS delta)

| Size | buffered | stream-cursor | stream-foreach | mvd-stream | yield-cursor | pg-query-stream |
|---|---|---|---|---|---|---|
| 1,000 | 112.85 MB | **86.19 MB** | 97.44 MB | 96.18 MB | 89.77 MB | 87.52 MB |
| 10,000 | **261.73 MB** | 85.00 MB | 90.18 MB | 87.09 MB | 90.29 MB | 86.29 MB |
| 100,000 | **1,271.96 MB** | 85.65 MB | 80.37 MB | 91.17 MB | 90.79 MB | **75.76 MB** |

At 100K rows, buffered reaches **~1.27 GB** while every streaming strategy — including `mvd-stream` — stays below **100 MB**. The memory advantage of streaming remains decisive.

---

## Framework Overhead

Elysia vs raw Bun.serve at concurrency 10.

### 1,000 rows

| Framework | Endpoint | RPS | p95 |
|---|---|---|---|
| Elysia | buffered | **212.0** | 69.7 ms |
| Bun.serve raw | buffered | 211.2 | 71.3 ms |
| Elysia | mvd-stream | **86.3** | 318.0 ms |
| Bun.serve raw | mvd-stream | 78.3 | **264.9 ms** |
| Elysia | stream-foreach | 77.0 | 313.0 ms |
| Bun.serve raw | stream-foreach | 76.8 | 311.0 ms |
| Elysia | stream-cursor | 38.2 | 308.9 ms |
| Bun.serve raw | stream-cursor | 37.7 | 302.8 ms |

### 10,000 rows

| Framework | Endpoint | RPS | p95 |
|---|---|---|---|
| Bun.serve raw | buffered | **23.3** | **522.0 ms** |
| Elysia | buffered | 22.5 | 546.8 ms |
| Bun.serve raw | stream-foreach | **4.8** | 3,323.1 ms |
| Elysia | stream-foreach | 4.5 | 3,383.5 ms |
| Elysia | mvd-stream | **4.5** | 3,905.7 ms |
| Bun.serve raw | mvd-stream | 4.2 | **3,407.3 ms** |
| Elysia | stream-cursor | 5.0 | 2,954.3 ms |
| Bun.serve raw | stream-cursor | 5.0 | **2,917.5 ms** |

### 100,000 rows

| Framework | Endpoint | RPS | p95 |
|---|---|---|---|
| Bun.serve raw | buffered | **3.2** | **6,104.5 ms** |
| Elysia | buffered | 2.7 | 6,529.0 ms |
| Elysia | stream-cursor | 1.7 | 6,211.0 ms |
| Bun.serve raw | stream-cursor | 1.7 | **6,182.6 ms** |
| Elysia | stream-foreach | 1.7 | 6,402.7 ms |
| Bun.serve raw | stream-foreach | 1.7 | **6,396.0 ms** |
| Elysia | mvd-stream | 1.7 | **6,452.1 ms** |
| Bun.serve raw | mvd-stream | 1.7 | 6,475.0 ms |

Framework overhead remains small relative to query/streaming cost. At 1K rows, Elysia and raw Bun are effectively tied on buffered throughput, and `mvd-stream` performs competitively on both servers.

---

## Compression

Gzip streaming vs uncompressed NDJSON (stream-cursor endpoint).

| Endpoint | Size | RPS | p95 | Memory Delta | Throughput |
|---|---|---|---|---|---|
| **gzip** | 1,000 | **64.8** | **188.8 ms** | 112.16 MB | 18.9 MB/s |
| uncompressed | 1,000 | 35.8 | 334.9 ms | 82.53 MB | 10.4 MB/s |
| **gzip** | 10,000 | **6.0** | **2,411 ms** | 371.67 MB | 17.6 MB/s |
| uncompressed | 10,000 | 4.7 | 3,018 ms | 86.69 MB | 13.7 MB/s |
| uncompressed | 100,000 | 1.7 | 31,263 ms | 83.87 MB | 49.5 MB/s |
| gzip | 100,000 | 1.7 | **15,300 ms** | 1,043.70 MB | 49.5 MB/s |

Gzip **doubles throughput** at 1K rows by reducing wire transfer size. At 100K rows, gzip halves p95 latency but at a severe memory cost (1 GB vs 84 MB) — the compression buffers accumulate under sustained load.

---

## Transport Comparison

WebSocket vs HTTP NDJSON streaming.

| Transport | Size | RPS | p95 |
|---|---|---|---|
| **HTTP NDJSON** | 1,000 | **12,677** | 2.6 ms |
| WebSocket | 1,000 | 1,997 | 6.0 ms |
| **HTTP NDJSON** | 10,000 | **12,255** | 2.7 ms |
| WebSocket | 10,000 | 2,103 | 5.5 ms |
| **HTTP NDJSON** | 100,000 | **11,778** | 2.9 ms |
| WebSocket | 100,000 | 2,040 | 5.7 ms |

HTTP NDJSON is **6x faster** than WebSocket for streaming. The WebSocket per-message framing and event dispatch overhead is significant. Both show near-zero memory delta, suggesting the bottleneck is purely in transport/protocol handling, not data size.

---

## Concurrency & Backpressure

### Concurrency Scaling (stream-cursor, 100K rows)

| Concurrency | RPS | p95 | Memory Delta |
|---|---|---|---|
| 1 | 1.2 | 1,453 ms | 72.61 MB |
| 10 | 1.7 | 6,231 ms | 91.52 MB |
| 50 | 2.8 | 6,337 ms | 97.23 MB |
| 100 | 2.8 | 6,452 ms | 104.72 MB |

Throughput plateaus at c=50 despite 2x more connections. Memory grows linearly but modestly (~0.3 MB per connection). The event loop is the bottleneck, not memory.

### Slow Consumer Simulation

| Delay per row | RPS | p95 | Memory Delta |
|---|---|---|---|
| 0 ms | 5.0 | 3,179 ms | 90.69 MB |
| 5 ms | 5.0 | 2,932 ms | 91.42 MB |
| 10 ms | 5.0 | 3,055 ms | 92.41 MB |
| 50 ms | 5.0 | 3,029 ms | 94.81 MB |

Slow consumers have no measurable impact on throughput or latency — backpressure propagates correctly through the streaming pipeline.

### Backpressure Modes

| Mode | RPS | p95 | Memory Delta |
|---|---|---|---|
| start-based | 1.7 | 6,209 ms | 88.02 MB |
| pull-based | 1.7 | 6,295 ms | 98.33 MB |
| pool saturated (c=50) | **12.5** | 10,862 ms | 79.70 MB |

Start-based and pull-based streaming perform identically. Pool saturation at c=50 achieves higher aggregate throughput by keeping all DB connections busy.

---

## Streaming Bottleneck Deep Dive

This section isolates the root cause of streaming performance degradation under concurrency.

### HTTP Layer Isolation

Synthetic endpoints that remove DB access to measure pure HTTP/streaming overhead.

| Endpoint | RPS | p95 | avg |
|---|---|---|---|
| noop stream (stream setup) | **26,802** | 0.5 ms | 0.4 ms |
| noop buffered (baseline) | 12,620 | 3.0 ms | 0.8 ms |
| stream 2 enqueues (no DB) | 3,057 | 10.3 ms | 3.3 ms |
| buffered prebuilt (no DB) | 2,773 | 10.9 ms | 3.6 ms |
| stream 1 enqueue (no DB) | 2,740 | 10.3 ms | 3.7 ms |
| stream 1k enqueues (no DB) | 1,303 | 11.5 ms | 7.7 ms |
| buffered (DB + JSON array) | 178 | 85.8 ms | 56.5 ms |
| stream batch enqueue (DB cursor) | 163 | 76.1 ms | 61.4 ms |
| **stream per-row enqueue (DB cursor)** | **33** | **338.4 ms** | **303.8 ms** |

The critical finding: **1K enqueues without DB** achieves 1,303 RPS, but **per-row enqueue with DB** drops to 33 RPS. The DB cursor adds latency, but the per-row enqueue pattern collapses throughput by **5x** compared to batch enqueue (163 vs 33 RPS).

### Enqueue Count Sweep

Pure HTTP streaming with varying enqueue counts (no DB), c=10.

| Enqueues | RPS | avg |
|---|---|---|
| 1 | 2,405 | 4.2 ms |
| 2 | 3,003 | 3.3 ms |
| 5 | 2,984 | 3.4 ms |
| 10 | 2,269 | 4.4 ms |
| 50 | 1,945 | 5.1 ms |
| 100 | 1,879 | 5.3 ms |
| 1,000 | 1,303 | 7.6 ms |

RPS degrades roughly linearly with enqueue count. Each `controller.enqueue()` call yields to the event loop, and under c=10 concurrent streams, these yields create contention.

### Cursor Batch Size

1,000 rows via cursor, varying batch size (fewer batches = fewer enqueues).

| Config | Enqueues | RPS | p95 |
|---|---|---|---|
| cursor(1000) → 1 enqueue | 1 | **157** | 76.0 ms |
| cursor(500) → 2 enqueues | 2 | 153 | 77.9 ms |
| cursor(250) → 4 enqueues | 4 | 151 | 76.1 ms |
| cursor(100) → 10 enqueues | 10 | 136 | 84.4 ms |
| cursor(50) → 20 enqueues | 20 | 96 | 127.3 ms |

Fewer enqueues = more throughput. Going from 20 enqueues to 1 enqueue improves RPS by **63%** (96 → 157). The optimal strategy is to batch all rows from each cursor fetch into a single enqueue.

### Per-Row Enqueue (the bottleneck)

| Config | Enqueues | RPS | p95 |
|---|---|---|---|
| cursor(100) per-row → 1k enqueues | 1,000 | 32 | 346.1 ms |
| cursor(500) per-row → 1k enqueues | 1,000 | 33 | 348.4 ms |
| cursor(1000) per-row → 1k enqueues | 1,000 | 33 | 349.9 ms |

Cursor batch size is irrelevant when using per-row enqueue — all three configs produce identical results (~33 RPS). The 1,000 enqueue calls dominate the timing.

### Concurrency Scaling

| Strategy | c=1 | c=5 | c=10 |
|---|---|---|---|
| prebuilt per-row (no DB) | 803 | 1,297 | 1,504 |
| buffered (DB + JSON) | 94 | 191 | 204 |
| cursor batch enqueue | 96 | 177 | **185** |
| buffered → per-row stream | 107 | 167 | 175 |
| **cursor per-row enqueue** | **72** | **41** | **40** |

Every strategy scales positively with concurrency **except per-row enqueue**, which actually **degrades** from 72 RPS (c=1) to 40 RPS (c=10). This is the smoking gun: per-row `controller.enqueue()` causes event loop contention that worsens under concurrent load.

### Root Cause

Per-row `controller.enqueue()` in a `ReadableStream` yields control to the event loop on every call. Under concurrent load, multiple streams compete for event loop time, creating O(n * rows) yield points. With 10 concurrent streams each enqueuing 1,000 rows, that's 10,000 event loop yields per second.

**The fix**: batch rows by cursor fetch size into a single enqueue:

```typescript
// SLOW: per-row enqueue (33 RPS at c=10)
for await (const row of cursor) {
  controller.enqueue(JSON.stringify(row) + "\n");
}

// FAST: batch enqueue (185 RPS at c=10, 5.6x improvement)
const cursor = sql.cursor(500);
for await (const batch of cursor) {
  const chunk = batch.map(r => JSON.stringify(r)).join("\n") + "\n";
  controller.enqueue(chunk);
}
```

---

## Go pgx TCP Backpressure

Go's `net/http` + `pgx` enables a fundamentally different streaming model. Instead of cursors (DECLARE/FETCH), Go uses simple queries where TCP backpressure naturally throttles PostgreSQL when the HTTP client is slower than the DB.

### Go Strategies (c=10)

All 7 Go strategies tested across three row counts.

#### 1,000 rows

| Strategy | RPS | p95 | avg |
|---|---|---|---|
| **Go: backpressure batch flush (500)** | **540** | 23.8 ms | 18.6 ms |
| Go: backpressure no explicit flush | 508 | 26.1 ms | 19.9 ms |
| Go: buffered | 507 | 25.6 ms | 19.7 ms |
| Go: backpressure io.Pipe | 455 | 27.5 ms | 22.5 ms |
| Go: cursor(500) batch write | 401 | 29.4 ms | 24.9 ms |
| Go: backpressure per-row flush | 368 | 33.2 ms | 27.6 ms |
| Go: cursor(500) per-row write | 353 | 33.0 ms | 28.3 ms |

#### 10,000 rows

| Strategy | RPS | p95 | avg |
|---|---|---|---|
| **Go: backpressure batch flush (500)** | **63** | 187.3 ms | 158.6 ms |
| Go: buffered | 62 | 201.2 ms | 161.1 ms |
| Go: backpressure no explicit flush | 56 | 211.9 ms | 179.4 ms |
| Go: backpressure io.Pipe | 52 | 219.6 ms | 193.5 ms |
| Go: cursor(500) batch write | 52 | 216.5 ms | 191.5 ms |
| Go: cursor(500) per-row write | 44 | 268.2 ms | 230.1 ms |
| Go: backpressure per-row flush | 43 | 259.9 ms | 238.9 ms |

#### 100,000 rows

| Strategy | RPS | p95 | avg |
|---|---|---|---|
| **Go: backpressure batch flush (500)** | **7** | 1.78 s | 1.50 s |
| Go: backpressure no explicit flush | 7 | 1.92 s | 1.52 s |
| Go: backpressure io.Pipe | 7 | 2.07 s | 1.56 s |
| Go: cursor(500) batch write | 7 | 2.20 s | 1.54 s |
| Go: buffered | 6 | 2.06 s | 1.68 s |
| Go: backpressure per-row flush | 5 | 2.38 s | 2.09 s |
| Go: cursor(500) per-row write | 5 | 2.70 s | 2.00 s |

Backpressure batch flush is the fastest strategy at every row count. At 100K rows, it overtakes buffered — streaming with TCP backpressure avoids the cost of building a full JSON array in memory. Cursor-based approaches are consistently slower due to DECLARE/FETCH round-trips, and per-row flushing adds ~40% overhead vs batch flushing.

### Go vs Bun Head-to-Head (c=10)

Direct comparison with memory tracking. Go uses `runtime.HeapAlloc`; Bun uses `process.memoryUsage().rss`.

#### 1,000 rows

| Strategy | Go RPS | Go Mem | Bun RPS | Bun Mem | Go/Bun Ratio |
|---|---|---|---|---|---|
| **Buffered** | **516** | ~0 MB | 236 | +100.91 MB | **2.2x** |
| **Streaming (batch)** | **505** | ~0 MB | 214 | +56.34 MB | **2.4x** |
| **Streaming (per-row)** | **393** | ~0 MB | 50 | +56.14 MB | **7.9x** |

#### 10,000 rows

| Strategy | Go RPS | Go Mem | Bun RPS | Bun Mem | Go/Bun Ratio |
|---|---|---|---|---|---|
| **Buffered** | **63** | ~0 MB | 26 | +320.91 MB | **2.4x** |
| **Streaming (batch)** | **62** | ~0 MB | 23 | +26.67 MB | **2.7x** |
| **Streaming (per-row)** | **53** | ~0 MB | 5 | +54.86 MB | **10.6x** |

#### 100,000 rows

| Strategy | Go RPS | Go Mem | Bun RPS | Bun Mem | Go/Bun Ratio |
|---|---|---|---|---|---|
| **Buffered** | **8** | ~0 MB | 3 | +1,441.29 MB | **2.7x** |
| **Streaming (batch)** | **7** | ~0 MB | 3 | +15.01 MB | **2.3x** |
| **Streaming (per-row)** | **5** | ~0 MB | 2 | ~0 MB | **2.5x** |

Go's heap allocations are effectively zero-delta across all strategies and row counts. Go's GC collects per-request allocations immediately — goroutine stacks and row buffers are short-lived and never accumulate. In contrast, Bun's buffered strategy balloons to **+1.4 GB** at 100K rows because the entire result set is held in V8 heap memory until the response completes.

The per-row throughput gap widens dramatically with row count: **7.9x at 1K, 10.6x at 10K**. At 100K, the gap narrows to 2.5x because DB fetch time dominates and both runtimes spend most of their time waiting on PostgreSQL.

Bun's streaming memory is well-bounded (~15-57 MB) regardless of row count — proving streaming works. But Go achieves the same bounded memory *plus* higher throughput because goroutines avoid event loop contention.

### Go Concurrency Scaling (1,000 rows)

| Strategy | c=1 | c=5 | c=10 | c=20 |
|---|---|---|---|---|
| Go: buffered | 129 | 412 | 503 | **537** |
| Go: backpressure batch flush | 151 | 460 | **540** | 502 |
| Go: backpressure per-row flush | 86 | 270 | 438 | **566** |
| Go: backpressure io.Pipe | 96 | 317 | 441 | **504** |
| Go: cursor batch write | 122 | 299 | 400 | **430** |

Go scales nearly linearly to c=10 (3.5-5x improvement over c=1). At c=20, most strategies continue to improve or plateau. Backpressure batch flush peaks at c=10 (540 RPS), while buffered and per-row flush peak at c=20 (537 and 566 RPS respectively).

Peak throughput is **540 RPS** with backpressure batch flush at c=10 — the best streaming result in the entire benchmark suite.

### Analysis

TCP backpressure eliminates cursor overhead entirely. In this model:

1. Go sends a simple `SELECT ... LIMIT N` query (no DECLARE/FETCH)
2. PostgreSQL streams rows over the TCP connection
3. When Go's HTTP response writer is slower than PG's output, the TCP window fills up
4. PG naturally pauses sending until Go reads more data
5. No application-level cursor management needed

This is fundamentally more efficient than cursors because:
- **Zero round-trips**: No DECLARE, no repeated FETCH commands
- **OS-level flow control**: TCP backpressure is handled by the kernel, not userspace
- **Goroutine model**: Each request gets its own goroutine with a dedicated stack, avoiding event loop contention entirely
- **Zero memory overhead**: Go's GC reclaims per-request allocations immediately; no measurable heap growth under load

The advantage grows with concurrency and shrinks with row count. At small payloads with high concurrency, Go's goroutine model dominates (10.6x at 10K rows). At large payloads, the DB becomes the bottleneck and both runtimes converge (2.3-2.7x at 100K rows).

---

## Key Takeaways

- **DB driver choice still trails access pattern.** Buffered and streaming-iteration paths (`pg`, `porsager .forEach()`, `mvd .stream()`) cluster tightly, while cursor-driven and `pg-query-stream` paths remain significantly slower.

- **TEXT columns are 2.3x faster than JSONB** for read-heavy workloads. If you don't need server-side JSON operations, store as TEXT and parse client-side.

- **Unnest batching is the fastest write strategy** — faster than COPY FROM STDIN for matching batch sizes. Use batch size >= total row count when possible. Row-by-row INSERT is 65-94x slower.

- **Streaming saves an order of magnitude of memory at scale.** At 100K rows, Bun buffered reached **~1.27 GB** while all streaming paths (including `mvd-stream`) stayed under **100 MB**.

- **Buffered is still throughput king when memory allows.** At 1K rows, buffered is **178.3 RPS** while cursor streaming is **37.7 RPS**; `mvd-stream` improves streaming throughput to **105.8 RPS**.

- **Per-row `controller.enqueue()` is the streaming bottleneck.** It causes event loop contention that worsens under concurrency: 72 RPS at c=1 drops to 40 RPS at c=10. Batch enqueue achieves 185 RPS at c=10 — a **4.6x improvement**.

- **Go outperforms Bun 2.2-10.6x for HTTP streaming.** The advantage is largest at medium payloads (10K rows) under concurrency, where Go's goroutines avoid event loop contention. At large payloads (100K), the gap narrows to 2.3-2.7x as DB time dominates.

- **TCP backpressure eliminates cursor overhead.** Go's simple query + TCP flow control achieves 540 RPS at 1K rows — matching buffered throughput with zero memory overhead. No DECLARE/FETCH round-trips needed.

- **Go's memory profile is flat under load.** Zero measurable heap delta across all strategies and row sizes, compared to Bun's **+1.27 GB** for buffered 100K rows. Go's per-goroutine GC reclaims allocations immediately.

- **Gzip doubles small-payload throughput** but costs 12x more memory at 100K rows (1 GB vs 84 MB). Use compression selectively based on payload size.

- **HTTP NDJSON is 6x faster than WebSocket** for streaming. WebSocket per-message framing overhead is significant; prefer NDJSON for server-to-client data streaming.

- **Elysia adds low overhead** compared to raw Bun.serve; differences were small across endpoints, including `mvd-stream`.

- **Cursor stream pagination is 2.8x faster than OFFSET/LIMIT** at 100K rows. For large dataset traversal, always prefer cursors over page-based pagination.
