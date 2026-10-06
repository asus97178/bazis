# gRPC

Passport version: 1.3. Date: 2026-09-26. Type: atomic technical module.
Path: `src/bazis/core/grpc`. Public entry: `bazis/core/grpc`.
Connection: `grpcModule(options)` or `runApp(AppModule, { grpc: options })`.
Status: implemented without external libraries; the functional checks and the binary smoke test passed.
Scope: server controllers, client RPCs, the protobuf contract, DI and the transport lifecycle.

The scaffold was created from the repository root with this actual command:

```sh
BAZIS_BUN_BIN=/private/tmp/bazis-di-structure-20260919-5pq4e459/bun-1.4.0 \
  ./scripts/bazis-bun run bazis g module Grpc --empty --modules-root src/bazis/core --no-register
```

## Responsibility and components

One feature: interaction of application modules over standard gRPC/HTTP2.
The owner's decision of 2026-09-20: keep the bazis API, remove external libraries and
library types. HTTP/2/TLS is done by Bun's built-in `node:http2`; gRPC framing,
metadata, statuses, the parser and the protobuf codec belong to bazis.
Neither the runtime nor the test clients import external packages. The framework
manifest has no dependencies, and the lockfile has no added gRPC packages or their
transitive dependencies. The former exception in the import check was removed.
The project's existing TypeScript/@types/Bun tooling was not replaced.
Domain services, ORM, data, UI, AI and business validation stay with the application.
No parts, own DI or persistent storage are used.

| Component | File | Input / responsibility / result |
| --- | --- | --- |
| Decorators | [decorators.ts](decorators.ts) | ServiceDefinition and RPC name → metadata; the contract match check |
| Registration | [moduleControllers.ts](moduleControllers.ts) | grpcControllers → owner-bound scoped providers of the existing DI |
| Composition | [Grpc.module.ts](Grpc.module.ts) | imports, controllers, options → a singleton HOSTED_SERVICE |
| Server | [GrpcServer.ts](GrpcServer.ts) | Configuration/registrations → listener, routes, start/stop and the call limit |
| Client | [GrpcClient.ts](GrpcClient.ts) | ServiceDefinition/address → four RPC kinds, session reuse, limits and close/dispose |
| Client call | [GrpcClientCall.ts](GrpcClientCall.ts) | Bounded framing, streaming, metadata/status, deadline and cancellation |
| Client contracts | [clientContracts.ts](clientContracts.ts) | Options, GrpcResponse and GrpcResponseStream without library types |
| Client registration | [grpcClientProvider.ts](grpcClientProvider.ts) | A regular singleton factory provider; DI owns dispose |
| Call | [GrpcCall.ts](GrpcCall.ts) | Request/stream → response/status; scope, cancellation and backpressure |
| DTO binding | [GrpcRequest.binding.ts](GrpcRequest.binding.ts), [GrpcBinding.contract.ts](GrpcBinding.contract.ts) | The shared binder/validator; exact-class generated metadata; INVALID_ARGUMENT and bounded field errors |
| Contracts | [contracts.ts](contracts.ts) | Options and the RPC context |
| Error | [GrpcError.ts](GrpcError.ts) | The public code, message and trailers |
| Protobuf | [protobuf.ts](protobuf.ts) | Picking a ServiceDefinition from a package |
| HTTP/2 stream | [GrpcTransport.ts](GrpcTransport.ts) | Framing, deadline, metadata, trailers, bounded message buffering |
| Protocol types | [serviceDefinition.ts](serviceDefinition.ts), [GrpcStatus.ts](GrpcStatus.ts) | Own codec contracts, options and the standard codes |
| Metadata / TLS | [Metadata.ts](Metadata.ts), [ServerCredentials.ts](ServerCredentials.ts) | Own types instead of library ones |
| Protobuf parser / codec | [ProtoParser.ts](ProtoParser.ts), [ProtoSchema.ts](ProtoSchema.ts), [ProtoCodec.ts](ProtoCodec.ts), [ProtoReader.ts](ProtoReader.ts) | Proto3 syntax, a bounded schema graph, encode/decode |

State belongs to one server or one RPC. Walking the tree and checking routes happen
during composition. The output stream creates no unbounded queue: the next element is
requested after the transport's write callback.
ORM/DI are not duplicated. The own protocol implementation is a direct requirement of
the owner; it is not a full clone of a third-party gRPC SDK API.

