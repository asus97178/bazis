import { describe, expect, test } from "bun:test";
import { DI, Module, singleton } from "../../di";
import { AllowAnonymous, anyOf, Authorize, bearerToken, Controller, ForbiddenError, Get, UnauthorizedError, type AuthorizeCheck } from "../../http";
import type { Logger } from "../../kernel";
import { startTestApp, type TestApp } from "../../testing";
import { JwtExpiredError } from "../../../library/jwt";
import { GrpcClient, GrpcController, GrpcError, GrpcMethod, GrpcServer, GrpcStatus, Metadata, type GrpcContext } from "../index";
import { HOSTED_SERVICE } from "../../di";
import { echoService, type EchoMessage } from "./fixtures/contract";

// 0.98.32: @Authorize protects gRPC like HTTP with the same checks, unexpected
// handler failures are logged, and a failing GrpcClient call in an HTTP
// request answers 502/504 instead of 500.

class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  debug(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "debug", message, fields }); }
  info(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "info", message, fields }); }
  warn(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "warn", message, fields }); }
  error(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "error", message, fields }); }
}

/** One check for both transports: a token "admin" or "user" in the authorization header. */
const signedIn: AuthorizeCheck = (ctx) => {
  const token = bearerToken(ctx);
  if (token === "expired") throw new JwtExpiredError();
  if (token !== "admin" && token !== "user") throw new UnauthorizedError();
  ctx.state.set("role", token);
  return true;
};
const isAdmin: AuthorizeCheck = (ctx) => ctx.state.get("role") === "admin";
const neverForbidden: AuthorizeCheck = () => { throw new ForbiddenError(); };
const apiKey: AuthorizeCheck = (ctx) => { if (ctx.header("x-api-key") !== "k1") throw new UnauthorizedError(); return true; };

class Greeter { readonly calls: string[] = []; }

@GrpcController(echoService)
@Authorize(signedIn)
class SecureEchoController {
  constructor(private readonly greeter: Greeter) {}
  @GrpcMethod("Echo")
  echo(request: EchoMessage, context: GrpcContext): EchoMessage {
    if (request.text === "crash") throw new Error("database password=hunter2 refused");
    this.greeter.calls.push(String(context.state.get("role")));
    return { text: `${request.text}:${String(context.state.get("role"))}`, count: request.count };
  }
  @GrpcMethod("Expand") @Authorize(isAdmin)
  async *expand(request: EchoMessage): AsyncGenerator<EchoMessage> { yield { text: request.text, count: 1 }; }
  @GrpcMethod("Collect") @AllowAnonymous()
  async collect(requests: AsyncIterable<EchoMessage>): Promise<EchoMessage> { let count = 0; for await (const r of requests) count += r.count; return { text: "open", count }; }
  @GrpcMethod("Chat") @Authorize(anyOf(apiKey, neverForbidden))
  async *chat(requests: AsyncIterable<EchoMessage>): AsyncGenerator<EchoMessage> { for await (const r of requests) yield r; }
}
DI.bindDeps(SecureEchoController, Greeter);

@Module({ providers: [singleton(Greeter)], grpcControllers: [SecureEchoController], exports: [] })
class SecureModule {}

async function start(logger = new RecordingLogger()): Promise<{ app: TestApp; client: GrpcClient; logger: RecordingLogger; greeter: Greeter }> {
  const app = await startTestApp(SecureModule, { http: false, grpc: { address: "127.0.0.1:0" }, configure: (builder) => builder.useLogger(logger) });
  const server = app.container.resolveAll(HOSTED_SERVICE).find((service): service is GrpcServer => service instanceof GrpcServer)!;
  const client = new GrpcClient(echoService, { address: `127.0.0.1:${server.port}`, timeoutMs: 2000 });
  return { app, client, logger, greeter: app.container.resolve(Greeter) };
}
const token = (value: string): Metadata => { const metadata = new Metadata(); metadata.set("authorization", `Bearer ${value}`); return metadata; };
const code = (work: Promise<unknown>) => work.then(() => "OK", (error: unknown) => error instanceof GrpcError ? `${error.code} ${error.message}` : String(error));

