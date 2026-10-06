import { describe, expect, test } from "bun:test";
import {
  HttpClient,
  HttpClientConfigError,
  HttpClientError,
  HttpClientFactoryBuilder,
  HttpErrorCode,
} from "@/library/http-client";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
}

/** Builds a fetch mock that records the last request and returns `make()`. */
function recorder(make: () => Response): { fetch: typeof fetch; last(): Captured } {
  let captured: Captured | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    return make();
  }) as unknown as typeof fetch;
  return { fetch: impl, last: () => captured! };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("HttpClient: URL, baseUrl, params", () => {
  test("preserves baseUrl prefix and serializes params (arrays repeat)", async () => {
    const rec = recorder(() => json({ ok: true }));
    const client = new HttpClient({ baseUrl: "https://api.test/v1", fetch: rec.fetch });
    await client.get("/items", { params: { q: "x", tag: ["a", "b"], skip: undefined } });
    expect(rec.last().url).toBe("https://api.test/v1/items?q=x&tag=a&tag=b");
  });

  test("absolute url bypasses baseUrl", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({ baseUrl: "https://api.test", fetch: rec.fetch });
    await client.get("https://other.test/raw");
    expect(rec.last().url).toBe("https://other.test/raw");
  });
});

describe("HttpClient: data and responses", () => {
  test("auto-JSON request body + sets content-type, parses JSON response into .data", async () => {
    const rec = recorder(() => json({ id: 7 }));
    const client = new HttpClient({ fetch: rec.fetch });
    const res = await client.post<{ id: number }>("https://x.test/a", { name: "n" });
    expect(rec.last().headers.get("content-type")).toBe("application/json");
    expect(rec.last().body).toBe(JSON.stringify({ name: "n" }));
    expect(res.data).toEqual({ id: 7 });
    expect(res.status).toBe(200);
  });

  test("raw BodyInit is passed through without JSON encoding", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({ fetch: rec.fetch });
    const form = new URLSearchParams({ a: "1" });
    await client.post("https://x.test/a", form);
    expect(rec.last().body).toBe(form);
  });

  test("responseType text returns string data", async () => {
    const rec = recorder(() => new Response("plain", { status: 200 }));
    const client = new HttpClient({ fetch: rec.fetch });
    const res = await client.get<string>("https://x.test/a", { responseType: "text" });
    expect(res.data).toBe("plain");
  });
});

describe("HttpClient: validateStatus", () => {
  test("non-2xx rejects with HttpClientError carrying the response", async () => {
    const rec = recorder(() => json({ error: "no" }, { status: 404, statusText: "Not Found" }));
    const client = new HttpClient({ fetch: rec.fetch });
    try {
      await client.get("https://x.test/missing");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpClientError);
      const err = error as HttpClientError;
      expect(err.status).toBe(404);
      expect(err.code).toBe(HttpErrorCode.BadStatus);
      expect(err.response?.data).toEqual({ error: "no" });
    }
  });

  test("validateStatus: null never rejects", async () => {
    const rec = recorder(() => json({}, { status: 500 }));
    const client = new HttpClient({ fetch: rec.fetch });
    const res = await client.get("https://x.test/a", { validateStatus: null });
    expect(res.status).toBe(500);
  });
});

