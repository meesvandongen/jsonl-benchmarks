# Benchmark Results

> Generated: 2026-03-07T19:47:32.920Z
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
| 1,000   | +112.1MB   | +85.87MB        | +91.23MB         | +94.87MB     | +91.49MB        |
| 10,000  | +340.84MB  | +89.94MB        | +93.13MB         | +89.86MB     | +98.08MB        |
| 100,000 | +1520.93MB | +90.03MB        | +87.7MB          | +91.06MB     | +80.6MB         |

## Throughput (RPS)

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 203      | 38              | 76               | 33           | 33              |
| 10,000  | 24       | 5               | 5                | 4            | 3               |
| 100,000 | 3        | 2               | 2                | 2            | 2               |

## p95 Latency

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 77.72ms  | 326.78ms        | 322.98ms         | 371.98ms     | 437.42ms        |
| 10,000  | 528.64ms | 2.68s           | 3.51s            | 3.14s        | 3.3s            |
| 100,000 | 5.87s    | 27.17s          | 25.78s           | 31.3s        | 33.3s           |

## Absolute Peak RSS (MB)

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 388.13   | 319.86          | 321.21           | 340.09       | 372.2           |
| 10,000  | 580.65   | 351.87          | 356.28           | 340.65       | 339.81          |
| 100,000 | 1820.08  | 325.7           | 323.47           | 320.66       | 352.79          |

---

## Framework Overhead: Elysia vs Bun.serve raw

| Size    | Endpoint       | Elysia RPS | Bun.serve RPS | Elysia p95 | Bun.serve p95 |
| ------- | -------------- | ---------- | ------------- | ---------- | ------------- |
| 1,000   | buffered       | 224        | 227           | 65.89ms    | 65.16ms       |
| 1,000   | stream-cursor  | 41         | 39            | 291.73ms   | 297.3ms       |
| 1,000   | stream-foreach | 83         | 59            | 267.37ms   | 376.85ms      |
| 10,000  | buffered       | 23         | 24            | 579.44ms   | 501.52ms      |
| 10,000  | stream-cursor  | 5          | 5             | 2.68s      | 2.69s         |
| 10,000  | stream-foreach | 6          | 5             | 3.23s      | 2.91s         |
| 100,000 | buffered       | 3          | 3             | 5.2s       | 5.15s         |
| 100,000 | stream-cursor  | 2          | 2             | 6.16s      | 6.26s         |
| 100,000 | stream-foreach | 2          | 2             | 6.37s      | 6.22s         |

---

## Compression: Uncompressed vs Gzip

| Size    | Mode         | RPS | p95      | Memory    | Throughput |
| ------- | ------------ | --- | -------- | --------- | ---------- |
| 1,000   | uncompressed | 44  | 288.89ms | +84.37MB  | 12.08MB/s  |
| 1,000   | gzip         | 87  | 147.5ms  | +118.19MB | 24.25MB/s  |
| 10,000  | uncompressed | 5   | 2.73s    | +87.74MB  | 14.03MB/s  |
| 10,000  | gzip         | 9   | 1.46s    | +368.35MB | 25.72MB/s  |
| 100,000 | uncompressed | 2   | 27.59s   | +89.22MB  | 47.23MB/s  |
| 100,000 | gzip         | 2   | 11.97s   | +982.43MB | 47.23MB/s  |

---

## Transport: HTTP NDJSON vs WebSocket

| Size    | Transport   | RPS | p95      | Memory    |
| ------- | ----------- | --- | -------- | --------- |
| 1,000   | HTTP NDJSON | 41  | 286.39ms | +95.02MB  |
| 1,000   | WebSocket   | 90  | 135.47ms | +91.16MB  |
| 10,000  | HTTP NDJSON | 5   | 2.75s    | +96.41MB  |
| 10,000  | WebSocket   | 10  | 1.16s    | +93.49MB  |
| 100,000 | HTTP NDJSON | 2   | 6.19s    | +96.3MB   |
| 100,000 | WebSocket   | 2   | 6.04s    | +105.25MB |

---

## Concurrency & Backpressure

| Test            | Concurrency | RPS | p95      | Memory    |
| --------------- | ----------- | --- | -------- | --------- |
| concurrency=1   | 1           | 2   | 892.87ms | +80.31MB  |
| concurrency=10  | 10          | 2   | 6.3s     | +89.34MB  |
| concurrency=50  | 50          | 3   | 6.4s     | +102.49MB |
| concurrency=100 | 100         | 3   | 6.27s    | +100.25MB |
| slow_0ms        | 10          | 5   | 2.65s    | +89.7MB   |
| slow_5ms        | 10          | 5   | 2.74s    | +93.35MB  |
| slow_10ms       | 10          | 5   | 2.78s    | +89.19MB  |
| slow_50ms       | 10          | 5   | 2.77s    | +88.14MB  |
| pool_saturated  | 50          | 13  | 9.64s    | +86.88MB  |
| start-based     | 10          | 2   | 6.21s    | +95.29MB  |
| pull-based      | 10          | 2   | 6.16s    | +100.29MB |

---

## Key Takeaways

- **All streaming strategies use ~18.87x less memory** than buffered at 100,000 rows
- Buffered: +1520.93MB vs best streaming (pg-query-stream): +80.6MB
- All streaming strategies have **similar memory** (within 10.46MB)
- Highest streaming RPS at 100,000 rows: **pg-query-stream** (2)
- With streaming, server RSS stays under ~373MB — safe for container memory limits
- Elysia adds negligible overhead vs raw Bun.serve
- Gzip compression reduces bandwidth by ~32.53% with modest CPU overhead
