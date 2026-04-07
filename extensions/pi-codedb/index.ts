/**
 * pi-codedb — Pi Extension
 *
 * Code intelligence via codedb REST API.
 *
 * Design: Cloudflare Dynamic Workers pattern
 * - TypeScript interfaces as compact API surface (token-efficient for LLM context)
 * - Capability-based: agent receives typed env bindings, not raw HTTP endpoints
 * - Context embedding: project path & server URL flow through typed CodeDB interface
 * - Project-scoped: all queries include project path to avoid cross-project contamination
 *
 * Only parameters verified via e2e tests (contract.test.ts) are exposed.
 * See the parameter parity matrix snapshot for current REST API support status.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CODEDB_BASE = "http://localhost:7719";
const STARTUP_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 300;

// ---------------------------------------------------------------------------
// Module state — project path scoped per session
// ---------------------------------------------------------------------------
let currentProjectPath = "";

// ---------------------------------------------------------------------------
// System prompt — injected once per agent turn, includes API type definitions
// ---------------------------------------------------------------------------

const CODEDB_SYSTEM_PROMPT = `\
## CodeDB — Code Intelligence (PREFERRED over built-in tools)

You have a code intelligence server via \`codedb_*\` tools. These are **faster and more token-efficient** than built-in alternatives.

### MANDATORY: Use codedb tools instead of built-in equivalents

| Task | Use this | NOT this |
|------|----------|----------|
| Read file | \`codedb_read\` | \`read\` tool / \`cat\` / \`head\` |
| Search text | \`codedb_search\` | \`grep\` tool / \`rg\` / \`bash grep\` |
| Find identifier | \`codedb_word\` | \`grep\` for exact word |
| Find definition | \`codedb_symbol\` | \`grep\` for function name |
| List files | \`codedb_tree\` | \`ls\` / \`find\` / \`glob\` |
| File structure | \`codedb_outline\` | reading entire file |
| File dependencies | \`codedb_deps\` | manual import tracing |

### Why codedb is better
- **\`codedb_outline\`**: Returns symbols with line numbers — 4-15x fewer tokens than reading the raw file
- **\`codedb_search\`**: Trigram-accelerated, pre-indexed — faster than grep on large codebases
- **\`codedb_word\`**: O(1) inverted index lookup — instant for exact identifiers
- **\`codedb_changes\`**: Track file changes incrementally by sequence number

### Workflow
1. \`codedb_tree\` first to understand project structure
2. \`codedb_outline\` on key files (BEFORE reading them — understand structure first)
3. \`codedb_symbol\` or \`codedb_word\` to trace identifiers
4. \`codedb_search\` for broader text patterns
5. \`codedb_read\` when you need actual file content
6. \`codedb_deps\` before modifying a file to understand impact

### API Types

\`\`\`typescript
interface CodeDB {
  tree(): Promise<{ tree: string }>;
  outline(path: string): Promise<{ path: string; language: string; lines: number; bytes: number; symbols: Symbol[] }>;
  symbol(name: string): Promise<{ name: string; results: SymbolHit[] }>;
  search(query: string): Promise<{ query: string; results: SearchHit[] }>;
  word(word: string): Promise<{ query: string; hits: WordHit[] }>;
  hot(): Promise<{ files: string[] }>;
  deps(path: string): Promise<{ path: string; imported_by: string[] }>;
  read(path: string): Promise<{ path: string; content: string; size: number }>;
  status(): Promise<{ status: string; seq: number }>;
  changes(since?: number): Promise<{ since: number; seq: number; changes: Change[] }>;
  snapshot(): Promise<object>;
}

interface Symbol { name: string; kind: string; line: number; end_line?: number }
interface SymbolHit { path: string; line: number; kind: string; detail?: string }
interface SearchHit { path: string; line: number; text: string }
interface WordHit { path: string; line: number }
interface Change { path: string; seq: number; op: string; size: number; timestamp: number }
\`\`\``;

// ---------------------------------------------------------------------------
// Helper: wrap a string as AgentToolResult with timing metadata
// ---------------------------------------------------------------------------

function textResult(text: string, durationMs: number, endpoint: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { durationMs, endpoint },
  };
}

// ---------------------------------------------------------------------------
// HTTP client — thin fetch wrapper for codedb REST API
// ---------------------------------------------------------------------------

async function codedbFetch(path: string, timeout = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const separator = path.includes("?") ? "&" : "?";
    const url =
      currentProjectPath && !path.startsWith("/health")
        ? `${CODEDB_BASE}${path}${separator}project=${encodeURIComponent(currentProjectPath)}`
        : `${CODEDB_BASE}${path}`;
    const res = await fetch(url, { signal: controller.signal });
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
  return JSON.parse(await codedbFetch(path));
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;

async function ensureServer(projectPath: string): Promise<boolean> {
  try {
    await codedbFetch("/health", 2000);
    return true;
  } catch {
    // Not running, start one
  }

  const codedbBin = process.env.CODEDB_PATH || "codedb";
  serverProcess = spawn(codedbBin, ["serve", projectPath], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, CODEDB_NO_TELEMETRY: "1" },
  });
  serverProcess.unref();

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
// Tool steering — guide agent to prefer codedb over built-in tools
// ---------------------------------------------------------------------------

const STEERING_MAP: Record<string, string> = {
  read: "Tip: Use `codedb_outline` first to understand file structure (4-15x fewer tokens), then `codedb_read` for content.",
  grep: "Tip: `codedb_search` is trigram-accelerated and pre-indexed. For exact identifiers, `codedb_word` is O(1).",
  find: "Tip: `codedb_tree` shows the full file tree with language detection and symbol counts.",
  ls: "Tip: `codedb_tree` provides a complete file tree with metadata.",
};

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let serverReady = false;
  let warmupPromise: Promise<boolean> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const projectPath = ctx.cwd || process.cwd();
    currentProjectPath = projectPath;
    ctx.ui.setStatus("codedb", "codedb: starting...");
    warmupPromise = ensureServer(projectPath);
    serverReady = await warmupPromise;
    warmupPromise = null;
    ctx.ui.setStatus(
      "codedb",
      serverReady ? `codedb: ready (${projectPath.split("/").pop()})` : "codedb: offline",
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const projectPath = ctx.cwd || process.cwd();
    if (projectPath !== currentProjectPath) {
      currentProjectPath = projectPath;
      serverReady = await ensureServer(projectPath);
    }
    if (warmupPromise) {
      serverReady = await warmupPromise;
    }
    if (serverReady) {
      ctx.ui.setStatus("codedb", `codedb: ready (${projectPath.split("/").pop()})`);
      return { systemPrompt: event.systemPrompt + "\n\n" + CODEDB_SYSTEM_PROMPT };
    }
    ctx.ui.setStatus("codedb", "codedb: offline");
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    stopServer();
  });

  pi.on("tool_call", async (event) => {
    const hint = STEERING_MAP[event.toolName];
    if (hint && serverReady) {
      return { block: false, reason: hint };
    }
    return undefined;
  });

  pi.registerCommand("codedb", {
    description: "CodeDB status and reindex",
    handler: async (_args, ctx) => {
      const projectPath = currentProjectPath || ctx.cwd || process.cwd();
      currentProjectPath = projectPath;
      ctx.ui.setStatus("codedb", "codedb: reindexing...");

      const ok = await ensureServer(projectPath);
      if (ok) {
        const [health, seq] = await Promise.all([
          codedbFetch("/health").catch(() => '{"status":"error"}'),
          codedbFetch("/seq").catch(() => '{"seq":-1}'),
        ]);
        ctx.ui.setStatus("codedb", `codedb: ready (${projectPath.split("/").pop()})`);
        pi.sendMessage(
          {
            customType: "codedb-status",
            content: `CodeDB status: ${health}\nSequence: ${seq}\nProject: ${projectPath}`,
            display: true,
            details: undefined,
          },
          { triggerTurn: false },
        );
      } else {
        ctx.ui.setStatus("codedb", "codedb: offline");
        pi.sendMessage(
          {
            customType: "codedb-status",
            content: "CodeDB: failed to start server",
            display: true,
            details: undefined,
          },
          { triggerTurn: false },
        );
      }
    },
    getArgumentCompletions: () => [],
  });

  // ── Tools ──

  pi.registerTool({
    name: "codedb_tree",
    label: "CodeDB Tree",
    description:
      "File tree with language, line counts, and symbol counts. Start here to understand project structure.",
    promptSnippet: "codedb_tree — full file tree with language detection, line/symbol counts",
    promptGuidelines: [
      "Use codedb_tree instead of ls, find, or glob to explore the project file structure.",
    ],
    parameters: Type.Object({}),
    execute: async () => {
      const start = Date.now();
      const data = (await codedbGet("/explore/tree")) as { tree: string };
      const result = truncateTail(data.tree, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return textResult(result.content, Date.now() - start, "/explore/tree");
    },
  });

  pi.registerTool({
    name: "codedb_outline",
    label: "CodeDB Outline",
    description:
      "Symbols in a file: functions, structs, imports with line numbers. 4-15x fewer tokens than reading the raw file. ALWAYS use this before codedb_read.",
    promptSnippet: "codedb_outline <path> — file symbols (4-15x fewer tokens than reading)",
    promptGuidelines: ["ALWAYS call codedb_outline before codedb_read on any file."],
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to project root" }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const data = await codedbGet(`/explore/outline?path=${encodeURIComponent(params.path)}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/explore/outline");
    },
  });

  pi.registerTool({
    name: "codedb_symbol",
    label: "CodeDB Symbol",
    description:
      "Find where a symbol is defined across the codebase. More precise than search — returns only definitions, not references.",
    promptSnippet: "codedb_symbol <name> — find symbol definitions across codebase",
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name to search for" }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const data = await codedbGet(`/explore/symbol?name=${encodeURIComponent(params.name)}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/explore/symbol");
    },
  });

  pi.registerTool({
    name: "codedb_search",
    label: "CodeDB Search",
    description:
      "Trigram-accelerated full-text search. Returns up to 50 matching lines with file paths and line numbers. For single identifiers, prefer codedb_word (O(1)).",
    promptSnippet: "codedb_search <query> — trigram full-text search (up to 50 results)",
    promptGuidelines: ["Use codedb_search instead of grep for text search."],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (substring match)" }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const data = await codedbGet(`/explore/search?q=${encodeURIComponent(params.query)}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/explore/search");
    },
  });

  pi.registerTool({
    name: "codedb_word",
    label: "CodeDB Word",
    description:
      "O(1) inverted index word lookup — exact identifier match. Much faster than search for single-word queries.",
    promptSnippet: "codedb_word <word> — O(1) exact word lookup via inverted index",
    promptGuidelines: [
      "For single identifier lookups, codedb_word is O(1) and faster than codedb_search or grep.",
    ],
    parameters: Type.Object({
      word: Type.String({ description: "Exact word/identifier to look up" }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const data = await codedbGet(`/explore/word?q=${encodeURIComponent(params.word)}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/explore/word");
    },
  });

  pi.registerTool({
    name: "codedb_hot",
    label: "CodeDB Hot",
    description:
      "10 most recently modified files, ordered by recency. Useful to see what's being actively worked on.",
    promptSnippet: "codedb_hot — 10 most recently modified files",
    parameters: Type.Object({}),
    execute: async () => {
      const start = Date.now();
      const data = await codedbGet("/explore/hot");
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/explore/hot");
    },
  });

  pi.registerTool({
    name: "codedb_deps",
    label: "CodeDB Deps",
    description:
      "Reverse dependency graph — which files import this file. Use before modifying a file to understand impact.",
    promptSnippet: "codedb_deps <path> — reverse dependencies (who imports this file)",
    promptGuidelines: [
      "ALWAYS use codedb_deps before modifying a file to check what other files depend on it.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path to check dependents of" }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const data = await codedbGet(`/explore/deps?path=${encodeURIComponent(params.path)}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/explore/deps");
    },
  });

  pi.registerTool({
    name: "codedb_read",
    label: "CodeDB Read",
    description:
      "Read entire file content. Use codedb_outline first to understand structure — it's 4-15x more token-efficient than reading the whole file.",
    promptSnippet: "codedb_read <path> — read file content (use outline first)",
    promptGuidelines: [
      "Use codedb_outline first, then codedb_read only when you need actual content.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to project root" }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const data = await codedbGet(`/file/read?path=${encodeURIComponent(params.path)}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/file/read");
    },
  });

  pi.registerTool({
    name: "codedb_status",
    label: "CodeDB Status",
    description: "Index status: health check and current sequence number.",
    promptSnippet: "codedb_status — index health and sequence number",
    parameters: Type.Object({}),
    execute: async () => {
      const start = Date.now();
      const [health, seq] = await Promise.all([
        codedbFetch("/health").catch(() => '{"status":"error"}'),
        codedbFetch("/seq").catch(() => '{"seq":-1}'),
      ]);
      return textResult(
        JSON.stringify({ health: JSON.parse(health), seq: JSON.parse(seq) }, null, 2),
        Date.now() - start,
        "/health+/seq",
      );
    },
  });

  pi.registerTool({
    name: "codedb_changes",
    label: "CodeDB Changes",
    description:
      "Get files that changed since a sequence number. Use with codedb_status to poll for incremental changes.",
    promptSnippet: "codedb_changes [since] — files changed since sequence number",
    parameters: Type.Object({
      since: Type.Optional(
        Type.Number({ description: "Sequence number to get changes since (default: 0)" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const q = params.since != null ? `?since=${params.since}` : "";
      const data = await codedbGet(`/changes${q}`);
      return textResult(JSON.stringify(data, null, 2), Date.now() - start, "/changes");
    },
  });

  pi.registerTool({
    name: "codedb_snapshot",
    label: "CodeDB Snapshot",
    description:
      "Full pre-rendered codebase snapshot as JSON: tree, all outlines, symbol index, and dependency graph. Large output — use only when you need a comprehensive overview.",
    promptSnippet: "codedb_snapshot — full codebase snapshot (tree+outlines+symbols+deps)",
    promptGuidelines: [
      "Only use when you need a comprehensive overview — prefer targeted tools for specific queries.",
    ],
    parameters: Type.Object({}),
    execute: async () => {
      const start = Date.now();
      const data = await codedbGet("/snapshot");
      const text = JSON.stringify(data, null, 2);
      const result = truncateTail(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return textResult(result.content, Date.now() - start, "/snapshot");
    },
  });
}
