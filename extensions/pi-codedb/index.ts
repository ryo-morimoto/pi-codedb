/**
 * pi-codedb — Pi Extension
 *
 * Code intelligence via codedb REST API.
 *
 * Design: Cloudflare Dynamic Workers pattern
 * - TypeScript interfaces as compact API surface (token-efficient for LLM context)
 * - Capability-based: agent receives typed env bindings, not raw HTTP endpoints
 * - Context embedding: project path & server URL flow through typed CodeDB interface
 *
 * Provides:
 * - `codedb_tree` tool — file tree with language, line counts, symbol counts
 * - `codedb_outline` tool — symbols in a file (functions, structs, imports)
 * - `codedb_symbol` tool — find where a symbol is defined across the codebase
 * - `codedb_search` tool — trigram-accelerated full-text search
 * - `codedb_word` tool — O(1) inverted index word lookup
 * - `codedb_hot` tool — recently modified files
 * - `codedb_deps` tool — reverse dependency graph
 * - `codedb_read` tool — read file content with line ranges
 * - `codedb_status` tool — index status (health + sequence number)
 * - Status bar showing codedb server state
 * - System prompt with TypeScript type definitions for efficient context
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CODEDB_PORT = 7719;
const CODEDB_BASE = `http://localhost:${CODEDB_PORT}`;
const STARTUP_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 300;

// ---------------------------------------------------------------------------
// TypeScript type definitions as API surface (Dynamic Workers pattern)
//
// These types serve dual purpose:
// 1. Runtime: guide tool parameter validation
// 2. Context: injected into system prompt as compact API docs
//    (~20 tokens per method vs ~200 tokens for equivalent OpenAPI spec)
// ---------------------------------------------------------------------------

/**
 * CodeDB API surface — TypeScript interface as the agent's view of capabilities.
 * Injected into system prompt so the LLM understands available operations
 * without verbose tool descriptions eating context window.
 */
const CODEDB_TYPE_DEFS = `\
interface CodeDB {
  tree(): Promise<{ tree: string }>;
  outline(path: string): Promise<{ path: string; language: string; lines: number; bytes: number; symbols: Symbol[] }>;
  symbol(name: string): Promise<{ name: string; results: SymbolHit[] }>;
  search(query: string, max?: number): Promise<{ query: string; results: SearchHit[] }>;
  word(word: string): Promise<{ query: string; hits: WordHit[] }>;
  hot(limit?: number): Promise<{ files: string[] }>;
  deps(path: string): Promise<{ path: string; imported_by: string[] }>;
  read(path: string, startLine?: number, endLine?: number): Promise<{ path: string; content: string; size: number }>;
  status(): Promise<{ status: string; seq: number }>;
}

interface Symbol { name: string; kind: string; line: number; end_line?: number }
interface SymbolHit { path: string; line: number; kind: string; detail?: string }
interface SearchHit { path: string; line: number; text: string }
interface WordHit { path: string; line: number }
`;

const CODEDB_SYSTEM_PROMPT = [
  "## CodeDB — Code Intelligence",
  "",
  "You have access to a code intelligence server via the `codedb_*` tools.",
  "The API surface is defined by these TypeScript types:",
  "",
  "```typescript",
  CODEDB_TYPE_DEFS.trim(),
  "```",
  "",
  "Use `codedb_tree` first to understand the project structure, then drill into files with `codedb_outline` and `codedb_symbol`.",
  "For text search use `codedb_search` (trigram, supports regex). For exact identifier lookup use `codedb_word` (O(1) inverted index).",
].join("\n");

// ---------------------------------------------------------------------------
// Helper: wrap a string as AgentToolResult
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

// ---------------------------------------------------------------------------
// HTTP client — thin fetch wrapper for codedb REST API
// ---------------------------------------------------------------------------