## Connection by analogy with HTTP

```ts
import { Module, scoped } from "bazis/core/di";
import { GrpcController, GrpcMethod, GrpcError, GrpcStatus, grpcService, loadGrpcPackage } from "bazis/core/grpc";
import { runApp } from "bazis/core/app";
import { Validator } from "bazis/library/validation";
import usersProto from "./users.proto" with { type: "file" };
import { UsersController } from "./UsersController";
import { UserService } from "./UserService";
import { IUserService } from "./IUserService";

const UsersRpc = grpcService(loadGrpcPackage(usersProto), "users.v1.UsersService");

export class GetUserRequest {
  @Validator({ required: true, integer: true, positive: true })
  id!: number;
}

@GrpcController(UsersRpc)
export class UsersGrpcController {
  constructor(private readonly users: IUserService) {}

  @GrpcMethod("GetUser")
  async getById(request: GetUserRequest) {
    const user = await this.users.getById(request.id);
    if (!user) throw new GrpcError(GrpcStatus.NOT_FOUND, "User not found.");
    return { id: user.id, name: user.name };
  }
}

@Module({
  providers: [scoped(IUserService, UserService)],
  controllers: [UsersController],
  grpcControllers: [UsersGrpcController],
  exports: [],
})
export class UsersModule {}

await runApp(UsersModule, {
  http: { port: 3000 },
  grpc: { address: "127.0.0.1:50051" },
});
```

This is an integration scheme for an application that already has an IUserService
contract, not a ready public Users API of this repository. The existing UsersModule gets
a grpcControllers field, and its other ORM/background/UI registrations are kept.
For the example, users.proto contains:

```proto
syntax = "proto3";
package users.v1;
service UsersService { rpc GetUser(GetUserRequest) returns (UserReply); }
message GetUserRequest { int32 id = 1; }
message UserReply { int32 id = 1; string name = 2; }
```

Existing application endpoints are not published automatically.
A TypeScript import of `.proto` needs an ambient module with a default string, as in the
[fixture](test/fixtures/proto.d.ts). A static `with { type: "file" }` includes the
contract in the binary. Dependent proto imports need separately included
resources/includeDirs in a binary delivery; the loader walks the available import files
but does not add them to the Bun bundle automatically.
A ready ServiceDefinition from a protobuf generator can be passed directly.

After adding/changing a DTO, run `di:generate`: the class of the first parameter is bound
to the RPC without `@RequestModel()` and without repeating the rules in the controller.
For the convention the DTO and the controller are named top-level exports of the
project; type-only imports and class aliases, inherited methods and nested DTOs/arrays
are supported. Without codegen you can write `@GrpcMethod("GetUser", GetUserRequest)`.
For a client/bidi stream the signature is `input: AsyncIterable<GetUserRequest>`; an
explicit second decorator argument also names the class of one message.

Controllers are not duplicated in providers. `di:generate` wires constructor DI.
The registration belongs to the feature module and sees its private providers; foreign
dependencies need regular imports/exports. The gRPC module's DI exports: `[]`.
The server is a singleton HOSTED_SERVICE with phase 10. GrpcServer is available through
the TS facade: port is the port after start and undefined before start/after stop;
activeCalls is the number of handlers, including those still running after
cancellation. Scopes belong to the RPC.

## Client: the input contract

Addendum of 2026-09-20: the client is made of components of the existing atomic module,
not a new module, DI or protobuf runtime. No external libraries are used.

The calling application loads the same `.proto`. For the UsersRpc from the example above:

```ts
import { GrpcClient } from "bazis/core/grpc";

const client = new GrpcClient(UsersRpc, { address: "127.0.0.1:50051" });
try {
  const { data: user } = await client.unary<{ id: number }, { id: number; name: string }>(
    "GetUser", { id: 42 }, { timeoutMs: 2000 },
  );
  console.log(user.name);
} finally {
  client.close(); // In DI the container makes this call.
}
```

In an existing feature module the client is registered next to the consuming service:

