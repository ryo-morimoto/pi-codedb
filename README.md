# pi-codedb

Code intelligence extension for [pi-coding-agent](https://github.com/badlogic/pi-mono) via [codedb](https://github.com/justrach/codedb) REST API.

## Tools

| Tool             | Description                                         |
| ---------------- | --------------------------------------------------- |
| `codedb_tree`    | File tree with language, line counts, symbol counts |
| `codedb_outline` | Symbols in a file (functions, structs, imports)     |
| `codedb_symbol`  | Find where a symbol is defined across the codebase  |
| `codedb_search`  | Trigram-accelerated full-text search                |
| `codedb_word`    | O(1) inverted index word lookup                     |
| `codedb_hot`     | Recently modified files                             |
| `codedb_deps`    | Reverse dependency graph                            |
| `codedb_read`    | Read file content with line ranges                  |
| `codedb_status`  | Index health and sequence number                    |

## Install

```nix
# flake.nix
{
  inputs.pi-codedb.url = "github:ryo-morimoto/pi-codedb";
}
```

## Development

```sh
pnpm install
pnpm check    # lint + format + typecheck
pnpm test     # run tests
```

## License

MIT
