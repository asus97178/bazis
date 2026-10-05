# Infra

Passport version: 1.8. Date: 2026-10-02. Status: the contracts and the earlier local physical acceptance are described below; the composition change is checked separately without external services.
Type: an existing atomic technical responsibility: connections and their lifecycle.
The scaffold existed before mandatory CLI generation; no new modules are created.
Connection points: `Infra(manifest)` / `infraModule(manifest)` in [Infra.ts](Infra.ts).
Passport scope: the manifest, lifecycle, tokens, failure fixes and connector settings.

## Responsibility and components

The manifest declares logical names and connectors. Infra binds them to the existing DI
and kernel and owns the created clients and health registrations. ORM schemas,
migrations, domain models, HTTP controllers and AI tools are not used here.

| Component | Responsibility / input |
| --- | --- |
| `Infra.ts` | `Readonly<Record<string, InfraConnector>>`; builds the global module metadata |
| `InfraConnector.ts` | Client type, DI token, config, create/connect/dispose/health |
| `InfraLifecycle.ts` | One connector instance; creation, cancellation, exactly one dispose |
| `connectorIdentity.ts` | The internal link of the original connector to its lifecycle and the immutability check; no phase/token policy |
| `connectors/*` | Adapting a checked domain config to the matching client |
| `test/*` | Contracts, errors, cancellation and resource limits |

## DI and ownership

The client is published as a singleton under `connector.token`; the raw client is
`externallyOwned`. The internal singleton `InfraLifecycle` belongs to DI and is also
published under `HOSTED_SERVICE`. Its `dispose` closes the client, including an early
resolution before start. The factories use explicit name/connector arguments and
internal tokens created per manifest entry; this is composition data, not a manual
duplication of class deps. The external TS exports are in [index.ts](index.ts); the DI
exports are the client token and the declared `connector.exports`. Infra itself
publishes no HTTP/AI inputs.

## Inputs and lifecycle

The client is identified by the required `token: InjectionToken<TClient>`.
The `config`, `phase`, `providers`, `exports` fields are optional.
`config` is one ModuleConfig or a readonly array, no default.
`phase` is a finite integer, default -100; a lower phase starts earlier.
Manifest names are non-empty; the same client token from different owners is rejected.
DI walks the same connected module once.

By the owner's decision of 2026-10-02 `kind` was removed from `InfraConnector` and
`LlmProviderAdapter`, the built-in connectors and the application SMS connector.
This is a change of the public TypeScript contract without a transitional alias or an
optional field. To connect your own client, implement the contract operations and pass
the connector to the manifest; there is no need to register a type name.
Manifest keys are arbitrary, for example `payment-delivery`; they are used in
diagnostics and health check names. For database readiness the ORM compares the
DATABASE_PROVIDER token itself; another token with the same display name does not replace it.

An LLM adapter needs only `create(options)`; `connect`, `dispose`, `healthCheck` stay
optional. The implementation is chosen by passing the adapter itself.
No new type registries, classification fields or modules were introduced.
Custom connector scenarios, ORM rejections, results and binary checks:
[contract change report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-design-2026-10-02/INFRA_CONNECTOR_CONTRACT.md).

| Operation / field | Type, default | Check / result |
| --- | --- | --- |
| `create(configs?)` | An optional ConfigRegistry, the result is TClient | Creates an unconnected client from the kernel view; must not leave resources behind on its own exception |
| `connect(client, signal?)` | The client; an optional AbortSignal | Promise<void> or void; cancellation stops the wait and starts cleanup |
| `dispose(client)` | The created client | Promise<void> or void; must also stop an unfinished connect and forbid opening after close |
| `healthCheck(client, signal?)` | The client; an optional AbortSignal | boolean/Promise<boolean>; no method means no check |
| `InfraLifecycle(name, connector, client?, configs?)` | Name, connector; the ready client and the registry are optional | Keeps the former three-argument call; without a client creation is lazy |
| `getClient()` | No arguments | Creates the client once; throws InfraError after dispose |
| `start(signal?)` | An optional AbortSignal | Runs connect; an exception/cancellation releases the created client |
| `stop()` / `dispose()` | No arguments | One shared release operation; a repeat does not call connector.dispose again |

