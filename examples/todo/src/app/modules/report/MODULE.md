# ReportModule

Passport 1.0. Type: atomic. CLI profile: empty.
Created with (from `examples/todo`):
`../../scripts/osnova-bun node_modules/osnv/cli/main.ts g module Report --empty`
Entry: [Report.module.ts](Report.module.ts), class `ReportModule`.

## Responsibility

Read-only summary over the other modules. Owns no data and no DI exports;
shows a module that only composes services exported by others.

imports: `ProjectModule`, `TaskModule`. exports: none.

## Inputs, outputs, effects

`GET /report` — no input; returns `{ projects: number, tasks: number,
done: number }`, three counts read in parallel (not one snapshot). No effects.

## Checks

`src/app/test/api.test.ts` compares the report before and after its changes.
