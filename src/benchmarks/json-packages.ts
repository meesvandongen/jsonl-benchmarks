/**
 * JSON Serialization Package Benchmark
 *
 * Compares stringify and parse performance across popular npm packages
 * using the benchmark suite's standard record schema.
 *
 * Stringify:
 *   - JSON.stringify (V8 built-in)
 *   - fast-json-stringify (schema-based, fastify ecosystem)
 *   - Manual template literal (hand-rolled per schema)
 *   - json-stringify-safe (handles circular refs)
 *
 * Parse:
 *   - JSON.parse (V8 built-in)
 *   - destr (unjs, safe + fast)
 *   - secure-json-parse (prototype pollution safe)
 *
 * Encode (binary):
 *   - msgpackr (Packr)
 *   - @msgpack/msgpack (official)
 */

import { bench, group, run } from "mitata";
import { sql, pool, waitForDb } from "../db/client";
import { setupTables, seedIfNeeded, seedTextIfNeeded } from "../db/setup";
import fastJsonStringify from "fast-json-stringify";
import { destr } from "destr";
import secureJsonParse from "secure-json-parse";
import { Packr } from "msgpackr";
import { encode as mpEncode } from "@msgpack/msgpack";
import stringifySafe from "json-stringify-safe";

// ─── Schema for fast-json-stringify ─────────────────────────────────────────

const stringify = fastJsonStringify({
  type: "object",
  properties: {
    id: { type: "string" },
    user_id: { type: "integer" },
    name: { type: "string" },
    email: { type: "string" },
    age: { type: "integer" },
    score: { type: "number" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    address: {
      type: "object",
      properties: {
        city: { type: "string" },
        country: { type: "string" },
        zip: { type: "string" },
      },
    },
    metadata: {
      type: "object",
      properties: {
        created_at: { type: "string" },
        source: { type: "string" },
        version: { type: "integer" },
      },
    },
  },
});

const stringifyArray = fastJsonStringify({
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      user_id: { type: "integer" },
      name: { type: "string" },
      email: { type: "string" },
      age: { type: "integer" },
      score: { type: "number" },
      active: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      address: {
        type: "object",
        properties: {
          city: { type: "string" },
          country: { type: "string" },
          zip: { type: "string" },
        },
      },
      metadata: {
        type: "object",
        properties: {
          created_at: { type: "string" },
          source: { type: "string" },
          version: { type: "integer" },
        },
      },
    },
  },
});

// ─── Manual template-literal stringify ──────────────────────────────────────

function manualStringify(row: any): string {
  const d = row.data ?? row;
  return `{"id":"${d.id}","user_id":${d.user_id},"name":"${d.name}","email":"${d.email}","age":${d.age},"score":${d.score},"active":${d.active},"tags":${JSON.stringify(d.tags)},"address":{"city":"${d.address.city}","country":"${d.address.country}","zip":"${d.address.zip}"},"metadata":{"created_at":"${d.metadata.created_at}","source":"${d.metadata.source}","version":${d.metadata.version}}}`;
}

// ─── Packr instance ─────────────────────────────────────────────────────────

const packr = new Packr();

// ─── Benchmark ──────────────────────────────────────────────────────────────

const sizes = [1_000, 10_000, 100_000];

await waitForDb();
await setupTables();
await seedIfNeeded(100_000);
await seedTextIfNeeded(100_000);

// Pre-fetch rows for each size so we benchmark serialization only, not DB
const preloaded: Record<number, any[]> = {};
const preloadedText: Record<number, string[]> = {};
for (const size of sizes) {
  const rows = await sql`SELECT data FROM records ORDER BY id LIMIT ${size}`;
  preloaded[size] = rows.map((r: any) => r.data);

  const textRows = await sql`SELECT data FROM records_text ORDER BY id LIMIT ${size}`;
  preloadedText[size] = textRows.map((r: any) => r.data);
}

console.log("Pre-loaded rows for all sizes. Starting benchmarks...\n");

// ── Stringify benchmarks ──────────────────────────────────────────────────

for (const size of sizes) {
  const rows = preloaded[size];

  group(`Stringify — ${size.toLocaleString()} rows`, () => {
    bench("JSON.stringify (row-by-row)", () => {
      for (let i = 0; i < rows.length; i++) {
        JSON.stringify(rows[i]);
      }
    });

    bench("JSON.stringify (full array)", () => {
      JSON.stringify(rows);
    });

    bench("fast-json-stringify (row-by-row)", () => {
      for (let i = 0; i < rows.length; i++) {
        stringify(rows[i]);
      }
    });

    bench("fast-json-stringify (full array)", () => {
      stringifyArray(rows);
    });

    bench("manual template literal", () => {
      for (let i = 0; i < rows.length; i++) {
        manualStringify(rows[i]);
      }
    });

    bench("json-stringify-safe (row-by-row)", () => {
      for (let i = 0; i < rows.length; i++) {
        stringifySafe(rows[i]);
      }
    });
  });
}

// ── Parse benchmarks (from TEXT column strings) ────────────────────────────

for (const size of sizes) {
  const strings = preloadedText[size];

  group(`Parse — ${size.toLocaleString()} rows`, () => {
    bench("JSON.parse", () => {
      for (let i = 0; i < strings.length; i++) {
        JSON.parse(strings[i]);
      }
    });

    bench("destr", () => {
      for (let i = 0; i < strings.length; i++) {
        destr(strings[i]);
      }
    });

    bench("secure-json-parse", () => {
      for (let i = 0; i < strings.length; i++) {
        secureJsonParse.parse(strings[i]);
      }
    });
  });
}

// ── Binary encode benchmarks ───────────────────────────────────────────────

for (const size of sizes) {
  const rows = preloaded[size];

  group(`Binary encode — ${size.toLocaleString()} rows`, () => {
    bench("JSON.stringify → Buffer", () => {
      for (let i = 0; i < rows.length; i++) {
        Buffer.from(JSON.stringify(rows[i]));
      }
    });

    bench("msgpackr (Packr)", () => {
      for (let i = 0; i < rows.length; i++) {
        packr.pack(rows[i]);
      }
    });

    bench("@msgpack/msgpack encode", () => {
      for (let i = 0; i < rows.length; i++) {
        mpEncode(rows[i]);
      }
    });

    bench("fast-json-stringify → Buffer", () => {
      for (let i = 0; i < rows.length; i++) {
        Buffer.from(stringify(rows[i]));
      }
    });
  });
}

// ── NDJSON construction benchmarks ─────────────────────────────────────────

for (const size of sizes) {
  const rows = preloaded[size];

  group(`NDJSON build — ${size.toLocaleString()} rows`, () => {
    bench("JSON.stringify + join", () => {
      const lines: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        lines.push(JSON.stringify(rows[i]));
      }
      lines.join("\n");
    });

    bench("fast-json-stringify + join", () => {
      const lines: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        lines.push(stringify(rows[i]));
      }
      lines.join("\n");
    });

    bench("manual template + join", () => {
      const lines: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        lines.push(manualStringify(rows[i]));
      }
      lines.join("\n");
    });

    bench("JSON.stringify + concat", () => {
      let out = "";
      for (let i = 0; i < rows.length; i++) {
        out += JSON.stringify(rows[i]) + "\n";
      }
    });

    bench("fast-json-stringify + concat", () => {
      let out = "";
      for (let i = 0; i < rows.length; i++) {
        out += stringify(rows[i]) + "\n";
      }
    });
  });
}

await run();
await sql.end();
await pool.end();
