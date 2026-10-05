import { registerGeneratedBindings } from "../Binding/autoBindings";
import { expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, type DiContainer } from "@/core/di";
import {
  All,
  ApiVersion,
  Controller,
  Get,
  Head,
  HttpContext,
  HttpServer,
  Post,
  Put,
  httpModule,
  type HttpModuleOptions,
} from "../index";
import { PayloadTooLargeError } from "../Errors/HttpError";

@Controller("limits")
class BodyLimitController {
  @Post("default")
  async defaultBody(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Post("large", { maxBodySize: "4kb" })
  async large(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Post("save", { maxBodySize: "4mb" })
  async save(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Post("lower", { maxBodySize: "4b" })
  async lower(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Post("json", { maxBodySize: "4kb" })
  async json(ctx: HttpContext) { const body = await ctx.json() as { value: string }; return { length: body.value.length }; }

  @Post("text", { maxBodySize: "4kb" })
  async text(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Post("form", { maxBodySize: "4kb" })
  async form(ctx: HttpContext) {
    const data = await ctx.formData();
    return { length: String(data.get("value") ?? "").length };
  }

  @Get("same", { maxBodySize: "4kb" })
  getSame() { return "get"; }

  @Head("same", { maxBodySize: "2kb" })
  headSame() { return "head"; }

  @Get("head-fallback", { maxBodySize: "4kb" })
  headFallback() { return "fallback"; }

  @Put("head-fallback", { maxBodySize: "1kb" })
  putHeadFallback() { return "put"; }

  @Put("same", { maxBodySize: "1kb" })
  async putSame(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @All("priority", { maxBodySize: "2kb" })
  async allPriority(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Put("priority", { maxBodySize: "1kb" })
  async putPriority(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @All("head-all", { maxBodySize: "2kb" })
  headAll() { return "all"; }

  @Put("head-all", { maxBodySize: "1kb" })
  putHeadAll() { return "put"; }
}
// Unit fixture for the generated registry; real inference is covered by codegen-dx.integration.test.ts.
registerGeneratedBindings(BodyLimitController, {
  defaultBody: [{source: "context"}],
  large: [{source: "context"}],
  save: [{source: "context"}],
  lower: [{source: "context"}],
  text: [{source: "context"}],
  form: [{source: "context"}],
  putSame: [{source: "context"}],
  allPriority: [{source: "context"}],
  putPriority: [{source: "context"}],
}, new Map([]));

@Controller("versions")
class UnversionedController {
  @Put("fallback", { maxBodySize: "1kb" })
  async fallback(ctx: HttpContext) { return { length: (await ctx.text()).length }; }
}
registerGeneratedBindings(UnversionedController, {
  fallback: [{source: "context"}],
}, new Map([]));

@Controller("versions")
@ApiVersion("2")
class VersionTwoController {
  @Put("fallback", { maxBodySize: "2kb" })
  async fallback(ctx: HttpContext) { return { length: (await ctx.text()).length }; }

  @Put("only", { maxBodySize: "4kb" })
  async only(ctx: HttpContext) { return { length: (await ctx.text()).length }; }
}
registerGeneratedBindings(VersionTwoController, {
  fallback: [{source: "context"}],
  only: [{source: "context"}],
}, new Map([]));

@Module({ controllers: [BodyLimitController, UnversionedController, VersionTwoController] })
class BodyLimitControllersModule {}

interface StartedServer {
  readonly server: HttpServer;
  readonly base: string;
  dispose(): Promise<void>;
}

async function startServer(options: Omit<HttpModuleOptions, "imports" | "controllers" | "port">): Promise<StartedServer> {
  @Module({
    imports: [httpModule({
      ...options,
      imports: [BodyLimitControllersModule],
      port: 0,
      versioning: options.versioning ?? { source: "header", headerName: "x-api-version" },
    })],
  })
  class App {}
  const container: DiContainer = createContainer(App, { validateOnBuild: true });
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    dispose: async () => {
      await server.stop();
      await container.dispose();
    },
  };
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const split = Math.floor(bytes.byteLength / 2);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
}

async function post(
  base: string,
  path: string,
  body: NonNullable<RequestInit["body"]>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", body, headers: { connection: "close", ...headers } });
}

async function expect413(response: Response, maxBytes: number): Promise<void> {
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "Payload Too Large", details: { maxBytes } });
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

async function rawHead(base: string, path: string, contentLength: number): Promise<{ status: number; headers: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    let response = "";
    let settled = false;
    const finish = (result: { status: number; headers: string } | Error) => {
      if (settled) return;
      settled = true;
      result instanceof Error ? reject(result) : resolve(result);
    };
    void Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        binaryType: "uint8array",
        open(socket) {
          socket.write(
            `HEAD ${path} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: ${contentLength}\r\nConnection: close\r\n\r\n${"x".repeat(contentLength)}`,
          );
        },
        data(socket, data) {
          response += new TextDecoder().decode(data);
          const headerEnd = response.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const [statusLine] = response.split("\r\n", 1);
          const status = Number(statusLine?.split(" ")[1]);
          finish({ status, headers: response.slice(0, headerEnd) });
          socket.end();
        },
        error(_socket, error) { finish(error); },
        close() {
          if (!settled) finish(new Error("Raw HEAD socket closed before a response."));
        },
      },
    }).catch(finish);
  });
}

test("declared bodies use selected route cap while default and lower routes retain their own limits", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    await expect413(await post(app.base, "/limits/default", "x".repeat(33)), 32);
    expect((await (await post(app.base, "/limits/default", "x".repeat(32))).json()) as unknown).toEqual({ length: 32 });
    expect((await (await post(app.base, "/limits/large", "x".repeat(4_096))).json()) as unknown).toEqual({ length: 4_096 });
    await expect413(await post(app.base, "/limits/large", "x".repeat(4_097)), 4_096);
    expect((await (await post(app.base, "/limits/lower", "xxxx")).json()) as unknown).toEqual({ length: 4 });
    await expect413(await post(app.base, "/limits/lower", "xxxxx"), 4);
  } finally {
    await app.dispose();
  }
});

