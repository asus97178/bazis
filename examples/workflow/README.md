# Orders — a bazis workflow example

An application on [business processes](../../docs/guide/workflow/processes.md)
and [permissions](../../docs/guide/security/access.md), without a CMS: an order
is approved by a process, its steps are Tools of the `order` module, and who may
do what is the data of `defineRoles`.

| Part | Where |
| --- | --- |
| The process: a big order waits for a manager for two days | `modules/order/process/OrderApproval.process.ts` |
| Variables, an `assign` step, expressions, titles in two languages, a folder | the same process |
| A step: the module's own operation | `modules/order/tools/SetOrderStatus.tool.ts` |
| What the module lets an administrator allow | `modules/order/access/Order.permissions.ts` |
| Roles → permissions | `modules/App.module.ts` |
| The audit log: the framework's events, kept by the application | `modules/audit/events/AuditLog.ts` |
| Who makes the request (a JWT) | `auth/signedIn.ts` |
| Tests: the process on a stopped clock, the rights over HTTP | `test/` |

## Run

Needs Bun ≥ 1.4.0 and PostgreSQL 17. The tables are created on start.

```sh
docker run -d --name orders-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=orders -p 5432:5432 postgres:17-alpine
bun install
bunx bazis dev
```

```sh
ANN=$(bun run --silent token ann customer)
MILA=$(bun run --silent token mila manager)

curl -X POST localhost:3000/orders -H "authorization: Bearer $ANN" -H 'content-type: application/json' -d '{"amount":5000}'
curl localhost:3000/workflow/tasks -H "authorization: Bearer $MILA"
curl -X POST localhost:3000/workflow/tasks/<task id>/complete -H "authorization: Bearer $MILA" -H 'content-type: application/json' -d '{"output":{"approved":true}}'
curl localhost:3000/orders -H "authorization: Bearer $ANN"

ROOT=$(bun run --silent token root admin)
curl 'localhost:3000/audit?filter[action][startsWith]=task.' -H "authorization: Bearer $ROOT"
```

## Test

```sh
BAZIS_DB__HOST=127.0.0.1 bunx bazis test
```

Without `BAZIS_DB__HOST` the tests are reported as skipped.