```ts
import { Module, scoped } from "bazis/core/di";
import { GrpcClient, grpcClientProvider } from "bazis/core/grpc";

export class UsersGateway {
  constructor(private readonly rpc: GrpcClient) {}
  async getUser(id: number) {
    const reply = await this.rpc.unary<{ id: number }, { id: number; name: string }>(
      "GetUser", { id },
    );
    return reply.data;
  }
}

@Module({
  providers: [
    grpcClientProvider(UsersRpc, { address: "users.internal:50051" }),
    scoped(UsersGateway),
  ],
  exports: [UsersGateway],
})
export class ConsumerModule {}
```

Regular codegen wires the constructor dependency; no manual deps list is needed.
This example illustrates the registration inside its own feature module; it does not
create an application ConsumerModule in the repository. `UsersRpc` and the DTOs come
from the application's shared contract. To call from another machine, the server must
listen on a reachable interface (not loopback), and the client must use the server's
real hostname/IP. Outside a trusted local connection use https/TLS; authorization is
passed through Metadata and checked by the application handler.

`new GrpcClient(service, options)` takes the same ServiceDefinition as the controller.
Methods are chosen by key, originalName or the name from the RPC path; an
unknown/ambiguous method and a wrong call mode give a TypeError before the network.

| Call | Input | Result |
| --- | --- | --- |
| unary<Request, Response> | method, request, options? | Promise<GrpcResponse<Response>> |
| serverStream<Request, Response> | method, request, options? | GrpcResponseStream<Response> |
| clientStream<Request, Response> | method, Iterable/AsyncIterable<Request>, options? | Promise<GrpcResponse<Response>> |
| bidi<Request, Response> | method, Iterable/AsyncIterable<Request>, options? | GrpcResponseStream<Response> |

GrpcResponse holds data, metadata and trailers. GrpcResponseStream is a single-use
AsyncIterable with metadata/trailers promises and cancel(). Read the stream to the end
or cancel it; an early exit from for-await cancels the RPC. Success is confirmed only
after a full read, the framing/cardinality check and grpc-status=0.
A non-zero status is a GrpcError, and its metadata holds the trailers. Elements of a
streaming response received before the error are not discarded. The generic types are
the caller's responsibility; the codec checks the wire data, and TypeScript clients are
not generated.

| GrpcClientOptions | Default | Rules |
| --- | --- | --- |
| address | Required | host:port, http://host:port or https://host:port; no credentials/path/query/fragment |
| tls | None | ca, cert, key: string/Buffer; servername: string; https only, certificate verification is always on |
| metadata | Empty Metadata | A snapshot; call metadata adds to the values |
| timeoutMs | 30000 | An integer 1..2147483647; covers the connection, the upload and reading the response |
| maxSendMessageLength / maxReceiveMessageLength | 4 MiB each | An integer 0..2147483647 bytes, the length is checked before the receive buffer is allocated |
| maxConcurrentCalls | 1024 | A positive safe integer; overflow gives RESOURCE_EXHAUSTED, no queue |

GrpcCallOptions: metadata, timeoutMs (replaces the default), deadline (a Date or a finite
epoch-ms number; the minimum with the timeout is used), signal (AbortSignal).
Null, unknown options and invalid values are rejected. Cancellation gives CANCELLED, an
expired deadline DEADLINE_EXCEEDED; closing the client cancels active calls.
close()/dispose() are idempotent and final; activeCalls shows the number of RPCs.

One client lazily reuses an HTTP/2 session. GOAWAY separates the leaving session: new
RPCs use a new one, started ones are not retried. There are no automatic retries,
because a network error does not prove the absence of a remote side effect.
A streaming upload requests the next element after the write callback; a download is
read on the consumer's demand, without an own unbounded queue.
After cancellation iterator.return() is called best-effort, without delaying completion
on an arbitrary user iterator. Never-finishing user code cannot be stopped by force; it
must honor its own cancellation.

`grpcClientProvider(service, options, token = GrpcClient)` returns a regular singleton
factory provider of the existing DI. Each container owns its client and calls
dispose(); no connection is opened at registration. Several services use different DI
tokens and regular imports/exports.
HTTP/2 push is off; the inbound header list is declared as 8192 bytes and limited to 128
pairs. These transport limits do not replace application authorization.

## Inputs and fields

### DTO binding and validation (change of 2026-09-26)

