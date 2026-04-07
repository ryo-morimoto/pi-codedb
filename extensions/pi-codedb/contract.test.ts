/**
 * Contract tests for the codedb MCP API (JSON-RPC 2.0 over stdio).
 *
 * Two suites:
 *
 * 1. **Response contract** — each tool returns non-empty content with the
 *    expected block structure.
 *
 * 2. **Parameter parity** — optional parameters are snapshotted as
 *    "effective" or "ignored". When codedb updates parameter handling,
 *    the snapshot breaks → pi-codedb must be updated to match.
 *
 * Prerequisites:
 *   - codedb binary available in PATH (or set CODEDB_PATH)
 *   - Set CODEDB_PROJECT env var to the project root to index
 */

import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CODEDB_PROJECT = process.env.CODEDB_PROJECT || process.cwd();
const CODEDB_BIN = process.env.CODEDB_PATH || "codedb";

// ---------------------------------------------------------------------------
// MCP stdio client
// ---------------------------------------------------------------------------

let mcpProcess: ChildProcess | null = null;
let lineBuffer = "";
let rpcIdCounter = 0;
const pendingRequests = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function spawnMcp(): ChildProcess {
  const child = spawn(CODEDB_BIN, [CODEDB_PROJECT, "mcp", "--no-telemetry"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CODEDB_NO_TELEMETRY: "1" },
  });

  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    lineBuffer += chunk;
    let idx: number;
    while ((idx = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, idx).trim();
      lineBuffer = lineBuffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const p = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        /* non-JSON log line */
      }
    }
  });

  child.on("exit", () => {
    for (const [id, p] of pendingRequests) {
      p.reject(new Error("codedb exited"));
      pendingRequests.delete(id);
    }
  });

  return child;
}

function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!mcpProcess?.stdin?.writable) return Promise.reject(new Error("no mcp"));
  const id = ++rpcIdCounter;
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method, id };
  if (params) msg.params = params;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 30_000);
    pendingRequests.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    mcpProcess!.stdin!.write(JSON.stringify(msg) + "\n");
  });
}

// ---------------------------------------------------------------------------
// MCP tool call helpers
// ---------------------------------------------------------------------------

/** Raw MCP result preserving all content blocks. */
interface McpResult {
  content: Array<{ type: string; text: string }>;
}

/** Call a tool and return the raw MCP result. */
async function callRaw(tool: string, args: Record<string, unknown> = {}): Promise<McpResult> {
  const r = (await rpc("tools/call", {
    name: tool,
    arguments: args,
  })) as McpResult;
  return { content: r?.content ?? [] };
}

/** Extract the data block (block index 1 when multi-block, 0 when single). */
function dataBlock(result: McpResult): string {
  const blocks = result.content.filter((c) => c.type === "text");
  if (blocks.length === 0) return "";
  return blocks.length > 1 ? blocks[1].text : blocks[0].text;
}

/** Number of lines in a string. */
const lines = (s: string) => s.split("\n").length;

// ---------------------------------------------------------------------------
// Lifecycle — start MCP, handshake, wait for index
// ---------------------------------------------------------------------------

beforeAll(async () => {
  mcpProcess = spawnMcp();
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0.0" },
  });
  mcpProcess.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

  // Poll until indexed
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = await callRaw("codedb_status");
    if (dataBlock(r).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}, 20_000);

