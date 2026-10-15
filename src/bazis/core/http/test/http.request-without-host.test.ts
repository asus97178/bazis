import { expect, spyOn, test } from "bun:test";
import { HOSTED_SERVICE, Module } from "@/core/di";
import { Controller, Get, HttpServer } from "@/core/http";
import { Bazis } from "@/core/kernel";
import { composeApp } from "@/core/app/runApp";

// HTTP/1.0 allows a request without Host (some load balancer health checks
// send one). Bun hands such a request a path instead of a URL; on 0.100.2 it
// failed with `[http] transport failed: Invalid URL` and a 500.

@Controller("things")
class ThingsController {
  @Get()
  list() { return { items: [] }; }
}

@Module({ controllers: [ThingsController] })
class AppModule {}

async function raw(port: number, request: string): Promise<string> {
  const chunks: string[] = [];
  const done = Promise.withResolvers<void>();
  await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open: (socket) => { socket.write(request); },
      data: (_socket, data) => { chunks.push(Buffer.from(data).toString()); },
      close: () => done.resolve(),
      error: (_socket, error) => done.reject(error),
    },
  });
  await done.promise;
  return chunks.join("");
}

test("an HTTP/1.0 request without Host is served by this server", async () => {
  const errors = spyOn(console, "error");
  const kernel = await Bazis.createBuilder(composeApp(AppModule, { http: { hostname: "127.0.0.1", port: 0, health: true } }))
    .useEnvironment("test").useStartupReport(false).build();
  await kernel.start();
  try {
    const server = kernel.container.resolveAll(HOSTED_SERVICE).find((service) => service instanceof HttpServer) as HttpServer;
    const health = await raw(server.port, "GET /health HTTP/1.0\r\n\r\n");
    expect(health.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect(health).toContain('"healthy":true');
    const things = await raw(server.port, "GET /things?page=1 HTTP/1.0\r\n\r\n");
    expect(things.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect(things).toContain('{"items":[]}');
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("transport failed"))).toEqual([]);
  } finally {
    errors.mockRestore();
    await kernel.stop();
  }
});
