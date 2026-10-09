import { afterEach, describe, expect, test } from "bun:test";
import { HttpClient, HttpClientError } from "../index";

// A relative baseUrl ("/api") resolves against the page address, as axios's
// baseURL does in a browser app. Before, it failed with "Invalid base URL".
const globals = globalThis as { location?: unknown };
afterEach(() => { delete globals.location; });

function recordingFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("relative baseUrl", () => {
  test("resolves against the page and keeps same-origin headers", async () => {
    globals.location = { href: "http://app.test/orders/7", origin: "http://app.test" };
    const { calls, fetch } = recordingFetch();
    const api = new HttpClient({ baseUrl: "/api", fetch, headers: { authorization: "Bearer t" } });
    const response = await api.get<{ ok: boolean }>("/users", { params: { page: 2 } });
    expect(response.data).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("http://app.test/api/users?page=2");
    expect(calls[0]!.headers.authorization).toBe("Bearer t");

    // Another origin still loses the secret header.
    await api.get("https://other.test/users");
    expect(calls[1]!.url).toBe("https://other.test/users");
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  test("outside a page a relative baseUrl is a clear error", async () => {
    const { fetch } = recordingFetch();
    const api = new HttpClient({ baseUrl: "/api", fetch });
    const error = await api.get("/users").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).message).toBe(
      'baseUrl "/api" is relative: outside a browser page it must be absolute, for example "http://localhost:3000/api"',
    );
    expect((error as HttpClientError).code).toBeUndefined();
  });
});
