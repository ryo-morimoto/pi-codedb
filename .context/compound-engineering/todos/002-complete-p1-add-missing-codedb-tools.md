---
status: ready
priority: p1
issue_id: "002"
tags: [feature, tools, parity]
dependencies: ["001"]
---

# codedb 本体との機能パリティ: 未実装ツール7個の追加

## Problem Statement

pi-codedb は 9 ツールしか公開していないが、codedb 本体は 16 ツールを提供。特に `codedb_edit`（ファイル編集）と `codedb_find`（ファジー検索）が欠如しているため、エージェントが bash/Read/Edit に頼らざるを得ない。

## Findings

codedb バイナリの MCP ツール定義から抽出した未実装ツール一覧:

| ツール            | 説明                                              | 優先度                        |
| ----------------- | ------------------------------------------------- | ----------------------------- |
| `codedb_edit`     | 行ベース edit (replace/insert/delete)             | **最高** — bash sed/Edit 代替 |
| `codedb_find`     | ファジーファイル検索（typo-tolerant subsequence） | **高** — glob/fd 代替         |
| `codedb_bundle`   | 最大20クエリをバッチ実行                          | **高** — ラウンドトリップ削減 |
| `codedb_changes`  | seq 番号以降の変更ファイル取得                    | 中 — インクリメンタル解析     |
| `codedb_snapshot` | tree+outline+symbol+deps 一括 JSON                | 中 — セッション開始最適化     |
| `codedb_projects` | ローカル全 indexed プロジェクト一覧               | 低 — マルチプロジェクト補助   |
| `codedb_index`    | 指定パスを index                                  | 低 — 001 の依存               |
| `codedb_remote`   | GitHub リポの cloud intelligence                  | 低 — 外部依存調査             |

## Proposed Solutions

### Option 1: 段階的追加（推奨）

**Approach:** 優先度順に追加。まず edit/find/bundle、次に changes/snapshot。

**Pros:**

- 差分が小さくレビューしやすい
- 各ツールを個別にテスト可能

**Cons:**

- 複数 PR になる

**Effort:** 各ツール 30 分程度

**Risk:** Low

### Option 2: 一括追加

**Approach:** 全ツールを一度に追加。

**Pros:** 一発で完了

**Cons:** 差分が大きい、テスト負荷

## Recommended Action

Option 1。001（project パラメータ対応）完了後に、edit → find → bundle の順で追加。

## Technical Details

**既存ツールの未活用パラメータも同時に追加:**

- `compact` (outline, read, search) — トークン節約
- `scope` (search) — シンボルスコープ付与
- `body` (symbol) — ソースコード本文
- `if_hash` (read) — キャッシュ
- `regex` (search) — 正規表現フラグ

## Acceptance Criteria

- [ ] codedb_edit ツールが登録され、replace/insert/delete が動作する
- [ ] codedb_find ツールがファジー検索を実行できる
- [ ] codedb_bundle が複数クエリをバッチ実行できる
- [ ] 既存ツールに compact/scope/body/if_hash/regex パラメータが追加
- [ ] コントラクトテストに新ツールのケースが追加

## Work Log

### 2026-04-07 - ツール差分調査

**By:** Claude Code

**Actions:**

- codedb バイナリから全 16 MCP ツール定義を抽出
- pi-codedb の 9 ツールと比較、差分 7 ツールを特定
- 既存ツールの未活用パラメータを洗い出し
