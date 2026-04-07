# TODO: pi-codedb

## 完了済み

- [x] HTTP serve → MCP stdio 移行（レイテンシ ~50x 改善、ポート競合解消）
- [x] 複数プロジェクト対応（codedb MCP の ProjectCache + `project` 引数）
- [x] contract テストを MCP ベースに書き直し（AAA パターン）
- [x] MCP 専用ツール追加: `codedb_find`, `codedb_bundle`, `codedb_edit`, `codedb_remote`, `codedb_projects`, `codedb_index`
- [x] 既存ツールのパラメータ拡張: `line_start/line_end`, `compact`, `if_hash`, `max_results`, `scope`, `regex`, `body`, `limit`
- [x] MCP プロセスの自動再接続（crash recovery）
- [x] `.pi-lens/` を `.gitignore` に追加

## 未対応（codedb 側の対応待ち）

| 項目           | 説明                     | 状態                                                               |
| -------------- | ------------------------ | ------------------------------------------------------------------ |
| `codedb_query` | パイプライン型の複合検索 | codedb main ブランチにソースあり。v0.2.54 のリリースビルドには未含 |

## 将来の改善候補

- [ ] codedb バージョン検出（`tools/list` で利用可能なツールを動的に判定し、ない場合は登録をスキップ）