Implemented in the existing atomic module; the checks are listed below.
Components: decorators/contracts, GrpcServer/GrpcCall, GrpcRequestBinding, the regular
di:generate and runApp. The existing HTTP modelBinder and ModelValidator are used, not a
new engine. Shared generated request shapes provide nested DTOs/arrays. The binding to
the exact controller class is published through the existing generated provider
attachment channel, atomically with the rest of the target.

| Input | Default / null | Behavior |
| --- | --- | --- |
| The first @GrpcMethod parameter: a DTO class | No binding for an interface/inline object | di:generate binds the class to the handler; for AsyncIterable<DTO> the stream element is bound; an ambiguous union/intersection with a DTO is a codegen error |
| @GrpcMethod(name?, requestModel?) | An optional second argument; null is forbidden | An explicit class with a no-argument constructor; wins over codegen inference; the old call with a name is kept |
| GrpcModuleOptions.validator | modelValidatorAdapter; null is forbidden | The existing synchronous ModelValidator; captured by the server, not taken from the global HTTP bridge |
| RunAppOptions.validator | modelValidatorAdapter | Used by HTTP and gRPC, including gRPC-only; grpc.validator allows an explicit replacement for gRPC only |

The DTO is created and checked before the unary/server-streaming handler. For an input
stream each consumed message is checked before it is passed to the handler.
An error aborts the RPC even if the handler caught the iterator error. Messages the
handler did not read are not drained; earlier side effects are not rolled back.
Output DTOs are not checked automatically. Async custom validators are not included:
the same synchronous port as in HTTP applies.

Unknown fields are removed; bigint is kept, Buffer/Uint8Array bytes are copied in a
special internal binder mode (the HTTP JSON behavior does not change).
Protobuf defaults apply before DTO binding; then the DTO initializers are used for
missing fields. `required` checks undefined/null but does not forbid an empty string or
0: with defaults:true you need notEmpty/minLength and positive/min.
To control presence use optional protobuf fields or defaults:false.
The nullability of nested DTOs is fixed by the generated shape from the type; required
and the other value checks are set by validator rules, not by a TS type alone.
Field errors → INVALID_ARGUMENT (3), the message `Request validation failed.`; the
trailer `bazis-validation-errors-bin` is UTF-8 JSON `{ errors, truncated }` with
`property/message/code?` elements, at most 4096 bytes of JSON. Long strings and the list
are truncated with `truncated: true`; input field values are not added automatically.
Other validator/DI errors stay a hidden INTERNAL. Processing is bounded to one message,
without buffering the whole stream; the existing binder depth/complexity limits and the
transport sizes are kept. No load SLA is claimed.

The email/minLength/positive rules are described with the existing @Validator in a
runtime class. `.proto` defines the wire format; its arbitrary field options do not run
these rules. Automatic binding needs up-to-date codegen; standalone without codegen
passes requestModel explicitly (complex nested DTOs need generated shapes or
initialized nested instances).

Null is not part of the contract of the listed fields. Unknown fields of the top-level
options create no new capabilities. Unknown serverOptions and ProtoLoaderOptions are
rejected. Library types and an opaque passthrough of foreign settings were removed.

| Input | Type / source | Required / default | Rules / result |
| --- | --- | --- | --- |
| @Module.grpcControllers | readonly Class[] | [] | Classes with @GrpcController; scoped for the whole RPC; repeats in one array are removed |
| @GrpcController(service) | ServiceDefinition | Required | A non-empty map: path `/package.Service/Method`, requestStream/responseStream, protobuf codecs; a snapshot |
| @GrpcMethod(name?, requestModel?) | A string, an optional DTO class | The TS method name, the DTO from codegen | A public instance method; key, originalName or the RPC name from the path; unknown/ambiguous names are forbidden; an explicit DTO wins |
| grpcService(definition, serviceName) | PackageDefinition, the full name | Both required | A ServiceDefinition, or TypeError if the name does not point to a service |
| loadGrpcPackage(filename, options?) | string or readonly string[], ProtoLoaderOptions | filename is required | Own proto3 loader, option fields below |
| imports | readonly BazisModuleRef[] | [] | Publishes only the chosen tree; modules are deduplicated |
| controllers | readonly Class[] | [] | An alternative to feature registration; the owner is the transport module |
| validator | ModelValidator | modelValidatorAdapter | Synchronous check of the bound DTO; each server has its own instance |
| address | config string | 127.0.0.1:50051 | host:port or [IPv6]:port; port 0 picks a free one; unix sockets/DNS resolver schemes are not supported |
| credentials | ServerCredentials | createInsecure() | Plaintext by default; createSsl(...) for TLS/mTLS |
| serverOptions | Own ServerOptions | 4 MiB receive/send each; 1024 HTTP/2 streams per session | Only grpc.max_receive_message_length, grpc.max_send_message_length (an integer 0..2147483647 bytes), grpc.max_concurrent_streams (an integer 1..4294967295) |
| maxConcurrentCalls | A positive safe integer | 1024 | Overflow → RESOURCE_EXHAUSTED before a scope is created |
| shutdownTimeoutMs | An integer 1..2147483647, ms | 5000 | The grace period; expiry → forceShutdown and a stop error |
| phase | A safe integer | 10 | Infrastructure starts earlier and stops later |

