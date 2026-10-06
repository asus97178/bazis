# bazis

A modular backend framework for [Bun](https://bun.com), written in TypeScript:
constructor dependency injection wired by code generation, HTTP controllers
with validated request models, an ORM for PostgreSQL, configuration with
per-environment defaults, JWT, WebSocket, gRPC, background services, AI agents
and a CLI that scaffolds, runs, tests and compiles your app into a single
executable.

## Requirements

- **Bun 1.4.0 or newer. Node.js and Deno are not supported.** The package
  ships TypeScript sources with standard decorators and no build step; Bun
  runs them directly. Node.js refuses to load TypeScript from `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and the runtime uses Bun
  APIs throughout: `Bun.serve`, `Bun.SQL`, the built-in Redis client,
  `bun:test`, `bun build --compile`.
- TypeScript 5.9 or newer as a peer dependency: the code generator reads
  your sources through the TypeScript compiler API. Nothing is compiled to
  JavaScript.
- PostgreSQL for the ORM.
- Qualified platforms: macOS arm64, Linux x64 and arm64.

## Install

The package is `bazis` on npm. Install
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
bun add -d typescript @types/bun
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

`bazis new` creates a project with `src/index.ts`, a root `AppModule`,
`bazis.config.json`, scripts, a `/health` test and an `.env.example`.

## CLI

| Command | What it does |
| --- | --- |
| `bazis new <Name> [--vendor]` | Create a project in `./<name>` that depends on `bazis` from npm; `--vendor` copies the package into `vendor/bazis` instead |
| `bazis g module <Name> --empty\|--minimal\|--full` | Add a module: empty; CRUD with ORM, validation and paging; or the same with auth guards |
| `bazis g pack <Name> --parts a,b` | Add a composite module made of several atomic ones |
| `bazis codegen` | Regenerate dependency wiring into `src/generated/bazis` |
| `bazis dev [--watch]` | Codegen, then run the app from source with `BAZIS_ENV=development` (unless set); `--watch` restarts on changes in `src/` |
| `bazis test [args]` | Codegen, then `bun test` |
| `bazis build` | Codegen and typecheck |
| `bazis build --bin` | Also compile `bin/<name>`, a standalone executable |

`dev`, `test` and `build` run codegen themselves. If you start the app some
other way after changing code, it warns at startup that the generated code is
out of date. A compiled binary carries everything it needs and skips that
check.

## A module

```ts
// src/app/modules/greeting/Greeting.module.ts
import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";

export class GreetingService {
  hello(name: string) {
    return { message: `Hello, ${name}` };
  }
}

@Controller("greetings")
export class GreetingController {
  // No registration code: `bazis codegen` reads the constructor.
  constructor(private readonly greetings: GreetingService) {}

  @Get(":name")
  get(name: string) {
    return this.greetings.hello(name);
  }
}

@Module({
  controllers: [GreetingController],
  providers: [scoped(GreetingService)],
  exports: [GreetingService],
})
export class GreetingModule {}
```

`bunx bazis g module Greeting --empty` creates this file with an empty module
and adds `GreetingModule` to the `imports` of `AppModule`. With the code above,
`GET /greetings/world` answers `{"message":"Hello, world"}`. Another module
that imports `GreetingModule` can take `GreetingService` in its own
constructor.

## Database

```ts
// src/app/infra/App.infra.ts
import { Infra } from "bazis/core/infra";
import { ormBazisConnect } from "bazis/core/orm";
import { dbConfig } from "../config/db.config"; // defineConfig("db", { default: { host, port, ... } })

@Infra({ db: ormBazisConnect(dbConfig) })
export class AppInfra {}

// src/index.ts
await runApp(AppModule, { infra: AppInfra, http: { port: 3000, health: true } });
```

A feature module attaches its own `DbContext` and entities with
`ormBazis: { context, entities }`; its services take that context in their
constructors. `bunx bazis g module Task --minimal` generates such a module.
Configuration values can be overridden from the environment
(`BAZIS_DB__HOST`, `BAZIS_DB__PASSWORD`, ...). Invalid configuration or a
missing production secret stops startup with an error that names the key.

A unique index violation in `saveChanges()` rejects with
`UniqueViolationError` (with `constraint` and `table`); catch it to answer 409.
Request-body fields declared as `string`, `number` or `boolean` are checked
against the JSON type automatically (400 on mismatch); other rules come from
`@Validator`.

## Example

The source repository contains `examples/todo`: three modules (projects,
tasks and a report), PostgreSQL, cross-module injection, validation, JSON:API
lists, an end-to-end test and a binary build.

## Entry points

Import from the subpaths listed in `exports` of `package.json`:
`bazis/core/app`, `bazis/core/di`, `bazis/core/http`, `bazis/core/orm`,
`bazis/core/infra`, `bazis/core/kernel`, `bazis/library/validation`,
`bazis/library/jsonapi` and others. Anything not listed there is internal.

## Language of built-in texts

Built-in texts are English. Russian sets ship with the package; apply them
once at startup:

```ts
import { MessageRegistry, RU_VALIDATION_MESSAGES } from "bazis/library/validation";
import { CodexError, RU_CODEX_MESSAGES } from "bazis/core/infra";
import { RU_UI_LABELS } from "bazis/core/app";

MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES); // validation errors
CodexError.useMessages(RU_CODEX_MESSAGES);           // Codex connector errors
await runApp(AppModule, { ui: { labels: RU_UI_LABELS, surfaces: [/* ... */] } }); // generated UI texts
```

Either call also accepts your own texts for some codes.

## Status

Pre-1.0: a minor version (0.x) can contain breaking changes; a patch version
does not.

## License

MIT
