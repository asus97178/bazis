import { describe, expect, test } from "bun:test";
import { InfraError, OpenSearchClient } from "../index";

describe("OpenSearchClient safety", () => {
  test("encodes index and document id as independent URL path segments", async () => {
    const originalFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const client = new OpenSearchClient({ url: "https://search.internal:9200" });
      await client.index("tenant/a b", { title: "x" }, "doc/1");
      expect(requested).toBe("https://search.internal:9200/tenant%2Fa%20b/_doc/doc%2F1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("bounds streamed response bodies before JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"payload":"this is too large"}', { status: 200 })) as unknown as typeof fetch;
    try {
      const client = new OpenSearchClient({
        url: "https://search.internal:9200",
        maxResponseBytes: 16,
      });
      await expect(client.info()).rejects.toThrow(/response exceeded 16 bytes/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("redacts sensitive OpenSearch error bodies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      '{"apiKey":"super-secret-key","reason":"denied"}',
      { status: 401 },
    )) as unknown as typeof fetch;
    try {
      const client = new OpenSearchClient({ url: "https://search.internal:9200" });
      try {
        await client.info();
        throw new Error("unreachable");
      } catch (error) {
        expect(error).toBeInstanceOf(InfraError);
        expect((error as Error).message).toContain('"apiKey":"***"');
        expect((error as Error).message).not.toContain("super-secret-key");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unsafe base URLs and invalid resource limits", () => {
    expect(() => new OpenSearchClient({ url: "file:///tmp/index" })).toThrow(/http or https/);
    expect(() => new OpenSearchClient({ url: "https://admin:secret@search.internal" })).toThrow(
      /embedded credentials/,
    );
    expect(() => new OpenSearchClient({ url: "https://search.internal?token=secret" })).toThrow(
      /query string or fragment/,
    );
    expect(() => new OpenSearchClient({ url: "https://search.internal", timeoutMs: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new OpenSearchClient({ url: "https://search.internal", maxResponseBytes: Infinity })).toThrow(
      /positive integer/,
    );
    const client = new OpenSearchClient({ url: "https://search.internal" });
    expect(() => client.index("index", {}, " ")).toThrow(/document id must be a non-empty string/);
  });
});
