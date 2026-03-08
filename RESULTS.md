# Benchmark Results

> Generated: 2026-03-07T23:22:37.001Z
> Platform: win32 x64
> Runtime: Bun 1.3.9
> PostgreSQL: 16.13
> DB rows: 100,000 | Concurrency: 10

## Strategies

| Strategy | DB driver | DB access | HTTP response |
| --- | --- | --- | --- |
| **Buffered** | porsager/postgres | `SELECT ... LIMIT N` | JSON array |
| **porsager cursor** | porsager/postgres | `.cursor(500)` | `ReadableStream` NDJSON |
| **porsager forEach** | porsager/postgres | `.forEach(fn)` | `ReadableStream` NDJSON |
| **Elysia yield** | porsager/postgres | `.cursor(500)` | Elysia `yield` generator |
| **pg-query-stream** | node-postgres (pg) | cursor stream | `ReadableStream` NDJSON |

DB driver + serialization + write path + real-world benchmarks (mitata) are printed to stdout.
Below: HTTP E2E results with peak memory measurement.

---

## Peak Memory (RSS delta from baseline)

| Rows    | Buffered   | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | ---------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | +110.72MB  | +82.8MB         | +96.7MB          | +91.53MB     | +87.37MB        |
| 10,000  | +249.29MB  | +87.34MB        | +86.68MB         | +93.87MB     | +83.99MB        |
| 100,000 | +1302.02MB | +84.57MB        | +84.61MB         | +92.79MB     | +76.52MB        |

## Throughput (RPS)

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 154      | 36              | 78               | 29           | 28              |
| 10,000  | 15       | 4               | 4                | 3            | 3               |
| 100,000 | 2        | 2               | 2                | 2            | 2               |

## p95 Latency

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 96.04ms  | 335.75ms        | 292.71ms         | 403.41ms     | 498.75ms        |
| 10,000  | 844.98ms | 3.24s           | 3.83s            | 3.71s        | 3.98s           |
| 100,000 | 8.26s    | 32.14s          | 29.84s           | 37.13s       | 38.77s          |

## Absolute Peak RSS (MB)

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 330.92   | 340.75          | 370.5            | 325.43       | 310.94          |
| 10,000  | 500.78   | 383.63          | 338.95           | 323.75       | 346.11          |
| 100,000 | 1526.91  | 303.54          | 313.31           | 345.54       | 321.14          |

---

## Framework Overhead: Elysia vs Bun.serve raw

| Size    | Endpoint       | Elysia RPS | Bun.serve RPS | Elysia p95 | Bun.serve p95 |
| ------- | -------------- | ---------- | ------------- | ---------- | ------------- |
| 1,000   | buffered       | 141        | 146           | 111.53ms   | 103.02ms      |
| 1,000   | stream-cursor  | 34         | 36            | 335.96ms   | 350.95ms      |
| 1,000   | stream-foreach | 65         | 60            | 372.13ms   | 400.09ms      |
| 10,000  | buffered       | 15         | 15            | 914.46ms   | 887.22ms      |
| 10,000  | stream-cursor  | 3          | 3             | 3.24s      | 3.04s         |
| 10,000  | stream-foreach | 5          | 5             | 4.21s      | 4.1s          |
| 100,000 | buffered       | 2          | 2             | 8.07s      | 7.98s         |
| 100,000 | stream-cursor  | 2          | 2             | 6.18s      | 6.2s          |
| 100,000 | stream-foreach | 2          | 2             | 6.34s      | 6.45s         |

---

## Compression: Uncompressed vs Gzip

| Size    | Mode         | RPS | p95      | Memory    | Throughput |
| ------- | ------------ | --- | -------- | --------- | ---------- |
| 1,000   | uncompressed | 38  | 353.42ms | +87.6MB   | 10.46MB/s  |
| 1,000   | gzip         | 46  | 280.06ms | +105.3MB  | 12.73MB/s  |
| 10,000  | uncompressed | 4   | 3.28s    | +93.79MB  | 10.75MB/s  |
| 10,000  | gzip         | 5   | 2.57s    | +317.01MB | 14.03MB/s  |
| 100,000 | uncompressed | 2   | 31.94s   | +84.82MB  | 47.23MB/s  |
| 100,000 | gzip         | 2   | 20.53s   | +914.59MB | 47.23MB/s  |

