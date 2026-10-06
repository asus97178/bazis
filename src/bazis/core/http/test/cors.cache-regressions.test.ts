import { describe, expect, test } from "bun:test";
import type { HttpContext } from "../HttpContext/HttpContext";
import { cors, preflightResponse, type CorsOptions } from "../Middleware/cors";

describe("every origin-dependent representation carries Vary", () => {
  for (const origin of ["https://allowed.test", ["https://allowed.test"], (value: string) => value === "https://allowed.test"] satisfies CorsOptions["origin"][]) {
    test.each([undefined, "https://denied.test", "https://allowed.test"])(`${typeof origin} policy, Origin=%s`, async requestOrigin => {
      const response = new Response("cacheable", { headers: { vary: "Accept-Encoding", "cache-control": "public, max-age=60" } });
      const ctx = { header: () => requestOrigin, response } as unknown as HttpContext;
      await cors({ origin })(ctx, async () => {});
      expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
      expect(response.headers.get("access-control-allow-origin")).toBe(requestOrigin === "https://allowed.test" ? requestOrigin : null);
    });
  }
  test("preflight without Origin also varies", () => {
    const response = preflightResponse({ origin: "https://allowed.test" }, new Request("https://api.test", { method: "OPTIONS" }));
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("an existing Origin entry is not duplicated; wildcard policy stays invariant", async () => {
    const ctx = { header: () => undefined, response: new Response("ok", { headers: { vary: "origin" } }) } as unknown as HttpContext;
    await cors({ origin: "https://allowed.test" })(ctx, async () => {});
    expect(ctx.response!.headers.get("vary")).toBe("origin");
    ctx.response = new Response("ok");
    await cors({ origin: "*" })(ctx, async () => {});
    expect(ctx.response.headers.get("vary")).toBeNull();
    expect(ctx.response.headers.get("access-control-allow-origin")).toBe("*");
    const corsRequest = { header: () => "https://allowed.test", response: new Response("ok") } as unknown as HttpContext;
    await cors({ origin: "*" })(corsRequest, async () => {});
    expect([...corsRequest.response!.headers]).toEqual([...ctx.response.headers]);
  });
});
