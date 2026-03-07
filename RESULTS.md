# Benchmark Results

> Generated: 2026-03-07T11:11:53.629Z
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

DB driver benchmarks (mitata) are printed to stdout above.
Below: HTTP E2E results with peak memory measurement.

---

## Peak Memory (RSS delta from baseline)

| Rows    | Buffered   | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | ---------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | +105MB     | +85.41MB        | +93.37MB         | +86.03MB     | +85.49MB        |
| 10,000  | +229.64MB  | +87.43MB        | +93.36MB         | +89.16MB     | +81.52MB        |
| 100,000 | +1163.85MB | +81.41MB        | +82.81MB         | +89.7MB      | +78.6MB         |

## Throughput (RPS)

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 118      | 33              | 53               | 24           | 23              |
| 10,000  | 12       | 3               | 4                | 3            | 3               |
| 100,000 | 2        | 2               | 2                | 2            | 2               |

## p95 Latency

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 146.56ms | 374.2ms         | 495.19ms         | 532.8ms      | 666.21ms        |
| 10,000  | 1.3s     | 4.24s           | 4.69s            | 4.28s        | 4.44s           |
| 100,000 | 7.75s    | 35.96s          | 32.59s           | 37.89s       | 40.97s          |

## Absolute Peak RSS (MB)

| Rows    | Buffered | porsager cursor | porsager forEach | Elysia yield | pg-query-stream |
| ------- | -------- | --------------- | ---------------- | ------------ | --------------- |
| 1,000   | 401.95   | 320.46          | 390.71           | 326.18       | 335.43          |
| 10,000  | 501.77   | 327.97          | 359.73           | 329.42       | 307.2           |
| 100,000 | 1399.77  | 357.33          | 307.41           | 320.45       | 308.63          |

---

## Key Takeaways

- **All streaming strategies use ~14.81x less memory** than buffered at 100,000 rows
- Buffered: +1163.85MB vs best streaming (pg-query-stream): +78.6MB
- All streaming strategies have **similar memory** (within 11.1MB)
- Highest streaming RPS at 100,000 rows: **pg-query-stream** (2)
- With streaming, server RSS stays under ~391MB — safe for container memory limits
