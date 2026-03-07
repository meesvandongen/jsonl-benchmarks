# Future Benchmarks

Status legend: [x] implemented, [ ] not yet, [~] partial, [-] skipped (see reason)

---

## DB Driver Variants

- [-] **porsager/postgres `.readable()`** — COPY TO STDOUT hangs on repeated calls (connection pool exhaustion). Not safe for benchmarking.
- [~] **porsager/postgres `.writable()`** — COPY FROM STDIN via writable stream. See `write-path.ts` (may warn if unsupported).
- [x] **pg-cursor (raw)** — direct cursor without stream abstraction. See `db-driver-variants.ts`.
- [-] **COPY TO STDOUT** — same `.readable()` hang issue. Single call works but repeated calls exhaust pool.
- [x] **Prepared statements** — porsager auto-prepare + pg named queries. See `db-driver-variants.ts`.

## Serialization

- [x] **JSON.stringify vs streaming serializer** — big array vs NDJSON vs streaming JSON array. See `serialization.ts`.
- [x] **JSONB vs TEXT column** — JSONB (auto-parsed) vs TEXT (raw string) vs TEXT + JSON.parse. See `serialization.ts`.
- [x] **MessagePack** — binary serialization via msgpackr. See `serialization.ts`.
- [ ] **CBOR / Protobuf** — additional binary formats. Could add cbor-x and protobufjs.
- [x] **Streaming JSON array** — `[` + comma-separated + `]`. See `serialization.ts`.

## HTTP Layer

- [x] **Bun.serve raw vs Elysia** — framework overhead measurement. See `http-bun-raw.ts` + `server-raw.ts`.
- [x] **Compression (gzip)** — streaming with CompressionStream. See `http-compression.ts`.
- [-] **HTTP/2 server push** — skipped: Bun.serve does not support HTTP/2.
- [x] **WebSocket streaming** — WS vs HTTP NDJSON. See `http-websocket.ts` + server `/ws-stream`.
- [x] **SSE with backpressure** — slow client simulation via concurrency benchmark. See `concurrency.ts`.

## Concurrency & Backpressure

- [x] **Varying concurrency** — 1, 10, 50, 100 concurrent clients. See `concurrency.ts`.
- [x] **Slow client simulation** — throttled reader (0, 5, 10, 50ms delays). See `concurrency.ts`.
- [x] **Connection pool saturation** — max=5 pool with 50 concurrent. See `concurrency.ts`.
- [x] **ReadableStream backpressure** — `start()` vs `pull()` comparison. See `concurrency.ts` + server `/stream-cursor-pull`.

## Write Path

- [x] **Streaming INSERT** — NDJSON ingest via `POST /ingest`. See server endpoint.
- [x] **COPY FROM STDIN** — porsager writable stream. See `write-path.ts`.
- [x] **Batch INSERT sizes** — unnest 100/500/1000/5000. See `write-path.ts`.

## Memory Measurement

- [-] **V8 heap snapshots** — skipped: Bun uses JavaScriptCore, not V8. Use `process.memoryUsage()` instead.
- [x] **GC pressure** — `Bun.gc(true)` + heap measurement. See `memory-gc.ts`.
- [-] **Container memory limits** — skipped as automated benchmark. Manual test: `docker run --memory=256m`.
- [x] **ArrayBuffer pooling** — buffer reuse vs fresh allocation. See `memory-gc.ts`.

## Real-World Patterns

- [x] **Filtered queries** — WHERE clause buffered vs streaming. See `real-world.ts` + server `/filtered`.
- [x] **Pagination vs cursor streaming** — OFFSET/LIMIT vs single cursor. See `real-world.ts` + server `/paginated`.
- [x] **Transform streams** — redact/filter during streaming. See `real-world.ts` + server `/stream-transform`.
- [x] **Multi-table JOINs** — stream JOIN results. See `real-world.ts` + server `/stream-join`.
- [ ] **Time-series append** — LISTEN/NOTIFY + SSE. Would require PG trigger + persistent connection.

## Cross-Runtime

- [ ] **Node.js vs Bun** — requires tsx or ts-node to run TypeScript under Node. Could add as future work.
- [-] **Deno** — skipped: project is Bun-native (Bun.spawn, Bun.sleep, Bun.write). Porting would need significant shims.

## other

- [x] **influence of latency** — simulate network latency of the database
  connection (e.g. 10ms, 50ms) to see how it affects streaming vs buffered
  approaches. Could add artificial delay in server or use a proxy like
  `toxiproxy`.