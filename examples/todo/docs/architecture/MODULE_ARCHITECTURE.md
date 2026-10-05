# Application module architecture

`src/index.ts` calls `runApp`; `src/app/modules/App.module.ts` composes feature modules through `imports`. The application root owns no domain logic.

One self-contained function is an atomic module. It owns its data, services, HTTP and background handlers. A composite module is only for several independent functions; its root does composition. Layers and file counts alone do not create submodules.

Create new modules only with `bunx osnv g module <Name> --empty|--minimal|--full` or `bunx osnv g pack <Name> --parts <a,b>`. Before implementing, define the responsibility and public entries, then fill in the generated `MODULE.md`: fields, errors, dependencies, exports and checks. Use the public APIs of the `osnv` package and its DI and ORM. Do not edit `src/generated/` by hand; run `bunx osnv codegen`.

`--minimal` creates a sample CRUD with the ORM. To run it the application needs a database provider and a ready schema. For a first function without a database use `--empty`. Check types and the binary build after changes that affect startup.