describe("HttpClient: auth, credentials, headers", () => {
  test("basic auth header and per-request header precedence", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({ headers: { "x-app": "default" }, fetch: rec.fetch });
    await client.get("https://x.test/a", {
      auth: { username: "u", password: "p" },
      headers: { "x-app": "override" },
    });
    expect(rec.last().headers.get("authorization")).toBe(`Basic ${btoa("u:p")}`);
    expect(rec.last().headers.get("x-app")).toBe("override");
  });

  test("strips credentials when an absolute URL escapes baseUrl origin", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({
      baseUrl: "https://api.test/v1",
      headers: {
        accept: "application/json",
        authorization: "Bearer secret",
        cookie: "sid=secret",
        "x-api-key": "key",
        "x-auth-token": "token",
        "x-client-secret": "secret",
        apikey: "alternate-key",
      },
      withCredentials: true,
      fetch: rec.fetch,
    });
    await client.get("https://attacker.test/collect");
    expect(rec.last().headers.get("accept")).toBe("application/json");
    expect(rec.last().headers.get("authorization")).toBeNull();
    expect(rec.last().headers.get("cookie")).toBeNull();
    expect(rec.last().headers.get("x-api-key")).toBeNull();
    expect(rec.last().headers.get("x-auth-token")).toBeNull();
    expect(rec.last().headers.get("x-client-secret")).toBeNull();
    expect(rec.last().headers.get("apikey")).toBeNull();
  });

  test("does not let an empty request baseUrl erase the inherited origin boundary", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({
      baseUrl: "https://api.test",
      headers: { authorization: "Bearer inherited-secret" },
      fetch: rec.fetch,
    });

    for (const baseUrl of [undefined, ""] as const) {
      await client.get("https://attacker.test/collect", { baseUrl });
      expect(rec.last().headers.get("authorization")).toBeNull();
    }
  });

  test("keeps only explicitly permitted correlation headers on a foreign origin", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({
      baseUrl: "https://api.test",
      headers: { "x-custom-secret": "drop" },
      correlationHeaders: () => ({ "x-request-id": "req-foreign" }),
      propagateCorrelation: "all",
      fetch: rec.fetch,
    });

    await client.get("https://other.test/x");

    expect(rec.last().headers.get("x-request-id")).toBe("req-foreign");
    expect(rec.last().headers.get("x-custom-secret")).toBeNull();
  });

  test("cross-origin credentials require an explicit opt-in", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({
      baseUrl: "https://api.test",
      headers: { authorization: "Bearer explicit" },
      allowCrossOriginCredentials: true,
      fetch: rec.fetch,
    });
    await client.get("https://other.test/x");
    expect(rec.last().headers.get("authorization")).toBe("Bearer explicit");
  });

  test("re-applies cross-origin header policy after transformRequest mutates headers", async () => {
    const rec = recorder(() => json({ ok: true }));
    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch: rec.fetch,
      transformRequest(data, headers) {
        headers.authorization = "Bearer transform-secret";
        headers["x-api-key"] = "transform-key";
        headers["x-custom-secret"] = "transform-custom";
        headers.accept = "application/json";
        return data;
      },
    });

    await client.post("https://attacker.test/collect", { safe: true });

    expect(rec.last().headers.get("authorization")).toBeNull();
    expect(rec.last().headers.get("x-api-key")).toBeNull();
    expect(rec.last().headers.get("x-custom-secret")).toBeNull();
    expect(rec.last().headers.get("accept")).toBe("application/json");
    expect(rec.last().headers.get("content-type")).toBe("application/json");
  });

  test("strips API keys and Authorization on a live cross-origin redirect", async () => {
    let sourceHeaders: Headers | undefined;
    let targetHeaders: Headers | undefined;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        targetHeaders = new Headers(request.headers);
        return Response.json({ ok: true });
      },
    });
    const targetUrl = `http://127.0.0.1:${target.port}`;
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        sourceHeaders = new Headers(request.headers);
        return Response.redirect(`${targetUrl}/collect`, 302);
      },
    });

    try {
      const client = new HttpClient({
        baseUrl: `http://127.0.0.1:${source.port}`,
        headers: {
          accept: "application/json",
          "x-api-key": "top-secret",
          "api-key": "also-secret",
          "x-auth-token": "auth-token",
          "x-client-secret": "client-secret",
          apikey: "alternate-key",
        },
        auth: { username: "service", password: "secret" },
        correlationHeaders: () => ({ "x-request-id": "req-redirect" }),
        propagateCorrelation: "all",
      });
      const response = await client.get<{ ok: boolean }>("/start");

      expect(response.data.ok).toBe(true);
      expect(sourceHeaders?.get("authorization")).toBe(`Basic ${btoa("service:secret")}`);
      expect(sourceHeaders?.get("x-api-key")).toBe("top-secret");
      expect(targetHeaders?.get("authorization")).toBeNull();
      expect(targetHeaders?.get("x-api-key")).toBeNull();
      expect(targetHeaders?.get("api-key")).toBeNull();
      expect(targetHeaders?.get("x-auth-token")).toBeNull();
      expect(targetHeaders?.get("x-client-secret")).toBeNull();
      expect(targetHeaders?.get("apikey")).toBeNull();
      expect(targetHeaders?.get("accept")).toBe("application/json");
      expect(targetHeaders?.get("x-request-id")).toBe("req-redirect");
    } finally {
      await source.stop(true);
      await target.stop(true);
    }
  });

  test("explicit cross-origin opt-in also applies to redirect hops", async () => {
    let targetHeaders: Headers | undefined;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        targetHeaders = new Headers(request.headers);
        return Response.json({ ok: true });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${target.port}/collect`, 302);
      },
    });

    try {
      const client = new HttpClient({
        baseUrl: `http://127.0.0.1:${source.port}`,
        headers: { authorization: "Bearer explicit", "x-api-key": "explicit-key" },
        allowCrossOriginCredentials: true,
      });
      await client.get("/start");

      expect(targetHeaders?.get("authorization")).toBe("Bearer explicit");
      expect(targetHeaders?.get("x-api-key")).toBe("explicit-key");
    } finally {
      await source.stop(true);
      await target.stop(true);
    }
  });
});

