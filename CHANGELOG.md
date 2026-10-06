# Changelog

All notable changes to the `bazis` package. Versions follow
[Semantic Versioning](https://semver.org); before 1.0 a minor version may
contain breaking changes, a patch version does not.

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
