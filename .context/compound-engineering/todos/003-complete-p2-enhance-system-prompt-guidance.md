---
status: ready
priority: p2
issue_id: "003"
tags: [prompt-engineering, extension-api, ux]
dependencies: ["002"]
---

# codedb 優先使用を促すシステムプロンプト・ガイドライン強化

## Problem Statement

現在の system prompt は codedb ツールの存在を伝えるだけで、「bash read/write より codedb を使え」という指示が極端に弱い。エージェントが習慣的に Read/Bash に頼り、codedb ツールが活用されない。

## Findings

- 現在の `CODEDB_SYSTEM_PROMPT` (L71-83) はツール一覧と簡単な使い方のみ
- pi Extension API に `promptGuidelines` プロパティがある — ツール登録時にガイドラインを system prompt の Guidelines セクションに自動注入可能
- `tool_call` イベントで Read/Bash ツール呼び出しを検知し、codedb 代替を提案するスティアリングが可能
- `promptSnippet` でツール一覧の簡潔な説明を提供可能

## Proposed Solutions

### Option 1: promptGuidelines + tool_call インターセプト（推奨）

**Approach:**

1. 各ツール登録に `promptGuidelines` を追加（「ファイル読み取りは codedb_read を使え」等）
2. `tool_call` イベントで pi 組み込みの Read/Bash 呼び出しを検知、codedb 代替をユーザーメッセージで注入
3. `CODEDB_SYSTEM_PROMPT` をより強い指示文に書き換え

**Pros:**

- Extension API の正規機能を活用
- エージェントの行動を能動的に誘導

**Cons:**

- tool_call インターセプトが過剰になるとUX劣化

**Effort:** 中

**Risk:** Low

### Option 2: system prompt のみ強化

**Approach:** `CODEDB_SYSTEM_PROMPT` の文面を強化するだけ。

**Pros:** 変更最小

**Cons:** 指示力が弱い（LLM は長い system prompt を部分的に無視する傾向）

## Recommended Action

Option 1。ただし tool_call インターセプトは soft（ブロックせず提案のみ）にする。

## Acceptance Criteria

- [ ] 各 codedb ツールに promptGuidelines が設定されている
- [ ] エージェントがファイル読み取りに codedb_read を優先使用する
- [ ] codedb_search/codedb_word が grep/rg より先に選択される
- [ ] codedb_edit が bash sed/awk の代わりに使用される

## Work Log

### 2026-04-07 - 調査

**By:** Claude Code

**Actions:**

- Extension API の promptGuidelines/promptSnippet/tool_call イベントを確認
- 現在の CODEDB_SYSTEM_PROMPT の弱さを特定
