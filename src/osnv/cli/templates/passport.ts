import type { ModuleNaming } from "../naming";
import type { ModuleTemplateProfile } from "./module";

export function modulePassport(n: ModuleNaming, profile: ModuleTemplateProfile): string {
  const header = `# ${n.moduleClass}

Passport version: 1.0. Type: atomic. CLI profile: ${profile}.
Status: scaffold generated; the domain implementation and checks are not done.
Entry: [${n.module}.module.ts](${n.module}.module.ts), class ${n.moduleClass}, no arguments.

Before changing it, read AGENTS.md and docs/architecture/MODULE_ARCHITECTURE.md.
This passport covers the scaffold files. The author defines the responsibility
and fields before implementing the domain function and updates this passport
together with the code.
`;
  if (profile === "empty") return `${header}
## Responsibility and contents

The domain responsibility is not defined yet. The scaffold is meant for one
self-contained function; the owner of its data and invariants is decided when
it is implemented. Contents: this passport and ${n.module}.module.ts.
imports: []; exports: []. Public TypeScript entry: class ${n.moduleClass};
no factory or arguments. DI providers, ORM, HTTP, config, background, UI, AI and
events are not used yet. Do not create directories in advance.

## Inputs, outputs and effects

Connected through the imports of the host module. There are no input fields,
public operations, domain errors or external effects yet. When an operation is
added, describe its signature, every input (type, source, required, null,
default, validation, example), the output and the errors.

## Checks

None run for the new module. Generated files do not prove the domain function
works; check the contents, run codegen and the relevant tests.
`;

  const e = n.entity;
  const m = n.module;
  return `${header}
## Responsibility and components

A sample ${e} CRUD with name/email fields. It is a schema example, not the
requirements of the ${n.input} domain; replace the fields before using it for a
real function. One module owns the entity, the service invariants and the
adapters that access it.

| Component | File | Input / dependency | Output / effect |
| --- | --- | --- | --- |
| ${n.moduleClass} | [${n.module}.module.ts](${n.module}.module.ts) | host imports | ORM, DI, HTTP${profile === "full" ? ", background, AI" : ""} |
| ${e} | [model/${m}.model.ts](model/${m}.model.ts) | Fields below | Table ${n.route} |
| ${m}DbContext | [model/${m}.dbContext.ts](model/${m}.dbContext.ts) | Shared host ORM provider | DbSet ${n.collection} |
| I${m}Service / ${m}Service | [services/${m}.service.ts](services/${m}.service.ts), [token](services/I${m}.service.ts) | ${m}DbContext${profile === "full" ? ", ICache" : ""} | CRUD, count, summary |
| ${m}Controller | [http/${m}.controller.ts](http/${m}.controller.ts) | I${m}Service, HTTP request | HTTP operations below |
| Create${e}Request / Update${e}Request | [requests](http/contracts/${m}.requests.ts) | JSON body | RequestModel + Validator |
| ${e}Response / ${m}Summary / to${e}Response | [responses](http/contracts/${m}.responses.ts) | ORM entity | Public data projection |
| ${m}ListQuery | [list](http/contracts/${m}List.query.ts) | Query string | ListQuery, filters/sorting/pages |
${profile === "full" ? `| ${m}Reporter | [background](background/${m}.reporter.ts) | ServiceProvider, Logger, AbortSignal | Runs count and logs it |
| ${m}SummaryTool | [tool](ai/tools/${m}Summary.tool.ts) | I${m}Service, input, context | Summary for the agent |
| ${m}AnalystAgent | [agent](ai/agents/${m}Analyst.agent.ts) | Prepare${m}BriefRequest | ${m}BriefDocument via AgentRuntime |
| AI DTO | [contracts](ai/contracts/${m}.brief.ts) | topic, audience | title, bullets |
` : ""}

## Wiring, DI and data

No imports: the host provides the scaffold's functional dependencies.
exports: [I${m}Service]. TypeScript contract: services/I${e}.service.ts;
HTTP access is defined by the controller and the host policy, separately from DI exports.
I${m}Service → ${m}Service, scoped lifetime. The context and DbSet belong to the ORM.
${profile === "full" ? `${m}SummaryTool is listed in tools: [${m}SummaryTool]; the framework registers it as scoped, the tool is not exported.
The service uses cachedScoped; ICache comes from the host cacheModule.
The background service gets its own scope per tick and disposes it in finally.
The host also provides auth from src/app/modules/auth (TokenKind.Admin/Client),
AgentRuntime and the reasoning modelProfile. The CLI does not create them.
` : ""}Constructor dependencies, including ${m}DbContext, are wired by codegen.
No manual deps arrays. UI, events and own configuration are not used.

ORM: context ${m}DbContext, entities [${e}], shared host provider.
Table ${n.route}${profile === "full" ? `, schema ${n.dbSchema}` : ""}.
Only the module decides how tables are created: \`ensureCreated: true\` or
\`migrateOnStart: true\` in \`ormOsnv\`. The scaffold sets neither, so the host
must provide the schema before requests. The CLI and codegen do not create the database.

| Model / response field | Type | null | Initial value / owner |
| --- | --- | --- | --- |
| id | string UUID | no | Empty string before saving; the ORM assigns the value |
| name | string | no | Empty string in the model; comes from the body on create |
| email | string | no | Empty string in the model; from the body on create; unique DB index |
| createdAt | Date / ISO string in JSON | no | Date(0) before saving; ORM createdAt |
| updatedAt | Date / ISO string in JSON | no | Date(0) before saving; ORM updatedAt |

## Public entries and fields

The host sets the HTTP prefix; local route /${n.route}.
${profile === "full" ? "Read: Admin or Client. Write: Admin. Checked by HTTP Authorize.\n" : "No local Authorize checks; access is decided by the host policy.\n"}
| HTTP / service operation | Input | Result / effect |
| --- | --- | --- |
| GET /${n.route}, controller list(query, ctx) → service getAll(query) | ListQuery | Service: PageResult<${e}Response> (items, total); controller: ListDocument<${e}Response>, HTTP 200 |
| GET /${n.route}/:id, getById(id) | id | ${e}Response or null; HTTP 200 / 404 |
| POST /${n.route}, create(body) | Create${e}Request | ${e}Response; HTTP 201, Location from the current path and id; INSERT |
| PUT /${n.route}/:id, update(id, body) | id, Update${e}Request | ${e}Response or null; HTTP 200 / 404; only the fields sent are changed |
| DELETE /${n.route}/:id, delete(id) | id | boolean; HTTP 204 / 404; physical delete |
| count() | None | Promise<number>; SELECT count |
| summary() | None | Promise<${m}Summary>: count — total; names — up to 20 names ordered by id; SELECT count and a bounded projection |

| Field | Type / source | Required | null | Default | Validation | Example |
| --- | --- | --- | --- | --- | --- | --- |
| id | string / route or DI argument | To read/change/delete one record | no | none | UUID in the HTTP route; the service does not validate it | 123e4567-e89b-42d3-a456-426614174000 |
| body.name | string / JSON body | create: yes; update: no | no | none; a missing field leaves the record unchanged on update | Validator, 2–100 characters | Example |
| body.email | string / JSON body | create: yes; update: no | no | none; a missing field leaves the record unchanged on update | Validator, email, 3–120 characters; unique in the DB | guest@example.com |
| ctx | HttpContext / server | For controller create and list | no | HTTP pipeline | Not from JSON, holds the actual path; not passed to the service | /v1/${n.route} |
| query | ListQuery / query string or DI argument of getAll | Yes | no | ListRequest defaults | name: eq/contains/startsWith, email: eq/contains; sorting name/email/createdAt; HTTP page size 20, at most 100 | page[size]=20&sort=name |

The controller sets basePath for JSON:API links from ctx.path. The service
returns only items and total, without links or HTTP formatting. getAll reads
without tracking and runs count plus SELECT with LIMIT/OFFSET. A direct DI call
passes a parsed ListQuery; the shared ORM paginate caps limit at 1000.

Example create body: {"name":"Example","email":"guest@example.com"}.
Example update body: {"name":"Updated"}. The service does not copy unknown
fields into the entity; hydration and unknown fields follow the host
RequestModel rules. HTTP validates the DTO, including JSON types of
string/number/boolean fields. Direct DI calls must pass correct values: the
service does not repeat the Validator. An invalid HTTP body gets 400; a
malformed UUID does not match the route; a missing record is 404. A duplicate
email makes saveChanges() reject with UniqueViolationError (osnv/core/orm); the
scaffold does not catch it, so it reaches the shared error handler as 500 —
catch it to answer 409.
${m}DbContext.saveChanges() saves every change collected in the context, not
only the current entity. IRepository.saveChanges() saves the same scope and
stays a compatible API. The CRUD has no outer transaction, retries or separate
cancellation protocol. Data changes and later effects are not in one
transaction. Before production the author defines the required invariants.
${profile === "full" ? fullPassport(n) : ""}
## Checks and readiness

For a new module, codegen, DI/HTTP/ORM and business scenarios are not qualified
yet. Fill in results after adapting the scaffold: PASS / FAIL / SKIP with
commands. Check input errors, the exports contract, schema readiness and
${profile === "full" ? "cache invalidation, auth, the background scope, AI metadata and " : ""}CRUD separately.
Existing files do not prove that the host infrastructure works.
`;
}

