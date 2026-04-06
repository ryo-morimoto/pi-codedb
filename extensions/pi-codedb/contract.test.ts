/**
 * Contract tests for the codedb REST API.
 *
 * Purpose: Detect breaking changes when codedb server is updated.
 * Strategy: Snapshot each endpoint's response **shape** (keys + value types),
 *           stripping volatile data so only structural changes cause failures.
 *
 * Workflow:
 *   1. Initial run:  `npx vitest run --update` to capture baseline snapshots
 *   2. After update: `npx vitest run` — any structural diff = contract break
 *   3. If intentional: `npx vitest run --update` to accept the new contract
 *
 * Prerequisites:
 *   - codedb server running on localhost:7719 with a valid project indexed
 */

import { describe, it, expect, beforeAll } from "vitest";

const CODEDB_BASE = process.env.CODEDB_URL ?? "http://localhost:7719";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJSON(path: string): Promise<unknown> {
  const res = await fetch(`${CODEDB_BASE}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Recursively extract the "shape" of a value: keys and types only.
 * Arrays are collapsed to their first element's shape (or "empty_array").
 * Strings/numbers/booleans become their type name.
 */
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
  return typeof value; // "string" | "number" | "boolean"
}

// ---------------------------------------------------------------------------
// Endpoints to test
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  { name: "health",  path: "/health" },
  { name: "seq",     path: "/seq" },
  { name: "tree",    path: "/explore/tree" },
  { name: "outline", path: "/explore/outline?path=package.json" },
  { name: "symbol",  path: "/explore/symbol?name=default" },
  { name: "search",  path: "/explore/search?q=codedb&max=3" },
  { name: "word",    path: "/explore/word?q=codedb" },
  { name: "hot",     path: "/explore/hot?limit=3" },
  { name: "deps",    path: "/explore/deps?path=package.json" },
  { name: "read",    path: "/file/read?path=package.json&start=1&end=3" },
] as const;

// ---------------------------------------------------------------------------
// Server readiness gate
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    await fetch(`${CODEDB_BASE}/health`, { signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new Error(
      `codedb server not reachable at ${CODEDB_BASE}. ` +
        `Start it with: codedb serve <project-path>`
    );
  }
});

// ---------------------------------------------------------------------------
// Snapshot tests — response shape must not change across versions
// ---------------------------------------------------------------------------

describe("codedb API contract (snapshot)", () => {
  for (const ep of ENDPOINTS) {
    it(`${ep.name} response shape`, async () => {
      const data = await fetchJSON(ep.path);
      expect(shape(data)).toMatchSnapshot();
    });
  }
});
