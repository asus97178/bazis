import { afterEach, expect, test } from "bun:test";
import { Module, singletonValue } from "@/core/di";
import { ConflictError, Controller, Get, HTTP_ERROR_MAPPER, HttpError, HttpSetupError, NoContent, NotFound, Post, type HttpErrorMapper } from "@/core/http";
import { startTestApp, type TestApp } from "@/core/testing";
import { buildHttpOpenApiDocument } from "@/core/http/OpenApi/openApiDocument";
import { contextOnlyController } from "@/core/http/Routing/contextOnlyControllers";

class Unavailable extends Error {}
class Taken extends Error {}

@Controller("things")
class ThingsController {
  @Get("missing", { nullAs: NotFound })
  missing() { return null; }

  @Get("absent", { nullAs: NotFound })
  absent() { return undefined; }

  @Get("found", { nullAs: NotFound })
  found() { return { id: 1 }; }

  @Get("empty", { nullAs: NoContent })
  empty() { return null; }

  @Get("plain")
  plain() { return null; }

  @Post("taken")
  taken() { throw new Taken("the name is taken"); }

  @Post("conflict")
  conflict() { throw new ConflictError("Already there", { code: "unique", fields: ["name"] }); }

  @Post("down")
  down() { throw new Unavailable("the store is down"); }

  @Post("unknown")
  unknown() { throw new Error("secret detail"); }
}
contextOnlyController(ThingsController);

const mapper: HttpErrorMapper = (error) => (error instanceof Taken ? new ConflictError() : error instanceof Unavailable ? new HttpError(503, "Service Unavailable") : undefined);

@Module({ controllers: [ThingsController], providers: [singletonValue(HTTP_ERROR_MAPPER, mapper)] })
class ThingsModule {}

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const start = async () => {
  app = await startTestApp(ThingsModule);
  return app;
};
const call = async (method: string, path: string) => {
  const response = await app!.fetch(path, { method });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) as unknown };
};

test("nullAs turns null and undefined into the result of the helper", async () => {
  await start();
  expect(await call("GET", "/things/missing")).toEqual({ status: 404, body: { error: "Not Found" } });
  expect(await call("GET", "/things/absent")).toEqual({ status: 404, body: { error: "Not Found" } });
  expect(await call("GET", "/things/found")).toEqual({ status: 200, body: { id: 1 } });
  expect(await call("GET", "/things/empty")).toEqual({ status: 204, body: null });
  expect(await call("GET", "/things/plain")).toEqual({ status: 204, body: null });
});

test("nullAs must be a result helper", () => {
  expect(() => {
    class Bad {
      @Get("x", { nullAs: 404 as never })
      x() { return null; }
    }
    return Bad;
  }).toThrow(HttpSetupError);
});

test("ConflictError answers 409 with its text and details", async () => {
  await start();
  expect(await call("POST", "/things/conflict")).toEqual({ status: 409, body: { error: "Already there", details: { code: "unique", fields: ["name"] } } });
});

test("a registered mapper turns an error of a module into its answer; what nobody maps stays 500", async () => {
  await start();
  expect(await call("POST", "/things/taken")).toEqual({ status: 409, body: { error: "Conflict" } });
  expect(await call("POST", "/things/down")).toEqual({ status: 503, body: { error: "Service Unavailable" } });
  expect(await call("POST", "/things/unknown")).toMatchObject({ status: 500, body: { error: "Internal Server Error" } });
});

test("OpenAPI lists the status of nullAs", () => {
  const document = buildHttpOpenApiDocument({ controllers: [ThingsController], options: {} } as never) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
  expect(Object.keys(document.paths["/things/missing"]!.get!.responses)).toContain("404");
  expect(Object.keys(document.paths["/things/plain"]!.get!.responses)).not.toContain("404");
  expect(Object.keys(document.paths["/things/empty"]!.get!.responses)).not.toContain("404");
});