function fullPassport(n: ModuleNaming): string {
  return `
## Cache, background and AI

GET list is cached for 30 seconds with query and user in the key. Service
getById — 60 seconds, key ${n.route}:id. The shared tag ${n.route} is evicted
with ICache.evictByTag after a successful saveChanges in create/update/delete.
The cache lives in process memory; consistency across processes needs a
separate application decision.

Background: intervalMs 60000, runImmediately false. Each tick gets an
AbortSignal from the runtime, creates a scope, runs count and logs it unless
the signal is aborted; dispose always runs. The SQL itself is not cancelled by
this signal.

Tool ${n.route}.summary: execute(input, context), sideEffect read.
Agent ${n.route}-analyst: prepareBrief(input), task prepare-${n.route}-brief;
modelProfile reasoning, maxSteps 3. The agentOutput method is a declaration
for the runtime. Calling prepareBrief directly does not run the LLM.

| AI input field | Type / source | Required | null | Default | Check | Example |
| --- | --- | --- | --- | --- | --- | --- |
| topic | string / tool input or Prepare${n.module}BriefRequest | Yes | no | none | Validator required, minLength 3 | Daily summary |
| audience | string / Prepare${n.module}BriefRequest | Yes by Validator | no | operators when the DTO is created | Validator required, minLength 3 | operators |
| context | AgentToolExecutionContext / runtime | For the tool | no | runtime | agentName comes from the server context | agentName: ${n.route}-analyst |

Tool output: topic string, count number, names string[], agentName string
(empty when the context has no name). Agent output: title string, bullets
string[]. AgentRuntime validates AI inputs and reports their errors; the
scaffold adds no own permission checks for direct DI/tool calls. The host
decides which tools are allowed. The scaffold does not retry the tool.
`;
}
