import { describe, expect, spyOn, test } from "bun:test";
import { HttpContext } from "../HttpContext/HttpContext";
import { TooManyRequestsError } from "../Errors/HttpError";
import { rateLimit } from "../Middleware/rateLimit";
import { errorHandler } from "../Middleware/errorHandler";

function context(ip: string, forwarded?: string): HttpContext {
  const headers = forwarded ? { "x-forwarded-for": forwarded } : undefined;
  const request = new Request("http://localhost/test", { headers });
  return new HttpContext(request, new URL(request.url), {}, {} as never, undefined, undefined, ip);
}

describe("HTTP rateLimit security", () => {
  test("does not trust X-Forwarded-For by default", async () => {
    const middleware = rateLimit({ windowMs: 1_000, max: 1 });
    await middleware(context("10.0.0.1", "198.51.100.1"), async () => {});
    await expect(middleware(context("10.0.0.1", "198.51.100.2"), async () => {}))
      .rejects.toBeInstanceOf(TooManyRequestsError);
  });

  test("trusted proxy mode uses the address the proxy appended, not the client-written ones", async () => {
    const middleware = rateLimit({ windowMs: 1_000, max: 1, trustProxy: true });
    // The client writes the first entries; the proxy appends 203.0.113.9.
    await middleware(context("10.0.0.1", "198.51.100.1, 203.0.113.9"), async () => {});
    await expect(middleware(context("10.0.0.1", "198.51.100.2, 203.0.113.9"), async () => {}))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    // Another real client behind the same proxy has its own quota.
    await middleware(context("10.0.0.1", "203.0.113.10"), async () => {});
  });

  test("trustProxy: n takes the address n hops from the end", async () => {
    const middleware = rateLimit({ windowMs: 1_000, max: 1, trustProxy: 2 });
    // client-written, real client (seen by the CDN), CDN (seen by nginx).
    await middleware(context("10.0.0.1", "1.1.1.1, 203.0.113.9, 192.0.2.1"), async () => {});
    await expect(middleware(context("10.0.0.1", "1.1.1.2, 203.0.113.9, 192.0.2.1"), async () => {}))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    // Fewer entries than proxies: the first one.
    await middleware(context("10.0.0.1", "203.0.113.11"), async () => {});
    expect(() => rateLimit({ windowMs: 1_000, max: 1, trustProxy: 0 })).toThrow("rateLimit trustProxy");
  });

  test("responses carry RateLimit headers, 429 included", async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2 });
    const run = async () => {
      const ctx = context("10.0.0.7");
      await middleware(ctx, async () => { ctx.response = new Response("ok"); });
      return ctx.response!;
    };
    const first = await run();
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect(first.headers.get("ratelimit-reset")).toBe("60");
    expect((await run()).headers.get("ratelimit-remaining")).toBe("0");
    const rejected = await run().catch((error: unknown) => error) as TooManyRequestsError;
    expect(rejected).toBeInstanceOf(TooManyRequestsError);
    expect(rejected.headers).toEqual({ "ratelimit-limit": "2", "ratelimit-remaining": "0", "ratelimit-reset": "60" });

    // The error handler writes them on the 429 next to Retry-After.
    const ctx429 = context("10.0.0.7");
    await errorHandler()(ctx429, async () => { throw rejected; });
    expect(ctx429.response!.status).toBe(429);
    expect(ctx429.response!.headers.get("retry-after")).toBe("60");
    expect(ctx429.response!.headers.get("ratelimit-remaining")).toBe("0");

    const quiet = rateLimit({ windowMs: 60_000, max: 2, headers: false });
    const ctx = context("10.0.0.8");
    await quiet(ctx, async () => { ctx.response = new Response("ok"); });
    expect(ctx.response!.headers.has("ratelimit-limit")).toBe(false);
  });

  test("rejects unsafe numeric configuration", () => {
    expect(() => rateLimit({ windowMs: 0, max: 1 })).toThrow();
    expect(() => rateLimit({ windowMs: 1_000, max: 0 })).toThrow();
    expect(() => rateLimit({ windowMs: 1_000, max: 1, maxBuckets: Number.POSITIVE_INFINITY })).toThrow();
  });

  test("bucket saturation rejects new keys without resetting existing quotas", async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      max: 1,
      maxBuckets: 2,
      keyOf: (ctx) => ctx.header("x-key") ?? "missing",
    });
    const requestFor = (key: string) => {
      const request = new Request("http://localhost/test", { headers: { "x-key": key } });
      return new HttpContext(request, new URL(request.url), {}, {} as never);
    };
    let accepted = 0;
    const next = async () => { accepted++; };
    await middleware(requestFor("a"), next);
    await expect(middleware(requestFor("a"), next)).rejects.toBeInstanceOf(TooManyRequestsError);
    await middleware(requestFor("b"), next);
    for (let i = 0; i < 100; i++) {
      await expect(middleware(requestFor(`new-${i}`), next)).rejects.toMatchObject({ status: 429 });
    }
    await expect(middleware(requestFor("a"), next)).rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(middleware(requestFor("b"), next)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(accepted).toBe(2);
  });

  test("known keys can use their remaining quota while new keys are rejected", async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2, maxBuckets: 1 });
    let accepted = 0;
    const next = async () => { accepted++; };
    await middleware(context("a"), next);
    await expect(middleware(context("b"), next)).rejects.toBeInstanceOf(TooManyRequestsError);
    await middleware(context("a"), next);
    await expect(middleware(context("a"), next)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(accepted).toBe(2);
  });

  test("capacity Retry-After follows expiry without discarding a later active quota", async () => {
    let now = 10_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const middleware = rateLimit({ windowMs: 2_000, max: 1, maxBuckets: 2 });
      const next = async () => {};
      await middleware(context("a"), next);
      now = 11_000;
      await middleware(context("b"), next);
      await expect(middleware(context("c"), next)).rejects.toMatchObject({ retryAfterSeconds: 1 });
      now = 12_000;
      await middleware(context("c"), next);
      await expect(middleware(context("b"), next)).rejects.toMatchObject({ retryAfterSeconds: 1 });
      await expect(middleware(context("a"), next)).rejects.toMatchObject({ retryAfterSeconds: 1 });
      now = 13_000;
      await middleware(context("a"), next);
      await expect(middleware(context("c"), next)).rejects.toMatchObject({ retryAfterSeconds: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  test("an expired known key renews its slot and capacity retry timing is refreshed", async () => {
    let now = 10_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const middleware = rateLimit({ windowMs: 2_000, max: 1, maxBuckets: 1 });
      const next = async () => {};
      await middleware(context("a"), next);
      now = 12_000;
      await middleware(context("a"), next);
      await expect(middleware(context("b"), next)).rejects.toMatchObject({ retryAfterSeconds: 2 });
      await expect(middleware(context("a"), next)).rejects.toMatchObject({ retryAfterSeconds: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  test("concurrent admissions cannot exceed key or bucket capacity", async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1, maxBuckets: 2 });
    const results = await Promise.allSettled(["a", "b", "c", "a", "b", "d"].map(
      key => middleware(context(key), async () => { await Promise.resolve(); }),
    ));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(TooManyRequestsError);
    }
  });
});
