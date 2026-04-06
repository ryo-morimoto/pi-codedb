---
name: codedb
description: Index and explore the current project with codedb. Use when asked to "index this project", "explore the codebase structure", "find symbol X", or "what files changed recently".
---

# CodeDB — Code Intelligence

Structural code intelligence powered by codedb. Use the tools to understand codebase structure before making changes.

## Tools

- **`codedb_tree`** — full file tree with language detection, line counts, symbol counts. Start here.
- **`codedb_outline`** — symbols in a single file (functions, structs, imports) with line numbers.
- **`codedb_symbol`** — find where a symbol is defined across the entire codebase.
- **`codedb_search`** — trigram-accelerated full-text search. Supports regex. Fast on pre-indexed data.
- **`codedb_word`** — O(1) exact word lookup via inverted index. Use for identifier search.
- **`codedb_hot`** — recently modified files. Good for understanding active development areas.
- **`codedb_deps`** — reverse dependency graph. Shows which files import a given file.
- **`codedb_read`** — read file content, optionally by line range.
- **`codedb_status`** — check index health and current sequence number.

## Workflow

1. `codedb_tree` to get the project overview
2. `codedb_hot` to see what's actively being worked on
3. `codedb_outline` on key files to understand structure
4. `codedb_symbol` or `codedb_word` to trace specific identifiers
5. `codedb_search` for broader text patterns
6. `codedb_deps` to understand impact before modifying a file
