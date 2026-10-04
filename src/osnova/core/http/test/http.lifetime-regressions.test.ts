import { describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import { Controller, File, Get, HttpServer, httpModule, type HttpContext } from "../index";
import { holdResponseScope } from "../HttpContext/responseLifetime";

const encoder = new TextEncoder();
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("lifetime did not settle within 500ms")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

class Resource {
  disposed = 0;
  delay?: Promise<void>;
  readonly done = deferred();
  async dispose() { this.disposed++; await this.delay; this.done.resolve(); }
}

async function start(produce: (ctx: HttpContext, resource: Resource) => unknown, shortCircuit = false, inspectableRedirects = false) {
  let resource!: Resource;
  @Controller("lifetime")
  class FixtureController {
    @Get()
    get(ctx: HttpContext) {
      resource = ctx.services.resolve(Resource);
      return produce(ctx, resource);
    }
  }
  @Module({
    imports: [httpModule({
      controllers: [FixtureController], port: 0, docs: false, inspectableRedirects,
      middleware: shortCircuit ? [async ctx => {
        resource = ctx.services.resolve(Resource);
        ctx.response = produce(ctx, resource) as Response;
      }] : undefined,
    })],
    providers: [DI.scoped(DI.classProvider(Resource, Resource))],
  })
  class App {}
  const container = createContainer(App);
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  return {
    url: `http://127.0.0.1:${server.port}/lifetime`,
    resource: () => resource,
    async close() { await server.stop(); await container.dispose(); },
  };
}

describe("HTTP-03: scope lives with the response producer", () => {
  test.each([false, true])("live delayed stream retains scoped services (middleware response=%s)", async shortCircuit => {
    const gate = deferred();
    const app = await start((_ctx, resource) => new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode("begin\n")); },
      async pull(c) {
        await gate.promise;
        c.enqueue(encoder.encode(resource.disposed ? "DISPOSED" : "ALIVE"));
        c.close();
      },
    })), shortCircuit);
    try {
      const response = await fetch(app.url);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("begin\n");
      expect(app.resource().disposed).toBe(0);
      gate.resolve();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ALIVE");
      expect((await reader.read()).done).toBe(true);
      await bounded(app.resource().done.promise);
      expect(app.resource().disposed).toBe(1);
    } finally { gate.resolve(); await app.close(); }
  });

  test("peer abort cancels a producer and disposes its scope once", async () => {
    const gate = deferred();
    let canceled = 0;
    const app = await start(() => new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode("begin\n")); },
      cancel() { canceled++; return gate.promise; },
    })));
    const controller = new AbortController();
    try {
      const response = await fetch(app.url, { signal: controller.signal });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await bounded(app.resource().done.promise);
      expect(app.resource().disposed).toBe(1);
      expect(canceled).toBe(1);
      await reader.cancel().catch(() => {});
    } finally { controller.abort(); gate.resolve(); await app.close(); }
  });

  test("negotiated redirect retains its scoped stream until peer abort", async () => {
    let canceled = 0;
    const app = await start(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode("redirect body")); },
      cancel() { canceled++; },
    }), { status: 302, headers: { location: "/final" } }), false, true);
    const controller = new AbortController();
    try {
      const response = await fetch(app.url, { redirect: "manual", signal: controller.signal, headers: { "x-osnova-redirect": "manual-v1" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-osnova-redirect-status")).toBe("302");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("redirect body");
      expect(app.resource().disposed).toBe(0);
      controller.abort();
      await bounded(app.resource().done.promise);
      expect(canceled).toBe(1);
      expect(app.resource().disposed).toBe(1);
      reader.releaseLock();
    } finally { controller.abort(); await app.close(); }
  });

  test("File helper preserves native ranges and content length", async () => {
    const path = new URL("./http.lifetime-regressions.test.ts", import.meta.url).pathname;
    const app = await start(() => File(path));
    try {
      const response = await fetch(app.url, { headers: { range: "bytes=0-9" } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes 0-9/${Bun.file(path).size}`);
      expect(response.headers.get("content-length")).toBe("10");
      expect(await response.text()).toBe((await Bun.file(path).text()).slice(0, 10));
      expect(app.resource().disposed).toBe(1);
    } finally { await app.close(); }
  });

  test("a directly returned ReadableStream also retains the scoped producer", async () => {
    const app = await start((_ctx, resource) => new ReadableStream({
      async start(c) {
        await Bun.sleep(15);
        c.enqueue(encoder.encode(resource.disposed ? "DISPOSED" : "ALIVE"));
        c.close();
      },
    }));
    try {
      expect(await (await fetch(app.url)).text()).toBe("ALIVE");
      await bounded(app.resource().done.promise);
      expect(app.resource().disposed).toBe(1);
    } finally { await app.close(); }
  });

  test.each(["eof", "error", "cancel", "abort", "already-aborted"] as const)("scope cleanup on %s runs once without locking the body", async outcome => {
    const resource = new Resource();
    const abort = new AbortController();
    const error = new Error("producer failed");
    const gate = deferred();
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(c) { input = c; }, cancel: () => gate.promise });
    if (outcome === "already-aborted") abort.abort(error);
    const response = new Response(source);
    const completion = holdResponseScope(response, abort.signal, () => resource.dispose());
    expect(source.locked).toBe(false);
    try {
      if (outcome === "cancel") void response.body!.cancel();
      else if (outcome === "abort" || outcome === "already-aborted") abort.abort(error);
      else {
        const read = response.text();
        if (outcome === "eof") input.close();
        if (outcome === "error") input.error(error);
        if (outcome === "eof") expect(await bounded(read)).toBe("");
        else await expect(bounded(read)).rejects.toBe(error);
      }
      await bounded(completion);
      abort.abort(error);
      expect(resource.disposed).toBe(1);
      // The lifecycle observer never takes a reader. A Response consumer may
      // retain its own reader after EOF; ownership belongs to that consumer.
    } finally { gate.resolve(); }
  });

  test("native Bun direct stream retains scope under backpressure", async () => {
    const gate = deferred();
    const app = await start((_ctx, resource) => new Response(new ReadableStream({
      type: "direct",
      async pull(c) {
        c.write("begin\n");
        await c.flush();
        await gate.promise;
        c.write(resource.disposed ? "DISPOSED" : "ALIVE");
        c.close();
      },
    })));
    try {
      const reader = (await fetch(app.url)).body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("begin\n");
      await Bun.sleep(20);
      expect(app.resource().disposed).toBe(0);
      gate.resolve();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ALIVE");
      expect((await reader.read()).done).toBe(true);
      await bounded(app.resource().done.promise);
      expect(app.resource().disposed).toBe(1);
    } finally { gate.resolve(); await app.close(); }
  });

  test.each(["default", "direct"] as const)("%s producer retains scope before its first byte", async kind => {
    const gate = deferred();
    const started = deferred();
    const app = await start((_ctx, resource) => new Response(kind === "direct" ? new ReadableStream({
      type: "direct",
      async pull(c) {
        started.resolve();
        await gate.promise;
        c.write(resource.disposed ? "DISPOSED" : "ALIVE");
        c.close();
      },
    }) : new ReadableStream({
      async pull(c) {
        started.resolve();
        await gate.promise;
        c.enqueue(encoder.encode(resource.disposed ? "DISPOSED" : "ALIVE"));
        c.close();
      },
    })));
    const request = fetch(app.url, { signal: AbortSignal.timeout(1000) });
    try {
      await bounded(started.promise);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(app.resource().disposed).toBe(0);
      gate.resolve();
      expect(await (await request).text()).toBe("ALIVE");
      await bounded(app.resource().done.promise);
      expect(app.resource().disposed).toBe(1);
    } finally { gate.resolve(); await request.catch(() => undefined); await app.close(); }
  });

  test("host shutdown waits for asynchronous scope cleanup after EOF", async () => {
    const gate = deferred();
    const app = await start((_ctx, resource) => {
      resource.delay = gate.promise;
      return new Response("done");
    });
    let stopped = false;
    try {
      expect(await (await fetch(app.url)).text()).toBe("done");
      const stop = app.close().then(() => { stopped = true; });
      await Bun.sleep(20);
      expect(stopped).toBe(false);
      gate.resolve();
      await bounded(stop);
      expect(stopped).toBe(true);
    } finally { gate.resolve(); if (!stopped) await app.close(); }
  });
});

describe("raw file responses preserve native Bun behavior", () => {
  const path = new URL("./http.lifetime-regressions.test.ts", import.meta.url).pathname;
  for (const variant of ["file", "clone", "file-stream"] as const) {
    for (const range of [undefined, "bytes=0-9", "bytes=7-", "bytes=-12", "bytes=9999999-"]) {
      test(`${variant}: ${range ?? "full body"}`, async () => {
        const make = () => {
          const response = variant === "file-stream" ? new Response(Bun.file(path).stream())
            // @types/node declares clone() as an undici Response, but this
            // fixture runs on Bun and retains Bun's Response implementation.
            : variant === "clone" ? new Response(Bun.file(path)).clone() as Response : new Response(Bun.file(path));
          // Materialize native headers as the host's response middleware does.
          response.headers.get("content-type");
          return response;
        };
        const native = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: make });
        const app = await start(make);
        const config = { headers: range ? { range } : undefined, signal: AbortSignal.timeout(500) };
        try {
          const control = await fetch(`http://127.0.0.1:${native.port}`, config);
          const actual = await fetch(app.url, config);
          expect(actual.status).toBe(control.status);
          for (const name of ["content-range", "content-length", "content-type", "accept-ranges"]) {
            expect(actual.headers.get(name)).toBe(control.headers.get(name));
          }
          expect(await actual.arrayBuffer()).toEqual(await control.arrayBuffer());
          await bounded(app.resource().done.promise);
          expect(app.resource().disposed).toBe(1);
        } finally { await native.stop(true); await app.close(); }
      });
    }
  }
  test("a missing raw file does not retain its scope", async () => {
    const app = await start(() => new Response(Bun.file(`${path}.does-not-exist`)));
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(app.url, { signal: AbortSignal.timeout(500) });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal Server Error" });
      await bounded(app.resource().done.promise);
      expect(app.resource().disposed).toBe(1);
    } finally { console.error = originalError; await app.close(); }
  });
});

describe("HTTP-04: HEAD does not wait for producer cancellation", () => {
  test.each(["pending", "rejecting"] as const)("HEAD 200 with %s cancel", async kind => {
    const gate = deferred();
    let canceled = 0;
    const app = await start(() => new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode("body")); },
      cancel() { canceled++; return kind === "pending" ? gate.promise : Promise.reject(new Error("cleanup failed")); },
    }), { headers: { "x-preserved": "yes" } }));
    try {
      const response = await bounded(fetch(app.url, { method: "HEAD", signal: AbortSignal.timeout(400) }));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-preserved")).toBe("yes");
      expect(await response.text()).toBe("");
      expect(canceled).toBe(1);
      expect(app.resource().disposed).toBe(1);
    } finally { gate.resolve(); await app.close(); }
  });
});