describe("HttpClient: redirects", () => {
  test("enforces maxRedirects for a live two-origin loop", async () => {
    let firstUrl = "";
    let secondUrl = "";
    let firstHits = 0;
    let secondHits = 0;
    const first = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        firstHits += 1;
        return Response.redirect(`${secondUrl}/loop`, 302);
      },
    });
    firstUrl = `http://127.0.0.1:${first.port}`;
    const second = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        secondHits += 1;
        return Response.redirect(`${firstUrl}/loop`, 302);
      },
    });
    secondUrl = `http://127.0.0.1:${second.port}`;

    try {
      const client = new HttpClient({ baseUrl: firstUrl, maxRedirects: 2 });
      await expect(client.get("/loop")).rejects.toMatchObject({
        code: HttpErrorCode.TooManyRedirects,
      });
      expect(firstHits).toBe(2);
      expect(secondHits).toBe(1);
    } finally {
      await first.stop(true);
      await second.stop(true);
    }
  });

  test("applies Fetch method/body rules for 302 and 307", async () => {
    const received: Array<{ path: string; method: string; body: string; contentType: string | null }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/post-302") {
          return Response.redirect(new URL("/capture-302", request.url).toString(), 302);
        }
        if (path === "/post-307") {
          return Response.redirect(new URL("/capture-307", request.url).toString(), 307);
        }
        received.push({
          path,
          method: request.method,
          body: await request.text(),
          contentType: request.headers.get("content-type"),
        });
        return Response.json({ ok: true });
      },
    });

    try {
      const client = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });
      await client.post("/post-302", { value: 302 });
      await client.post("/post-307", { value: 307 });

      expect(received).toEqual([
        { path: "/capture-302", method: "GET", body: "", contentType: null },
        {
          path: "/capture-307",
          method: "POST",
          body: JSON.stringify({ value: 307 }),
          contentType: "application/json",
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("refuses a redirect that would replay a one-shot stream body", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 307, headers: { location: "https://api.test/next" } });
    }) as unknown as typeof fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one-shot"));
        controller.close();
      },
    });
    const client = new HttpClient({ fetch: fetchImpl });

    await expect(client.put("https://api.test/start", body)).rejects.toMatchObject({
      code: HttpErrorCode.RedirectBodyNotReplayable,
    });
    expect(calls).toBe(1);
  });

  test("blocks replayable request bodies on cross-origin redirects unless explicitly trusted", async () => {
    let blockedCalls = 0;
    const blockedFetch = (async () => {
      blockedCalls += 1;
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.test/collect" },
      });
    }) as unknown as typeof fetch;
    const blocked = new HttpClient({ baseUrl: "https://api.test", fetch: blockedFetch });

    await expect(blocked.put("/submit", { secret: "do-not-forward" })).rejects.toMatchObject({
      code: HttpErrorCode.RedirectBodyNotReplayable,
    });
    expect(blockedCalls).toBe(1);

    let trustedBody: RequestInit["body"];
    let trustedCalls = 0;
    const trustedFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      trustedCalls += 1;
      if (trustedCalls === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://trusted.test/collect" },
        });
      }
      trustedBody = init?.body;
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const trusted = new HttpClient({
      baseUrl: "https://api.test",
      allowCrossOriginCredentials: true,
      fetch: trustedFetch,
    });

    await trusted.put("/submit", { safeForTrustedHop: true });
    expect(trustedCalls).toBe(2);
    expect(trustedBody).toBe(JSON.stringify({ safeForTrustedHop: true }));
  });
});

