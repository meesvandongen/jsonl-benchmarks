# PostgreSQL drivers for streaming in Node.js

If you need to stream large PostgreSQL result sets in Node.js, `postgres .forEach()` looks like the best overall trade-off in these benchmarks.

We compared the same four approaches throughout:

- buffered reads
- `postgres .cursor(500)`
- `postgres .forEach()`
- `pg-query-stream`

The short version is:

- buffered reads are fast, but memory use grows too much for large responses
- `postgres .cursor(500)` and `pg-query-stream` keep memory bounded, but slow down badly when DB latency rises
- `postgres .forEach()` keeps memory bounded while staying much closer to buffered performance

---

## Speed

Speed answers a simple question: how much overhead each approach adds before HTTP, client speed, and memory pressure start to dominate.

In the raw driver benchmark, `postgres .forEach()` stayed very close to buffered reads, while the cursor-based options were slower.

At **1,000 rows**:

- `buffered reads`: **4.42 ms**
- `postgres .cursor(500)`: **5.83 ms**
- `postgres .forEach()`: **4.23 ms**
- `pg-query-stream`: **149.32 ms**

At **10,000 rows**:

- `buffered reads`: **38.64 ms**
- `postgres .cursor(500)`: **51.24 ms**
- `postgres .forEach()`: **36.59 ms**
- `pg-query-stream`: **219.95 ms**

At **100,000 rows**:

- `buffered reads`: **384.04 ms**
- `postgres .cursor(500)`: **627.30 ms**
- `postgres .forEach()`: **371.42 ms**
- `pg-query-stream`: **678.33 ms**

The important takeaway is not that buffered reads lose. They are still fast. The important takeaway is that `postgres .forEach()` gets streaming behavior without giving up baseline read speed. It is effectively tied with buffered reads in this test, while the cursor-driven options add noticeably more overhead.

---

## Throughput

Throughput shows how many complete HTTP responses the server can push through. This matters more than raw query time once the data has to move through the app and out to the client.

At **1,000 rows** in the end-to-end HTTP benchmark:

- `buffered reads`: **178.3 RPS**
- `postgres .cursor(500)`: **37.7 RPS**
- `postgres .forEach()`: **94.3 RPS**
- `pg-query-stream`: **27.7 RPS**

At **10,000 rows**:

- `buffered reads`: **20.8 RPS**
- `postgres .cursor(500)`: **5.0 RPS**
- `postgres .forEach()`: **5.2 RPS**
- `pg-query-stream`: **3.3 RPS**

Buffered reads win on absolute throughput. If you ignore memory, that is the fastest path.

But that is not usually the decision you need to make in production. The more useful comparison is among the approaches that keep memory bounded. There, `postgres .forEach()` is the clear leader at smaller payloads and at least matches `postgres .cursor(500)` at larger ones.

So if the requirement is “stream large responses without turning the app into a memory hog,” `postgres .forEach()` gives the strongest throughput trade-off of the streaming options.

---

## Memory

Memory is where the decision becomes operational, not just technical.

At **100,000 rows**, peak RSS delta in the end-to-end benchmark was:

- `buffered reads`: **+1,271.96 MB**
- `postgres .cursor(500)`: **+85.65 MB**
- `postgres .forEach()`: **+80.37 MB**
- `pg-query-stream`: **+75.76 MB**

All three streaming approaches stayed in the same broad range. Buffered reads did not. One buffered request at this size pushed RSS by roughly **1.27 GB**.

That matters because bounded memory changes how you can run the service:

- **Smaller Kubernetes requests and limits.** If a large response can add ~1.27 GB of RSS, you need much fatter pods and much more safety margin. If the same response stays around ~76-86 MB, you can size pods much closer to steady-state usage.
- **Higher pod density.** Lower per-request memory means you can pack more replicas onto the same nodes instead of paying for memory headroom that only exists to survive occasional large responses.
- **Lower OOM risk.** Buffered reads make traffic spikes much more dangerous. A few overlapping large responses can push a pod into its memory limit and get it killed.
- **Less GC jitter.** Large buffered responses create larger live heaps and more garbage to reclaim. That usually means more pause time, more CPU spent in GC, and more tail-latency noise.

This is also where TCP backpressure matters. With a streaming response, if the client or network is slow, the TCP send buffer fills up and the app is forced to slow down too. That is good. It means the server only needs to keep a small amount of data in flight instead of building the entire response in memory first.

So `.forEach()` is not the memory winner by a huge margin. The real win is that it stays in the bounded-memory group while avoiding the latency penalty that comes with cursor-style streaming.

---

## Latency

Latency matters because database round trips are not free. A design that looks fine on localhost can get ugly fast when the database is even a little farther away.

At **10,000 rows** with **100 ms simulated DB RTT**:

- `buffered reads`: **160.1 ms**
- `postgres .cursor(500)`: **2.54 s**
- `postgres .forEach()`: **166.9 ms**
- `pg-query-stream`: **2.53 s**

That is the most important result in the article.

`postgres .cursor(500)` and `pg-query-stream` both pay a repeated fetch-cycle cost. With 10,000 rows and a batch size of 500, the server has to go back to PostgreSQL many times. Once each of those fetches starts paying network RTT, total response time jumps into multi-second territory.

`postgres .forEach()` behaves differently. It still lets the HTTP layer stream the response out gradually, so you keep the memory and backpressure benefits of streaming. But it does not take the same cursor-style latency hit between the app and the database. That is why it stayed close to buffered reads here.

So buffered reads are still the fastest latency path in absolute terms, but they pay for that with much higher memory use. `postgres .forEach()` is the option that stays close on latency without forcing you into buffered-read memory costs.

---

Taken together, these results make `postgres .forEach()` the best value proposition of the four approaches in this benchmark set. It is not the absolute winner on every single number. Buffered reads still win on raw throughput and absolute latency. But `postgres .forEach()` gives the best overall trade-off: near-buffered speed, clearly better streaming throughput than the cursor-driven options, bounded memory, and far better behavior once database latency stops being trivial.
