import { expect, test } from "bun:test";
import { HttpClient, HttpClientError } from "../index";

// 0.100.8: an option the client does not know is refused with a suggestion.
// On 0.100.7 axios-style `baseURL` was dropped silently and every call failed
// with ERR_NETWORK "fetch() URL is invalid".

test("axios-style baseURL in the defaults is refused with the right name", () => {
  expect(() => new HttpClient({ baseURL: "http://localhost:3000" } as never))
    .toThrow('Unknown HttpClient option "baseURL" in the client defaults; did you mean "baseUrl"?');
});

test("axios timeout points to timeoutMs", () => {
  expect(() => new HttpClient({ timeout: 1000 } as never))
    .toThrow('Unknown HttpClient option "timeout" in the client defaults; did you mean "timeoutMs"?');
});

test("an unknown request option rejects the call without a request", async () => {
  let calls = 0;
  const client = new HttpClient({ baseUrl: "http://example.test", fetch: (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch });
  const error = await client.get("/x", { retries: 3 } as never).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpClientError);
  expect((error as Error).message).toBe('Unknown HttpClient option "retries" in the request config');
  expect(calls).toBe(0);
});

test("known options still work", async () => {
  const client = new HttpClient({ baseUrl: "http://example.test", timeoutMs: 1000, fetch: (async (url: string | URL | Request) => Response.json({ url: String(url) })) as unknown as typeof fetch });
  expect((await client.get<{ url: string }>("/x", { params: { a: 1 } })).data).toEqual({ url: "http://example.test/x?a=1" });
});
