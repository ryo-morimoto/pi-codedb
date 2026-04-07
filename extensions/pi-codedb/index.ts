/**
 * pi-codedb — Pi Extension
 *
 * Code intelligence via codedb MCP (JSON-RPC over stdio).
 *
 * Design: Long-lived codedb child process communicating via newline-delimited
 * JSON-RPC 2.0 over stdin/stdout. No port, no HTTP — zero network overhead.
 *
 * Multi-project: codedb MCP mode has a built-in ProjectCache (up to 5 projects).
 * When the agent switches directories, we pass `project` in tool arguments —
 * no server restart needed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

function textResult(text: string, durationMs: number, tool: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { durationMs, tool },
  };
}

// ---------------------------------------------------------------------------
// MCP Client — JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

let mcpProcess: ChildProcess | null = null;
let mcpReady = false;
let mcpProjectPath = ""; // project path used to start the MCP process
let rpcIdCounter = 0;
const pendingRequests = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }
>();
let lineBuffer = "";

function startMcpProcess(projectPath: string): ChildProcess {
  const codedbBin = process.env.CODEDB_PATH || "codedb";
  const child = spawn(codedbBin, [projectPath, "mcp", "--no-telemetry"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CODEDB_NO_TELEMETRY: "1" },
  });

  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    lineBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineIdx).trim();
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`codedb RPC error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // ignore malformed lines (e.g. log output)
      }
    }
  });

  child.on("exit", () => {
    mcpProcess = null;
    mcpReady = false;
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error("codedb process exited"));
      pendingRequests.delete(id);
    }
  });

  return child;
}

function sendRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!mcpProcess || !mcpProcess.stdin?.writable) {
    return Promise.reject(new Error("codedb MCP process not running"));
  }
  const id = ++rpcIdCounter;
  const msg: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    id,
  };
  if (params) msg.params = params;
  const line = JSON.stringify(msg) + "\n";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`codedb RPC timeout: ${method}`));
    }, 30_000);

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    mcpProcess!.stdin!.write(line);
  });
}

function sendNotification(method: string, params?: Record<string, unknown>): void {
  if (!mcpProcess || !mcpProcess.stdin?.writable) return;
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params) msg.params = params;
  mcpProcess.stdin.write(JSON.stringify(msg) + "\n");
}

/** Call a codedb MCP tool and return the text content from the result. */
async function mcpToolCall(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
  // Auto-reconnect on crash
  if (!mcpProcess || !mcpReady) {
    const ok = await ensureServer(mcpProjectPath || currentProjectPath);
    if (!ok) throw new Error("codedb MCP not available");
  }

  const result = (await sendRpc("tools/call", {
    name: toolName,
    arguments: args,
  })) as { content?: Array<{ type: string; text: string }> };

  if (!result?.content?.length) return "{}";

  // codedb MCP returns up to 3 text blocks:
  //   Block 0: ANSI status line (e.g. "✓ tree  40 files  ⚡ 22µs")
  //   Block 1: actual data
  //   Block 2: hint (e.g. "→ next: codedb_outline path=<file>")
  // We want Block 1 (the data). For 1-block responses (e.g. status), return that.
  const textBlocks = result.content.filter((c) => c.type === "text");
  if (textBlocks.length === 0) return "{}";
  if (textBlocks.length === 1) return textBlocks[0].text;
  // 2+ blocks: return the second one (index 1 = data block)
  return textBlocks[1].text;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function ensureServer(projectPath: string): Promise<boolean> {
  if (mcpProcess && mcpReady) {
    // Already running — codedb MCP handles multi-project via `project` arg
    return true;
  }

  // Kill any stale process
  stopServer();

  mcpProcess = startMcpProcess(projectPath);
  mcpProjectPath = projectPath;

  // Initialize MCP handshake — return as soon as handshake completes.
  // Indexing continues in the background; tools work with partial results.
  try {
    await sendRpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-codedb", version: "1.0.0" },
    });
    sendNotification("notifications/initialized");
    mcpReady = true;
    return true;
  } catch {
    stopServer();
    return false;
  }
}