test("global zero stays disabled while a positive route override remains enforced", async () => {
  const app = await startServer({ maxBodyBytes: 0 });
  try {
    expect((await (await post(app.base, "/limits/default", "x".repeat(5_000))).json()) as unknown).toEqual({ length: 5_000 });
    await expect413(await post(app.base, "/limits/large", "x".repeat(4_097)), 4_096);
  } finally {
    await app.dispose();
  }
});

test("actual default 1MiB accepts its declared boundary", async () => {
  const app = await startServer({});
  try {
    expect(await (await post(app.base, "/limits/default", "x".repeat(1_048_576))).json()).toEqual({ length: 1_048_576 });
  } finally {
    await app.dispose();
  }
});

test("actual default 1MiB rejects its declared boundary plus one", async () => {
  const app = await startServer({});
  try {
    await expect413(await post(app.base, "/limits/default", "x".repeat(1_048_577)), 1_048_576);
  } finally {
    await app.dispose();
  }
});

test("declared 4MiB route accepts its exact boundary", async () => {
  const app = await startServer({});
  try {
    expect(await (await post(app.base, "/limits/save", "x".repeat(4_194_304))).json()).toEqual({ length: 4_194_304 });
  } finally {
    await app.dispose();
  }
});

test("declared 4MiB route rejects its boundary plus one", async () => {
  const app = await startServer({});
  try {
    await expect413(await post(app.base, "/limits/save", "x".repeat(4_194_305)), 4_194_304);
  } finally {
    await app.dispose();
  }
});

test("chunked default 1MiB accepts its boundary", async () => {
  const app = await startServer({});
  try {
    expect(await (await post(app.base, "/limits/default", stream("x".repeat(1_048_576)))).json()).toEqual({ length: 1_048_576 });
  } finally {
    await app.dispose();
  }
});