describe("HttpClient: interceptors", () => {
  test("request and response interceptors transform config and result", async () => {
    const rec = recorder(() => json({ n: 1 }));
    const client = new HttpClient({ fetch: rec.fetch });
    client.interceptors.request.use((config) => {
      config.headers = { ...config.headers, "x-trace": "yes" };
      return config;
    });
    client.interceptors.response.use((response) => ({ ...response, data: { wrapped: response.data } }));

    const res = await client.get<{ wrapped: { n: number } }>("https://x.test/a");
    expect(rec.last().headers.get("x-trace")).toBe("yes");
    expect(res.data).toEqual({ wrapped: { n: 1 } });
  });
});

describe("HttpClient: timeout and retry", () => {
  test("rejects invalid timeout values before issuing a request", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return json({});
    }) as unknown as typeof fetch;

    for (const timeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const client = new HttpClient({ fetch: impl, timeoutMs });
      await expect(client.get("https://x.test/a")).rejects.toThrow(
        "timeoutMs must be a non-negative safe integer",
      );
    }
    expect(calls).toBe(0);
  });

  test("preserves inherited limits when an override contains undefined and accepts explicit zero", async () => {
    const rec = recorder(() => json({}));
    const client = new HttpClient({ fetch: rec.fetch, timeoutMs: 100, maxResponseBytes: 10 });

    await client.get("https://x.test/inherit", { timeoutMs: undefined, maxResponseBytes: undefined });
    expect(rec.last().url).toBe("https://x.test/inherit");

    await client.get("https://x.test/disabled", { timeoutMs: 0, maxResponseBytes: 0 });
    expect(rec.last().url).toBe("https://x.test/disabled");
  });

  test("preserves inherited redirect guards when an override contains undefined", async () => {
    let intercepted: { redirect?: RequestInit["redirect"]; maxRedirects?: number } | undefined;
    const rec = recorder(() => json({}));
    const client = new HttpClient({
      fetch: rec.fetch,
      redirect: "error",
      maxRedirects: 2,
    });
    client.interceptors.request.use((config) => {
      intercepted = { redirect: config.redirect, maxRedirects: config.maxRedirects };
      return config;
    });

    await client.get("https://x.test/inherit", { redirect: undefined, maxRedirects: undefined });

    expect(intercepted).toEqual({ redirect: "error", maxRedirects: 2 });
  });

  test("rejects invalid response limits before issuing a request", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return json({});
    }) as unknown as typeof fetch;
    const client = new HttpClient({ fetch: impl, maxResponseBytes: -1 });

    await expect(client.get("https://x.test/a")).rejects.toThrow(
      "maxResponseBytes must be a non-negative safe integer",
    );
    expect(calls).toBe(0);
  });

  test("timeout aborts and surfaces ETIMEDOUT", async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const client = new HttpClient({ fetch: impl, timeoutMs: 15 });
    try {
      await client.get("https://x.test/slow");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as HttpClientError).code).toBe(HttpErrorCode.Timeout);
    }
  });

  test("retries idempotent GET on 503 then succeeds", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 503 }) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = new HttpClient({ fetch: impl, retry: { maxRetries: 1, backoffMs: 1 } });
    const res = await client.get("https://x.test/a");
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("does not retry non-idempotent POST", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const client = new HttpClient({ fetch: impl, retry: { maxRetries: 2, backoffMs: 1 }, validateStatus: null });
    await client.post("https://x.test/a", "body");
    expect(calls).toBe(1);
  });

  test("cancels a retry response body before the next attempt", async () => {
    let calls = 0;
    let canceled = false;
    const impl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream({ cancel: () => { canceled = true; } }), { status: 503 });
      }
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const client = new HttpClient({ fetch: impl, retry: { maxRetries: 1, backoffMs: 0 } });
    await client.get("https://x.test/a");
    expect(canceled).toBe(true);
  });

  test("timeout is a total deadline including retry backoff", async () => {
    const impl = (async () => new Response(null, {
      status: 503,
      headers: { "retry-after": "1" },
    })) as unknown as typeof fetch;
    const client = new HttpClient({ fetch: impl, timeoutMs: 15, retry: { maxRetries: 3 } });
    await expect(client.get("https://x.test/a")).rejects.toMatchObject({ code: HttpErrorCode.Timeout });
  });
});

