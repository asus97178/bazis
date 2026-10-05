# Module passport template

For a new module, first run the osnv CLI command. Then extend the generated
`<module directory>/MODULE.md` with the sections below before the domain implementation.
For an existing module, use this template when creating or updating the passport
before changing the architecture/public inputs.
Basis: [MOD-ARCH-001](MODULE_ARCHITECTURE.md). Remove the hints and extra sample
rows; do not leave `<...>` in a finished passport.

If a part is not needed, write "not used" and a short reason. If a part is not
implemented or not checked yet, state that status instead of filling it with
desired facts. For an existing module described partially, name the covered
operations and the remaining scope explicitly; a partial passport is not complete.

---

# <Module name>

Passport version: <version>. Check date: <date>.
Status: <draft / implemented, checks listed below / partial>.
Type: <atomic / composite>.
Path: <path from the repository root>.
Connection point: <file and class or factory>.
Passport scope: <the whole module or the exact changed operations>.
Scaffold creation: <the CLI command actually run from the repository root;
for a pack part, the pack creation command; for a historical module,
"existed before mandatory CLI generation" if the command is unknown>.

## 1. Responsibility and choice of structure

Purpose: <the complete feature the module provides>.
Why this type: <the boundary of one feature or independent parts>.
Owner of data and invariants: <module/services>.
What is outside the module: <neighboring features and external dependencies>.

Decision priorities per MOD-ARCH-001 §2.1: <how OOP/SOLID, simplicity,
performance, resilience and binary build compatibility are ensured>.
Significant trade-offs: <the reason for extra abstractions, dependencies
or costs; the link to requirements and measurements, or "none">.

For a composite module fill in the table of atomic parts; for an atomic one
write "not used: implements one feature".

| Atomic part | Responsibility and data | Public inputs | Depends on | Passport / sources |
| --- | --- | --- | --- | --- |
| <name> | <duty> | <contracts> | <directed dependencies> | <link> |

## 2. Directories and components

<A tree of only the files/directories actually needed. List existing files and
planned additions separately.>

| Component / symbol | File | Purpose | Input data / DI | Output / effect | Status |
| --- | --- | --- | --- | --- | --- |
| <service / model / controller / handler> | <path> | <role> | <contracts> | <result> | <status> |

Consider the applicable roles from MOD-ARCH-001 §6: module/factory, contracts and tokens,
services, ORM, HTTP/list, response mapper, config/infra, background, UI, Tool adapters,
events, errors, internal and checks. Do not create roles for the sake of the table.

Agents are declared independently per [AGENT-ARCH-001](AGENT_ARCHITECTURE.md).
A module passport describes its services and Tool adapters; a concrete agent is
not added to the module.

## 3. Connection and DI

`imports`: <modules; the role of each: atomic part / external dependency>.
`exports`: <the exact list, including an explicit empty list when needed>.
TypeScript public entry: <index.ts or the existing contract files>.
Global infrastructure: <the required tokens and their source>.
Other `@Module` fields: <field, value, registration owner>.

| provide | useClass / factory / value | Constructor dependency types and their owners | Lifetime | Exported |
| --- | --- | --- | --- | --- |
| <token> | <implementation> | <dependencies> | <scoped / singleton / transient> | <yes / no> |

Codegen wires regular dependencies; do not copy this table into a manual `deps`
array. If an override is needed, state its reason and the concrete substitution.

Describe the module factory options as a separate entry point in §5. If there is no
factory, write "the class is connected, there are no arguments".

## 4. Data, configuration and lifecycle

ORM: <contexts, entities, shared provider mode, repositories, validation>.
Schema: <the chosen startup flags/migrations/ownedStore, or not used>.
Data ownership: <tables, keys, relations, constraints, transactions>.
Model fields: <a table of types, nullability, defaults and invariants, or a link>.
Configuration: <fields, override sources, defaults, validation; no secrets>.
Configuration ownership per [MOD-ARCH-001 §5.4](MODULE_ARCHITECTURE.md#kernel-config-isolation):
<a shared immutable declaration; a separate view per kernel; where sources are
fixed and checked; how services and connectors get values through DI or an
explicit host factory argument; the implementation status and transitional
limits, or "not used">.
Lifecycle: <start/stop, scopes, schedule, cancellation and dispose>.
External effects: <ports, limits, retries that are actually supported>.

## 5. Entry points and fields

List all entry points of the covered scope: HTTP, DI, factory options,
configuration, tool, events, background payloads. Repeat the block below for each.
Describe shared DTOs once and link to them from every operation that uses them.
For a new operation add its TypeScript signature and a correct input example
(JSON for HTTP or a method call). Samples: [code examples](MODULE_CODE_EXAMPLES.md).

### <Operation name>

- Symbol and file: <path>.
- How it is called: <method/route/event/tool/schedule>.
- Consumer and access: <who calls it; the permission check; the server context source>.
- Request / args: <type, or "no input fields">.
- Runtime binding and validation: <who checks this concrete path and where>.

| Field / nested path | Type / format | Source | Required | null | Default and where it applies | Limits / validation | Example |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <field> | <type> | <source> | <condition> | <yes / no> | <value or none> | <rules> | <value> |

Nested objects/arrays: <links to the element fields and size limits>.
Unknown fields and conversions: <rejected / removed / allowed by the schema>.

| Output field | Type / serialization | null / absence | Meaning |
| --- | --- | --- | --- |
| <field> | <type> | <condition> | <meaning> |

Operation result: <return type; HTTP status/headers if applicable>.

| Error / rejection | Condition | Result at the boundary | Check |
| --- | --- | --- | --- |
| <code/type> | <input/failure> | <response/status> | <scenario/file> |

Effect: <which data changes / which external actions run>.
Transaction, retry, concurrency, cancellation: <the actual behavior, limits or
"not applicable"; do not describe unsupported capabilities>.

## 6. Checks and the readiness boundary

For the affected behavior describe the applicable priority checks. Mark checks that
do not apply with a reason; do not present target values as measured ones.

| Priority | What to record |
| --- | --- |
| OOP / SOLID | Owners of invariants, boundaries of responsibility and interfaces, conditions for substituting implementations |
| Simplicity | Why the minimal sufficient option was chosen; the purpose of every added layer or mechanism |
| Performance | The hot path, data volume and load, required metrics/budgets, measurement conditions and results |
| Resilience | Dependency errors, timeouts, cancellation, partial execution, resource release and retry safety |
| Binary build | The affected target, external resources/tools, the build command and a control run of the artifact, platform and limits |

| Requirement / scenario | Command or check | Result | Evidence / limitation |
| --- | --- | --- | --- |
| <scenario> | <exact way> | <PASS / FAIL / SKIP / not run> | <what is confirmed> |

Check what applies: DI registration/isolation, inputs and errors, lifetime,
ORM ownership, the needed adapters; for a pack also the composition, no cycles and
no duplicate registrations. Tests must check behavior, not retell the code.
For a configuration change, describe the check of two kernels with a shared
declaration, different environments/sources and independent behavior on error and
shutdown. Do not run inapplicable checks for the sake of a formal list.

Unknown values, discrepancies and blockers: <concrete facts and the next step>.
Allowed deviations from the general specification: <reason, scope, basis, or none>.
Sources: <links to the relevant sources and checks>.