test("chunked default 1MiB rejects its boundary plus one", async () => {
  const app = await startServer({});
  try {
    await expect413(await post(app.base, "/limits/default", stream("x".repeat(1_048_577))), 1_048_576);
  } finally {
    await app.dispose();
  }
});

test("chunked 4MiB route accepts its exact boundary", async () => {
  const app = await startServer({});
  try {
    expect(await (await post(app.base, "/limits/save", stream("x".repeat(4_194_304)))).json()).toEqual({ length: 4_194_304 });
  } finally {
    await app.dispose();
  }
});

test("chunked 4MiB route rejects its boundary plus one", async () => {
  const app = await startServer({});
  try {
    await expect413(await post(app.base, "/limits/save", stream("x".repeat(4_194_305))), 4_194_304);
  } finally {
    await app.dispose();
  }
});

test("chunked JSON reader accepts its exact route boundary", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    const jsonAtLimit = JSON.stringify({ value: "x".repeat(4_084) });
    expect(Buffer.byteLength(jsonAtLimit)).toBe(4_096);
    const jsonOk = await post(app.base, "/limits/json", stream(jsonAtLimit), { "content-type": "application/json" });
    expect(await jsonOk.json()).toEqual({ length: 4_084 });
  } finally {
    await app.dispose();
  }
});

test("chunked JSON reader rejects its route boundary plus one", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    const jsonAtLimit = JSON.stringify({ value: "x".repeat(4_084) });
    await expect413(await post(app.base, "/limits/json", stream(`${jsonAtLimit} `), { "content-type": "application/json" }), 4_096);
  } finally {
    await app.dispose();
  }
});

test("chunked text reader accepts its exact route boundary", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    const textOk = await post(app.base, "/limits/text", stream("x".repeat(4_096)), { "content-type": "text/plain" });
    expect(await textOk.json()).toEqual({ length: 4_096 });
  } finally {
    await app.dispose();
  }
});

test("chunked text reader rejects its route boundary plus one", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    await expect413(await post(app.base, "/limits/text", stream("x".repeat(4_097)), { "content-type": "text/plain" }), 4_096);
  } finally {
    await app.dispose();
  }
});

test("chunked formData reader accepts its exact route boundary", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    const formAtLimit = `value=${"x".repeat(4_090)}`;
    expect(Buffer.byteLength(formAtLimit)).toBe(4_096);
    const formOk = await post(app.base, "/limits/form", stream(formAtLimit), { "content-type": "application/x-www-form-urlencoded" });
    expect(await formOk.json()).toEqual({ length: 4_090 });
  } finally {
    await app.dispose();
  }
});

test("chunked formData reader rejects its route boundary plus one", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    const formAtLimit = `value=${"x".repeat(4_090)}`;
    await expect413(await post(app.base, "/limits/form", stream(`${formAtLimit}x`), { "content-type": "application/x-www-form-urlencoded" }), 4_096);
  } finally {
    await app.dispose();
  }
});

test("unmatched, malformed, 405 and unsupported-version responses keep the global precedence", async () => {
  const app = await startServer({ maxBodyBytes: 32 });
  try {
    await expect413(await post(app.base, "/missing", "x".repeat(33)), 32);
    expect((await post(app.base, "/missing", "x")).status).toBe(404);
    await expect413(await post(app.base, "/bad/%zz", "x".repeat(33)), 32);
    expect((await post(app.base, "/bad/%zz", "x")).status).toBe(400);

    const method = await fetch(`${app.base}/limits/same`, { method: "DELETE", body: "x".repeat(33) });
    await expect413(method, 32);
    expect((await fetch(`${app.base}/limits/same`, { method: "DELETE", body: "x" })).status).toBe(405);

    const unsupported = await fetch(`${app.base}/versions/only`, { method: "PUT", headers: { "x-api-version": "9" }, body: "x".repeat(33) });
    await expect413(unsupported, 32);
    expect((await fetch(`${app.base}/versions/only`, { method: "PUT", headers: { "x-api-version": "9" }, body: "x" })).status).toBe(400);
  } finally {
    await app.dispose();
  }
});

