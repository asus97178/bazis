# osnv

A modular backend framework for [Bun](https://bun.com), written in TypeScript:
constructor dependency injection wired by code generation, HTTP controllers
with validated request models, an ORM for PostgreSQL, configuration with
per-environment defaults, JWT, WebSocket, gRPC, background services, AI agents
and a CLI that scaffolds, runs, tests and compiles your app into a single
executable.

The package ships TypeScript sources and runs on Bun only (≥ 1.4.0). There is
no build step and no separate type package.

## Quick start

```sh
bunx osnv new MyApp
cd my-app
bun install
bunx osnv dev            # GET http://127.0.0.1:3000/health
```

`osnv new` creates a project with `src/index.ts`, a root `AppModule`,
`osnv.config.json`, scripts, a `/health` test and an `.env.example`.

## CLI

| Command | What it does |
| --- | --- |
| `osnv new <Name>` | Create a project in `./<name>` |
| `osnv g module <Name> --empty\|--minimal\|--full` | Add a module: empty; CRUD with ORM, validation and paging; or the same with auth guards |
| `osnv g pack <Name> --parts a,b` | Add a composite module made of several atomic ones |
| `osnv codegen` | Regenerate dependency wiring into `src/generated/osnv` |
| `osnv dev [--watch]` | Codegen, then run the app from source with `OSNV_ENV=development` (unless set); `--watch` restarts on changes in `src/` |
| `osnv test [args]` | Codegen, then `bun test` |
| `osnv build` | Codegen and typecheck |
| `osnv build --bin` | Also compile `bin/<name>`, a standalone executable |

`dev`, `test` and `build` run codegen themselves. If you start the app some
other way after changing code, it warns at startup that the generated code is
out of date. A compiled binary carries everything it needs and skips that
check.

## A module

```ts
// src/app/modules/greeting/Greeting.module.ts
import { Module, scoped } from "osnv/core/di";
import { Controller, Get } from "osnv/core/http";

export class GreetingService {
  hello(name: string) {
    return { message: `Hello, ${name}` };
  }
}

@Controller("greetings")
export class GreetingController {
  // No registration code: `osnv codegen` reads the constructor.
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

`bunx osnv g module Greeting --empty` creates this file with an empty module
and adds `GreetingModule` to the `imports` of `AppModule`. With the code above,
`GET /greetings/world` answers `{"message":"Hello, world"}`. Another module
that imports `GreetingModule` can take `GreetingService` in its own
constructor.

## Database

```ts
// src/app/infra/App.infra.ts
import { Infra } from "osnv/core/infra";
import { ormOsnvConnect } from "osnv/core/orm";
import { dbConfig } from "../config/db.config"; // defineConfig("db", { default: { host, port, ... } })

@Infra({ db: ormOsnvConnect(dbConfig) })
export class AppInfra {}

// src/index.ts
await runApp(AppModule, { infra: AppInfra, http: { port: 3000, health: true } });
```

A feature module attaches its own `DbContext` and entities with
`ormOsnv: { context, entities }`; its services take that context in their
constructors. `bunx osnv g module Task --minimal` generates such a module.
Configuration values can be overridden from the environment
(`OSNV_DB__HOST`, `OSNV_DB__PASSWORD`, ...). Invalid configuration or a
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
`osnv/core/app`, `osnv/core/di`, `osnv/core/http`, `osnv/core/orm`,
`osnv/core/infra`, `osnv/core/kernel`, `osnv/library/validation`,
`osnv/library/jsonapi` and others. Anything not listed there is internal.

## Language of built-in texts

Built-in texts are English. Russian sets ship with the package; apply them
once at startup:

```ts
import { MessageRegistry, RU_VALIDATION_MESSAGES } from "osnv/library/validation";
import { CodexError, RU_CODEX_MESSAGES } from "osnv/core/infra";
import { RU_UI_LABELS } from "osnv/core/app";

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
