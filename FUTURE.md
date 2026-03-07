# Future Benchmarks

Ideas for additional benchmarks that would make sense for this project.

---

## DB Driver Variants

- **porsager/postgres `.readable()`** — the driver exposes a Node.js Readable stream via `.readable()`. Compare against cursor and forEach for streaming throughput.
- **porsager/postgres `.writable()`** — benchmark bulk INSERT via writable stream vs COPY vs `unnest()`.
- **pg-cursor (raw)** — use `pg-cursor` directly (what pg-query-stream wraps) without the Readable overhead. Isolate cursor vs stream abstraction cost.
- **COPY TO STDOUT** — PostgreSQL's native binary streaming. Use `COPY (SELECT ...) TO STDOUT` with CSV or binary format. This bypasses the query protocol entirely and should be the fastest possible read path.
- **Prepared statements** — compare `sql.prepare()` and `pool.query({ text, values, name })` against ad-hoc queries for repeated reads.

## Serialization

- **JSON.stringify vs streaming serializer** — compare `JSON.stringify(bigArray)` vs writing records one-by-one. Measure peak memory of serialization itself.
- **JSONB vs TEXT column** — store pre-serialized JSON text vs JSONB. JSONB has parse/serialize overhead on both sides. For read-heavy streaming, raw TEXT might win.
- **MessagePack / CBOR / Protobuf** — binary serialization over NDJSON. Smaller payloads = less network time, but adds encode/decode cost. Measure total throughput + memory.
- **Streaming JSON array** — write `[` then stream records with commas, then `]`. Clients get valid JSON without buffering. Compare against NDJSON for compatibility vs memory.

## HTTP Layer

- **Bun.serve raw vs Elysia** — bypass Elysia's routing/middleware and use `Bun.serve` directly. Measure the framework overhead for streaming responses.
- **Compression (gzip/brotli)** — streaming with `Content-Encoding: gzip`. Does compression buffering defeat the purpose of streaming? Measure memory impact.
- **HTTP/2 server push** — compare HTTP/1.1 chunked transfer vs HTTP/2 with multiplexed streams.
- **WebSocket streaming** — send records over a WebSocket connection. Compare latency and memory vs SSE and NDJSON.
- **SSE with backpressure** — Elysia SSE with `yield` and slow clients. Does the server buffer unsent events?

## Concurrency & Backpressure

- **Varying concurrency** — test 1, 10, 50, 100 concurrent clients. At what point does memory spike even for streaming?
- **Slow client simulation** — throttle the client's read speed. Does the server respect backpressure or buffer in memory?
- **Connection pool saturation** — what happens when concurrent requests exceed `max` pool connections? Measure queue time + memory.
- **ReadableStream backpressure** — compare `start()` (eager) vs `pull()` (lazy) in ReadableStream. Does pull-based streaming reduce memory further?

## Write Path

- **Streaming INSERT** — accept NDJSON upload, insert rows as they arrive. Compare memory vs buffering the full request body.
- **COPY FROM STDIN** — PostgreSQL's fastest bulk insert. Stream NDJSON -> CSV transform -> COPY. Measure throughput vs row-by-row INSERT.
- **Batch INSERT sizes** — vary `unnest()` batch size (100, 500, 1000, 5000). Find the sweet spot for throughput vs memory.

## Memory Measurement

- **V8 heap snapshots** — take heap snapshots during load to identify what's allocating (row objects, string buffers, framework internals).
- **GC pressure** — run with `--expose-gc` and force GC between iterations. Measure how much memory is reclaimable vs long-lived.
- **Container memory limits** — run the server in a Docker container with `--memory=256m`. Which strategies survive? Which OOM?
- **ArrayBuffer pooling** — reuse TextEncoder output buffers instead of allocating per-row. Measure allocation reduction.

## Real-World Patterns

- **Filtered queries** — add WHERE clauses (e.g., `data->>'active' = 'true'`). Streaming with filters vs buffering with filters.
- **Pagination vs cursor streaming** — compare OFFSET/LIMIT pagination (many small requests) vs single cursor stream (one large request). Total time + total memory.
- **Transform streams** — apply a map/filter transformation during streaming (e.g., redact fields, compute derived values). Measure overhead.
- **Multi-table JOINs** — stream results of a JOIN query. Does the row size/complexity change the streaming advantage?
- **Time-series append** — continuously INSERT + stream new rows via LISTEN/NOTIFY + SSE. Measure steady-state memory.

## Cross-Runtime

- **Node.js vs Bun** — run the same server and benchmark under both runtimes. Compare memory behavior and throughput.
- **Deno** — same benchmarks under Deno with `npm:postgres` and `npm:pg`. Compare runtime overhead.