function stopServer() {
  if (mcpProcess) {
    try {
      mcpProcess.kill("SIGTERM");
    } catch {
      // already dead
    }
    mcpProcess = null;
  }
  mcpReady = false;
  lineBuffer = "";
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error("codedb server stopped"));
    pendingRequests.delete(id);
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
    // Start server without blocking — don't wait for indexing to finish
    warmupPromise = ensureServer(projectPath).then((ok) => {
      serverReady = ok;
      warmupPromise = null;
      ctx.ui.setStatus(
        "codedb",
        ok ? `codedb: ready (${projectPath.split("/").pop()})` : "codedb: offline",
      );
      return ok;
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const projectPath = ctx.cwd || process.cwd();
    currentProjectPath = projectPath;
    if (!serverReady) {
      if (warmupPromise) {
        serverReady = await warmupPromise;
      } else {
        serverReady = await ensureServer(projectPath);
      }
    }
    if (serverReady) {
      ctx.ui.setStatus("codedb", `codedb: ready (${projectPath.split("/").pop()})`);
      return {
        systemPrompt: event.systemPrompt + "\n\n" + CODEDB_SYSTEM_PROMPT,
      };
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
        const statusText = await mcpToolCall("codedb_status", {
          project: projectPath,
        }).catch(() => '{"status":"error"}');
        ctx.ui.setStatus("codedb", `codedb: ready (${projectPath.split("/").pop()})`);
        pi.sendMessage(
          {
            customType: "codedb-status",
            content: `CodeDB status: ${statusText}\nProject: ${projectPath}`,
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

  // ── Helper: build args with optional project scope ──

  function withProject(args: Record<string, unknown>): Record<string, unknown> {
    if (currentProjectPath) {
      return { ...args, project: currentProjectPath };
    }
    return args;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tools
  // ═══════════════════════════════════════════════════════════════════════

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
      const text = await mcpToolCall("codedb_tree", withProject({}));
      const result = truncateTail(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return textResult(result.content, Date.now() - start, "codedb_tree");
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
      compact: Type.Optional(
        Type.Boolean({
          description: "Condensed format without detail comments (default: false)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = { path: params.path };
      if (params.compact) args.compact = true;
      const text = await mcpToolCall("codedb_outline", withProject(args));
      return textResult(text, Date.now() - start, "codedb_outline");
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
      body: Type.Optional(
        Type.Boolean({
          description: "Include source body for each symbol (default: false)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = { name: params.name };
      if (params.body) args.body = true;
      const text = await mcpToolCall("codedb_symbol", withProject(args));
      return textResult(text, Date.now() - start, "codedb_symbol");
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
      query: Type.String({
        description: "Search query (substring match, or regex if regex=true)",
      }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum results to return (default: 50)",
        }),
      ),
      scope: Type.Optional(
        Type.Boolean({
          description: "Annotate results with enclosing symbol scope (default: false)",
        }),
      ),
      compact: Type.Optional(
        Type.Boolean({
          description: "Skip comment and blank lines in results (default: false)",
        }),
      ),
      regex: Type.Optional(
        Type.Boolean({
          description: "Treat query as regex pattern (default: false)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = { query: params.query };
      if (params.max_results != null) args.max_results = params.max_results;
      if (params.scope) args.scope = true;
      if (params.compact) args.compact = true;
      if (params.regex) args.regex = true;
      const text = await mcpToolCall("codedb_search", withProject(args));
      return textResult(text, Date.now() - start, "codedb_search");
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
      const text = await mcpToolCall("codedb_word", withProject({ word: params.word }));
      return textResult(text, Date.now() - start, "codedb_word");
    },
  });

  pi.registerTool({
    name: "codedb_hot",
    label: "CodeDB Hot",
    description:
      "Most recently modified files, ordered by recency. Useful to see what's being actively worked on.",
    promptSnippet: "codedb_hot — recently modified files",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          description: "Number of files to return (default: 10)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = {};
      if (params.limit != null) args.limit = params.limit;
      const text = await mcpToolCall("codedb_hot", withProject(args));
      return textResult(text, Date.now() - start, "codedb_hot");
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
      const text = await mcpToolCall("codedb_deps", withProject({ path: params.path }));
      return textResult(text, Date.now() - start, "codedb_deps");
    },
  });

  pi.registerTool({
    name: "codedb_read",
    label: "CodeDB Read",
    description:
      "Read file contents. Use codedb_outline first to find the line numbers you need, then read only that range with line_start/line_end. Avoid reading entire large files.",
    promptSnippet: "codedb_read <path> — read file content (use outline first)",
    promptGuidelines: [
      "Use codedb_outline first, then codedb_read only when you need actual content.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to project root" }),
      line_start: Type.Optional(
        Type.Integer({
          description: "Start line (1-indexed, inclusive). Omit for full file.",
        }),
      ),
      line_end: Type.Optional(
        Type.Integer({
          description: "End line (1-indexed, inclusive). Omit to read to EOF.",
        }),
      ),
      compact: Type.Optional(
        Type.Boolean({
          description: "Skip comment and blank lines (default: false)",
        }),
      ),
      if_hash: Type.Optional(
        Type.String({
          description:
            "Previous content hash. If unchanged, returns short 'unchanged:HASH' response.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = { path: params.path };
      if (params.line_start != null) args.line_start = params.line_start;
      if (params.line_end != null) args.line_end = params.line_end;
      if (params.compact) args.compact = true;
      if (params.if_hash) args.if_hash = params.if_hash;
      const text = await mcpToolCall("codedb_read", withProject(args));
      return textResult(text, Date.now() - start, "codedb_read");
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
      const text = await mcpToolCall("codedb_status", withProject({}));
      return textResult(text, Date.now() - start, "codedb_status");
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
        Type.Number({
          description: "Sequence number to get changes since (default: 0)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = {};
      if (params.since != null) args.since = params.since;
      const text = await mcpToolCall("codedb_changes", withProject(args));
      return textResult(text, Date.now() - start, "codedb_changes");
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
      const text = await mcpToolCall("codedb_snapshot", withProject({}));
      const result = truncateTail(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return textResult(result.content, Date.now() - start, "codedb_snapshot");
    },
  });

  // ── New tools (MCP-only) ──

  pi.registerTool({
    name: "codedb_find",
    label: "CodeDB Find",
    description:
      "Fuzzy file search — finds files by approximate name. Typo-tolerant subsequence matching with word-boundary and filename bonuses. Use when you know roughly what file you're looking for but not the exact path.",
    promptSnippet: "codedb_find <query> — fuzzy file search",
    parameters: Type.Object({
      query: Type.String({
        description: "Fuzzy search query (e.g. 'authmidlware', 'test_auth', 'main.zig')",
      }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum results to return (default: 10)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = { query: params.query };
      if (params.max_results != null) args.max_results = params.max_results;
      const text = await mcpToolCall("codedb_find", withProject(args));
      return textResult(text, Date.now() - start, "codedb_find");
    },
  });

  pi.registerTool({
    name: "codedb_bundle",
    label: "CodeDB Bundle",
    description:
      "Batch multiple queries in one call. Max 20 ops. Bundle outline+symbol+search, not full file reads. Total response is not size-capped.",
    promptSnippet: "codedb_bundle — batch multiple codedb queries in one call",
    parameters: Type.Object({
      ops: Type.Array(
        Type.Object({
          tool: Type.String({
            description: "Tool name (e.g. codedb_outline, codedb_symbol)",
          }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Tool arguments",
            }),
          ),
        }),
        { description: "Array of tool calls to execute (max 20)" },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const text = await mcpToolCall("codedb_bundle", withProject({ ops: params.ops }));
      const result = truncateTail(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return textResult(result.content, Date.now() - start, "codedb_bundle");
    },
  });

  pi.registerTool({
    name: "codedb_edit",
    label: "CodeDB Edit",
    description:
      "Apply a line-based edit to a file. Supports replace (range), insert (after line), and delete (range) operations.",
    promptSnippet: "codedb_edit — line-based file editing",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit" }),
      op: Type.Union([Type.Literal("replace"), Type.Literal("insert"), Type.Literal("delete")], {
        description: "Edit operation type",
      }),
      content: Type.Optional(Type.String({ description: "New content (for replace/insert)" })),
      range_start: Type.Optional(
        Type.Integer({
          description: "Start line number (for replace/delete, 1-indexed)",
        }),
      ),
      range_end: Type.Optional(
        Type.Integer({
          description: "End line number (for replace/delete, 1-indexed)",
        }),
      ),
      after: Type.Optional(
        Type.Integer({
          description: "Insert after this line number (for insert)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = {
        path: params.path,
        op: params.op,
      };
      if (params.content != null) args.content = params.content;
      if (params.range_start != null) args.range_start = params.range_start;
      if (params.range_end != null) args.range_end = params.range_end;
      if (params.after != null) args.after = params.after;
      const text = await mcpToolCall("codedb_edit", withProject(args));
      return textResult(text, Date.now() - start, "codedb_edit");
    },
  });

  pi.registerTool({
    name: "codedb_remote",
    label: "CodeDB Remote",
    description:
      "Query any GitHub repo via cloud intelligence. Gets file tree, symbol outlines, or searches code in external repos without cloning.",
    promptSnippet: "codedb_remote — query external GitHub repos",
    parameters: Type.Object({
      repo: Type.String({
        description: "GitHub repo in owner/repo format (e.g. justrach/codedb)",
      }),
      action: Type.Union(
        [
          Type.Literal("tree"),
          Type.Literal("outline"),
          Type.Literal("search"),
          Type.Literal("meta"),
        ],
        { description: "What to query: tree, outline, search, or meta" },
      ),
      query: Type.Optional(
        Type.String({
          description: "Search query (required when action=search)",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const args: Record<string, unknown> = {
        repo: params.repo,
        action: params.action,
      };
      if (params.query) args.query = params.query;
      const text = await mcpToolCall("codedb_remote", args); // no project needed
      return textResult(text, Date.now() - start, "codedb_remote");
    },
  });

  pi.registerTool({
    name: "codedb_projects",
    label: "CodeDB Projects",
    description: "List all locally indexed projects with their paths and status.",
    promptSnippet: "codedb_projects — list all indexed projects",
    parameters: Type.Object({}),
    execute: async () => {
      const start = Date.now();
      const text = await mcpToolCall("codedb_projects", {});
      return textResult(text, Date.now() - start, "codedb_projects");
    },
  });

  pi.registerTool({
    name: "codedb_index",
    label: "CodeDB Index",
    description:
      "Index a local folder. Scans all source files, builds outlines/trigrams/word indexes, and creates a codedb.snapshot. After indexing, the folder is queryable via the project param on any tool.",
    promptSnippet: "codedb_index <path> — index a local folder",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to the folder to index",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const start = Date.now();
      const text = await mcpToolCall("codedb_index", { path: params.path });
      return textResult(text, Date.now() - start, "codedb_index");
    },
  });
}
