# AccessModule

Passport version: 1.3. Check date: 2026-11-13.
Status: implemented for stages 1, 5 (v1.4: permission sources, number comparisons) and 6 (v1.5: `Grant.id`, `explain`, `filterableFields`) of [ACCESS-001](../../../../docs/architecture/ACCESS.md); checks below.
Type: atomic.
Path: `src/bazis/core/access`.
Connection point: [Access.module.ts](Access.module.ts), class `AccessModule`; public entry `bazis/core/access`, test helpers `bazis/core/access/testing`.
Scaffold creation: framework module, written by hand.

## 1. Responsibility and choice of structure

Purpose: access as one layer for every module. A module declares what can be
allowed (`@Module({ permissions })`); the application's rights system
(`AccessPolicy`) answers with data — grants; this module checks objects and
builds list filters from them. Modules write neither the check nor the filter,
and the rights system does not know how a module stores its rows. Permissions
that appear while the application runs (a data manager's tables and their
fields) come from a module's `PermissionSource`.

Why atomic: the catalog, the checks and the default rights system change
together with the grant format; there is no data of its own: the version of a
permission source lives in the source's own tables.

What is outside: roles, their storage and screens (the rights system of the
application: a CMS roles module, later `bazis/identity`); who signed in (the
application's route check puts the principal); code conditions after `can`
(the module's own code).

Priorities: grants are asked once per permission per request and are not kept
longer (the rights system owns long caches and their reset); a check and a list
filter agree because both follow SQL's three-valued logic and compare numbers
exactly, as decimals; every declaration error stops the build, not a request;
a permission of a source that is wrong or missing is closed for everyone,
never open.

## 2. Directories and components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| `definePermissions`, `PermissionSpec` | [catalog/permissions.ts](catalog/permissions.ts) | — | frozen declarations; `permissionProblems` |
| Module fields `permissions`, `references`, `roles` | [catalog/moduleFields.ts](catalog/moduleFields.ts) | DI module-owned metadata channels `access.permission/v1`, `access.reference/v1`, `access.role/v1` | contributions; build-time checks (`AccessSetupError`) |
| Module field `permissionSources` | [catalog/moduleFields.ts](catalog/moduleFields.ts) | channel `access.permission-source/v1`; the field registers the class as scoped | prefix → `PermissionSource` class; build-time checks: a prefix is owned once, no declared key and no other source under it |
| `IAccessCatalog` → `AccessCatalog` (singleton) | [catalog](catalog) | `SERVICE_PROVIDER`: the container's contributions; `PermissionSources`; `accessConfig` | permissions (declared and of sources), reference kinds, roles; `find`, `grantProblem`, `changed`, `sources` |
| `PermissionSource` (port of declaring modules) | [contracts/PermissionSource.ts](contracts/PermissionSource.ts) | — | `version()`, `load(keys?)` |
| `PermissionSourcesService` (singleton) | [catalog/PermissionSources.service.ts](catalog/PermissionSources.service.ts) | `SERVICE_PROVIDER` (a scope of its own for every call), `accessConfig`, `LOGGER` | the permissions of every source, checked like declared ones; `load`, `poll`, `retry`, `changed`, `verify`; a deadline for every call |
| `PermissionSourceLoader` (`background`, phase 5) | [catalog/PermissionSourceLoader.background.ts](catalog/PermissionSourceLoader.background.ts) | `PermissionSourcesService` | reads the sources before the HTTP host starts, then polls their versions (without a poll — tries the failed ones again); `/health` check `background:PermissionSourceLoader` |
| `AccessPolicy` (port) | [contracts/AccessPolicy.ts](contracts/AccessPolicy.ts) | — | `subject`, `grants`, `ownerIds`, `principals` |
| `AttributeLookup`, `References` (ports of declaring modules) | [contracts](contracts) | — | column conditions for lookups; values of reference kinds |
| Conditions | [check/conditions.ts](check/conditions.ts), [check/decimal.ts](check/decimal.ts) | — | `grantProblem` (limits: depth 8, 200 nodes, `maxInList`; `gt`/`gte`/`lt`/`lte` only for a `type: "number"` attribute with a column), `evaluate`; exact decimal comparison of number attributes |
| List filter | [check/filter.ts](check/filter.ts) | ORM `Operand` | `AccessFilter`, `ColumnCondition` (`{ column, op, value }` for a comparison), `grantsToWhere` |
| `IAccess` → `Access` (singleton), `SubjectAccess` | [check](check) | `IAccessCatalog`, `accessConfig`; `AccessPolicy` and lookups from the request scope | `for(ctx)`, `as(subject, scope)`, `can`, `explain`, `filter`, `fields`, `filterableFields`, `principals`, `ownerIds`; `maskFields` |
| `can(permission, objectOf?)` | [check/can.ts](check/can.ts) | `IAccess` | an `AuthorizeCheck` |
| `defineRoles`; `AccessPolicy` → `RolesAccessPolicy` (singleton) | [roles](roles) | `IAccessCatalog`, `accessConfig` | the default rights system; the application's own `AccessPolicy` registration replaces it |
| `AccessCatalogController` (context only) | [http/AccessCatalog.controller.ts](http/AccessCatalog.controller.ts) | `IAccessCatalog`, `IAccess` from the request scope | `GET /access/catalog`, `GET /access/references/:kind` |
| `StaticAccessPolicy` | [testing/index.ts](testing/index.ts) | — | grants from a table, for tests |

exports: `[IAccessCatalog, IAccess, AccessPolicy]`.

## 3. Connection and DI

The application imports `AccessModule` once. A module that declares
permissions, references or roles without it in the graph stops the build.
Every service is registered as contract → implementation, like in an
application: `singleton(IAccess, Access)`. Constructor dependencies come from
the pack's generated wiring [generated/deps.ts](generated/deps.ts), which
`index.ts` imports (see "Framework packs" in the [DI passport](../di/MODULE.md)).
The rights system is the `AccessPolicy` token: `AccessModule`
registers `RolesAccessPolicy`, and the application's own registration in its
module replaces it. Lookup, `References` and `PermissionSource` classes are
registered by the module field that names them and resolved in a scope (the
request's; a source — in a scope the catalog opens for one reading); an
unregistered one stops the build. A lookup that only a source's permissions
name is listed in the module's `providers`: nothing is registered while the
application runs.

## 4. Data, configuration and lifecycle

No data of its own. Config `access`:

| Key | Default | Meaning |
| --- | --- | --- |
| `kindClaim` | `""` | claim with the account kind: `sub` = `<kind>:<subject>` in `RolesAccessPolicy` |
| `roleClaim` | `role` | claim with the roles, separated by spaces or commas |
| `maxInList` | `1000` | values of one `in`/`notIn` and of a lookup result; more → the grant is dropped / `AccessFilterTooLargeError` |
| `sourcePollSeconds` | `5` | seconds between two questions to the permission sources about their version; `0` — no poll |
| `sourceTimeoutSeconds` | `10` | seconds a permission source has for one answer; after them the reading has failed |

The subject of a request is asked once and kept in `ctx.state`; grants are
kept in its `SubjectAccess` for the request, together with the specification
they were checked against.

Permission sources (ACCESS-001 §3.1):

- Start: `PermissionSourceLoader` reads every source before the HTTP host
  starts. A source that fails does not stop the start: its prefix has no
  permissions, the error is logged, `/health` is unhealthy, and every poll
  tries again; without a poll a failed source is tried again every 5 seconds.
- A call of a source (`version()`, `load()`) has `sourceTimeoutSeconds`. A
  call that ran out of time cannot be stopped: its scope is closed when it
  answers, and until then no new call of that source starts.
- A version is a number, a bigint or a non-empty string; anything else is a
  failed reading.
- `/health` is unhealthy for a source that has never been read and for one
  whose readings failed three times in a row; one failure keeps it healthy.
- A specification that cannot be checked (any shape may come from a
  database) is one rejected permission, not a failed reading.
- Change on this instance: the module calls `IAccessCatalog.changed(prefix, keys?)`
  after its transaction is committed. With `keys` only they are read, and the
  catalog keeps the old version, so the next comparison reads the whole prefix.
- Change on another instance: every `sourcePollSeconds` the version is asked
  and, when it differs, the prefix is read again as a whole.
- A key of a source that is not in the catalog, or a grant with an unknown
  attribute of a source's permission, compares the version first (at most once
  a second per prefix); `grantProblem` compares it once more past that limit
  before it reports a problem.
- A reading replaces the permissions of a prefix at once; a failed one keeps
  the previous ones. Readings of one source go one after another.

## 5. Entry points and fields

- `@Module({ permissions: definePermissions({...}) })` — key
  `<module>.<object>.<action>`, `title`, `scope` (`"none"`, `"request"`,
  `{ column }`, `{ lookup }`), `on` (attributes with `ref` or `type`, `column`
  or `lookup`; `all`, `any`, `not`, `own`, `scope` are reserved), `owner`,
  `fields`.
- `@Module({ references: { kind: Class } })` — values of a reference kind.
- `@Module({ roles: defineRoles({...}) })` — roles of the default rights
  system; `"<key>:own"` is `{ where: { own: true } }`. Roles name declared
  permissions only; `"all"` gives the permissions of sources too.
- `@Module({ permissionSources: { prefix: Class } })` — permissions that appear
  while the application runs; the source owns every key under the prefix.
- `IAccessCatalog.grantProblem(permission, grant)` — the checks of a request,
  for a rights system that saves a rule; `changed(prefix, keys?)`; `sources()`.
- `@Authorize(can(permission, objectOf?))` — 401 without a subject, 403
  without the right; without `objectOf` the permission anywhere.
- `Access.for(ctx)` / `Access.as(subject, scope)` → `can`, `filter`, `fields`;
  they take a declared key (`PermissionKey`) or a key under a source's prefix
  (`SourcePermissionKey`). A source's key that does not exist now gives `false`,
  `"none"` and empty field lists, and the rights system is not asked.
- `grantsToWhere(filter)` → ORM `Predicate`, `"all"` or `"none"`.
- `explain(permission, object)` → `AccessExplanation`: `"all"` (a superuser),
  `"absent"` (a source's key that does not exist now) or every grant of the
  rights system in its order with `id`, `scope`, `where` (`true`, `false`,
  `"unknown"`), `applies`, `problem` of a dropped grant and `fields` of a grant
  that applies. `allowed` is the answer of `can`: both use one function. There
  is no route: the answer shows the rules of another person.
- `filterableFields(permission, { scope? })` → `"all"` or the fields the
  subject reads by every grant: a list is filtered and sorted only by them.
  `restrictListOptions(options, fields)` of `bazis/library/jsonapi` applies it
  to the options of a list.
- `Grant.id` — a label of the rights system; it comes back in `explain` and in
  the `warn` line of a dropped grant (field `grant`). `RolesAccessPolicy` sets
  `role:<role>`.
- An object of `can` and `explain` has values under the names of attributes
  (not columns), the owner under the name of the `owner` column, the partition
  under `scope`. An attribute may be on the column of the partition
  (`scope: { column: "spaceId" }` and `on: { spaceId: … }`): a grant applies
  when both its partition and its condition fit.

A grant the permission cannot use (unknown attribute, `own` without `owner`,
a comparison of an attribute that is not a number in a column, a value of a
number attribute that is not a number, limits) is dropped with a `warn` log
line: a broken rule never widens access.

`GET /access/catalog` adds `source` to a permission of a source and
`compare: true` to an attribute that `gt`, `gte`, `lt`, `lte` may test.

## 6. Checks and the readiness boundary

- [test/access.test.ts](test/access.test.ts): build-time checks of
  declarations and roles; `can` with partitions, `own`, three-valued logic;
  filters with lookups and limits; dropped grants; fields; the default rights
  system and the catalog over HTTP.
- [test/access.compare.test.ts](test/access.compare.test.ts): exact decimals;
  comparisons in `can` and in the filter; which attributes may be compared.
- [test/access.explain.test.ts](test/access.explain.test.ts): `explain`
  answers like `can` for every kind of condition; the order, the ids, the
  problems and the fields of grants; the id in the warning; the role in the id
  of the default rights system; `filterableFields`; an attribute on the column
  of the partition.
- [test/access.sources.test.ts](test/access.sources.test.ts): prefixes at
  build time; the start, bad specifications, a closed missing key; `changed`,
  the version comparison for a new key and a new attribute, `grantProblem`,
  failures, the poll of a started application, the HTTP catalog.
- [test/access.postgres.live.test.ts](test/access.postgres.live.test.ts)
  (`BAZIS_PG_URL`): the filter lists exactly the rows `can` allows, for every
  kind of condition, on `decimal`, `integer` and `real` columns.
- [../scripts/test/permissions-codegen.integration.test.ts](../scripts/test/permissions-codegen.integration.test.ts):
  the prefixes of `permissionSources` as key types, the source's dependencies.
- Known limit: a lookup cannot return a subquery yet; a result over
  `maxInList` fails the request (ACCESS-001 §11).
- [test/access.postgres.live.test.ts](test/access.postgres.live.test.ts) also
  runs a source that reads the database through a private provider of its
  module, in two containers on one database: a new table reaches the second
  instance through the version, a removed one — with the poll.
- Known limits of v1.4: no comparisons of dates; a permission or an attribute
  removed on another instance lives here up to `sourcePollSeconds`; a fraction
  goes to the database as decimal text; the comparison is exact for `decimal`
  columns and, in a list filter, for integers of any size (the ORM sends an
  integer beyond 2^53 as a bigint), but the ORM still reads such an integer
  as a rounded number, so `can` needs it as a string or a bigint; `real` is a
  double on both sides (ACCESS-001 §4.2, §11).
- Known limits of v1.5: `explain` gives one result per grant, not per leaf
  of its condition; `filterableFields` counts every grant, also one that opens
  no row of the list.
- Known cost: after `changed(prefix, keys)` the next comparison of versions
  reads the whole prefix again; `keys` makes the change visible at once, it
  does not save the reading.
