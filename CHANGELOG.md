# Changelog

All notable changes to the `bazis` package. Versions follow
[Semantic Versioning](https://semver.org); before 1.0 a minor version may
contain breaking changes, a patch version does not.

## 0.96.3 — 2026-10-06

### Fixed

- A binary built with `bazis build --bin` (or `bun build --compile`) ran in
  `development` mode when `BAZIS_ENV` was not set: Bun inlines the literal
  `process.env.NODE_ENV` as `"development"` at bundle time, and a runtime
  `NODE_ENV=production` was ignored. In that mode `debug` is on, so 500
  responses included error details, the OpenAPI page was served and
  production-only configuration checks were skipped. The environment is now
  read at runtime: without `BAZIS_ENV`/`NODE_ENV` a binary runs as
  `production`. Rebuild existing binaries; until then set
  `BAZIS_ENV=production` explicitly.
- TypeScript 6 is supported: the peer dependency is now
  `^5.9.3 || ^6.0.0`, new projects from `bazis new` get `"typescript": "^6"`,
  and the framework itself is built and tested with TypeScript 6.0.3.
  TypeScript 7 is not supported yet: it removed the JavaScript compiler API
  that the code generator uses. The README install steps for an existing
  project pin `typescript@^6`, because a bare `bun add -d typescript`
  installs TypeScript 7. With TypeScript 6 the project `tsconfig.json`
  must list `"types": ["bun"]` (TypeScript 6 no longer loads every
  `@types/*` package by default); projects from `bazis new` already do.

## 0.96.2 — 2026-10-06

### Changed

- `bazis new` makes the project depend on `bazis` from npm
  (`"bazis": "^<version>"`) instead of copying the package into
  `vendor/bazis`; `bun update bazis` now updates the framework. The previous
  behavior is available with `bazis new <Name> --vendor`.
- README: how to install from npm, a module map with links to the specs, and
  an explicit note that bazis runs on Bun only (Node.js refuses to load the
  package: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
- Releases are published through npm Trusted Publishing; no npm token is
  stored in the repository settings.

## 0.96.1 — 2026-10-06

First public release on npm. The framework was developed as Osnova and
then osnv; npm rejected `osnv` as too similar to existing package names, so
the first release uses the name `bazis`.

### Added

- `bazis` CLI: `new`, `g module` (`--empty`, `--minimal`, `--full`), `g pack`,
  `codegen`, `dev [--watch]`, `test`, `build`, `build --bin`.
- Dependency injection wired by codegen (`src/generated/bazis`), with a startup
  warning when sources changed after codegen.
- HTTP: controllers, request models with validation, JSON:API lists. Body
  fields declared as `string`, `number` or `boolean` are checked against the
  JSON type without `@Validator` (400, code `type`).
- PostgreSQL ORM: `DbContext`, migrations, owned stores. A unique index
  violation in `saveChanges()` rejects with `UniqueViolationError`
  (`constraint`, `table`, `cause`). Tables are created only through the module
  (`ensureCreated` or `migrateOnStart` in `ormBazis`).
- Configuration with per-environment defaults and `BAZIS_*` environment
  variables, JWT, WebSocket, gRPC, background services, agents and tools.
- `@UUID({ version: "v7" })`: the ORM assigns a time-ordered UUID v7 key
  before INSERT (native `uuid` column, no database default, any supported
  PostgreSQL version). Dynamic tables with `uuidVersion: "v7"` keys get the same
  behavior instead of a v4 database default. Owned stores accept v7 keys and
  plain `uuid` columns without a default, such as foreign keys to uuid keys.
- Built-in texts are English; Russian sets `RU_VALIDATION_MESSAGES`,
  `RU_CODEX_MESSAGES` and `RU_UI_LABELS` are included.
- `examples/todo` in the repository: three modules, PostgreSQL,
  cross-module injection, an end-to-end test and a binary build.

### Requirements

- Bun 1.4.0 or newer. The package ships TypeScript sources; there is no build
  step.
