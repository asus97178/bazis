import { expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import { Controller, Get, HttpContext, HttpServer, Post, httpModule } from "../index";
import { registerGeneratedBindings } from "../Binding/autoBindings";

// `consumes` applies to every request with a body, however the action reads
// it. Before, it was checked only for body-model parameters, so a form route
// answered JSON with "Malformed form data" (400) instead of 415.
@Controller("consumes")
class UploadController {
  @Post("form", { consumes: "multipart/form-data" })
  async form(ctx: HttpContext) { return { keys: [...(await ctx.formData()).keys()] }; }

  @Post("ignores-body", { consumes: "application/octet-stream" })
  ignores() { return { ok: true }; }

  @Get("read", { consumes: "multipart/form-data" })
  read() { return { ok: true }; }
}
registerGeneratedBindings(UploadController, { form: [{ source: "context" }], ignores: [], read: [] });

@Module({ controllers: [UploadController], exports: [] })
class Feature {}

test("consumes rejects a wrong Content-Type with 415 for any body route; GET is not checked", async () => {
  @Module({ imports: [httpModule({ imports: [Feature], port: 0 })] })
  class App {}
  const container = createContainer(App, { validateOnBuild: true });
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  const base = `http://127.0.0.1:${server.port}/consumes`;
  try {
    const json = await fetch(`${base}/form`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([json.status, await json.json()]).toEqual([415, { error: "Unsupported Media Type: expected multipart/form-data" }]);

    const form = new FormData();
    form.set("note", "hi");
    const ok = await fetch(`${base}/form`, { method: "POST", body: form });
    expect([ok.status, await ok.json()]).toEqual([200, { keys: ["note"] }]);

    expect((await fetch(`${base}/ignores-body`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await fetch(`${base}/read`)).status).toBe(200);
  } finally {
    await server.stop();
    await container.dispose();
  }
});