ProtoLoaderOptions: keepCase, defaults, arrays, objects, oneofs are optional booleans,
false by default. snake_case fields are converted to camelCase by default. defaults fills
missing regular scalars; optional/oneof keep presence. arrays/objects add empty
repeated/maps. longs takes BigInt (default), String or Number; BigInt/String keep 64-bit
precision, Number may lose it. enums is Number (default) or String; bytes is Buffer
(default), String (base64) or Array. includeDirs is an array of non-empty paths for
imports. Unknown options are a load error.

An explicitly described proto3 profile is supported: scalar types, message/enum, nested
types, repeated (packed/unpacked), map, oneof, optional, service/rpc and file
imports/public imports. Calls may pass ready ServiceDefinitions and own codecs without
the loader. Proto2/editions/extensions/groups, weak imports and a built-in catalog of
well-known .proto files are not implemented.
Google types need provided proto3 files; no special JSON conversion of Timestamp/Any was
added. Message/enum reflection descriptors of a third-party SDK are not an bazis contract.

The codec ignores unknown object fields on encode and skips unknown protobuf fields with
wire types 0/1/2/5 on decode; groups (3/4) are rejected.
Invalid UTF-8, varints, lengths, wire types and integer ranges are rejected.
Safe integer inputs are number, bigint and a decimal string; an imprecise number for 64
bits is rejected. The depth of messages/imports is limited to 64, the number of schema
files to 256, one schema file to 4 MiB, the whole schema graph to 16 MiB; a codec message
to 64 MiB. The default transport limits are stricter (4 MiB).

Every method of a protobuf service must have one @GrpcMethod. A route repeated across
published controllers, a missing method and a double registration through
providers/grpcControllers fail the build. Metadata is inherited copy-on-write;
overriding a method does not change the base class.

| RPC kind | Method arguments | Return value |
| --- | --- | --- |
| Unary | request, context | a response or a Promise of a response |
| Server streaming | request, context | an AsyncIterable of responses |
| Client streaming | an AsyncIterable of requests, context | a response or a Promise of a response |
| Bidirectional | an AsyncIterable of requests, context | an AsyncIterable of responses |

Wire message fields and defaults are defined by `.proto` and the codec. When a DTO class
is bound, the shared binder creates an instance, removes unknown fields and checks
@Validator. An interface/inline object without an explicit binding keeps the former raw
protobuf path, without automatic DTO validation. HTTP routes/@Authorize do not apply.
Access and extra domain invariants stay with the application.

GrpcContext is passed as the second argument: metadata is the incoming Metadata;
signal is the cancellation AbortSignal; deadline is a Date/number (currently epoch ms),
Infinity without a deadline; peer is the transport address; path is the full RPC path;
sendMetadata(Metadata) sends the initial headers. Metadata does not prove an authorized
identity. The own Metadata provides set/add/get/remove/getMap/clone/merge.
Text values are printable ASCII; -bin keys need a Buffer and are base64-encoded on the
wire; the input accepts padded/unpadded and repeated binary headers.
Application metadata does not override the controlling HTTP/2/gRPC headers.

GrpcError(code, message, metadata?): code is an integer status 1..16, message a public
string, metadata optional trailers. OK/invalid codes are forbidden.
Regular exceptions, DI/disposal errors and a wrong streaming return → INTERNAL with the
message `Internal server error.` without internal details.

## Lifecycle and limits

