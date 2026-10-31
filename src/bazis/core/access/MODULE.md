# AccessModule

Passport version: 1.0. Check date: 2026-11-01.
Status: implemented for stage 1 of [ACCESS-001](../../../../docs/architecture/ACCESS.md); checks below.
Type: atomic.
Path: `src/bazis/core/access`.
Connection point: [Access.module.ts](Access.module.ts), class `AccessModule`; public entry `bazis/core/access`, test helpers `bazis/core/access/testing`.
Scaffold creation: framework module, written by hand.

## 1. Responsibility and choice of structure

Purpose: access as one layer for every module. A module declares what can be
allowed (`@Module({ permissions })`); the application's rights system
(`AccessPolicy`) answers with data — grants; this module checks objects and
builds list filters from them. Modules write neither the check nor the filter,
and the rights system does not know how a module stores its rows.

Why atomic: the catalog, the checks and the default rights system change
together with the grant format; there is no data of its own.

What is outside: roles, their storage and screens (the rights system of the
application: a CMS roles module, later `bazis/identity`); who signed in (the
application's route check puts the principal); code conditions after `can`
(the module's own code).

Priorities: grants are asked once per permission per request and are not kept
longer (the rights system owns long caches and their reset); a check and a list
filter agree because both follow SQL's three-valued logic; every declaration
error stops the build, not a request.

## 2. Directories and components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| `definePermissions`, `PermissionSpec` | [catalog/permissions.ts](catalog/permissions.ts) | — | frozen declarations; `permissionProblems` |
| Module fields `permissions`, `references`, `roles` | [catalog/moduleFields.ts](catalog/moduleFields.ts) | DI module-owned metadata channels `access.permission/v1`, `access.reference/v1`, `access.role/v1` | contributions; build-time checks (`AccessSetupError`) |
| `AccessCatalog` (singleton) | [catalog/AccessCatalog.ts](catalog/AccessCatalog.ts) | the container's contributions | permissions, reference kinds, roles |
| `AccessPolicy` (port) | [contracts/AccessPolicy.ts](contracts/AccessPolicy.ts) | — | `subject`, `grants`, `ownerIds`, `principals` |
| `AttributeLookup`, `References` (ports of declaring modules) | [contracts](contracts) | — | column conditions for lookups; values of reference kinds |
| Conditions | [check/conditions.ts](check/conditions.ts) | — | `grantProblem` (limits: depth 8, 200 nodes, `maxInList`), `evaluate` |
| List filter | [check/filter.ts](check/filter.ts) | ORM `Operand` | `AccessFilter`, `grantsToWhere` |
| `Access` (scoped), `SubjectAccess` | [check/Access.ts](check/Access.ts) | `AccessCatalog`, `AccessPolicy` or `RolesAccessPolicy`, `accessConfig`, the request scope | `for(ctx)`, `as(subject)`, `can`, `filter`, `fields`, `principals`, `ownerIds`; `maskFields` |
| `can(permission, objectOf?)` | [check/can.ts](check/can.ts) | `Access` | an `AuthorizeCheck` |
| `defineRoles`, `RolesAccessPolicy` (singleton) | [roles](roles) | `AccessCatalog`, `accessConfig` | the default rights system |
| `AccessCatalogController` | [http/AccessCatalog.controller.ts](http/AccessCatalog.controller.ts) | `AccessCatalog`, `Access` | `GET /access/catalog`, `GET /access/references/:kind` |
| `StaticAccessPolicy` | [testing/index.ts](testing/index.ts) | — | grants from a table, for tests |

exports: `[AccessCatalog, Access, RolesAccessPolicy]`.

## 3. Connection and DI

The application imports `AccessModule` once. A module that declares
permissions, references or roles without it in the graph stops the build.
The rights system is `AccessPolicy` registered in any module; without one
`Access` uses `RolesAccessPolicy`. Lookup and `References` classes are
registered by the declaring module in its `providers` and resolved in the
request scope; an unregistered one stops the build.

## 4. Data, configuration and lifecycle

No data of its own. Config `access`:

| Key | Default | Meaning |
| --- | --- | --- |
| `kindClaim` | `""` | claim with the account kind: `sub` = `<kind>:<subject>` in `RolesAccessPolicy` |
| `roleClaim` | `role` | claim with the roles, separated by spaces or commas |
| `maxInList` | `1000` | values of one `in`/`notIn` and of a lookup result; more → the grant is dropped / `AccessFilterTooLargeError` |

The subject of a request is asked once and kept in `ctx.state`; grants are
kept in its `SubjectAccess` for the request.

## 5. Entry points and fields

- `@Module({ permissions: definePermissions({...}) })` — key
  `<module>.<object>.<action>`, `title`, `scope` (`"none"`, `"request"`,
  `{ column }`, `{ lookup }`), `on` (attributes with `ref` or `type`, `column`
  or `lookup`; `all`, `any`, `not`, `own`, `scope` are reserved), `owner`,
  `fields`.
- `@Module({ references: { kind: Class } })` — values of a reference kind.
- `@Module({ roles: defineRoles({...}) })` — roles of the default rights
  system; `"<key>:own"` is `{ where: { own: true } }`.
- `@Authorize(can(permission, objectOf?))` — 401 without a subject, 403
  without the right; without `objectOf` the permission anywhere.
- `Access.for(ctx)` / `Access.as(subject)` → `can`, `filter`, `fields`.
- `grantsToWhere(filter)` → ORM `Predicate`, `"all"` or `"none"`.

A grant the permission cannot use (unknown attribute, `own` without `owner`,
limits) is dropped with a `warn` log line: a broken rule never widens access.

## 6. Checks and the readiness boundary

- [test/access.test.ts](test/access.test.ts): build-time checks of
  declarations and roles; `can` with partitions, `own`, three-valued logic;
  filters with lookups and limits; dropped grants; fields; the default rights
  system and the catalog over HTTP.
- Known limit: a lookup cannot return a subquery yet; a result over
  `maxInList` fails the request (ACCESS-001 §11).
