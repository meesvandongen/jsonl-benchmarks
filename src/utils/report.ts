// ANSI color codes
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
};

export function printHeader(title: string) {
  const width = 72;
  const padded = title.padStart(Math.floor((width + title.length) / 2)).padEnd(width);
  console.log("\n" + C.bold + C.cyan + "╔" + "═".repeat(width) + "╗" + C.reset);
  console.log(C.bold + C.cyan + "║" + C.reset + C.bold + padded + C.reset + C.bold + C.cyan + "║" + C.reset);
  console.log(C.bold + C.cyan + "╚" + "═".repeat(width) + "╝" + C.reset + "\n");
}

export function printSectionHeader(title: string) {
  console.log("\n" + C.bold + C.yellow + "  ▶ " + title + C.reset);
  console.log("  " + C.dim + "─".repeat(68) + C.reset);
}

export interface TableRow {
  cells: string[];
  highlight?: "winner" | "loser" | "neutral";
}

export function printTable(headers: string[], rows: TableRow[], colAligns?: ("left" | "right")[]) {
  const allRows = rows.map((r) => r.cells);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...allRows.map((r) => (r[i] ?? "").length))
  );

  const aligns = colAligns ?? headers.map(() => "left" as const);

  const sep = "  +" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmtRow = (cells: string[], color = "", bold = false) => {
    const parts = cells.map((cell, i) => {
      const padded = aligns[i] === "right" ? cell.padStart(widths[i]) : cell.padEnd(widths[i]);
      return ` ${padded} `;
    });
    const prefix = bold ? C.bold : "";
    return "  |" + parts.map((p) => color + prefix + p + C.reset).join("|") + "|";
  };

  console.log(sep);
  console.log(fmtRow(headers, C.cyan, true));
  console.log(sep);

  for (const row of rows) {
    let color = "";
    if (row.highlight === "winner") color = C.green;
    else if (row.highlight === "loser") color = C.dim;
    console.log(fmtRow(row.cells, color));
  }

  console.log(sep + "\n");
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}μs`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB/s`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB/s`;
  return `${bytes.toFixed(0)}B/s`;
}

export function fmtRps(rps: number): string {
  if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k`;
  return rps.toFixed(0);
}

export function winner(a: number, b: number, lowerIsBetter = true): { aWin: boolean; ratio: string } {
  const aWin = lowerIsBetter ? a <= b : a >= b;
  const ratio = lowerIsBetter
    ? (Math.max(a, b) / Math.min(a, b)).toFixed(2)
    : (Math.max(a, b) / Math.min(a, b)).toFixed(2);
  return { aWin, ratio };
}

export function printSummary(results: { label: string; wins: number; total: number }[]) {
  console.log(C.bold + "\n  Summary" + C.reset);
  for (const r of results) {
    const pct = Math.round((r.wins / r.total) * 100);
    const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
    const color = pct >= 60 ? C.green : pct >= 40 ? C.yellow : C.red;
    console.log(`  ${r.label.padEnd(20)} ${color}${bar}${C.reset} ${pct}% (${r.wins}/${r.total} tests)`);
  }
  console.log();
}
