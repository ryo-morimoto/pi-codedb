---
status: pending
priority: p3
issue_id: "004"
tags: [ux, extension-api, polish]
dependencies: ["001", "002"]
---

# Extension API の UI 機能活用（renderResult, commands, shortcuts）

## Problem Statement

pi Extension API は豊富な UI 機能（renderResult, registerCommand, registerShortcut, widgets）を提供しているが、pi-codedb は setStatus しか使っていない。ツール結果の表示品質やユーザー操作性に改善余地がある。

## Findings

未活用の UI 機能:

- `renderResult()` — ツール結果のカスタムレンダリング（ハイライト、テーブル表示等）
- `renderCall()` — ツール呼び出し時のカスタム表示
- `registerCommand()` — `/codedb status`, `/codedb reindex` 等のスラッシュコマンド
- `registerShortcut()` — キーボードショートカット
- `ui.setWidget()` — ウィジェット配置
- `ui.notify()` — 通知
- `details` フィールド — メタデータ（実行時間、結果件数等）

## Proposed Solutions

### Option 1: 段階的 UX 改善

1. renderResult で outline/tree の見栄え改善
2. `/codedb` コマンド群の追加
3. details にクエリ実行時間を含める

**Effort:** 低〜中

**Risk:** Low

## Acceptance Criteria

- [ ] codedb_tree/codedb_outline に renderResult が実装されている
- [ ] `/codedb status` コマンドが使える
- [ ] ツール結果の details にメタデータが含まれる

## Work Log

### 2026-04-07 - 調査

**By:** Claude Code

**Actions:**

- Extension API の UI 機能を網羅的に調査（types.d.ts L55-164, L252-302）
- examples/extensions/ の built-in-tool-renderer.ts, commands.ts 等を参照
