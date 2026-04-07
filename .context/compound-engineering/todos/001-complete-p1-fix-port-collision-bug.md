---
status: ready
priority: p1
issue_id: "001"
tags: [bug, server-lifecycle, breaking]
dependencies: []
---

# ポート競合バグ: 別プロジェクトの codedb index が返される

## Problem Statement

pi-codedb を別プロジェクトで起動後、さらに別プロジェクトで pi を起動すると、先に起動したプロジェクトの codedb index が参照される。ユーザーが意図しないコードベースの情報を受け取る致命的なバグ。

## Findings

- `extensions/pi-codedb/index.ts:33-34` でポート `7719` がハードコード
- `ensureServer()` (L123-151) は `/health` チェックで「既存プロセスが応答すれば起動済みとみなす」ロジック
- 別プロジェクトの codedb が `:7719` で動作中 → health OK → **プロジェクト不一致のまま接続**
- `codedb serve` コマンド自体にポート指定オプションがない（`--help` で確認済み）
- しかし codedb MCP ツール定義には全ツールに `project` パラメータが存在（`codedb.snapshot` があるプロジェクトを直接クエリ可能）
- `codedb_index` ツール: 任意パスを index して snapshot を作成可能
- データは `~/.codedb/projects/<hash>/` にプロジェクト別で保存済み

## Proposed Solutions

### Option 1: project パラメータ方式への移行（推奨）

**Approach:** `codedb serve` の常駐プロセスに依存する現行方式をやめ、REST API の各リクエストに `project=<absolute_path>` パラメータを付与する。snapshot ベースのクエリに切り替える。

**実装:**

1. `before_agent_start` で `codedb_index` 相当の処理（snapshot 作成）を実行
2. serve プロセスは1つだけ起動 or 既存プロセスを再利用（ポート競合は無視）
3. 全 REST リクエストに `project=<projectPath>` クエリパラメータを追加
4. `CODEDB_BASE` をモジュールスコープ定数からコンテキスト依存値に変更

**Pros:**

- ポート競合が根本的に解消
- 複数プロジェクト同時利用が自然に対応
- codedb 本体の設計思想に合致（MCP ツールが全て project パラメータを持つ）

**Cons:**

- REST API が project パラメータを受け付けるか実機検証が必要
- snapshot の初回生成コストが発生する可能性

**Effort:** 中（index.ts 全体の修正）

**Risk:** Medium（REST API の project パラメータ対応を要検証）

---

### Option 2: 動的ポート割り当て

**Approach:** 空きポートを自動検出し、`codedb serve` に環境変数やパッチで渡す。

**Pros:**

- 現行アーキテクチャを維持
- 変更箇所が少ない

**Cons:**

- codedb serve にポート指定オプションがないため実現困難
- codedb 本体への PR or fork が必要になる可能性
- 根本解決ではない

**Effort:** 高（codedb 本体の変更が必要）

**Risk:** High

## Recommended Action

Option 1 を採用。REST API の `project` パラメータ対応を先に検証し、動作確認後に全ツールを移行する。

## Technical Details

**Affected files:**

- `extensions/pi-codedb/index.ts:33-34` — CODEDB_PORT/CODEDB_BASE 定数
- `extensions/pi-codedb/index.ts:97-115` — codedbFetch/codedbGet（project パラメータ追加）
- `extensions/pi-codedb/index.ts:123-151` — ensureServer（ロジック変更）
- `extensions/pi-codedb/index.ts:168-177` — before_agent_start（index/snapshot 処理追加）
- `extensions/pi-codedb/index.ts:185-315` — 全ツールの REST URL に project パラメータ追加

## Acceptance Criteria

- [ ] プロジェクトAで codedb 起動後、プロジェクトBで pi 起動 → B の index が返される
- [ ] 同時に2つの pi セッションを異なるプロジェクトで実行しても干渉しない
- [ ] 既存のコントラクトテストが通る
- [ ] codedb serve が既に別プロジェクトで起動中でも正常動作

## Work Log

### 2026-04-07 - 原因特定

**By:** Claude Code

**Actions:**

- `index.ts` のポートハードコード (L33-34) と health チェックロジック (L123-131) を特定
- `codedb --help` / `codedb serve --help` でポート指定オプション不在を確認
- codedb バイナリから MCP ツール定義を抽出、全ツールに `project` パラメータが存在することを発見
- `codedb_index` / `codedb_projects` ツールの存在を確認

**Learnings:**

- codedb は snapshot ベースのクエリを想定した設計（MCP ツール全体が project パラメータ対応）
- 現行の pi-codedb は serve 依存の旧い使い方をしている
