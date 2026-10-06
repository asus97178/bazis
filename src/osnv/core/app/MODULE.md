# Application composition

Passport version: 1.1. Date: 2026-09-26. Type: existing technical composition module.
Path: `src/osnv/core/app`. Entry point: [runApp.ts](runApp.ts).
Scope: adding `RunAppOptions.grpc`; the other HTTP/UI/infra options are described
in the source contracts. The module existed before CLI generation became mandatory.

runApp assembles the feature root, the infrastructure and the explicitly enabled
server transports in one kernel. An optional `grpc?: GrpcModuleOptions` was added.
Fields, defaults, errors and limits are in the [gRPC passport](../grpc/MODULE.md).
Since 2026-09-20 gRPC uses osnv's own contracts/codecs and the built-in HTTP/2
without external libraries; the shape of RunAppOptions.grpc is kept. The types and
SDK-specific passthrough options of the third-party SDK were removed by the owner's decision.
undefined does not start gRPC; `{}` enables a 127.0.0.1:50051 listener and the
controllers of the feature root; null is not allowed.

With both http and grpc, the servers share one container and use separate request
scopes. grpc.imports extend the published gRPC tree; http.imports keep their
purpose. Ownership of providers, kernel configuration and imports/exports is unchanged.

`RunAppOptions.validator` sets the existing synchronous ModelValidator for
HTTP and gRPC; the default is modelValidatorAdapter. A gRPC-only app gets the same
adapter. An optional `grpc.validator` replaces it for gRPC only (null is
forbidden). Each server captures its validator when created: a later HTTP
useModelValidator call does not switch a running gRPC server. A DTO needs a binding
by parameter class through di:generate or an explicit second @GrpcMethod argument.
DTO errors map to INVALID_ARGUMENT with bounded field errors, not to HTTP 400;
details and streaming semantics are in the gRPC passport.

```ts
await runApp(AppModule, {
  http: { port: 3000 },
  grpc: { address: "127.0.0.1:50051" },
});
```

Components of the change: RunAppOptions and the composition before osnv.run.
There are no new providers/ORM/UI/AI handlers of its own. DI exports and lifecycle
belong to the existing kernel and transports. The osnv TS facade also exports the
gRPC decorators and contracts. runApp still returns Promise<number> under the
existing osnv.run contract; startup errors are never treated as success.

Checks of HTTP + gRPC, private constructor DI and a standalone binary:
[grpc.codegen-binary.test.ts](../grpc/test/grpc.codegen-binary.test.ts).
Regular checks: [runApp.config.test.ts](test/runApp.config.test.ts).
Baseline before the change: full TypeScript check PASS. Results are recorded in the
gRPC passport; the change does not qualify the application's external infrastructure.