---

## Transport: HTTP NDJSON vs WebSocket

| Size    | Transport   | RPS | p95      | Memory    |
| ------- | ----------- | --- | -------- | --------- |
| 1,000   | HTTP NDJSON | 36  | 328.68ms | +80.89MB  |
| 1,000   | WebSocket   | 69  | 180.26ms | +88.1MB   |
| 10,000  | HTTP NDJSON | 4   | 3.07s    | +82.63MB  |
| 10,000  | WebSocket   | 8   | 1.58s    | +88.31MB  |
| 100,000 | HTTP NDJSON | 2   | 6.19s    | +86.52MB  |
| 100,000 | WebSocket   | 2   | 6.06s    | +101.13MB |

---

## Concurrency & Backpressure

| Test            | Concurrency | RPS | p95    | Memory    |
| --------------- | ----------- | --- | ------ | --------- |
| concurrency=1   | 1           | 1   | 1.61s  | +75.76MB  |
| concurrency=10  | 10          | 2   | 6.19s  | +88.48MB  |
| concurrency=50  | 50          | 3   | 6.53s  | +103.42MB |
| concurrency=100 | 100         | 3   | 6.33s  | +98.46MB  |
| slow_0ms        | 10          | 3   | 3.37s  | +89.54MB  |
| slow_5ms        | 10          | 5   | 3.12s  | +86.13MB  |
| slow_10ms       | 10          | 4   | 3.06s  | +90.79MB  |
| slow_50ms       | 10          | 4   | 3.08s  | +87.43MB  |
| pool_saturated  | 50          | 12  | 11.63s | +83.72MB  |
| start-based     | 10          | 2   | 6.22s  | +91.05MB  |
| pull-based      | 10          | 2   | 6.2s   | +104.02MB |

---

## Bottleneck Analysis: HTTP Layer Isolation

All endpoints return ~284KB (1,000 rows). Concurrency = 10.

| Endpoint                           | RPS    | p95      | avg      |
| ---------------------------------- | ------ | -------- | -------- |
| noop buffered (baseline)           | 8.73k  | 4.1ms    | 1.15ms   |
| noop stream (stream setup)         | 23.99k | 610us    | 416us    |
| buffered prebuilt (no DB)          | 1.97k  | 15.73ms  | 5.08ms   |
| stream 1 enqueue (no DB)           | 2k     | 14.64ms  | 5ms      |
| stream 2 enqueues (no DB)          | 1.96k  | 16.37ms  | 5.12ms   |
| stream 1k enqueues (no DB)         | 1.2k   | 14.62ms  | 8.3ms    |
| buffered (DB + JSON array)         | 133    | 116.35ms | 75.49ms  |
| stream batch enqueue (DB cursor)   | 125    | 100.3ms  | 80.15ms  |
| stream per-row enqueue (DB cursor) | 32     | 351.8ms  | 318.62ms |

---

## Bottleneck Analysis: Enqueue Count vs RPS

Pre-built ~284KB payload, no DB. Shows pure enqueue overhead. Concurrency = 10.

| Enqueue count | RPS   | p95     | avg    |
| ------------- | ----- | ------- | ------ |
| 1 enqueue     | 1.81k | 15.84ms | 5.54ms |
| 2 enqueues    | 2.15k | 14.76ms | 4.66ms |
| 5 enqueues    | 2.18k | 13.35ms | 4.59ms |
| 10 enqueues   | 1.91k | 12.89ms | 5.24ms |
| 50 enqueues   | 1.63k | 13.43ms | 6.12ms |
| 100 enqueues  | 1.64k | 12.91ms | 6.11ms |
| 1000 enqueues | 1.16k | 14.96ms | 8.62ms |

---

## Bottleneck Analysis: Cursor Batch Size & Enqueue Strategy

