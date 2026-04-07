/**
 * Contract tests for the codedb REST API.
 *
 * Two suites:
 *
 * 1. **Shape snapshot** — response structure (keys + types) must not change.
 *
 * 2. **Parameter parity** — for every known optional parameter, fire the same
 *    request with and without it and record whether the output changes.
 *    The result is snapshotted as a parity matrix:
 *
 *      { "read:start/end": "ignored", "search:max": "ignored", ... }
 *
 *    When codedb is updated and a parameter starts (or stops) working, the
 *    snapshot changes → test fails → pi-codedb must be updated to match.
 *
 * Prerequisites:
 *   - codedb server running on localhost:7719 with a valid project indexed
 *   - Set CODEDB_PROJECT env var for project-scoped queries
 */

import { describe, it, expect, beforeAll } from "vitest";

const CODEDB_BASE = process.env.CODEDB_URL ?? "http://localhost:7719";
const CODEDB_PROJECT = process.env.CODEDB_PROJECT ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUrl(path: string): string {
  if (!CODEDB_PROJECT || path === "/health") return `${CODEDB_BASE}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${CODEDB_BASE}${path}${sep}project=${encodeURIComponent(CODEDB_PROJECT)}`;
}

async function fetchJSON(path: string): Promise<unknown> {
  const res = await fetch(buildUrl(path), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

/** Fetch without project param — used by parity tests to avoid cross-project interference. */
async function fetchRaw(path: string): Promise<unknown> {
  const res = await fetch(`${CODEDB_BASE}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "empty_array" : [shape(value[0])];
  }
  if (typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = shape(v);
    }
    return obj;
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// Shape test endpoints
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  { name: "health", path: "/health" },
  { name: "seq", path: "/seq" },
  { name: "tree", path: "/explore/tree" },
  { name: "outline", path: "/explore/outline?path=package.json" },
  { name: "symbol", path: "/explore/symbol?name=default" },
  { name: "search", path: "/explore/search?q=codedb" },
  { name: "word", path: "/explore/word?q=codedb" },
  { name: "hot", path: "/explore/hot" },
  { name: "deps", path: "/explore/deps?path=package.json" },
  { name: "read", path: "/file/read?path=package.json" },
  { name: "changes", path: "/changes" },
  { name: "snapshot", path: "/snapshot" },
] as const;

// ---------------------------------------------------------------------------
// Parameter parity probes
//
// Each probe fires a baseline request and a variant with the param applied,
// then compares them with a param-specific comparator.
//
// `compare` returns "effective" if the param changed the output, "ignored" otherwise.
// ---------------------------------------------------------------------------

interface ParityProbe {
  name: string;
  baseline: string;
  withParam: string;
  compare: (baseline: unknown, withParam: unknown) => "effective" | "ignored";
}

const lineCount = (s: string) => s.split("\n").length;
const keySet = (r: Record<string, unknown>) => Object.keys(r).sort().join(",");

const PARITY_PROBES: ParityProbe[] = [
  {
    name: "read:start+end",
    baseline: "/file/read?path=package.json",
    withParam: "/file/read?path=package.json&start=1&end=3",
    compare: (a, b) => {
      const la = lineCount((a as { content: string }).content);
      const lb = lineCount((b as { content: string }).content);
      return lb <= 3 && lb < la ? "effective" : "ignored";
    },
  },
  {
    name: "read:compact",
    baseline: "/file/read?path=package.json",
    withParam: "/file/read?path=package.json&compact=true",
    compare: (a, b) => {
      const la = lineCount((a as { content: string }).content);
      const lb = lineCount((b as { content: string }).content);
      return lb < la ? "effective" : "ignored";
    },
  },
  {
    name: "read:if_hash",
    baseline: "/file/read?path=package.json",
    withParam: "/file/read?path=package.json&if_hash=abc123",
    compare: (a, b) => {
      const ka = keySet(a as Record<string, unknown>);
      const kb = keySet(b as Record<string, unknown>);
      return ka !== kb ? "effective" : "ignored";
    },
  },
  {
    name: "search:max",
    baseline: "/explore/search?q=import",
    withParam: "/explore/search?q=import&max=2",
    compare: (_a, b) => {
      const results = (b as { results: unknown[] }).results;
      return results.length <= 2 ? "effective" : "ignored";
    },
  },
  {
    name: "search:scope",
    baseline: "/explore/search?q=ensureServer",
    withParam: "/explore/search?q=ensureServer&scope=true",
    compare: (a, b) => {
      const ra = (a as { results: Array<Record<string, unknown>> }).results;
      const rb = (b as { results: Array<Record<string, unknown>> }).results;
      if (ra.length === 0 || rb.length === 0) return "ignored";
      return keySet(ra[0]) !== keySet(rb[0]) ? "effective" : "ignored";
    },
  },
  {
    name: "search:compact",
    baseline: "/explore/search?q=import",
    withParam: "/explore/search?q=import&compact=true",
    compare: (a, b) => {
      const la = (a as { results: unknown[] }).results.length;
      const lb = (b as { results: unknown[] }).results.length;
      return la !== lb ? "effective" : "ignored";
    },
  },
  {
    name: "search:regex",
    baseline: "/explore/search?q=function.*Server",
    withParam: "/explore/search?q=function.*Server&regex=true",
    compare: (a, b) => {
      const la = (a as { results: unknown[] }).results.length;
      const lb = (b as { results: unknown[] }).results.length;
      return la !== lb ? "effective" : "ignored";
    },
  },
  {
    name: "outline:compact",
    baseline: "/explore/outline?path=package.json",
    withParam: "/explore/outline?path=package.json&compact=true",
    compare: (a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa !== sb ? "effective" : "ignored";
    },
  },
  {
    name: "symbol:body",
    baseline: "/explore/symbol?name=textResult",
    withParam: "/explore/symbol?name=textResult&body=true",
    compare: (a, b) => {
      const ra = (a as { results: Array<Record<string, unknown>> }).results;
      const rb = (b as { results: Array<Record<string, unknown>> }).results;
      if (ra.length === 0 || rb.length === 0) return "ignored";
      return keySet(ra[0]) !== keySet(rb[0]) ? "effective" : "ignored";
    },
  },
  {
    name: "hot:limit",
    baseline: "/explore/hot",
    withParam: "/explore/hot?limit=2",
    compare: (_a, b) => {
      const files = (b as { files: string[] }).files;
      return files.length <= 2 ? "effective" : "ignored";
    },
  },
  {
    name: "changes:since",
    baseline: "/changes",
    withParam: "/changes?since=0",
    compare: (_a, b) => {
      return (b as Record<string, unknown>).since !== undefined ? "effective" : "ignored";
    },
  },
];

// ---------------------------------------------------------------------------
// Server readiness gate
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    await fetch(`${CODEDB_BASE}/health`, { signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new Error(
      `codedb server not reachable at ${CODEDB_BASE}. ` +
        `Start it with: codedb serve <project-path>`,
    );
  }
});

// ---------------------------------------------------------------------------
// Suite 1: Shape snapshots
// ---------------------------------------------------------------------------

describe("codedb API contract (snapshot)", () => {
  for (const ep of ENDPOINTS) {
    it(`${ep.name} response shape`, async () => {
      const data = await fetchJSON(ep.path);
      expect(shape(data)).toMatchSnapshot();
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 2: Parameter parity matrix
//
// Runs all probes, builds a { name → "effective"|"ignored" } map, and
// snapshots it. Any change in codedb's parameter handling flips a value
// and breaks the snapshot.
// ---------------------------------------------------------------------------

describe("codedb REST parameter parity matrix", () => {
  it("parameter support status", async () => {
    const matrix: Record<string, string> = {};
    for (const probe of PARITY_PROBES) {
      // Use fetchRaw (no project param) to avoid cross-project interference
      const [baseline, withParam] = await Promise.all([
        fetchRaw(probe.baseline),
        fetchRaw(probe.withParam),
      ]);
      matrix[probe.name] = probe.compare(baseline, withParam);
    }
    expect(matrix).toMatchSnapshot();
  });
});
