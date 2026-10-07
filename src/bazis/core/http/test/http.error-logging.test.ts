import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, singletonValue } from "@/core/di";
import { LOGGER, type LogFields, type Logger } from "@/core/kernel";
import { Controller, Get, HttpServer, createCorrelationIdMiddleware, httpModule } from "@/core/http";
import { errorHandler } from "../Middleware/errorHandler";
import { HttpContext } from "../HttpContext/HttpContext";

// Unexpected errors go to the application logger with the request id, like the
// access log; before, they always went to a bare console.error.
interface Line { readonly level: string; readonly message: string; readonly fields?: LogFields }

function recordingLogger(lines: Line[]): Logger {
  const write = (level: string) => (message: string, fields?: LogFields) => { lines.push({ level, message, fields }); };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

function context(path = "/tasks/7"): HttpContext {
  const request = new Request(`http://localhost${path}`);
  return new HttpContext(request, new URL(request.url), {}, {} as never);
}

describe("HTTP unexpected-error logging", () => {
  test("the logger gets one redacted error line with the method and path", async () => {
    const lines: Line[] = [];
    const ctx = context();
    await errorHandler({ logger: recordingLogger(lines) })(ctx, async () => { throw new Error("db lost: password=hunter2"); });

    expect(ctx.response?.status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", message: "GET /tasks/7 failed", fields: { method: "GET", path: "/tasks/7" } });
    expect(JSON.stringify(lines[0]?.fields)).toContain("password=***");
    expect(JSON.stringify(lines[0]?.fields)).not.toContain("hunter2");
  });

  test("logError replaces the logger", async () => {
    const lines: Line[] = [];
    const logged: unknown[] = [];
    await errorHandler({ logger: recordingLogger(lines), logError: (error) => logged.push(error) })(context(), async () => { throw new Error("boom"); });
    expect(lines).toEqual([]);
    expect(logged).toHaveLength(1);
  });

  test("onUnexpectedError is a notification: the error is logged as well", async () => {
    const lines: Line[] = [];
    const notified: string[] = [];
    await errorHandler({ logger: recordingLogger(lines), onUnexpectedError: (ctx, error) => notified.push(`${ctx.path} ${(error as Error).message}`) })(
      context(), async () => { throw new Error("boom"); },
    );
    expect(notified).toEqual(["/tasks/7 boom"]);
    expect(lines.map((line) => line.message)).toEqual(["GET /tasks/7 failed"]);
  });

  test("the development response is redacted like the log", async () => {
    const ctx = context();
    await errorHandler({ exposeDetails: true, logError: () => {} })(ctx, async () => { throw new Error("db lost: password=hunter2"); });
    const body = await ctx.response?.json() as { message: string; stack: string };
    expect(body.message).toBe("db lost: password=***");
    expect(body.stack).toContain("password=***");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  test("the server logs through the application LOGGER with the request id", async () => {
    const lines: Line[] = [];

    @Controller("crash")
    class CrashController {
      @Get() get(): string { throw new Error("route failed"); }
    }

    @Module({ controllers: [CrashController] })
    class Feature {}

    @Module({
      imports: [httpModule({ imports: [Feature], port: 0, middleware: [createCorrelationIdMiddleware()] })],
      providers: [singletonValue(LOGGER, recordingLogger(lines))],
    })
    class App {}

    const container = createContainer(App, { validateOnBuild: true });
    const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/crash`, { headers: { "x-request-id": "req-42" } });
      expect(response.status).toBe(500);
      expect(lines.filter((line) => line.level === "error")).toEqual([
        { level: "error", message: "GET /crash failed", fields: expect.objectContaining({ method: "GET", path: "/crash", requestId: "req-42" }) },
      ]);
    } finally {
      await server.stop();
      await container.dispose();
    }
  });
});
