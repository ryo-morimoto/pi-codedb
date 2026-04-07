# TODO: pi-codedb 改善項目

## 完了済み

- [x] HTTP serve → MCP stdio 移行（レイテンシ ~50x 改善、ポート競合解消）
- [x] 複数プロジェクト対応（codedb MCP の ProjectCache + `project` 引数）
- [x] contract テストを MCP ベースに書き直し（AAA パターン）

## MCP 専用ツールの公開検討

MCP で利用可能だが、pi-codedb の extension ツールとして未公開のもの。
需要に応じて `pi.registerTool` で追加する。

| MCP ツール        | 説明                                               | 優先度 |
| ----------------- | -------------------------------------------------- | ------ |
| `codedb_find`     | ファジーファイル名検索 (typo-tolerant subsequence) | 高     |
| `codedb_bundle`   | 最大20クエリのバッチ実行                           | 中     |
| `codedb_edit`     | 行ベースのファイル編集 (replace/insert/delete)     | 低     |
| `codedb_remote`   | GitHub リポの cloud intelligence                   | 低     |
| `codedb_projects` | ローカル全 indexed プロジェクト一覧                | 低     |
| `codedb_index`    | 指定パスの index 作成                              | 低     |
| `codedb_query`    | パイプライン型の複合検索                           | 中     |

## パラメータ拡張

現在 pi-codedb が公開しているツールは基本パラメータのみ。
codedb MCP が対応する追加パラメータを extension 側でも公開する。

| ツール           | 追加パラメータ           | 説明                         |
| ---------------- | ------------------------ | ---------------------------- |
| `codedb_read`    | `line_start`, `line_end` | 行範囲指定                   |
| `codedb_read`    | `compact`                | コメント・空行スキップ       |
| `codedb_read`    | `if_hash`                | コンテンツハッシュキャッシュ |
| `codedb_search`  | `max_results`            | 結果件数の上限               |
| `codedb_search`  | `scope`                  | シンボルスコープの付与       |
| `codedb_search`  | `compact`, `regex`       | 結果フィルタ・正規表現       |
| `codedb_outline` | `compact`                | 簡潔形式                     |
| `codedb_symbol`  | `body`                   | ソースコード本文を含める     |
| `codedb_hot`     | `limit`                  | 返すファイル数の上限         |

## その他

- [ ] MCP プロセスの再接続ロジック（crash recovery）
- [ ] codedb バージョン検出とプロトコルバージョンのネゴシエーション
- [ ] `.pi-lens/` をテストのスナップショットから除外（不安定なファイル）
