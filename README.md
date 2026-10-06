# bazis — framework repository fot BunJS

Source of the [`bazis`](src/bazis/README.md) npm package: a modular backend
framework for Bun with DI wired by codegen, HTTP, a PostgreSQL ORM, WebSocket,
gRPC, agents and a CLI. The published package is the `src/bazis` directory.
Rules for changes: [AGENTS.md](AGENTS.md) and
[module architecture](docs/architecture/MODULE_ARCHITECTURE.md).

| Path | What it is |
| --- | --- |
| `src/bazis` | The package (published from here) |
| `examples/todo` | Example app built the way a user builds one |
| `toolchain/`, `scripts/bazis-bun` | Pinned, hash-checked Bun 1.4.0 |
| `scripts/ci.ts`, `scripts/package-check.ts` | CI and the "as a user" package check |
| `ops/live-postgres` | Live qualification on a disposable PostgreSQL 17 (Docker) |

## Work locally

```sh
export BAZIS_BUN_BIN=/absolute/path/to/qualified/bun   # see toolchain/README.md
./scripts/bazis-bun run toolchain:check
./scripts/bazis-bun install --frozen-lockfile
./scripts/bazis-bun --no-env-file run ci
# with the live PostgreSQL qualification (Docker):
./scripts/bazis-bun --no-env-file run ci -- --live <directory-outside-the-repo>/<run-name>
```

`run ci` runs codegen (`src/generated` must stay unchanged), the typecheck, all
tests, the CLI binary, the packed package installed into an empty project, and
`examples/todo`. Codegen targets: `production` scans the package entry
`src/bazis/index.ts`, `test` the HTTP fixtures.

## Release

Branch `release/x.y.z`, version in `src/bazis/package.json`, notes in
[docs/RELEASE.md](docs/RELEASE.md), green `run ci`, tag `vX.Y.Z`, then
`bun publish --provenance` from CI and a GitHub Release.

## License

MIT, see [src/bazis/LICENSE](src/bazis/LICENSE).
