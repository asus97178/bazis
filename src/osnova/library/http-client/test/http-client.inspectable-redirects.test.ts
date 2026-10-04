import { describe, expect, test } from "bun:test";
import { HttpClient, HttpErrorCode, InspectableRedirectProtocol as protocol } from "../index";

describe("inspectable redirect protocol validation", () => {
  const invalidHeaders: Record<string, string>[] = [
    {},
    { [protocol.header]: "unknown" },
    { [protocol.header]: protocol.version, [protocol.statusHeader]: "0302", location: "/next" },
    { [protocol.header]: protocol.version, [protocol.statusHeader]: "999", location: "/next" },
    { [protocol.header]: protocol.version, [protocol.statusHeader]: "302" },
  ];
  test.each(invalidHeaders)("rejects invalid or unavailable protocol before following", async headers => {
    let calls = 0;
    let canceled = 0;
    const client = new HttpClient({ inspectableRedirects: true, retry: { maxRetries: 3, backoffMs: 0 },
      fetch: (async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { canceled++; return new Promise(() => {}); } }), { headers });
      }) as unknown as typeof fetch,
    });
    await expect(client.get("https://peer.test")).rejects.toMatchObject({ code: HttpErrorCode.RedirectNotInspectable });
    expect(calls).toBe(1);
    expect(canceled).toBe(1);
  });

  test("undefined preserves opt-in and false explicitly disables it", async () => {
    const observed: (string | null)[] = [];
    const client = new HttpClient({ inspectableRedirects: true, fetch: (async (_url, init) => {
      const value = new Headers(init?.headers).get(protocol.header);
      observed.push(value);
      return new Response("ok", { headers: value ? { [protocol.header]: value } : {} });
    }) as typeof fetch });
    await client.get("https://peer.test", { inspectableRedirects: undefined });
    await client.get("https://peer.test", { inspectableRedirects: false });
    expect(observed).toEqual([protocol.version, null]);
  });

  test("rejects invalid opt-in before a request", async () => {
    let calls = 0;
    const client = new HttpClient({ fetch: (async () => { calls++; return new Response(); }) as unknown as typeof fetch });
    for (const value of [null, "true", 1]) {
      await expect(client.get("https://peer.test", { inspectableRedirects: value as unknown as boolean })).rejects.toThrow("must be a boolean");
    }
    expect(calls).toBe(0);
  });
});