start opens the listener. stop stops new calls and waits for the transport/handlers.
A startup cancellation signal leaves no late-opened port. Repeated starts during startup
and stop join the work; restarting a stopped instance is forbidden. A bind error is not
counted as a start.

The scope is released after the handler/generator and before the regular final
response/status, including errors. On deadline/cancel the response may end before the
handler, but the scope is held until it finishes. The input iterator keeps duplex after
reading ends. Cancellation wakes a waiting read/write and reaches the handler through
the signal. Arbitrary code is not interrupted by force: the handler must honor the
signal. Its scope/slot are held until it finishes; a shutdown timeout reports an error,
not a clean drain. If the whole kernel ends abnormally, the shared container dispose stays
the final owner of the resources; continuing a non-cancellable handler is not guaranteed.

The transport uses the standard gRPC envelope (flag + uint32 BE length), HTTP/2 POST and
grpc-status/grpc-message trailers; all four RPC modes are supported.
Transfer is identity: compression is rejected with UNIMPLEMENTED. An unknown method is
UNIMPLEMENTED, a wrong content-type HTTP 415, a corrupted payload INTERNAL, an exceeded
limit RESOURCE_EXHAUSTED, a shutdown UNAVAILABLE.
The server grpc-timeout supports H/M/S/m/u/n and aborts the signal without a client
timer. RST_STREAM/a broken connection also cancel the RPC.

The transport adds no retries and no transactions; a deadline does not roll back domain
effects. Reflection, grpc.health.v1, server interceptors and automatic retry/load
balancing are not added. Client registration uses the existing DI through
grpcClientProvider, not a separate container system.
The own ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate)
passes TLS/mTLS to the built-in HTTP/2. The client was also checked against an
independent HTTP/2 TLS server: a trusted certificate, a wrong hostname, an untrusted CA,
a mandatory client certificate. The test's local certificates are generated by the system
openssl; it is not a runtime dependency and not an external gRPC/protobuf SDK.
A separate qualification of production certificates/policies is not claimed.

