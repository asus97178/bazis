import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, type DiContainer } from "@/core/di";
import { Controller, Get, HttpServer, httpModule, type HttpModuleOptions } from "@/core/http";

@Controller("ping")
class PingController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class PingModule {}

async function startServer(options: Omit<HttpModuleOptions, "imports" | "port">) {
  @Module({ imports: [httpModule({ ...options, imports: [PingModule], port: 0 })] })
  class App {}

  const container: DiContainer = createContainer(App, { validateOnBuild: true });
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  return {
    base: `http://localhost:${server.port}`,
    dispose: async () => {
      await server.stop();
      await container.dispose();
    },
  };
}

describe("HTTP: security headers", () => {
  test("secure-by-default headers are present when not configured", async () => {
    const app = await startServer({});
    try {
      const res = await fetch(`${app.base}/ping`);
      await res.text();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
      // Opt-in headers stay off.
      expect(res.headers.get("strict-transport-security")).toBeNull();
      expect(res.headers.get("content-security-policy")).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  test("framework-generated 404 responses retain security headers", async () => {
    const app = await startServer({});
    try {
      const res = await fetch(`${app.base}/missing`);
      await res.text();
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      await app.dispose();
    }
  });

  test("false disables the headers entirely", async () => {
    const app = await startServer({ securityHeaders: false });
    try {
      const res = await fetch(`${app.base}/ping`);
      await res.text();
      expect(res.headers.get("x-content-type-options")).toBeNull();
      expect(res.headers.get("x-frame-options")).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  test("options tune and enable opt-in headers", async () => {
    const app = await startServer({
      securityHeaders: {
        frameOptions: "SAMEORIGIN",
        referrerPolicy: false,
        hsts: { maxAgeSeconds: 100, includeSubDomains: false },
        contentSecurityPolicy: "default-src 'self'",
        headers: { "permissions-policy": "geolocation=()" },
      },
    });
    try {
      const res = await fetch(`${app.base}/ping`);
      await res.text();
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("referrer-policy")).toBeNull(); // disabled
      expect(res.headers.get("strict-transport-security")).toBe("max-age=100");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
      expect(res.headers.get("permissions-policy")).toBe("geolocation=()");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff"); // default kept
    } finally {
      await app.dispose();
    }
  });
});
