# bazis — framework repository for BunJS

A modular backend framework for **[Bun](https://bun.com)**, written in
TypeScript. You describe features as modules with constructor dependency
injection; a code generator wires the dependencies and HTTP bindings before
the run. On top of that: HTTP controllers with validated request models, a
PostgreSQL ORM, configuration, JWT, WebSocket, gRPC, background services,
AI agents and a CLI that scaffolds, runs, tests and compiles the app into a
single executable.

Package: [`bazis` on npm](https://www.npmjs.com/package/bazis) ·
Changes: [CHANGELOG.md](CHANGELOG.md) · License: MIT

> [!IMPORTANT]
> **bazis runs on Bun only (1.4.0 or newer). Node.js and Deno are not
> supported.**
>
> - The package ships TypeScript sources with standard (TC39) decorators and
>   has no build step. Bun runs them directly; Node.js does not strip types in
>   `node_modules`, so it cannot even load the package.
> - The runtime is built on Bun APIs: `Bun.serve` for HTTP and WebSocket,
>   `Bun.SQL` for PostgreSQL, Bun's built-in Redis client, `Bun.spawn`,
>   `Bun.file`; tests use `bun:test`; binaries are made with
>   `bun build --compile`.
> - Qualified platforms: macOS arm64, Linux x64 and arm64. Other platforms,
>   including Windows, are not checked.

## Install from npm

The package is [`bazis` on npm](https://www.npmjs.com/package/bazis). Install
it with Bun; `npm install` would download it too, but the code only runs on Bun.

**A new project** (recommended): the CLI creates the app and adds the
dependency `"bazis": "^<current version>"`:

```sh
bunx bazis new MyApp      # creates ./my-app; nothing is copied, the package comes from npm
cd my-app
bun install               # downloads bazis and its peer dependency typescript
bunx bazis dev            # GET http://127.0.0.1:3000/health
```

**An existing Bun project:**

```sh
bun add bazis             # or a fixed version: bun add bazis@0.96.2
bun add -d typescript@^5.9 @types/bun   # TypeScript 7 is not supported yet
```

Then take `tsconfig.json`, `bazis.config.json` and `src/index.ts` from a
project made by `bazis new` as the starting point, and run `bunx bazis codegen`.

| Task | Command |
| --- | --- |
| Show the installed version | `bun pm ls \| grep bazis` |
| Update within the version range | `bun update bazis` |
| Move to the latest release | `bun add bazis@latest` |
| A project that must build without npm access | `bunx bazis new MyApp --vendor` (copies the package into `vendor/bazis`) |

Every release is published from GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements): the
npm page shows the source commit and the workflow that built it. The release
tarball is also attached to each
[GitHub Release](https://github.com/asus97178/bazis/releases).

Then add features with the CLI, for example `bunx bazis g module Task --empty`.
The [package README](src/bazis/README.md) shows a module, a database
connection, the CLI commands and the public entry points;
[docs/QUICKSTART.md](docs/QUICKSTART.md) goes from a new project to a binary.

## What is inside

| Area | Entry point | What it gives | Spec |
| --- | --- | --- | --- |
| Application | `bazis/core/app` | `runApp`: wires modules, infrastructure, HTTP and lifecycle | [MODULE](src/bazis/core/app/MODULE.md) |
| Modules and DI | `bazis/core/di` | `@Module`, `scoped` / `singleton`, module encapsulation, codegen-wired constructors | [README](src/bazis/core/di/README.md), [MODULE](src/bazis/core/di/MODULE.md) |
| HTTP | `bazis/core/http` | Controllers, routing, request models, middleware, `@Authorize`, OpenAPI, rate limit | [SPEC](src/bazis/core/http/SPEC.md), [README](src/bazis/core/http/README.md) |
| Validation | `bazis/library/validation` | `@Validator` rules and messages, a Russian message set | [SPEC](src/bazis/library/validation/SPEC.md) |
| ORM | `bazis/core/orm`, `bazis/library/orm` | `DbContext`, typed queries, migrations, UUID v7 keys, owned stores (PostgreSQL) | [README](src/bazis/library/orm/README.md), [MODULE](src/bazis/library/orm/MODULE.md) |
| Configuration and kernel | `bazis/core/kernel` | `defineConfig`, per-environment values, `BAZIS_*` overrides, secrets, lifecycle | [README](src/bazis/core/kernel/README.md), [config](src/bazis/core/kernel/config/README.md) |
| Infrastructure | `bazis/core/infra` | `@Infra` connectors: PostgreSQL, Redis, OpenSearch, LLM, Codex | [MODULE](src/bazis/core/infra/MODULE.md) |
| Cache | `bazis/core/cache` | Output cache, `@Cacheable`, in-memory and distributed (Redis) | [SPEC](src/bazis/core/cache/SPEC.md) |
| WebSocket | `bazis/core/websocket` | Gateways, acknowledgements, replay, a Redis adapter | [MODULE](src/bazis/core/websocket/MODULE.md) |
| gRPC | `bazis/core/grpc` | `@GrpcController` server and `GrpcClient`; `.proto` files are parsed at runtime, no generated stubs | [MODULE](src/bazis/core/grpc/MODULE.md) |
| Background | `bazis/core/background` | Hosted services with managed start and stop | [MODULE](src/bazis/core/background/MODULE.md) |
| Agents | `bazis/core/agent` | Agents, tools, tool hooks, execution sessions | [README](src/bazis/core/agent/README.md), [architecture](docs/architecture/AGENT_ARCHITECTURE.md) |
| JWT, HTTP client, JSON:API | `bazis/library/jwt`, `bazis/library/http-client`, `bazis/library/jsonapi` | Tokens, an outbound HTTP client, list queries and documents | [JWT](src/bazis/library/jwt/MODULE.md), [HTTP client](src/bazis/library/http-client/MODULE.md) |
| CLI | `bazis` binary | `new`, `g module`, `g pack`, `codegen`, `dev`, `test`, `build --bin` | [MODULE](src/bazis/cli/MODULE.md) |

Only the subpaths listed in `exports` of
[package.json](src/bazis/package.json) are public; everything else is internal.

How applications are structured — atomic and composite modules, inputs and
outputs, the rules every change follows:
[module architecture](docs/architecture/MODULE_ARCHITECTURE.md), with
[code examples](docs/architecture/MODULE_CODE_EXAMPLES.md) and the
[module passport template](docs/architecture/MODULE_SPEC_TEMPLATE.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `src/bazis` | The package; npm publishes exactly this directory |
| `examples/todo` | Example app built the way a user builds one: three modules, PostgreSQL, an end-to-end test, a binary |
| `docs/` | Architecture, quick start, release history |
| `toolchain/`, `scripts/bazis-bun` | The pinned, hash-checked Bun 1.4.0 used by CI and scripts |
| `scripts/ci.ts`, `scripts/package-check.ts` | CI pipeline and the check that installs the packed package into an empty project |
| `ops/live-postgres` | Live qualification on a disposable PostgreSQL 17 (Docker) |

## Working on the framework

Contribution rules for people and agents: [AGENTS.md](AGENTS.md).

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

## Releasing

1. Set the version in `src/bazis/package.json` and add a `## x.y.z — date`
   section to [CHANGELOG.md](CHANGELOG.md).
2. Merge to `main` with a green CI.
3. Push the tag `vX.Y.Z`. The `publish` job in
   [ci.yml](.github/workflows/ci.yml) checks that the tag matches the version
   and the changelog, packs the package with the qualified Bun, publishes it to
   npm through npm Trusted Publishing (no stored token) with provenance, and
   creates a GitHub Release with the tarball and the changelog section.

[docs/RELEASE.md](docs/RELEASE.md) keeps the history of earlier releases.

## Status

Pre-1.0: a minor version (0.x) can contain breaking changes; a patch version
does not.

## License

MIT, see [src/bazis/LICENSE](src/bazis/LICENSE).
