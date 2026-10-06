import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import { HttpClient, HttpErrorCode, InspectableRedirectProtocol as protocol } from "@/library/http-client";
import { httpModule } from "../index";
import { inspectableRedirectResponse } from "../HttpContext/inspectableRedirects";
import { startRedirectPeer } from "./fixtures/inspectableRedirects";

describe("inspectable redirects on the real HTTP server", () => {
  let peer: Awaited<ReturnType<typeof startRedirectPeer>>;
  beforeAll(async () => { peer = await startRedirectPeer(); });
  afterAll(async () => { await peer.close(); });

  test.each([301, 302, 303, 307, 308])("negotiates status %s without changing ordinary requests", async status => {
    const url = `${peer.baseUrl}/chain/1?status=${status}`;
    for (const version of [undefined, "unknown", protocol.version]) {
      const response = await fetch(url, { redirect: "manual", headers: version ? { [protocol.header]: version } : undefined });
      expect(response.status).toBe(version === protocol.version ? 200 : status);
      expect(response.headers.get(protocol.statusHeader)).toBe(version === protocol.version ? String(status) : null);
      expect(response.headers.get("location")).toBe(`0?status=${status}`);
      expect(response.headers.get("vary")?.toLowerCase()).toContain(protocol.header);
      if (version === protocol.version) expect(response.headers.get("cache-control")).toBe("no-store");
      await response.body?.cancel();
    }
  });

  test.each([0, 1, 2, 19, 20, 100])("enforces the exact cap %s", async maxRedirects => {
    const client = new HttpClient({ baseUrl: peer.baseUrl, inspectableRedirects: true, maxRedirects, timeoutMs: 2000 });
    let before = peer.traffic.length;
    expect((await client.get(`/chain/${maxRedirects}`)).status).toBe(200);
    expect(peer.traffic.length - before).toBe(maxRedirects + 1);
    before = peer.traffic.length;
    await expect(client.get(`/chain/${maxRedirects + 1}`)).rejects.toMatchObject({ code: HttpErrorCode.TooManyRedirects });
    expect(peer.traffic.length - before).toBe(maxRedirects + 1);
  });

  test("HEAD negotiates redirects without response bodies", async () => {
    const response = await new HttpClient({ inspectableRedirects: true, maxRedirects: 1 }).head(`${peer.baseUrl}/chain/1`);
    expect(response.status).toBe(200);
    expect(response.data).toBeUndefined();
    const raw = await fetch(`${peer.baseUrl}/chain/1`, { method: "HEAD", redirect: "manual", headers: { [protocol.header]: protocol.version } });
    expect(raw.headers.get(protocol.statusHeader)).toBe("302");
    expect(await raw.text()).toBe("");
  });

  test("protocol applies to framework 404 and keeps normal error decoding", async () => {
    const error = await new HttpClient({ inspectableRedirects: true }).get(`${peer.origin}/unmatched`).catch(error => error);
    expect(error.code).toBe(HttpErrorCode.BadStatus);
    expect(error.status).toBe(404);
    expect(error.response.data).toEqual({ error: "Not Found" });
  });

  test("native raw file Range survives enabled and negotiated transport", async () => {
    for (const inspectableRedirects of [false, true]) {
      const response = await new HttpClient({ inspectableRedirects, responseType: "text" }).get(`${peer.baseUrl}/file`, { headers: { range: "bytes=0-9" } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toStartWith("bytes 0-9/");
      expect(response.data).toBe("import { H");
    }
  });

  test("a native file-open failure preserves HTTP 500 without protocol metadata", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const error = await new HttpClient({ inspectableRedirects: true }).get(`${peer.baseUrl}/missing-file`).catch(error => error);
      expect(error.code).toBe(HttpErrorCode.BadStatus);
      expect(error.status).toBe(500);
      expect(error.response.data).toEqual({ error: "Internal Server Error" });
    } finally { console.error = original; }
  });

  test("server opt-out preserves 302 even if a client asks to inspect", async () => {
    const disabled = await startRedirectPeer({ enabled: false });
    try {
      const response = await fetch(`${disabled.baseUrl}/chain/1`, { redirect: "manual", headers: { [protocol.header]: protocol.version } });
      expect(response.status).toBe(302);
      expect(response.headers.get(protocol.header)).toBeNull();
      await response.body?.cancel();
    } finally { await disabled.close(); }
  });

  test("server rejects a non-boolean opt-in", async () => {
    @Module({ imports: [httpModule({ inspectableRedirects: "yes" as unknown as boolean })] })
    class Invalid {}
    const container = createContainer(Invalid);
    try { expect(() => container.resolveAll(HOSTED_SERVICE)).toThrow("inspectableRedirects must be a boolean"); }
    finally { await container.dispose(); }
  });
});

test("immutable responses retain body while protocol metadata stays readable", async () => {
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unchanged") });
  try {
    const raw = await fetch(`http://127.0.0.1:${source.port}`);
    const response = inspectableRedirectResponse(raw, new Request("http://peer.test", { headers: { [protocol.header]: protocol.version } }));
    expect(response.headers.get(protocol.header)).toBe(protocol.version);
    expect(await response.text()).toBe("unchanged");
  } finally { await source.stop(true); }
});
