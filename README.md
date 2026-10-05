# osnv — framework repository

Source of the [`osnv`](src/osnv/README.md) npm package: a modular backend
framework for Bun with DI wired by codegen, HTTP, a PostgreSQL ORM, WebSocket,
gRPC, agents and a CLI. The published package is the `src/osnv` directory.
Rules for changes: [AGENTS.md](AGENTS.md) and
[module architecture](docs/architecture/MODULE_ARCHITECTURE.md).

| Path | What it is |
| --- | --- |
| `src/osnv` | The package (published from here) |
| `examples/todo` | Example app built the way a user builds one |
| `toolchain/`, `scripts/osnv-bun` | Pinned, hash-checked Bun 1.4.0 |
| `scripts/ci.ts`, `scripts/package-check.ts` | CI and the "as a user" package check |
| `ops/live-postgres` | Live qualification on a disposable PostgreSQL 17 (Docker) |

## Work locally

```sh
export OSNV_BUN_BIN=/absolute/path/to/qualified/bun   # see toolchain/README.md
./scripts/osnv-bun run toolchain:check
./scripts/osnv-bun install --frozen-lockfile
./scripts/osnv-bun --no-env-file run ci
# with the live PostgreSQL qualification (Docker):
./scripts/osnv-bun --no-env-file run ci -- --live <directory-outside-the-repo>/<run-name>
```

`run ci` runs codegen (`src/generated` must stay unchanged), the typecheck, all
tests, the CLI binary, the packed package installed into an empty project, and
`examples/todo`. Codegen targets: `production` scans the package entry
`src/osnv/index.ts`, `test` the HTTP fixtures.

## Release

Branch `release/x.y.z`, version in `src/osnv/package.json`, notes in
[docs/RELEASE.md](docs/RELEASE.md), green `run ci`, tag `vX.Y.Z`, then
`bun publish --provenance` from CI and a GitHub Release.

## License

MIT, see [src/osnv/LICENSE](src/osnv/LICENSE).