afterAll(() => {
  try {
    mcpProcess?.kill("SIGTERM");
  } catch {
    /* */
  }
  mcpProcess = null;
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Response contract
//
// Each test: Arrange (define args) → Act (call tool) → Assert (check response)
// ═══════════════════════════════════════════════════════════════════════════

describe("codedb MCP response contract", () => {
  it("codedb_status returns seq and file count", async () => {
    // Arrange — no args needed

    // Act
    const result = await callRaw("codedb_status");

    // Assert
    const text = dataBlock(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/seq|indexed|files/i);
  });

  it("codedb_tree returns file listing with line counts", async () => {
    const result = await callRaw("codedb_tree");

    const text = dataBlock(result);
    expect(text).toContain("package.json");
    expect(text).toMatch(/\d+L/); // e.g. "45L"
  });

  it("codedb_outline returns symbols for a known file", async () => {
    const result = await callRaw("codedb_outline", {
      path: "extensions/pi-codedb/index.ts",
    });

    const text = dataBlock(result);
    expect(text).toContain("index.ts");
    expect(text).toMatch(/function|constant|import/i);
  });

  it("codedb_symbol finds a known symbol", async () => {
    const result = await callRaw("codedb_symbol", { name: "textResult" });

    const text = dataBlock(result);
    expect(text).toContain("textResult");
    expect(text).toContain("index.ts");
  });

  it("codedb_search returns matching lines", async () => {
    const result = await callRaw("codedb_search", { query: "codedb" });

    const text = dataBlock(result);
    expect(text.length).toBeGreaterThan(0);
    expect(lines(text)).toBeGreaterThan(1);
  });

  it("codedb_word returns exact identifier hits", async () => {
    const result = await callRaw("codedb_word", { word: "spawn" });

    const text = dataBlock(result);
    expect(text).toContain("index.ts");
  });

  it("codedb_hot returns recently modified files", async () => {
    const result = await callRaw("codedb_hot");

    const text = dataBlock(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it("codedb_deps returns dependency info", async () => {
    const result = await callRaw("codedb_deps", {
      path: "extensions/pi-codedb/index.ts",
    });

    const text = dataBlock(result);
    // index.ts is imported by contract.test.ts (or no importers)
    expect(text.length).toBeGreaterThan(0);
  });

  it("codedb_read returns file content", async () => {
    const result = await callRaw("codedb_read", { path: "package.json" });

    const text = dataBlock(result);
    expect(text).toContain('"name"');
    expect(lines(text)).toBeGreaterThan(5);
  });

  it("codedb_changes returns change entries", async () => {
    const result = await callRaw("codedb_changes");

    const text = dataBlock(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it("codedb_snapshot returns full codebase data", async () => {
    const result = await callRaw("codedb_snapshot");

    const text = dataBlock(result);
    const data = JSON.parse(text);
    expect(data).toHaveProperty("tree");
    expect(data).toHaveProperty("outlines");
    expect(data).toHaveProperty("symbol_index");
    expect(data).toHaveProperty("dep_graph");
    expect(data).toHaveProperty("seq");
  });

  it("codedb_tree with project param works for cross-project queries", async () => {
    const result = await callRaw("codedb_tree", { project: CODEDB_PROJECT });

    const text = dataBlock(result);
    expect(text).toContain("package.json");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Parameter parity matrix
//
// For each optional parameter, compare baseline vs with-param responses.
// Snapshot the matrix so codedb upgrades surface behavioral changes.
// ═══════════════════════════════════════════════════════════════════════════

describe("codedb MCP parameter parity", () => {
  it("read:line_start+line_end limits output lines", async () => {
    // Arrange
    const baselineArgs = { path: "package.json" };
    const paramArgs = { path: "package.json", line_start: 1, line_end: 3 };

    // Act
    const [baseline, withParam] = await Promise.all([
      callRaw("codedb_read", baselineArgs).then(dataBlock),
      callRaw("codedb_read", paramArgs).then(dataBlock),
    ]);

    // Assert — MCP read adds a hash header + line-number prefixes,
    // so 3 content lines become ~5 output lines
    expect(lines(withParam)).toBeLessThan(lines(baseline));
  });

  it("search:max_results limits result count", async () => {
    const [baseline, withParam] = await Promise.all([
      callRaw("codedb_search", { query: "import" }).then(dataBlock),
      callRaw("codedb_search", { query: "import", max_results: 2 }).then(dataBlock),
    ]);

    expect(lines(withParam)).toBeLessThan(lines(baseline));
  });

  it("search:scope annotates results with enclosing symbol", async () => {
    const [baseline, withParam] = await Promise.all([
      callRaw("codedb_search", { query: "ensureServer" }).then(dataBlock),
      callRaw("codedb_search", { query: "ensureServer", scope: true }).then(dataBlock),
    ]);

    expect(withParam).not.toEqual(baseline);
  });

  it("search:regex enables regex matching", async () => {
    const [baseline, withParam] = await Promise.all([
      callRaw("codedb_search", { query: "function.*Server" }).then(dataBlock),
      callRaw("codedb_search", { query: "function.*Server", regex: true }).then(dataBlock),
    ]);

    expect(withParam).not.toEqual(baseline);
  });

  it("symbol:body includes source code", async () => {
    const [baseline, withParam] = await Promise.all([
      callRaw("codedb_symbol", { name: "textResult" }).then(dataBlock),
      callRaw("codedb_symbol", { name: "textResult", body: true }).then(dataBlock),
    ]);

    expect(withParam).not.toEqual(baseline);
    expect(withParam.length).toBeGreaterThan(baseline.length);
  });

  it("hot:limit restricts file count", async () => {
    const [baseline, withParam] = await Promise.all([
      callRaw("codedb_hot", {}).then(dataBlock),
      callRaw("codedb_hot", { limit: 2 }).then(dataBlock),
    ]);

    expect(lines(withParam)).toBeLessThanOrEqual(lines(baseline));
  });

  // Snapshot the full parity matrix for regression detection
  it("parity matrix snapshot", async () => {
    const probes = [
      {
        name: "read:line_start+line_end",
        tool: "codedb_read",
        base: { path: "package.json" },
        param: { path: "package.json", line_start: 1, line_end: 3 },
      },
      {
        name: "read:compact",
        tool: "codedb_read",
        base: { path: "package.json" },
        param: { path: "package.json", compact: true },
      },
      {
        name: "read:if_hash",
        tool: "codedb_read",
        base: { path: "package.json" },
        param: { path: "package.json", if_hash: "abc123" },
      },
      {
        name: "search:max_results",
        tool: "codedb_search",
        base: { query: "import" },
        param: { query: "import", max_results: 2 },
      },
      {
        name: "search:scope",
        tool: "codedb_search",
        base: { query: "ensureServer" },
        param: { query: "ensureServer", scope: true },
      },
      {
        name: "search:compact",
        tool: "codedb_search",
        base: { query: "import" },
        param: { query: "import", compact: true },
      },
      {
        name: "search:regex",
        tool: "codedb_search",
        base: { query: "function.*Server" },
        param: { query: "function.*Server", regex: true },
      },
      {
        name: "outline:compact",
        tool: "codedb_outline",
        base: { path: "package.json" },
        param: { path: "package.json", compact: true },
      },
      {
        name: "symbol:body",
        tool: "codedb_symbol",
        base: { name: "textResult" },
        param: { name: "textResult", body: true },
      },
      { name: "hot:limit", tool: "codedb_hot", base: {}, param: { limit: 2 } },
      {
        name: "changes:since",
        tool: "codedb_changes",
        base: {},
        param: { since: 0 },
      },
    ] as const;

    const matrix: Record<string, "effective" | "ignored"> = {};
    for (const p of probes) {
      const [a, b] = await Promise.all([
        callRaw(p.tool, { ...p.base }).then(dataBlock),
        callRaw(p.tool, { ...p.param }).then(dataBlock),
      ]);
      matrix[p.name] = a !== b ? "effective" : "ignored";
    }

    expect(matrix).toMatchSnapshot();
  });
});
