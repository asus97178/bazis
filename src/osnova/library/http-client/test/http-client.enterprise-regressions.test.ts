import { describe, expect, test } from "bun:test";
import { HttpClient, HttpClientError, HttpErrorCode } from "../index";
import type { RequestConfig } from "../types";

const url = "https://api.test/body";
const encoder = new TextEncoder();

describe("HTTP-E01: normalize transport body errors at the read boundary", () => {
  for (const mode of ["text", "json", "arrayBuffer", "blob", "inferred-json", "progress"] as const) {
    for (const limit of [0, 1024]) {
      test(`${mode}, response cap ${limit}`, async () => {
        const cause = new TypeError("connection reset after headers");
        let calls = 0;
        const client = new HttpClient({
          maxResponseBytes: limit,
          retry: { maxRetries: 3, backoffMs: 0 },
          fetch: (async () => {
            calls++;
            let pulls = 0;
            return new Response(new ReadableStream<Uint8Array>({
              pull(controller) {
                if (++pulls === 1) controller.enqueue(encoder.encode('{"partial":'));
                else controller.error(cause);
              },
            }), { headers: { "content-type": "application/json" } });
          }) as unknown as typeof fetch,
        });
        const error = await client.get(url, {
          responseType: mode === "progress" ? "text" : mode === "inferred-json" ? undefined : mode,
          onDownloadProgress: mode === "progress" ? () => {} : undefined,
        }).catch(error => error);
        expect(error).toBeInstanceOf(HttpClientError);
        expect(error.code).toBe(HttpErrorCode.Network);
        expect(error.cause).toBe(cause);
        expect(error.config.url).toBe(url);
        expect(calls).toBe(1); // A partially consumed response must not be replayed.
      });
    }
  }

  for (const abortCaller of [false, true]) {
    test(`a progress TimeoutError remains the caller's error, abort=${abortCaller}`, async () => {
      const caller = new AbortController();
      const failure = new DOMException("progress callback failed", "TimeoutError");
      let canceled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode("ok")); },
        cancel() { canceled++; },
      });
      const client = new HttpClient({
        fetch: (async () => new Response(body)) as unknown as typeof fetch,
        signal: caller.signal,
        maxResponseBytes: 1024,
      });
      await expect(client.get(url, { onDownloadProgress: () => {
        if (abortCaller) caller.abort();
        throw failure;
      } })).rejects.toBe(failure);
      expect(canceled).toBe(1);
      expect(body.locked).toBe(false);
    });
  }
});

describe("HTTP-E02: one-shot uploads use the Fetch stream contract", () => {
  test("stream upload carries duplex without buffering the request", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("stream upload")); controller.close(); },
    });
    const client = new HttpClient({ fetch: (async (_url: string | Request | URL, init?: RequestInit) => {
      expect(init?.body).toBe(body);
      expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
      return new Response(await new Response(init!.body).text());
    }) as unknown as typeof fetch });
    expect((await client.post(url, body)).data).toBe("stream upload");
  });

  test("a stream PUT is not retried after a transport failure", async () => {
    let calls = 0;
    const client = new HttpClient({
      retry: { maxRetries: 3, backoffMs: 0 },
      fetch: (async () => { calls++; throw new TypeError("connection reset"); }) as unknown as typeof fetch,
    });
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    await expect(client.put(url, body)).rejects.toMatchObject({ code: HttpErrorCode.Network });
    expect(calls).toBe(1);
  });
});

describe("HTTP-E03: response cap measures bytes exposed by Fetch", () => {
  test("CORS can hide Content-Encoding while exposing the encoded Content-Length", async () => {
    const raw = new Response("ok", { headers: { "content-length": "22" } });
    Object.defineProperty(raw, "type", { value: "cors" });
    const client = new HttpClient({ maxResponseBytes: 5, fetch: (async () => raw) as unknown as typeof fetch });
    expect((await client.get(url)).data).toBe("ok");
  });

  for (const encoding of ["gzip", "br", "gzip, br"]) {
    test(`${encoding}: encoded Content-Length cannot reject a decoded body that fits`, async () => {
      const client = new HttpClient({ maxResponseBytes: 5, fetch: (async () => new Response("ok", {
        headers: { "content-encoding": encoding, "content-length": "22" },
      })) as unknown as typeof fetch });
      const result = await client.get(url);
      expect(result.data).toBe("ok");
      expect(result.raw.headers.get("content-length")).toBe("22");
    });
  }

  test("a small encoded representation does not bypass the decoded stream cap", async () => {
    const client = new HttpClient({ maxResponseBytes: 5, fetch: (async () => new Response("decoded body is too long", {
      headers: { "content-encoding": "gzip", "content-length": "2" },
    })) as unknown as typeof fetch });
    await expect(client.get(url)).rejects.toMatchObject({ code: HttpErrorCode.ResponseTooLarge });
  });

  test("identity Content-Length still fails early and cancels without waiting for cleanup", async () => {
    let canceled = 0;
    const body = new ReadableStream({ cancel() { canceled++; return new Promise(() => {}); } });
    const client = new HttpClient({ maxResponseBytes: 5, fetch: (async () => new Response(body, {
      headers: { "content-encoding": " Identity ", "content-length": "22" },
    })) as unknown as typeof fetch });
    await expect(client.get(url)).rejects.toMatchObject({ code: HttpErrorCode.ResponseTooLarge });
    expect(canceled).toBe(1);
  });
});

describe("HTTP-E04: wrappers preserve the original Fetch response", () => {
  const wrappers: Record<string, RequestConfig> = {
    limit: { maxResponseBytes: 1024 },
    progress: { onDownloadProgress: () => {} },
    both: { maxResponseBytes: 1024, onDownloadProgress: () => {} },
  };
  for (const [name, config] of Object.entries(wrappers)) {
    for (const [status, body, code] of [
      [200, '{"ok":true}', undefined],
      [422, '{"error":true}', HttpErrorCode.BadStatus],
      [200, "malformed", HttpErrorCode.BadResponse],
      [502, "malformed", HttpErrorCode.BadStatus],
    ] as const) {
      test(`${name}, ${status}, ${body}`, async () => {
        const raw = new Response(body, { status, headers: { "content-type": "application/json" } });
        const client = new HttpClient({ ...config, fetch: (async () => raw) as unknown as typeof fetch });
        const outcome = await client.get(url).catch(error => error);
        if (code) {
          expect(outcome).toBeInstanceOf(HttpClientError);
          expect(outcome.code).toBe(code);
        }
        const envelope = code ? outcome.response : outcome;
        expect(envelope.raw).toBe(raw);
        expect(envelope.status).toBe(status);
        expect(raw.bodyUsed).toBe(true);
        expect(raw.body?.locked).toBe(false);
      });
    }
  }

  test("stream data retains the cap while raw retains its identity", async () => {
    let pulls = 0;
    const raw = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulls === 1) controller.enqueue(encoder.encode("a"));
      else if (pulls === 2) controller.enqueue(encoder.encode("bcde"));
      else controller.close();
    } }));
    const client = new HttpClient({ maxResponseBytes: 3, fetch: (async () => raw) as unknown as typeof fetch });
    const result = await client.get<ReadableStream<Uint8Array>>(url, { responseType: "stream" });
    expect(result.raw).toBe(raw);
    expect(result.data).not.toBe(raw.body);
    expect(raw.body?.locked).toBe(true);
    await expect(new Response(result.data).text()).rejects.toMatchObject({ code: HttpErrorCode.ResponseTooLarge });
    expect(raw.body?.locked).toBe(false);
  });
});