Null inputs are not supported. Config/manifest errors give InfraError; a connect error
is kept, and a cleanup error is added through AggregateError.
There are no automatic connection retries. Host timeouts stay in the kernel.
Passing an AbortSignal and calling dispose do not prove the driver natively cancelled the request.

## Checks and trade-offs

D02/D03 and the related regressions from the [plan](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config/WORK_PLAN.md) are done.
The simple stateful lifecycle leaves one resource owner. The settings and the graph are
checked on the cold path; no new network calls or retries are added.
Binary execution was checked with a controlled fixture; results in the [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config/RESULT.md).

## Configuration per kernel

Per [MOD-ARCH-001 §5.4](../../../../docs/architecture/MODULE_ARCHITECTURE.md#kernel-config-isolation)
`create(configs?: ConfigRegistry)` gets the configuration registry of its container;
the built-in connectors get the view through `configs.get(config)`.
The optional argument keeps direct standalone calls. The lifecycle keeps the identity
of the original connector and gets the registry of its container as the fourth
constructor argument. Two kernels may share the manifest, declarations and adapters,
but not the resolved configuration values. Deferred LLM profile factories are checked too.

Implemented and checked for two kernels with a shared manifest:
[isolation report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-config-isolation-2026-09-14.md).
This check does not replace the acceptance of the other Infra audit work.
No physical services were started for the separate isolation check.
Later a [local operational acceptance](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config-acceptance/RESULT.md)
was done with PostgreSQL/Valkey and measurements. No admission of new platforms is claimed.
There are no deviations from the architecture specification.

## Connector parameters

`postgres(config, { token?, shutdownTimeoutMs? })`, `redisConnect(config, { token?, cache? })` and
`openSearchConnect(config, { token?, timeoutMs?, maxResponseBytes? })` keep their default
tokens. An explicit InjectionToken is needed for a second instance of the same client;
the token type matches the client. A null field is not supported.
The distributed Redis cache stays one shared backend per application.
A second backend, including one connected in another module, is rejected by Cache when
the module container is built, before clients are created. The `cache.connection`
parameter sets a name inside the single backend and does not merge backends.
Several raw Redis clients with different tokens are allowed.
By the owner's decision of 2026-10-02 the compatible no-op `start/stop` were removed from
RedisDistributedCacheBackend; it implements only DistributedCacheStores.
The former combined type and connecting the backend through Cache options were removed.
The Redis connector stays the owner of the connection and health; its options are kept.
`ormOsnvConnect` keeps the shared DATABASE_PROVIDER and its ORM policy.

Since 2026-10-02 `InfraLifecycle` does not import the ORM and does not recognize
DATABASE_PROVIDER, the phases −110/−105 or schema admission. Infra keeps an internal
WeakMap link "connector → lifecycle". The LLM and checkpoint protection factories mark
the original objects; Infra records their fields at creation and compares them when the
identity is read. Copying fields/symbols or inheritance does not carry the identity.
The internal functions are not exported by the public facade. The ORM interprets this
information itself in its validator, including the allowed roles and phases.
The ORM checks the readiness of the shared DB slot by the identity of the
DATABASE_PROVIDER token and lifecycle phase −110. A custom implementation of the same
contract is allowed without a string type marker. The former internal ORM marker was
removed from InfraLifecycle. The InfraConnector/InfraLifecycle operations, resource
ownership and phases are kept. The strict ORM checks still require phase 0 or later for
regular application services; removing `kind` does not allow the application to start
before schema admission.

PostgresConfigShape got the optional `max`, `connectionTimeout`, `idleTimeout`,
`maxLifetime` and `tls`. The first four fields are passed to Bun SQL; the timeouts are
in seconds. max/connectionTimeout are positive integers, idleTimeout/maxLifetime allow
0; the technical upper bound is 2147483647. port is 1…65535.
Missing fields keep the driver defaults. tls is disable, allow, prefer, require,
verify-ca or verify-full. Application defaults and narrower limits are described in the
osnova application's [db.config.ts](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/config/db.config.ts).
The shared `postgresConnectionOptions` builder is used by the raw SQL factory and the
existing ORM bridge; the ORM additions for timeouts/CA are kept.

The raw `postgres(config, options)` has `shutdownTimeoutMs?: number`: default 1000 ms,
an integer 0…2147483647, null is not allowed; 0 means an immediate close. It is the
maximum wait for unfinished queries in `SQL.close`, after which the driver closes the
connections. It must fit into the overall kernel shutdown budget; several sequential
disposers share that budget. Consumers first stop accepting work and finish their
operations. After the limit runs out, unfinished operations may get a connection error.
Before, `close()` without a limit hung on a lost response with the idle timeout off.
The setting applies to the raw PostgreSQL connector; the ORM close policy does not change.
It does not prove that SQL running on the server is cancelled.

The LLM router creates adapters on the first connect/complete/health, when the router
itself already has an owner. This allows waiting for an asynchronous rollback if
creating the next adapter fails. `connector.create()` itself stays synchronous.
Starting again after dispose is not supported. Only a separate physical check confirms
the native stopping of drivers and endpoint reachability.

## HTTP clients after shutdown

The Codex `run(input)` signal covers the whole preparation, including the internal
account checks and fetching the model catalog. Cancellation ends the run wait and
releases `activeRuns` without sending the next preparation RPC. If another caller is
already opening the connection, only the run wait is cancelled; the owner of the
opening continues its operation. Cancelling a sent RPC keeps the existing close of the
shared process. The public `models()` stays without arguments.
Regressions: [codex.preparation.test.ts](test/codex.preparation.test.ts).

`OpenSearchClient.dispose()` and `OpenAiCompatibleModelProvider.dispose()` are
idempotent operations without input fields. They cancel the current fetch requests,
including reading the response body, and forbid further sending through this object.
The existing connector/adapter `dispose` calls them. A new kernel creates new clients.
`OpenAiCompatibleModelProvider.ping(signal?)` gets an optional AbortSignal and passes it
down to the transport and body reading. Cancelling health returns false; other requests
are rejected. A custom fetch must honor the signal; forcibly stopping an arbitrary
implementation is not promised. Controlled network scenarios and limits:
[operational acceptance](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config-acceptance/PLAN.md).

## Structured LLM output

`OpenAiCompatibleModelProvider.complete` passes `output.mode: "json"` with
`schema.kind: "json-schema"` as `response_format.type: "json_schema"` and the fields
`json_schema.name`, `schema`, `strict` and an optional `description`. The name is
normalized to allowed ASCII characters and 64 characters. Without a schema
`json_object` stays. An unresolved class contract is rejected before fetch; the Driver
first tries to resolve it by generated metadata.

The Runtime's local validation applies regardless of `strict`. The schema is passed
without automatically replacing required fields or nullable semantics. The concrete
provider must support Structured Outputs and the passed subset; a provider rejection is
returned as an error, with no hidden fallback to JSON mode. In particular, the official
OpenAI strict mode requires an object root, required for all fields and
`additionalProperties: false`; application schemas must follow these limits.
[OpenAI protocol](https://developers.openai.com/api/docs/guides/structured-outputs).
The wire format was checked with a local fetch; real model endpoints were not called.
[Fix checks](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).

## Model text stream

For text output, including with Tools, when `context.onTextDelta` is present the adapter
sends `stream:true`, `stream_options.include_usage:true` and reads SSE. The callback gets
the new `choices[0].delta.content` fragments; complete returns the assembled answer and
usage. Structured JSON output keeps handling the full response. If a compatible endpoint
returns JSON instead of SSE, complete keeps working without partial events.
No extra connections, libraries or modules are created.

The limit of the whole transfer is the existing `maxResponseBytes` (default 16 MiB); one
SSE frame is limited to min(maxResponseBytes, 1 MiB) characters. UTF-8 and CR/LF may
cross network chunks. Success needs finish_reason and `[DONE]`; EOF, a provider error or
an unresolved Tool delta give an error, keeping the timer and the signal over the whole
read. The reader is cancelled on exit, including a callback failure. Error bodies are not
included in exceptions. stop/length/content_filter are passed to the Runtime for its
regular outcome check.

The Router allows fallback only before the first non-empty visible text. After a partial
answer an error ends the call: the second profile does not append a new answer to the
first. Late callbacks of a finished attempt are ignored. This stream is not a replay log.
`delta.tool_calls` fragments are collected until finish_reason and `[DONE]`: at most 16
indexes, unique IDs, sequential indexes, a bounded name and arguments. A partial or
contradictory call is not passed to the executor.
The regular Tool executor additionally checks the model arguments before execution.
Ollama compatibility: [official protocol](https://docs.ollama.com/api/openai-compatibility).
Stream checks: [source, binary and browser](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/client-chat-streaming-2026-09-20.md).

## Codex App Server

[codexAppServerConnect(config)](connectors/codex.ts) is an extra connector of the
existing Infra, without a separate module or a parallel lifecycle. It returns an
InfraConnector<CodexClient>, the token CODEX_APP_SERVER, phase=0. The client is created
without effects from the ConfigRegistry of its kernel. connect starts the stdio process,
initialize/initialized and the effective policy check; dispose closes the process and
ends all waits. health checks that the process is available, separately from the
account login. With enabled=false no process and no directories are created, and health=true.

Components of [connectors/codex](connectors/codex): CodexAppServerClient owns the
connection/authorization and the concurrency limit; CodexAppServer is a bounded
JSON-RPC; CodexTurn owns one turn and its cancellation; CodexPolicy owns process
isolation; contracts.ts is the TypeScript API. HTTP/ORM/UI stay in the application. DI
publishes only the narrow CodexClient; arbitrary RPC and the process are not exposed.
Codex is a full external executor, not an implementation of the raw AgentModelProvider.

| Config / input | Rule |
|---|---|
| enabled:boolean | Required; the application default is false |
| binary:string | A trusted CLI path/name; non-empty, up to 4096, without NUL; the application default is codex |
| stateDirectory:string | A dedicated persistent directory; the same check; default ./var/codex |
| status() | configured, connected, account(email/planType) or null, login or null, loginError, activeRuns |
| login(method) | browser/device, null is forbidden; managed ChatGPT login, up to 10 minutes |
| cancelLogin() / logout() | Cancel the login / remove the authorization through the official RPC; a BUSY error with active turns |
| models() | Up to 100 models, id/name/isDefault, supportedReasoningEfforts, defaultReasoningEffort; a 30-second cache, cleared on account changes |
| run(input) | model?: string 1–121, ASCII letters/digits/._-; absence picks the catalog default, an explicit name is never replaced |
| reasoningEffort | optional string 1–32, `[a-z][a-z0-9_-]*`, null/an empty string are forbidden; absence picks the chosen model's default; example high |
| instructions | string, up to 32000, may be empty; null is forbidden |
| messages | Up to 41 user/assistant messages, text up to 32000; the last user message 1–8000; the history is trimmed in whole pairs to 48000 characters together with the instructions and JSON |
| signal / onTextDelta | A required AbortSignal / a sync callback for new fragments; the result is Promise<string> |
| tools | An optional array of up to 32 {name, description, inputSchema}; unique names, `[A-Za-z_][A-Za-z0-9_-]{0,63}`, a description up to 4000, the whole list up to 128000 characters of JSON |
| onToolCall | Required with tools: an async callback ({id, name, arguments}, signal) → {success:boolean, text:string}; no arbitrary RPC |

CodexModel.supportedReasoningEfforts holds up to 32 pairs `{reasoningEffort:string,
description:string up to 1024}`; the levels come from model/list, no fixed enum shared by
all models is assumed. defaultReasoningEffort:string|null belongs to the list; null is
allowed for an empty list. An invalid catalog is PROTOCOL_ERROR.
The model and effort are checked before a thread is created; an unsupported effort gives
REASONING_UNAVAILABLE without generation. The chosen level is passed in turn/start.effort.

At most 8 concurrent turns, 120 seconds per turn, 32000 characters of answer.
The maxOutputTokens limit of the local LLM is not carried over here. Each turn gets a new
ephemeral thread. The history is passed as an explicitly marked JSON context: this lets
the application stay the only owner of the history and rules out a hidden continuation of
cancelled turns and an extra table reconciling two histories. Native resume, a token log
and cross-process management of a shared account are not claimed; the dedicated
stateDirectory belongs to one application instance.

Cancellation: turn/interrupt, then the turn/completed confirmation; one RPC ACK is not
counted as stopping. With no terminal within 3 seconds after the ACK the process is
stopped, and its other turns get an error. An RPC timeout/cancellation before the turn id
arrives also closes the process, ruling out a lost run. There are no automatic retries of
turn/start and no switch to an API key/another model. After the process dies a new
independent request may open a new process; the old operation is not repeated.
The ephemeral thread is released through thread/unsubscribe after each turn.

Protocol: 1 MiB per frame, 2 MiB per write queue, 64 pending RPCs, 32 subscriptions;
RPC 15 seconds, login/start 30, interrupt/unsubscribe 3. Early events before the
turn/start response are limited to 128 events / 128000 characters. Stderr is drained
without saving; provider error bodies, credentials, instructions and prompts are not
logged. CodexError publishes a fixed code/message without the original error body.

The CLI is an external dependency and is not embedded into the bun binary. The installed
codex-cli 0.154.0-alpha.6.2 was checked; --strict-config rejects incompatible parameters.
At startup the effective policy is checked as well. The separate home, workspace and the
process's user home have mode 0700; auth store=file.
The personal ~/.codex and ~/.agents, OpenAI/database keys and the rest of the application
env are not inherited. The standard directory is excluded from git. The CLI manages the
account refresh/storage; the application does not read or copy auth.json.

Shell, browser/computer, apps/plugins/MCP, hooks, memory, host skill discovery,
subagents and web search are disabled, sandbox=read-only, approval=never. With tools
passed explicitly, only osnv dynamicTools are allowed. Other requests to the client are
rejected; unexpected tool items end the turn. This does not allow native Codex tools.

`skip_host_skill_discovery` does not disable the built-in system skills. When the
connection opens, CodexPolicy reads `skills/list` with the single cwd of the isolated
workspace and `forceReload:true`, then disables all enabled skills through
`skills/config/write({path, enabled:false})`. Codex writes the settings into its isolated
CODEX_HOME; the user's personal configuration does not change.
Up to 128 records with unique absolute paths of up to 4096 characters without NUL and a
boolean enabled are allowed; exactly one group for the given cwd, without discovery errors.
The whole disabling takes up to 15 seconds, a single RPC up to 5 seconds.
After the write `effectiveEnabled:false` and a repeated catalog read are mandatory checks.
Before every `thread/start` the catalog is checked again, including new and re-enabled
skills. An invalid response, a read error or an enabled skill forbid a new turn before
any text is sent to the model. There is no automatic regeneration.
The current contract does not assign skills to agents: only the passed tools are allowed.
The developer instructions state explicitly that there are no skills; mentions of
capabilities in old history are not their current assignment. The text of old messages is
not rewritten. This is an extra instruction, not a replacement for the catalog check.

DynamicTools are an experimental App Server protocol. `thread/start` gets function specs
with generated schemas; `item/tool/call` is routed by threadId and turnId. Only the
assigned name, namespace=null and a new callId are allowed; up to 16 calls per turn,
sequentially. Repeated, foreign and unknown calls are rejected before the callback.
Incoming RPCs are limited to 32 requests per process.
A successful completion message with an unfinished tool request gives a protocol error,
including a request whose callback has not started yet.
The callback is cancelled by the lifetime signal; the wait is bounded even for a handler
that ignores the signal. The application executor must ensure the actual cancellation of
its effect: the end of the wait alone does not prove it.
The result is returned as inputText with success. Infra knows nothing about domain
services: Agents passes the callback to the regular AgentToolExecutor, where DTOs,
admission, scope, timeout and hooks apply. Adding write operations needs a separate
admission policy.

Checks: [codex.test.ts](test/codex.test.ts), the physical run: [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/codex-chatgpt-2026-09-20.md) (the probe scripts were removed in 0.96.1 and remain in the git history).
Skill isolation: a check of the real CLI without an account
— [results of 2026-09-21](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/codex-skills-2026-09-21.md).
PASS: real CLI handshake/policy/account-read without a login; mock subprocess
streaming, cancellation/death/errors/isolation; a built binary + a separate PostgreSQL
database and real WebSockets. Real ChatGPT generation needs the owner's login and is not
considered checked until then. Protocol sources:
[OpenAI App Server](https://learn.chatgpt.com/docs/app-server),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
