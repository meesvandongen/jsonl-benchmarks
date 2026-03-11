# PostgreSQL streaming benchmark repo

This repo is focused on the four approaches used in `WHICH_POSTGRES_DRIVER_NODEJS.md`:

- buffered reads
- `postgres .cursor(500)`
- `postgres .forEach()`
- `pg-query-stream`

## What stays in scope

- raw driver speed benchmark
- end-to-end HTTP throughput and memory benchmark
- simulated DB latency benchmark with Toxiproxy
- the article and the reports that support it

## Quick start

```bash
docker compose up -d postgres
bun install
bun run bench:all
```

Or run the pieces individually:

```bash
bun run db:setup
bun run bench:db
bun run bench:http
```

## Latency benchmark

```bash
docker compose up -d postgres toxiproxy
bun run bench:latency
```

This writes `reports/db-latency.json`.

## Kept reports

- `reports/db-drivers.txt`
- `reports/http-e2e.json`
- `reports/db-latency.json`

## Article

The write-up that uses these benchmarks lives in `WHICH_POSTGRES_DRIVER_NODEJS.md`.
