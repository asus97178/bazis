import { describe, expect, test } from "bun:test";
import { HttpContext } from "@/core/http/HttpContext/HttpContext";
import { createCorrelationIdMiddleware } from "@/core/http/correlation/createCorrelationIdMiddleware";
import { getRequestId, REQUEST_ID_HEADER, REQUEST_ID_STATE_KEY } from "@/core/kernel";

function createContext(requestId?: string): HttpContext {
  const headers = new Headers();
  if (requestId !== undefined) {
    headers.set(REQUEST_ID_HEADER, requestId);
  }
  const url = new URL("http://localhost/api/test");
  const scope = {
    tryResolve: () => undefined,
    resolve: () => {
      throw new Error("not used");
    },
  };
  return new HttpContext(new Request(url.toString(), { headers }), url, {}, scope as never);
}

describe("createCorrelationIdMiddleware", () => {
  test("generates request id and stores it on ctx.state", async () => {
    const middleware = createCorrelationIdMiddleware({ generateId: () => "generated-id" });
    const ctx = createContext();
    ctx.response = new Response(null, { status: 200 });

    await middleware(ctx, async () => {
      expect(ctx.state.get(REQUEST_ID_STATE_KEY)).toBe("generated-id");
      expect(getRequestId()).toBe("generated-id");
    });

    expect(ctx.response.headers.get(REQUEST_ID_HEADER)).toBe("generated-id");
  });

  test("reuses inbound x-request-id header", async () => {
    const middleware = createCorrelationIdMiddleware();
    const ctx = createContext("client-id");
    ctx.response = new Response(null, { status: 200 });

    await middleware(ctx, async () => {
      expect(getRequestId()).toBe("client-id");
    });

    expect(ctx.response.headers.get(REQUEST_ID_HEADER)).toBe("client-id");
  });

  test("replaces oversized or malformed inbound ids", async () => {
    const middleware = createCorrelationIdMiddleware({ generateId: () => "safe-generated" });
    const ctx = createContext(`bad id ${"x".repeat(200)}`);
    ctx.response = new Response(null, { status: 200 });

    await middleware(ctx, async () => {});

    expect(ctx.state.get(REQUEST_ID_STATE_KEY)).toBe("safe-generated");
    expect(ctx.response.headers.get(REQUEST_ID_HEADER)).toBe("safe-generated");
  });
});
