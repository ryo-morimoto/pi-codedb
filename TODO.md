# TODO: codedb REST API の未対応項目

codedb の MCP インターフェースで公開されているが、REST API (`GET /...`) では未実装または無視される項目の一覧。
pi-codedb は REST API 経由で通信するため、これらが対応されるまで公開できない。

検証方法: `contract.test.ts` のパリティマトリクス（with/without 比較）

## REST API に存在しないエンドポイント

MCP 専用で REST API にルートが存在しない（404 を返す）。

| MCP ツール | 説明 |
|-----------|------|
| `codedb_edit` | 行ベースのファイル編集 (replace/insert/delete) |
| `codedb_find` | ファジーファイル名検索 (typo-tolerant subsequence) |
| `codedb_bundle` | 最大20クエリのバッチ実行 |
| `codedb_remote` | GitHub リポの cloud intelligence |
| `codedb_projects` | ローカル全 indexed プロジェクト一覧 |
| `codedb_index` | 指定パスの index 作成 |

## REST API でパラメータが無視される

エンドポイント自体は存在するが、クエリパラメータがパースされず無視される。

| エンドポイント | パラメータ | MCP での説明 |
|--------------|-----------|-------------|
| `/file/read` | `start`, `end` | 行範囲指定 (1-indexed) |
| `/file/read` | `compact` | コメント・空行のスキップ |
| `/file/read` | `if_hash` | コンテンツハッシュによるキャッシュ |
| `/explore/search` | `max` / `max_results` | 結果件数の上限（常に50件固定） |
| `/explore/search` | `scope` | 結果にシンボルスコープを付与 |
| `/explore/search` | `compact` | コメント・空行のスキップ |
| `/explore/search` | `regex` | 正規表現パターンとして扱う |
| `/explore/outline` | `compact` | 詳細コメントなしの簡潔形式 |
| `/explore/symbol` | `body` | シンボルのソースコード本文を含める |
| `/explore/hot` | `limit` | 返すファイル数の上限（常に10件固定） |

## OpenAPI / スキーマ公開

REST API のパラメータを自動検出する手段がない。
codedb 側で OpenAPI スキーマまたは同等のエンドポイントが公開されれば、
pi-codedb のパリティテストを完全に自動化できる。
