# From a new project to a binary

bazis uses TypeScript, Bun, DI, DbContext and controllers with decorators.
It runs on Bun 1.4.0 or newer only; Node.js and Deno are not supported.
Codegen infers constructor dependencies and HTTP parameter bindings before the run.
For a C# developer the closest familiar concepts are the DI scope, EF DbContext and
ASP.NET controllers. ORM conditions in bazis are built with methods, without LINQ expression trees.

## 1. Create an application

In the framework checkout, use the qualified Bun from the
[toolchain](../toolchain/bun.json). The commands below assume BAZIS_BUN_BIN already
points to the verified executable.

```sh
./scripts/bazis-bun run toolchain:check
./scripts/bazis-bun run bazis new MyApp --path ../my-app
cd ../my-app
"$BAZIS_BUN_BIN" install
"$BAZIS_BUN_BIN" run dev
```

The empty backend listens on `http://127.0.0.1:3000`; GET `/health` checks that it runs.
If the port is busy, set `PORT=3100`. This project needs no database and no LLM.
The sample application in the source checkout has its own infrastructure requirements.

The new project depends on `bazis` from npm (`"bazis": "^<version>"`); `bun install`
downloads it and `bun update bazis` updates it. Outside the framework checkout the
same project comes from `bunx bazis new MyApp`. `--vendor` copies the package into
`vendor/bazis` instead, for projects that must build without npm access; commit that
directory, it is not updated automatically. `--link-framework` keeps a live link to
an external checkout for joint development. The built CLI outside the checkout
accepts `--framework /absolute/path/to/src/bazis`.

## 2. Add a feature

From the root of the new application:

```sh
"$BAZIS_BUN_BIN" x bazis g module Task --empty
```

The CLI creates `Task.module.ts` and `MODULE.md` and wires the module into `AppModule`.
Fill in the responsibility and the inputs in the passport before implementing. One
feature may hold a model, a service, a controller and background handlers. A composite
module is for independent features: `g pack Catalog --parts items,categories`.
A full controller example without a database: [HTTP README](../src/bazis/core/http/README.md).

For a learning CRUD there is `g module Guest --minimal`: ten files, including the
model, DbContext, service, controller, ListQuery and passport. Running it needs a
database provider and a ready schema. `--full` additionally needs host
auth/cache/background/AI infrastructure; it is an extended example, not a start without dependencies.

## 3. API boundaries

- A service declares its dependencies in the constructor; the usual registration is
  `scoped(IService, Service)`. Codegen infers the dependencies without a manual array.
- A list service returns `PageResult<T>`: `items` and `total`. The controller builds
  the JSON:API `data/meta/links` and takes the path from `HttpContext.path`.
- CLI lists over HTTP return 20 records by default, at most 100;
  `summary()` returns the full count and at most 20 names.
- `DbContext.saveChanges()` saves all pending changes of its context.
  `IRepository.saveChanges()` has the same save scope.
- ORM: `u => u.age.gte(18).and(u.name.startsWith("A"))`. `&&`, `||`, `!` over a
  Predicate stop codegen; TypeScript rejects a wrong comparison type.
  Running JS/any by hand without these checks gives no such protection.

## 4. Check and build

```sh
"$BAZIS_BUN_BIN" run di:generate
"$BAZIS_BUN_BIN" run build
"$BAZIS_BUN_BIN" run build:bin
./bin/my-app
```

`dev` and `build` run codegen themselves. Do not edit its files in `src/generated`
by hand. The `BAZIS_HTTP_BINDING_UNRESOLVED` error means the action signature does
not tell where an argument comes from: make the type precise; use `HttpContext` for headers and raw bodies.
On `BAZIS_ORM_PREDICATE_LOGIC` replace the JS logic with the `.and/.or/.not` methods.
A generation error keeps the previous outputs and stops the regular command.

The application binary contains the code and the generated metadata. External
databases, configuration and explicitly used files remain the host's job. Check
the binary by running it from another directory. The runtime is qualified on macOS
arm64 and Linux arm64/x64 (see the [toolchain notes](../toolchain/README.md));
other platforms need their own check.
