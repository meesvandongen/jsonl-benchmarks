# jsonl-benchmark

E2E benchmark measuring **memory usage** and throughput of two HTTP response strategies backed by PostgreSQL:

- **Buffered**: SELECT all rows into memory, serialize as JSON array, send complete response
- **Streamed**: CURSOR through rows, write NDJSON line-by-line, constant memory footprint

The goal: prove that streaming keeps memory flat as payload size grows, enabling safe container memory limits (green IT).

Runtime: [Bun](https://bun.sh) + [Elysia](https://elysiajs.com) + PostgreSQL 16

---

## Quick start

```bash
docker compose up -d          # Start PostgreSQL
bun install                   # Install dependencies
bun src/run.ts                # Run everything (seed + server + benchmark + report)
```

Results are written to `RESULTS.md`.

---

## What is measured

### Pipeline

```
HTTP request -> PostgreSQL query -> response serialization -> client
```

### Strategies

| Strategy | SQL | Response | Memory behavior |
|----------|-----|----------|-----------------|
| Buffered | `SELECT ... LIMIT N` | JSON array (`application/json`) | Grows with N |
| Streamed | `CURSOR(500)` | NDJSON line-by-line (`application/x-ndjson`) | Flat regardless of N |

### Payload sizes

100 / 1,000 / 10,000 / 50,000 / 100,000 rows at concurrency 10.

### Metrics

| Metric | Why |
|--------|-----|
| **Peak RSS delta** | Primary metric — how much extra memory above idle baseline |
| **Absolute RSS** | Can you fit this in a 256MB container? |
| RPS | Throughput cost of streaming vs buffering |
| p95 latency | Tail latency under load |
| MB/s | Raw data throughput |

---

## Project structure

```
src/
  server.ts           Elysia server with /buffered and /streamed endpoints
  benchmarks/
    e2e.ts            Benchmark runner (memory polling + load driver)
  db/
    client.ts         PostgreSQL connection
    setup.ts          Table creation + seeding
  utils/
    report.ts         Terminal table formatter
    md-report.ts      RESULTS.md generator
  run.ts              Full orchestrator (seed -> server -> bench -> report)
  index.ts            Entry point (delegates to run.ts)
docker-compose.yml    PostgreSQL 16 tuned for benchmarks
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `benchmark` | Database name |
| `DB_USER` | `postgres` | Username |
| `DB_PASS` | `postgres` | Password |
| `PORT` | `3000` | Server port |

---

## Cleanup

```bash
docker compose down -v    # Stop PostgreSQL + delete data
```