async function codedbFetch(path: string, timeout = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${CODEDB_BASE}${path}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`codedb ${res.status}: ${body}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function codedbGet(path: string): Promise<unknown> {
  const text = await codedbFetch(path);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;

async function ensureServer(projectPath: string): Promise<boolean> {
  // Check if already running
  try {
    await codedbFetch("/health", 2000);
    return true;
  } catch {
    // Not running, start it
  }

  const codedbBin = process.env.CODEDB_PATH || "codedb";
  serverProcess = spawn(codedbBin, ["serve", projectPath], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, CODEDB_NO_TELEMETRY: "1" },
  });
  serverProcess.unref();

  // Wait for health
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await codedbFetch("/health", 2000);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
  }
  return false;
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (api: ExtensionAPI, context: ExtensionContext) {
  let serverReady = false;

  // ── Lifecycle: start codedb on agent start, inject system prompt ──
  api.on("before_agent_start", async () => {
    const projectPath = context.cwd || process.cwd();
    serverReady = await ensureServer(projectPath);
    if (serverReady) {
      context.ui.setStatus("codedb", "codedb: ready");
      return { systemPrompt: CODEDB_SYSTEM_PROMPT };
    }
    context.ui.setStatus("codedb", "codedb: offline");
    return undefined;
  });

  api.on("session_shutdown", () => {
    stopServer();
  });

  // ── Tools ──

  api.registerTool({
    name: "codedb_tree",
    label: "CodeDB Tree",
    description: "File tree with language, line counts, and symbol counts",
    parameters: Type.Object({}),
    execute: async () => {
      const data = (await codedbGet("/explore/tree")) as { tree: string };
      const result = truncateTail(data.tree, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return textResult(result.content);
    },
  });

  api.registerTool({
    name: "codedb_outline",
    label: "CodeDB Outline",
    description: "Symbols in a file: functions, structs, imports with line numbers",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to project root" }),
    }),
    execute: async (_toolCallId, params) => {
      const data = await codedbGet(`/explore/outline?path=${encodeURIComponent(params.path)}`);
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_symbol",
    label: "CodeDB Symbol",
    description: "Find where a symbol is defined across the codebase",
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name to search for" }),
    }),
    execute: async (_toolCallId, params) => {
      const data = await codedbGet(`/explore/symbol?name=${encodeURIComponent(params.name)}`);
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_search",
    label: "CodeDB Search",
    description: "Trigram-accelerated full-text search (supports regex)",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    execute: async (_toolCallId, params) => {
      const max = params.max ?? 20;
      const data = await codedbGet(
        `/explore/search?q=${encodeURIComponent(params.query)}&max=${max}`,
      );
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_word",
    label: "CodeDB Word",
    description: "O(1) inverted index word lookup — exact identifier match",
    parameters: Type.Object({
      word: Type.String({ description: "Exact word/identifier to look up" }),
    }),
    execute: async (_toolCallId, params) => {
      const data = await codedbGet(`/explore/word?q=${encodeURIComponent(params.word)}`);
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_hot",
    label: "CodeDB Hot",
    description: "Recently modified files",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max files to return" })),
    }),
    execute: async (_toolCallId, params) => {
      const q = params.limit ? `?limit=${params.limit}` : "";
      const data = await codedbGet(`/explore/hot${q}`);
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_deps",
    label: "CodeDB Deps",
    description: "Reverse dependency graph — which files import this file",
    parameters: Type.Object({
      path: Type.String({ description: "File path to check dependents of" }),
    }),
    execute: async (_toolCallId, params) => {
      const data = await codedbGet(`/explore/deps?path=${encodeURIComponent(params.path)}`);
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_read",
    label: "CodeDB Read",
    description: "Read file content, optionally by line range",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to project root" }),
      start_line: Type.Optional(Type.Number({ description: "Start line (1-based)" })),
      end_line: Type.Optional(Type.Number({ description: "End line (1-based)" })),
    }),
    execute: async (_toolCallId, params) => {
      let q = `path=${encodeURIComponent(params.path)}`;
      if (params.start_line) q += `&start=${params.start_line}`;
      if (params.end_line) q += `&end=${params.end_line}`;
      const data = await codedbGet(`/file/read?${q}`);
      return textResult(JSON.stringify(data, null, 2));
    },
  });

  api.registerTool({
    name: "codedb_status",
    label: "CodeDB Status",
    description: "Index status: health check and current sequence number",
    parameters: Type.Object({}),
    execute: async () => {
      const [health, seq] = await Promise.all([
        codedbFetch("/health").catch(() => '{"status":"error"}'),
        codedbFetch("/seq").catch(() => '{"seq":-1}'),
      ]);
      return textResult(
        JSON.stringify({ health: JSON.parse(health), seq: JSON.parse(seq) }, null, 2),
      );
    },
  });
}