describe("@Authorize on gRPC controllers", () => {
  test("the class check and the method check run like on HTTP; denial codes are gRPC ones", async () => {
    const { app, client, greeter } = await start();
    try {
      expect((await client.unary<EchoMessage, EchoMessage>("Echo", { text: "hi", count: 1 }, { metadata: token("user") })).data).toEqual({ text: "hi:user", count: 1 });
      expect(await code(client.unary("Echo", { text: "hi", count: 1 }))).toBe(`${GrpcStatus.UNAUTHENTICATED} Unauthenticated.`);
      expect(await code(client.unary("Echo", { text: "hi", count: 1 }, { metadata: token("expired") }))).toBe(`${GrpcStatus.UNAUTHENTICATED} Unauthenticated.`);
      const expand = async (who: string) => { const out: EchoMessage[] = []; for await (const m of client.serverStream<EchoMessage, EchoMessage>("Expand", { text: "x", count: 1 }, { metadata: token(who) })) out.push(m); return out.length; };
      expect(await code(expand("user"))).toBe(`${GrpcStatus.PERMISSION_DENIED} Permission denied.`);
      expect(await expand("admin")).toBe(1);
      expect((await client.clientStream<EchoMessage, EchoMessage>("Collect", [{ text: "", count: 2 }, { text: "", count: 3 }])).data).toEqual({ text: "open", count: 5 });
      // The handler did not run for the refused calls.
      expect(greeter.calls).toEqual(["user"]);
    } finally { client.close(); await app.stop(); }
  });

  test("anyOf: unauthenticated by every check is 16; forbidden by one is 7; text metadata reaches header()", async () => {
    const { app, client } = await start();
    const chat = async (metadata?: Metadata) => { const out: EchoMessage[] = []; for await (const m of client.bidi<EchoMessage, EchoMessage>("Chat", [{ text: "a", count: 1 }], metadata ? { metadata } : {})) out.push(m); return out.map((m) => m.text); };
    try {
      const withKey = token("user"); withKey.set("x-api-key", "k1");
      expect(await chat(withKey)).toEqual(["a"]);
      expect(await code(chat(token("user")))).toBe(`${GrpcStatus.PERMISSION_DENIED} Permission denied.`);
    } finally { client.close(); await app.stop(); }
  });
});

describe("unexpected gRPC failures are logged", () => {
  test("a handler exception is INTERNAL for the client and logged redacted; a GrpcError is not logged", async () => {
    const { app, client, logger } = await start();
    try {
      expect(await code(client.unary("Echo", { text: "crash", count: 0 }, { metadata: token("user") }))).toBe(`${GrpcStatus.INTERNAL} Internal server error.`);
      expect(await code(client.unary("Echo", { text: "x", count: 0 }))).toBe(`${GrpcStatus.UNAUTHENTICATED} Unauthenticated.`);
      const failures = logger.lines.filter((line) => line.message === "gRPC handler failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]!.fields).toMatchObject({ path: "/bazis.test.Echo/Echo", error: { message: "database password=*** refused" } });
      expect(JSON.stringify(logger.lines)).not.toContain("hunter2");
    } finally { client.close(); await app.stop(); }
  });
});

describe("a failing GrpcClient call inside an HTTP request", () => {
  test("is 502 Bad Gateway, 504 for a deadline, 502 when the service is down", async () => {
    @GrpcController(echoService)
    class SlowEcho {
      @GrpcMethod("Echo") async echo(request: EchoMessage): Promise<EchoMessage> {
        if (request.text === "missing") throw new GrpcError(GrpcStatus.NOT_FOUND, "No such message.");
        if (request.text === "slow") await Bun.sleep(500);
        return request;
      }
      @GrpcMethod("Expand") async *expand(): AsyncGenerator<EchoMessage> {}
      @GrpcMethod("Collect") async collect(): Promise<EchoMessage> { return { text: "", count: 0 }; }
      @GrpcMethod("Chat") async *chat(): AsyncGenerator<EchoMessage> {}
    }
    @Module({ grpcControllers: [SlowEcho], exports: [] })
    class Upstream {}
    const upstream = await startTestApp(Upstream, { http: false, grpc: { address: "127.0.0.1:0" } });
    const port = upstream.container.resolveAll(HOSTED_SERVICE).find((service): service is GrpcServer => service instanceof GrpcServer)!.port;
    const client = new GrpcClient(echoService, { address: `127.0.0.1:${port}`, timeoutMs: 100 });

    @Controller("proxy")
    class ProxyController {
      @Get("missing") async missing() { return (await client.unary("Echo", { text: "missing", count: 0 })).data; }
      @Get("slow") async slow() { return (await client.unary("Echo", { text: "slow", count: 0 })).data; }
      @Get("down") async down() { return (await new GrpcClient(echoService, { address: "127.0.0.1:1", timeoutMs: 500 }).unary("Echo", { text: "", count: 0 })).data; }
    }
    @Module({ controllers: [ProxyController], exports: [] })
    class Proxy {}
    const app = await startTestApp(Proxy, { http: {} });
    try {
      const missing = await app.fetch("/proxy/missing");
      expect(missing.status).toBe(502);
      expect(await missing.json()).toMatchObject({ error: "Bad Gateway" });
      expect((await app.fetch("/proxy/slow")).status).toBe(504);
      expect((await app.fetch("/proxy/down")).status).toBe(502);
    } finally { client.close(); await app.stop(); await upstream.stop(); }
  });
});
