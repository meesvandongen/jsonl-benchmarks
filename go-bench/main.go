package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var pool *pgxpool.Pool

func getLimit(r *http.Request) int {
	s := r.URL.Query().Get("limit")
	if s == "" {
		return 1000
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 1000
	}
	return n
}

// Strategy 1: Buffered — SELECT all rows, build JSON array, write at once.
func bufferedHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	rows, err := pool.Query(r.Context(), "SELECT data FROM records ORDER BY id LIMIT $1", limit)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	records := make([]json.RawMessage, 0, limit)
	for rows.Next() {
		var data json.RawMessage
		if err := rows.Scan(&data); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		records = append(records, data)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(records)
}

// Strategy 2: Simple query + TCP backpressure — no cursor, no DECLARE/FETCH.
// pgx sends a simple Query, PG streams rows over TCP. Go reads row-by-row.
// When Go is slow to read from the socket, TCP backpressure throttles PG.
// Each row is written to the HTTP response immediately (flushed).
func backpressureHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", 500)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Transfer-Encoding", "chunked")

	// Simple query — no cursor. PG sends all rows, TCP backpressure controls flow.
	rows, err := pool.Query(r.Context(), "SELECT data FROM records ORDER BY id LIMIT $1", limit)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var data json.RawMessage
		if err := rows.Scan(&data); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Write(data)
		w.Write([]byte("\n"))
		flusher.Flush()
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
}

// Strategy 3: Same as backpressure but batch writes — accumulate N rows, then flush.
func backpressureBatchHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", 500)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Transfer-Encoding", "chunked")

	rows, err := pool.Query(r.Context(), "SELECT data FROM records ORDER BY id LIMIT $1", limit)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	count := 0
	buf := make([]byte, 0, 64*1024)

	for rows.Next() {
		var data json.RawMessage
		if err := rows.Scan(&data); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		buf = append(buf, data...)
		buf = append(buf, '\n')
		count++

		// Flush every 500 rows
		if count%500 == 0 {
			w.Write(buf)
			flusher.Flush()
			buf = buf[:0]
		}
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// Flush remainder
	if len(buf) > 0 {
		w.Write(buf)
		flusher.Flush()
	}
}

// Strategy 4: pgx cursor (DECLARE/FETCH) with per-row streaming.
func cursorPerRowHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", 500)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Transfer-Encoding", "chunked")

	conn, err := pool.Acquire(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer conn.Release()

	tx, err := conn.Begin(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(), fmt.Sprintf(
		"DECLARE bench_cursor CURSOR FOR SELECT data FROM records ORDER BY id LIMIT %d", limit))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	for {
		rows, err := tx.Query(r.Context(), "FETCH 500 FROM bench_cursor")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		fetched := 0
		for rows.Next() {
			var data json.RawMessage
			if err := rows.Scan(&data); err != nil {
				rows.Close()
				http.Error(w, err.Error(), 500)
				return
			}
			w.Write(data)
			w.Write([]byte("\n"))
			fetched++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		flusher.Flush()

		if fetched == 0 {
			break
		}
	}

	tx.Exec(r.Context(), "CLOSE bench_cursor")
	tx.Commit(r.Context())
}

// Strategy 5: pgx cursor with batch flush (same as per-row but writes per batch).
func cursorBatchHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", 500)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Transfer-Encoding", "chunked")

	conn, err := pool.Acquire(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer conn.Release()

	tx, err := conn.Begin(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(), fmt.Sprintf(
		"DECLARE bench_cursor CURSOR FOR SELECT data FROM records ORDER BY id LIMIT %d", limit))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	buf := make([]byte, 0, 64*1024)

	for {
		rows, err := tx.Query(r.Context(), "FETCH 500 FROM bench_cursor")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		fetched := 0
		for rows.Next() {
			var data json.RawMessage
			if err := rows.Scan(&data); err != nil {
				rows.Close()
				http.Error(w, err.Error(), 500)
				return
			}
			buf = append(buf, data...)
			buf = append(buf, '\n')
			fetched++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		if len(buf) > 0 {
			w.Write(buf)
			flusher.Flush()
			buf = buf[:0]
		}

		if fetched == 0 {
			break
		}
	}

	tx.Exec(r.Context(), "CLOSE bench_cursor")
	tx.Commit(r.Context())
}

// Strategy 6: Backpressure no-flush — write row-by-row but let Go's bufio handle flushing.
func backpressureNoFlushHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	w.Header().Set("Content-Type", "application/x-ndjson")

	rows, err := pool.Query(r.Context(), "SELECT data FROM records ORDER BY id LIMIT $1", limit)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var data json.RawMessage
		if err := rows.Scan(&data); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Write(data)
		w.Write([]byte("\n"))
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
}

// Strategy 7: Backpressure with io.Pipe — goroutine writes to pipe, handler streams pipe reader.
func backpressurePipeHandler(w http.ResponseWriter, r *http.Request) {
	limit := getLimit(r)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Transfer-Encoding", "chunked")

	pr, pw := io.Pipe()

	go func() {
		defer pw.Close()
		rows, err := pool.Query(context.Background(), "SELECT data FROM records ORDER BY id LIMIT $1", limit)
		if err != nil {
			pw.CloseWithError(err)
			return
		}
		defer rows.Close()

		for rows.Next() {
			var data json.RawMessage
			if err := rows.Scan(&data); err != nil {
				pw.CloseWithError(err)
				return
			}
			pw.Write(data)
			pw.Write([]byte("\n"))
		}
		if err := rows.Err(); err != nil {
			pw.CloseWithError(err)
		}
	}()

	io.Copy(w, pr)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func memoryHandler(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	w.Header().Set("Content-Type", "application/json")
	// Use HeapAlloc (live heap) as "rss" — Sys doesn't shrink and is misleading for delta tracking.
	// Also report Sys for reference as "sys".
	json.NewEncoder(w).Encode(map[string]uint64{
		"rss":       m.HeapAlloc,
		"heapUsed":  m.HeapInuse,
		"heapTotal": m.HeapSys,
		"heapAlloc": m.HeapAlloc,
		"sys":       m.Sys,
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3400"
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@localhost:5432/benchmark?sslmode=disable"
	}

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatal(err)
	}
	cfg.MaxConns = 20
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	// Verify DB connection
	if err := pool.Ping(context.Background()); err != nil {
		log.Fatal("Cannot connect to DB:", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/memory", memoryHandler)
	mux.HandleFunc("/buffered", bufferedHandler)
	mux.HandleFunc("/backpressure", backpressureHandler)
	mux.HandleFunc("/backpressure-batch", backpressureBatchHandler)
	mux.HandleFunc("/backpressure-nofflush", backpressureNoFlushHandler)
	mux.HandleFunc("/backpressure-pipe", backpressurePipeHandler)
	mux.HandleFunc("/cursor-perrow", cursorPerRowHandler)
	mux.HandleFunc("/cursor-batch", cursorBatchHandler)

	fmt.Printf("[go-server] listening on http://localhost:%s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