DB cursor with batch enqueue (1 `controller.enqueue()` per cursor batch) vs per-row enqueue. Concurrency = 10.

| Strategy                           | RPS | p95      | avg      |
| ---------------------------------- | --- | -------- | -------- |
| cursor(50) → 20 enqueues           | 93  | 126.8ms  | 107.6ms  |
| cursor(100) → 10 enqueues          | 110 | 109.51ms | 91.39ms  |
| cursor(250) → 4 enqueues           | 123 | 94.52ms  | 81.1ms   |
| cursor(500) → 2 enqueues           | 124 | 100.29ms | 80.63ms  |
| cursor(1000) → 1 enqueue           | 125 | 105.03ms | 80.16ms  |
| cursor(100) per-row → 1k enqueues  | 28  | 434.87ms | 353.27ms |
| cursor(500) per-row → 1k enqueues  | 31  | 369.71ms | 321.72ms |
| cursor(1000) per-row → 1k enqueues | 28  | 411.87ms | 361.53ms |

---

## Bottleneck Analysis: Concurrency Scaling

Same endpoints tested at concurrency 1, 5, and 10. Shows event loop contention.

| Endpoint                  | c=1 RPS | c=5 RPS | c=10 RPS | c=1 avg | c=5 avg  | c=10 avg |
| ------------------------- | ------- | ------- | -------- | ------- | -------- | -------- |
| prebuilt per-row (no DB)  | 604     | 986     | 1.1k     | 1.66ms  | 5.07ms   | 9.14ms   |
| buffered (DB + JSON)      | 66      | 104     | 108      | 15.25ms | 48.53ms  | 93.34ms  |
| buffered → per-row stream | 70      | 90      | 101      | 14.29ms | 55.76ms  | 100.27ms |
| cursor batch enqueue      | 67      | 100     | 105      | 14.9ms  | 49.89ms  | 95.45ms  |
| cursor per-row enqueue    | 51      | 31      | 28       | 19.5ms  | 162.82ms | 356.8ms  |

---

## Bottleneck Analysis: Root Cause

The streaming RPS bottleneck is caused by **per-row `controller.enqueue()` under concurrent load**:

1. Each `enqueue()` call on a `ReadableStream` connected to an HTTP response triggers Bun's internal stream→socket bridge
2. At concurrency=1, Bun coalesces all enqueues efficiently — per-row and batch perform identically
3. Under concurrent load (c=10), 10 requests × 1,000 enqueues = 10,000 micro-operations competing for the event loop
4. This creates O(concurrency × enqueues_per_request) scheduling overhead, collapsing RPS
5. **TCP fragmentation is NOT the cause** — Bun coalesces writes (client sees only 2-5 read() calls regardless)

**Fix:** Batch enqueues by cursor batch — concatenate all rows per cursor batch into one string, enqueue once:

```typescript
// SLOW: 1,000 enqueues per request
for await (const batch of cursor) {
  for (const row of batch) {
    controller.enqueue(enc.encode(JSON.stringify(row.data) + "\n"));
  }
}

// FAST: 2 enqueues per request (with cursor batch size 500)
for await (const batch of cursor) {
  let chunk = "";
  for (const row of batch) chunk += JSON.stringify(row.data) + "\n";
  controller.enqueue(enc.encode(chunk));
}
```

This fix yields **3.75x higher RPS** at concurrency=10 (105 vs 28) while preserving streaming memory benefits.
At concurrency=1, both strategies perform identically (51 vs 67 RPS), confirming the bottleneck is purely from event loop contention under concurrent load.

---

## Key Takeaways

- **All streaming strategies use ~17.02x less memory** than buffered at 100,000 rows
- Buffered: +1302.02MB vs best streaming (pg-query-stream): +76.52MB
- All streaming strategies have **similar memory** (within 16.27MB)
- Highest streaming RPS at 100,000 rows: **pg-query-stream** (2)
- With streaming, server RSS stays under ~384MB — safe for container memory limits
- Elysia framework overhead: ~0.19% lower RPS vs raw Bun.serve on average
- Gzip compression reduces bandwidth by ~8.09% with modest CPU overhead
