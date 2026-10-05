import { describe, expect, test } from "bun:test";
import { HttpClient, HttpClientError, HttpErrorCode } from "../index";
import { appendQuery } from "../serialize";

describe("transport cancellation reasons survive browser error normalization", () => {
  for (const phase of ["fetch", "body"] as const) {
    for (const cause of ["timeout", "caller"] as const) {
      test(`${cause} during ${phase} when transport reports TypeError`, async () => {
        const caller = new AbortController();
        let calls = 0;
        const client = new HttpClient({
          timeoutMs: cause === "timeout" ? 15 : 1000,
          signal: caller.signal,
          fetch: (async (_url, init) => {
            calls++;
            const signal = init!.signal!;
            if (cause === "caller") setTimeout(() => caller.abort(new DOMException("custom reason", "TimeoutError")), 15);
            if (phase === "fetch") return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new TypeError("Load failed")), { once: true });
            });
            return new Response(new ReadableStream({ start(controller) {
              signal.addEventListener("abort", () => controller.error(new TypeError("Load failed")), { once: true });
            } }));
          }) as typeof fetch,
        });
        await expect(bounded(client.get("https://api.test/slow"))).rejects.toMatchObject({
          code: cause === "timeout" ? HttpErrorCode.Timeout : HttpErrorCode.Canceled,
        });
        expect(calls).toBe(1);
      });
    }
  }

  test("failed progress callback cancels the producer and releases its reader", async () => {
    const failure = new Error("consumer progress failure");
    let canceled = 0;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { canceled++; return new Promise(() => {}); },
    });
    const client = new HttpClient({ fetch: (async () => new Response(body)) as unknown as typeof fetch });
    await expect(bounded(client.get("https://api.test", { onDownloadProgress: () => { throw failure; } }))).rejects.toBe(failure);
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("request did not settle within 300ms")), 300);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("HTTP-08: query precedes fragment", () => {
  test.each([
    ["https://api.test/items#section", "https://api.test/items?page=2#section"],
    ["https://api.test/items?q=a#section", "https://api.test/items?q=a&page=2#section"],
    ["/items#section?ignored=1", "/items?page=2#section?ignored=1"],
    ["/items#", "/items?page=2#"],
  ])("%s", (url, expected) => {
    expect(appendQuery(url!, { page: 2 })).toBe(expected);
  });

  test("custom serializer preserves encoded values", () => {
    expect(appendQuery("/items?fixed=1#part", {}, () => "tag=a%23b&tag=c%20d"))
      .toBe("/items?fixed=1&tag=a%23b&tag=c%20d#part");
  });

  test("params reach the HTTP peer", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => Response.json({ query: new URL(req.url).search }) });
    try {
      const response = await new HttpClient().get(`http://127.0.0.1:${server.port}/items#part`, { params: { page: 2 } });
      expect(response.data).toEqual({ query: "?page=2" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("HTTP-09: malformed JSON preserves the HTTP envelope", () => {
  for (const [status, validateStatus, code] of [
    [502, undefined, HttpErrorCode.BadStatus],
    [200, undefined, HttpErrorCode.BadResponse],
    [502, null, HttpErrorCode.BadResponse],
  ] as const) {
    test(`${status} / validateStatus ${String(validateStatus)}`, async () => {
      const raw = new Response("<upstream failed>", { status, headers: { "content-type": "application/problem+json", "x-upstream": "gateway" } });
      const client = new HttpClient({ fetch: (async () => raw) as unknown as typeof fetch });
      const error = await client.get("https://api.test/failure", { validateStatus }).catch(e => e);
      expect(error).toBeInstanceOf(HttpClientError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.cause).toBeInstanceOf(SyntaxError);
      expect(error.response.raw).toBe(raw);
      expect(error.response.headers.get("x-upstream")).toBe("gateway");
      expect(error.response.data).toBe("<upstream failed>");
    });
  }

  test("custom status validation runs once; progress/transform errors remain caller errors", async () => {
    const client = new HttpClient({ fetch: (async () => new Response("{", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    let validations = 0;
    const error = await client.get("https://api.test", { validateStatus: () => { validations++; return false; } }).catch(e => e);
    expect(error.code).toBe(HttpErrorCode.BadStatus);
    expect(validations).toBe(1);
    const callerError = new SyntaxError("from progress callback");
    await expect(client.get("https://api.test", { onDownloadProgress: () => { throw callerError; } })).rejects.toBe(callerError);
    await expect(client.get("https://api.test", { responseType: "text", transformResponse: () => { throw callerError; } })).rejects.toBe(callerError);
  });
});

describe("HTTP-06: producer cleanup cannot retain client operations", () => {
  for (const cancellation of ["pending", "rejecting"] as const) {
    for (const operation of ["retry", "redirect", "limit", "advertised-limit"] as const) {
      test(`${operation} with ${cancellation} cancel`, async () => {
        let canceled = 0;
        let attempts = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const source = new ReadableStream<Uint8Array>({
          start(controller) { if (operation.includes("limit")) controller.enqueue(new Uint8Array([65, 66])); },
          cancel() { canceled++; return cancellation === "pending" ? gate : Promise.reject(new Error("cleanup failed")); },
        });
        const client = new HttpClient({
          timeoutMs: 100,
          retry: operation === "retry" ? { maxRetries: 1, backoffMs: 0 } : undefined,
          maxResponseBytes: operation.includes("limit") ? 1 : undefined,
          fetch: (async () => {
            if (++attempts > 1) return new Response("ok");
            return new Response(source, {
              status: operation === "retry" ? 503 : operation === "redirect" ? 302 : 200,
              headers: operation === "redirect" ? { location: "/final" } : operation === "advertised-limit" ? { "content-length": "2" } : undefined,
            });
          }) as unknown as typeof fetch,
        });
        try {
          if (operation.includes("limit")) {
            await expect(bounded(client.get("https://api.test"))).rejects.toMatchObject({ code: HttpErrorCode.ResponseTooLarge });
            expect(attempts).toBe(1);
          } else {
            expect((await bounded(client.get("https://api.test"))).data).toBe("ok");
            expect(attempts).toBe(2);
          }
          expect(canceled).toBe(1);
          expect(source.locked).toBe(false);
        } finally {
          release();
        }
      });
    }
  }

  test.each(["timeout", "caller"] as const)("%s during retry backoff ignores pending cleanup", async (mode) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const client = new HttpClient({
      timeoutMs: mode === "timeout" ? 20 : 0,
      signal: controller.signal,
      retry: { maxRetries: 1, backoffMs: 1000 },
      fetch: (async () => new Response(new ReadableStream({ cancel: () => gate }), { status: 503 })) as unknown as typeof fetch,
    });
    const timer = setTimeout(() => { if (mode === "caller") controller.abort(); }, 20);
    try {
      await expect(bounded(client.get("https://api.test"))).rejects.toMatchObject({
        code: mode === "timeout" ? HttpErrorCode.Timeout : HttpErrorCode.Canceled,
      });
    } finally {
      clearTimeout(timer);
      release();
    }
  });
});
