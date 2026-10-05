# Changelog

All notable changes to the `osnv` package. Versions follow
[Semantic Versioning](https://semver.org); before 1.0 a minor version may
contain breaking changes, a patch version does not.

## 0.96.1 — 2026-10-05

First public release on npm.

### Added

- `osnv` CLI: `new`, `g module` (`--empty`, `--minimal`, `--full`), `g pack`,
  `codegen`, `dev [--watch]`, `test`, `build`, `build --bin`.
- Dependency injection wired by codegen (`src/generated/osnv`), with a startup
  warning when sources changed after codegen.
- HTTP: controllers, request models with validation, JSON:API lists. Body
  fields declared as `string`, `number` or `boolean` are checked against the
  JSON type without `@Validator` (400, code `type`).
- PostgreSQL ORM: `DbContext`, migrations, owned stores. A unique index
  violation in `saveChanges()` rejects with `UniqueViolationError`
  (`constraint`, `table`, `cause`). Tables are created only through the module
  (`ensureCreated` or `migrateOnStart` in `ormOsnv`).
- Configuration with per-environment defaults and `OSNV_*` environment
  variables, JWT, WebSocket, gRPC, background services, agents and tools.
- Built-in texts are English; Russian sets `RU_VALIDATION_MESSAGES`,
  `RU_CODEX_MESSAGES` and `RU_UI_LABELS` are included.
- `examples/todo` in the repository: three modules, PostgreSQL,
  cross-module injection, an end-to-end test and a binary build.

### Requirements

- Bun 1.4.0 or newer. The package ships TypeScript sources; there is no build
  step.