test("router-selected fallback, explicit method and All priority determine the cap", async () => {
  const app = await startServer({ maxBodyBytes: 64 });
  try {
    const fallback = await fetch(`${app.base}/versions/fallback`, { method: "PUT", headers: { "x-api-version": "9" }, body: "x".repeat(1_025) });
    await expect413(fallback, 1_024);
    const exactVersion = await fetch(`${app.base}/versions/fallback`, { method: "PUT", headers: { "x-api-version": "2" }, body: "x".repeat(1_500) });
    expect(await exactVersion.json()).toEqual({ length: 1_500 });
    await expect413(await fetch(`${app.base}/limits/same`, { method: "PUT", body: "x".repeat(1_025) }), 1_024);
    await expect413(await fetch(`${app.base}/limits/priority`, { method: "PUT", body: "x".repeat(1_025) }), 1_024);
    const all = await fetch(`${app.base}/limits/priority`, { method: "PATCH", body: "x".repeat(1_500) });
    expect(await all.json()).toEqual({ length: 1_500 });
  } finally {
    await app.dispose();
  }
});

test("live HEAD selects explicit, GET-fallback and All action caps before the length guard", async () => {
  const app = await startServer({ maxBodyBytes: 64 });
  try {
    for (const [path, limit] of [["/limits/same", 2_048], ["/limits/head-fallback", 4_096], ["/limits/head-all", 2_048]] as const) {
      const atLimit = await rawHead(app.base, path, limit);
      expect(atLimit.status).toBe(200);
      expect(atLimit.headers.toLowerCase()).toContain("x-content-type-options: nosniff");
      const overflow = await rawHead(app.base, path, limit + 1);
      expect(overflow.status).toBe(413);
      expect(overflow.headers.toLowerCase()).toContain("content-type: application/json; charset=utf-8");
    }
  } finally {
    await app.dispose();
  }
});

test("health, docs and CORS preflight still short-circuit before the length guard", async () => {
  const app = await startServer({ maxBodyBytes: 4, health: true, docs: true, cors: { origin: "*" } });
  try {
    const declared = { "content-length": "5" };
    expect((await fetch(`${app.base}/health`, { method: "HEAD", headers: declared })).status).toBe(200);
    expect((await fetch(`${app.base}/docs`, { method: "HEAD", headers: declared })).status).toBe(200);
    const preflight = await fetch(`${app.base}/anything`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST" },
      body: "12345",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  } finally {
    await app.dispose();
  }
});

test("lying Content-Length cannot bypass the actual stream cap", async () => {
  const request = new Request("http://local/body", { method: "POST", headers: { "content-length": "1" }, body: "12345" });
  const ctx = new HttpContext(request, new URL(request.url), {}, {} as never, undefined, 4);
  await expect(ctx.text()).rejects.toMatchObject({ status: 413, details: { maxBytes: 4 } });
  expect(request.body?.locked).toBe(false);
});

test("never-settling or rejecting cancellation cannot hang 413 and reader lock is released", async () => {
  for (const cancelKind of ["pending", "reject"] as const) {
    let cancelCalls = 0;
    let reason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("12345")); },
      cancel(value) {
        cancelCalls += 1;
        reason = value;
        return cancelKind === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("cancel failed"));
      },
    });
    const request = new Request("http://local/body", { method: "POST", body });
    const ctx = new HttpContext(request, new URL(request.url), {}, {} as never, undefined, 4);
    const result = await Promise.race([
      ctx.text().then(() => "resolved", (error: unknown) => error),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(result).toBeInstanceOf(PayloadTooLargeError);
    expect((result as PayloadTooLargeError).details).toEqual({ maxBytes: 4 });
    expect(cancelCalls).toBe(1);
    expect(reason).toBe("request body exceeds maxBodyBytes");
    expect(request.body?.locked).toBe(false);
  }
});
