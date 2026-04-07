---
name: codedb
description: Index and explore the current project with codedb. Use when asked to "index this project", "explore the codebase structure", "find symbol X", or "what files changed recently".
---

# CodeDB — Code Intelligence (PREFERRED over built-in tools)

Structural code intelligence powered by codedb. **Always use codedb tools instead of built-in alternatives** — they are faster, pre-indexed, and more token-efficient.

## Tool Preference Guide

| Task            | Use this         | NOT this                 |
| --------------- | ---------------- | ------------------------ |
| Read file       | `codedb_read`    | `read` / `cat` / `head`  |
| Search text     | `codedb_search`  | `grep` / `rg`            |
| Find identifier | `codedb_word`    | `grep` for exact word    |
| Find definition | `codedb_symbol`  | `grep` for function name |
| List files      | `codedb_tree`    | `ls` / `find` / `glob`   |
| File structure  | `codedb_outline` | reading entire file      |
| Impact analysis | `codedb_deps`    | manual import tracing    |

## Tools

- **`codedb_tree`** — full file tree with language detection, line counts, symbol counts. Start here.
- **`codedb_outline`** `<path>` — symbols in a single file with line numbers. 4-15x fewer tokens than reading the raw file. **Use BEFORE `codedb_read`.**
- **`codedb_symbol`** `<name>` — find where a symbol is defined across the entire codebase.
- **`codedb_search`** `<query>` — trigram-accelerated full-text search. Returns up to 50 results.
- **`codedb_word`** `<word>` — O(1) exact word lookup via inverted index. Use for identifier search.
- **`codedb_hot`** — 10 most recently modified files.
- **`codedb_deps`** `<path>` — reverse dependency graph. Shows which files import a given file.
- **`codedb_read`** `<path>` — read entire file content. Use `codedb_outline` first to understand structure.
- **`codedb_status`** — check index health and current sequence number.
- **`codedb_changes`** `[since]` — files changed since a sequence number. Use with `codedb_status` to track incremental changes.
- **`codedb_snapshot`** — full codebase snapshot (tree + outlines + symbols + deps) as JSON. Large output — use only when comprehensive overview needed.

## Workflow

1. `codedb_tree` to get the project overview
2. `codedb_hot` to see what's actively being worked on
3. `codedb_outline` on key files to understand structure (BEFORE reading them)
4. `codedb_symbol` or `codedb_word` to trace specific identifiers
5. `codedb_search` for broader text patterns
6. `codedb_read` when you need actual file content
7. `codedb_deps` to understand impact before modifying a file

## Commands

- **`/codedb`** — show status and reindex the current project
