# From a new project to a binary

osnv uses TypeScript, Bun, DI, DbContext and controllers with decorators.
Codegen infers constructor dependencies and HTTP parameter bindings before the run.
For a C# developer the closest familiar concepts are the DI scope, EF DbContext and
ASP.NET controllers. ORM conditions in osnv are built with methods, without LINQ expression trees.

## 1. Create an application

In the framework checkout, use the qualified Bun from the
[toolchain](../toolchain/bun.json). The commands below assume OSNV_BUN_BIN already
points to the verified executable.

```sh
./scripts/osnv-bun run toolchain:check
./scripts/osnv-bun run osnv new MyApp --path ../my-app
cd ../my-app
"$OSNV_BUN_BIN" install
"$OSNV_BUN_BIN" run dev
```

The empty backend listens on `http://127.0.0.1:3000`; GET `/health` checks that it runs.
If the port is busy, set `PORT=3100`. This project needs no database and no LLM.
The sample application in the source checkout has its own infrastructure requirements.

The CLI copies the package into `vendor/osnv`. Commit this directory together with the
application: after that the source checkout is not needed. It is a snapshot of the
version; framework changes are not pulled in automatically. `--link-framework` keeps
a live link to an external checkout for joint development. The built CLI outside
the checkout accepts `--framework /absolute/path/to/src/osnv`.

## 2. Add a feature

From the root of the new application:

```sh
"$OSNV_BUN_BIN" x osnv g module Task --empty
```

The CLI creates `Task.module.ts` and `MODULE.md` and wires the module into `AppModule`.
Fill in the responsibility and the inputs in the passport before implementing. One
feature may hold a model, a service, a controller and background handlers. A composite
module is for independent features: `g pack Catalog --parts items,categories`.
A full controller example without a database: [HTTP README](../src/osnv/core/http/README.md).

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
"$OSNV_BUN_BIN" run di:generate
"$OSNV_BUN_BIN" run build
"$OSNV_BUN_BIN" run build:bin
./bin/my-app
```

`dev` and `build` run codegen themselves. Do not edit its files in `src/generated`
by hand. The `OSNV_HTTP_BINDING_UNRESOLVED` error means the action signature does
not tell where an argument comes from: make the type precise; use `HttpContext` for headers and raw bodies.
On `OSNV_ORM_PREDICATE_LOGIC` replace the JS logic with the `.and/.or/.not` methods.
A generation error keeps the previous outputs and stops the regular command.

The application binary contains the code and the generated metadata. External
databases, configuration and explicitly used files remain the host's job. Check
the binary by running it from another directory. The runtime is qualified on macOS
arm64 and Linux arm64/x64 (see the [toolchain notes](../toolchain/README.md));
other platforms need their own check.
