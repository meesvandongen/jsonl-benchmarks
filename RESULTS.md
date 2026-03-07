# E2E Benchmark: Response Strategies from PostgreSQL

> Generated: 2026-03-07T10:41:16.867Z
> Platform: win32 x64
> Runtime: Bun 1.3.9
> PostgreSQL: 16.13
> DB rows: 100,000 | Concurrency: 10

## Strategies

| Strategy | DB access | HTTP response | Memory model |
| --- | --- | --- | --- |
| **Buffered** | `SELECT ... LIMIT N` (all at once) | JSON array | Grows with N |
| **Cursor+RS** | `.cursor(500)` batched iteration | `ReadableStream` NDJSON | Flat |
| **forEach+RS** | `.forEach(fn)` instant row callback | `ReadableStream` NDJSON | Flat |
| **Yield+Cursor** | `.cursor(500)` batched iteration | Elysia `yield` generator | Flat |

Primary metric: **peak memory (RSS)**. Secondary: throughput, latency.

---

## Peak Memory (RSS delta from baseline)

How much *extra* memory above the server's idle baseline during concurrent load.

| Rows    | Buffered   | Cursor+RS | forEach+RS | Yield+Cursor |
| ------- | ---------- | --------- | ---------- | ------------ |
| 100     | +82.41MB   | +77.11MB  | +72.97MB   | +78.25MB     |
| 1,000   | +101.84MB  | +93.19MB  | +97.63MB   | +97.04MB     |
| 10,000  | +282.21MB  | +91.16MB  | +92.17MB   | +99.7MB      |
| 50,000  | +725.3MB   | +90.29MB  | +90.79MB   | +98.03MB     |
| 100,000 | +1244.46MB | +88.96MB  | +92.42MB   | +101.25MB    |

## Throughput (RPS)

| Rows    | Buffered | Cursor+RS | forEach+RS | Yield+Cursor |
| ------- | -------- | --------- | ---------- | ------------ |
| 100     | 1.4k     | 364       | 773        | 299          |
| 1,000   | 159      | 36        | 61         | 33           |
| 10,000  | 19       | 5         | 5          | 4            |
| 50,000  | 5        | 2         | 2          | 2            |
| 100,000 | 3        | 2         | 2          | 2            |

## p95 Latency

| Rows    | Buffered | Cursor+RS | forEach+RS | Yield+Cursor |
| ------- | -------- | --------- | ---------- | ------------ |
| 100     | 11.26ms  | 35.67ms   | 24.67ms    | 45.29ms      |
| 1,000   | 97.81ms  | 349.4ms   | 406.68ms   | 387.68ms     |
| 10,000  | 658.5ms  | 3.26s     | 3.91s      | 3.51s        |
| 50,000  | 2.79s    | 13.75s    | 14.98s     | 17.63s       |
| 100,000 | 6.06s    | 29.97s    | 28.43s     | 35.67s       |

## Absolute Peak RSS (MB)

| Rows    | Buffered | Cursor+RS | forEach+RS | Yield+Cursor |
| ------- | -------- | --------- | ---------- | ------------ |
| 100     | 371.34   | 318.04    | 319.68     | 304.27       |
| 1,000   | 373.61   | 339.49    | 360.41     | 378.93       |
| 10,000  | 571.34   | 356.78    | 335.79     | 346.55       |
| 50,000  | 1003.85  | 333.67    | 368.55     | 339.88       |
| 100,000 | 1496.98  | 315.48    | 333.1      | 322.85       |

---

## Key Takeaways

- **All streaming strategies use dramatically less memory than buffered** at 100,000 rows
- Best streaming (Cursor+RS): +88.96MB vs buffered: +1244.46MB (~13.99x less)
- All three streaming strategies have **similar memory profiles** (within 12.29MB of each other)
- Streaming RPS is similar across all three strategies at 100,000 rows
- cursor and forEach have similar throughput — choose based on API ergonomics
- Elysia yield and ReadableStream have similar throughput — yield is cleaner code
- With any streaming strategy, RSS stays under ~379MB even at 100,000 rows
