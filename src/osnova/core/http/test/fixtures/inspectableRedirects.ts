import { HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import { All, Controller, HttpServer, httpModule, type HttpContext, type HttpModuleOptions } from "../../index";

export interface RedirectTraffic {
  path: string;
  method: string;
  body: string;
  key: string | null;
  authorization: string | null;
  cookie: string | null;
  correlation: string | null;
  contentType: string | null;
  negotiation: string | null;
}

/** Isolated HTTP-only fixture. Never imported by application modules. */
export async function startRedirectPeer(options: {
  enabled?: boolean;
  javascript?: string;
  cors?: HttpModuleOptions["cors"];
} = {}) {
  const traffic: RedirectTraffic[] = [];
  @Controller("inspect")
  class RedirectController {
    @All("*path")
    async handle(ctx: HttpContext) {
      const path = ctx.url.pathname.slice("/inspect".length);
      if (path === "/page") return new Response("<!doctype html><title>Inspectable redirects</title>", { headers: { "content-type": "text/html" } });
      if (path === "/client.js") return new Response(options.javascript ?? "", { headers: { "content-type": "text/javascript" } });
      const entry: RedirectTraffic = {
        path, method: ctx.request.method, body: await ctx.request.text(),
        key: ctx.header("x-api-key") ?? null,
        authorization: ctx.header("authorization") ?? null,
        cookie: ctx.header("cookie") ?? null,
        correlation: ctx.header("x-correlation-id") ?? null,
        contentType: ctx.header("content-type") ?? null,
        negotiation: ctx.header("x-osnova-redirect") ?? null,
      };
      traffic.push(entry);
      if (path.startsWith("/chain/")) {
        const remaining = Number(path.split("/").at(-1));
        if (remaining > 0) return new Response(null, {
          status: Number(ctx.url.searchParams.get("status") ?? 302),
          headers: { location: `${remaining - 1}${ctx.url.search}`, "cache-control": "public, max-age=600" },
        });
      }
      if (path === "/to") return new Response("redirect body", {
        status: Number(ctx.url.searchParams.get("status") ?? 302),
        headers: { location: ctx.url.searchParams.get("url")!, "content-type": "text/plain" },
      });
      if (path === "/loop") return new Response(null, { status: 302, headers: { location: "loop" } });
      if (path === "/file") return new Response(Bun.file(new URL(import.meta.url)));
      if (path === "/missing-file") return new Response(Bun.file(`${new URL(import.meta.url).pathname}.does-not-exist`));
      if (path === "/slow") await Bun.sleep(150);
      if (path === "/failure") return Response.json({ error: "fixture failure" }, { status: 503 });
      return Response.json(entry, { headers: { "x-test-result": "visible" } });
    }
  }
  @Module({ imports: [httpModule({
    controllers: [RedirectController], port: 0, hostname: "127.0.0.1", docs: false,
    inspectableRedirects: options.enabled ?? true,
    cors: options.cors,
  })] })
  class App {}
  const container = createContainer(App);
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin, baseUrl: `${origin}/inspect`, traffic,
    async close() { await server.stop(); await container.dispose(); },
  };
}