describe("HttpClient: transforms", () => {
  test("transformRequest pre-processes body, transformResponse post-processes data", async () => {
    const rec = recorder(() => json({ value: 2 }));
    const client = new HttpClient({ fetch: rec.fetch });
    const res = await client.post<{ doubled: number }>("https://x.test/a", { value: 1 }, {
      transformRequest: (data) => ({ ...(data as object), stamped: true }),
      transformResponse: (data) => ({ doubled: (data as { value: number }).value * 2 }),
    });
    expect(rec.last().body).toBe(JSON.stringify({ value: 1, stamped: true }));
    expect(res.data).toEqual({ doubled: 4 });
  });
});

describe("HttpClient: download progress", () => {
  test("reports byte progress and still decodes the body", async () => {
    const payload = JSON.stringify({ big: "x".repeat(20) });
    const rec = recorder(
      () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(payload.length) },
        }),
    );
    const client = new HttpClient({ fetch: rec.fetch });
    const events: number[] = [];
    const res = await client.get<{ big: string }>("https://x.test/file", {
      onDownloadProgress: (event) => events.push(event.loaded),
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toBe(payload.length);
    expect(res.data.big).toHaveLength(20);
  });

  test("rejects advertised and streamed bodies above maxResponseBytes", async () => {
    const advertised = new HttpClient({
      fetch: (async () => new Response("large", { headers: { "content-length": "100" } })) as unknown as typeof fetch,
      maxResponseBytes: 4,
    });
    await expect(advertised.get("https://x.test/a")).rejects.toMatchObject({
      code: HttpErrorCode.ResponseTooLarge,
    });

    const streamed = new HttpClient({
      fetch: (async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("123"));
          controller.enqueue(new TextEncoder().encode("456"));
          controller.close();
        },
      }))) as unknown as typeof fetch,
      maxResponseBytes: 4,
    });
    await expect(streamed.get("https://x.test/a", { responseType: "text" })).rejects.toMatchObject({
      code: HttpErrorCode.ResponseTooLarge,
    });
  });

  test("does not reject a bodyless HEAD response for its advertised representation length", async () => {
    const client = new HttpClient({
      fetch: (async () => new Response(null, {
        status: 200,
        headers: { "content-length": "1000000" },
      })) as unknown as typeof fetch,
      maxResponseBytes: 4,
    });

    const response = await client.head("https://x.test/large-resource");
    expect(response.status).toBe(200);
    expect(response.data).toBe("");
  });
});

describe("HttpClient: create + factory", () => {
  test("create merges defaults", async () => {
    const rec = recorder(() => json({}));
    const base = new HttpClient({ baseUrl: "https://api.test", fetch: rec.fetch });
    const scoped = base.create({ headers: { "x-tenant": "acme" } });
    await scoped.get("/x");
    expect(rec.last().url).toBe("https://api.test/x");
    expect(rec.last().headers.get("x-tenant")).toBe("acme");
  });

  test("factory fails fast on unknown client", () => {
    const factory = new HttpClientFactoryBuilder().addClient("api", { baseUrl: "https://api.test" }).build();
    expect(factory.createClient("api")).toBeInstanceOf(HttpClient);
    expect(factory.createClient()).toBeInstanceOf(HttpClient);
    expect(() => factory.createClient("nope")).toThrow(HttpClientConfigError);
  });

  test("named factory clients merge default and named headers", async () => {
    const rec = recorder(() => json({}));
    const factory = new HttpClientFactoryBuilder()
      .useDefault({ headers: { authorization: "Bearer default" }, fetch: rec.fetch })
      .addClient("api", { baseUrl: "https://api.test", headers: { "x-client": "api" } })
      .build();
    await factory.createClient("api").get("/x");
    expect(rec.last().headers.get("authorization")).toBe("Bearer default");
    expect(rec.last().headers.get("x-client")).toBe("api");
  });
});