Wire rules: [gRPC HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md),
[protobuf encoding](https://protobuf.dev/programming-guides/encoding/).
If grpc-status is missing, the client uses the standard
[HTTP → gRPC mapping](https://grpc.github.io/grpc/core/md_doc_http-grpc-status-mapping.html).
The own implementation does not claim to pass the full upstream conformance suite.

## Checks

Environment: the qualified Bun 1.4.0, macOS arm64; loopback without databases/containers.
The test HTTP/2 peer and the Echo protobuf codec are independent of the production codec:
external gRPC/protobuf SDKs are not used even for checks.
[Integration tests](test/grpc.integration.test.ts): four modes, metadata, private DI,
scope/dispose, errors, deadline/cancel, limits and the shutdown timeout.
[Wire tests](test/grpc.wire.test.ts): fragmentation, corrupted messages, limits,
headers/trailers, a server deadline without a client timer, shutdown.
[Protobuf tests](test/protobuf.test.ts): golden bytes, all scalar families,
nested/repeated/map/oneof, imports, unknown fields and negative scenarios.
[Client tests](test/grpc.client.test.ts): four modes, aliases, metadata, errors and
partial responses, a 256 KiB message through the HTTP/2 flow-control window,
cancellation/deadline, limits, an uncooperative producer, DI/isolation/dispose.
[Client wire](test/grpc.client-wire.test.ts): fixed protobuf bytes, fragmentation,
invalid/missing status, HTTP mapping, GOAWAY without retries, full duplex, backpressure
and an early rejection during upload. RST_STREAM was checked with raw HTTP/2 frames
through a TCP peer, independently of Bun's server close().
[TLS/mTLS](test/grpc.client-tls.test.ts): trust/hostname/client-certificate checks.
[DTO validation](test/grpc.validation.test.ts): rejection before the unary handler is
activated, all streaming modes and the non-suppressible iterator error, validator
isolation, nested DTOs/arrays, bytes/bigint, bounded metadata and negative settings.
[DTO codegen](test/grpc.codegen.test.ts): type aliases, inherited methods, DTOs with the
same name in different files, rejection of an ambiguous union and of a non-exported
implicit DTO before generated output is written.
[Codegen/binary](test/grpc.codegen-binary.test.ts): a separate copy of the framework, the
real generator, private controller DI and constructor DI of the own client, four client
modes, HTTP + gRPC, a binary without sources and without the external `.proto`.
After runApp the automatic client dispose is checked.
The check of 2026-09-26 additionally proves generated DTO binding, nested validation,
four RPC modes, the shared RunAppOptions.validator and the grpc.validator override in a
binary without sources, node_modules and the external .proto.
Generated files are not edited by hand.

```sh
BAZIS_BUN_BIN=<qualified-absolute-path> ./scripts/bazis-bun test --isolate --timeout 60000 ./src/bazis/core/grpc/test
./scripts/bazis-bun run di:generate --target all
./scripts/bazis-bun x --no-install tsc --noEmit
./scripts/bazis-bun run build:bin:app
```

Results of the change as of 2026-09-26, Bun 1.4.0 with the SHA/revision from toolchain/bun.json:

| Check | Result |
| --- | --- |
| All of gRPC, including the new DTO/codegen and the binary smoke test | 54 PASS / 0 FAIL |
| gRPC + HTTP + app + DI + generated runtime + validation + request/codegen/import-boundary | 493 PASS / 1 FAIL, 2387 assertions, 52 files |
| di:generate --target all | PASS, production/test, 21 outputs |
| Full tsc --noEmit | PASS |
| build:bin:app | PASS, 666 modules; the live application with a database was not run |
| An independent binary without source/node_modules/.proto | PASS: all four RPCs, nested DTOs/arrays, bytes/bigint; HTTP+gRPC, gRPC-only, a custom validator and the grpc override |
| External dependencies in gRPC runtime/types/tests | PASS, no new dependencies |

The only current FAIL is the existing `src/bazis/cli/moduleRegistration.ts` in the check
of the codegen-only TypeScript import list; it did not change. The first shared run also
stopped on the standard 5-second timeout of the existing full-scan codegen test; a rerun
with `--timeout 60000` passed.
The final run log: `/private/tmp/bazis-grpc-validation-final-20260926.log`.
The formal commands used the qualified runtime
`/private/tmp/bazis-grpc-validation-runtime.OxLFok/bun`; the temporary path is not part
of the configuration/contract and may be cleaned up.

Historical results as of 2026-09-20 (not a confirmation of the 2026-09-26 change):

| Check | Result |
| --- | --- |
| gRPC: 14 integration + 6 wire + 7 protobuf + 8 client + 9 client-wire + TLS + codegen/binary | 46 PASS / 0 FAIL, 297 assertions, 7 files |
| DI/HTTP/app/public DX/gRPC + import boundary, exact ./src directories | 421 PASS / 1 FAIL, 2103 assertions, 44 files |
| Ban on external runtime dependencies and gRPC imports (including types/tests) | PASS, no exceptions for gRPC |
| di:generate --target all | PASS, production and test, 21 outputs |
| Full tsc --noEmit | PASS |
| build:bin:app | PASS, bin/bazis-app, 614 modules |
| An isolated binary after removing sources, node_modules and .proto | PASS: HTTP + gRPC and separately gRPC-only; the own client through DI |

The only FAIL of the shared import-boundary check is the existing TypeScript import in
`src/bazis/cli/moduleRegistration.ts`, missing from its list of codegen-only exceptions.
This CLI file did not change in that task; the limitation was neither hidden nor fixed by
extending the gRPC scope. The new transport passes the checks of allowed dependencies and
of no compiler API in the runtime graph.
The full application with real databases/infra was not run; the controlled binary smoke
test uses the real runApp, DI, HTTP/gRPC and protobuf fixtures.

The historical run log: `/private/tmp/bazis-grpc-client-regressions-20260920.log`
(temporary, may be cleaned up). Results of the former implementation with external
packages are not evidence for this version.
When directories are passed to Bun test, the `./` prefix is used so the filter picks the
directory rather than any path substring match.

Load SLAs, other OSes, production certificates/policies and production deployment were
not checked. The TLS qualification here applies to the client and an independent TLS
peer, not to the full application infrastructure.
A new port of the live application is enabled only with the explicit grpc option.
An authorized change: library types and passthrough options were removed by the owner's
direct decision; the controller, DI and runApp APIs are kept. The codec does not promise
full compatibility with all protobuf dialects and all SDK capabilities.
The other architecture rules are kept.
