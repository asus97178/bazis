import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AgentToolExecutionContext } from "@/core/agent";
import { HttpRequestTool, type ToolsSettings } from "@/core/tools";
import { hostAllowed, isPublicAddress } from "@/core/tools/http/publicAddress";
import type { ConfigView } from "@/core/kernel";
import { redactValues } from "@/library/redaction";

const seen: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers), body: await request.text() });
    switch (url.pathname) {
      case "/json": return Response.json({ hello: "world" }, { headers: { "set-cookie": "a=b", "x-kept": "yes" } });
      case "/text": return new Response("plain");
      case "/empty": return new Response(null, { status: 204 });
      case "/missing": return new Response("no", { status: 404 });
      case "/down": return new Response("no", { status: 503 });
      case "/busy": return new Response("no", { status: 429 });
      case "/big": return new Response("x".repeat(2000));
      case "/stream": return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("y".repeat(2000))); controller.close(); } }));
      case "/slow": await Bun.sleep(500); return new Response("late");
      case "/moved": return new Response(null, { status: 302, headers: { location: "/json" } });
      case "/keep": return new Response(null, { status: 307, headers: { location: "/json" } });
      case "/away": return new Response(null, { status: 302, headers: { location: url.searchParams.get("to")! } });
      case "/loop": return new Response(null, { status: 302, headers: { location: "/loop" } });
      default: return new Response("?", { status: 500 });
    }
  };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
});

afterAll(() => {
  server.stop(true);
  other.stop(true);
});

function tool(settings: Partial<ToolsSettings> = {}): HttpRequestTool {
  const values: ToolsSettings = { "http.allow": `127.0.0.1:${server.port}`, "http.callers": "workflow", "http.allowPrivateNetworks": true, "http.maxResponseBytes": 1000, "http.timeoutMs": 2000, ...settings };
  return new HttpRequestTool({ get: (key: keyof ToolsSettings) => values[key] } as unknown as ConfigView<ToolsSettings>);
}

const context = (more: Partial<AgentToolExecutionContext> = {}) => ({ signal: new AbortController().signal, caller: "workflow", metadata: {}, ...more }) as unknown as AgentToolExecutionContext;
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const reasonOf = (promise: Promise<unknown>) => promise.then(() => "no error", (error: { reason?: string; message: string }) => error.reason ?? `plain: ${error.message}`);

test("closed by default: an empty list lets nothing through, and sends nothing", async () => {
  const before = seen.length;
  expect(await reasonOf(tool({ "http.allow": "" }).execute({ url: url("/json") }, context()))).toBe("host_not_allowed");
  expect(await reasonOf(tool({ "http.allow": "api.example.com" }).execute({ url: url("/json") }, context()))).toBe("host_not_allowed");
  expect(seen.length).toBe(before);
});

test("private and loopback addresses are refused unless they are allowed, whatever the name", async () => {
  const closed = tool({ "http.allowPrivateNetworks": false, "http.allow": `127.0.0.1,localhost,[::1],169.254.169.254` });
  const before = seen.length;
  expect(await reasonOf(closed.execute({ url: url("/json") }, context()))).toBe("address_not_allowed");
  expect(await reasonOf(closed.execute({ url: `http://localhost:${server.port}/json` }, context()))).toBe("address_not_allowed");
  expect(await reasonOf(closed.execute({ url: "http://169.254.169.254/latest/meta-data" }, context()))).toBe("address_not_allowed");
  expect(await reasonOf(closed.execute({ url: "http://[::1]/x" }, context()))).toBe("address_not_allowed");
  // Other spellings of 127.0.0.1 become the same host in a URL.
  expect(await reasonOf(closed.execute({ url: "http://2130706433/x" }, context()))).toBe("address_not_allowed");
  expect(await reasonOf(closed.execute({ url: "http://0x7f.1/x" }, context()))).toBe("address_not_allowed");
  expect(seen.length).toBe(before);
});

test("a successful answer: JSON, text, headers without cookies", async () => {
  const json = await tool().execute({ url: url("/json") }, context()) as { status: number; body: unknown; headers: Record<string, string> };
  expect(json).toMatchObject({ status: 200, body: { hello: "world" } });
  expect(json.headers["x-kept"]).toBe("yes");
  expect(json.headers["set-cookie"]).toBeUndefined();
  expect(await tool().execute({ url: url("/text") }, context())).toMatchObject({ body: "plain" });
  expect(await tool().execute({ url: url("/empty") }, context())).toMatchObject({ status: 204, body: null });
  expect(await tool().execute({ url: url("/json"), method: "HEAD" }, context())).toMatchObject({ status: 200, body: null });
});

test("the method, headers, JSON body and every kind of auth reach the server", async () => {
  const last = () => seen.at(-1)!;
  await tool().execute({ url: url("/json"), method: "post", headers: { "X-One": "1" }, body: { a: 1 } }, context());
  expect(last()).toMatchObject({ method: "POST", body: '{"a":1}', headers: { "x-one": "1", "content-type": "application/json" } });
  await tool().execute({ url: url("/json"), auth: { type: "bearer", token: "abc" } }, context());
  expect(last().headers.authorization).toBe("Bearer abc");
  await tool().execute({ url: url("/json"), auth: { type: "basic", username: "u", password: "p" } }, context());
  expect(last().headers.authorization).toBe(`Basic ${btoa("u:p")}`);
  await tool().execute({ url: url("/json"), auth: { type: "apiKey", header: "X-Key", value: "k" } }, context());
  expect(last().headers["x-key"]).toBe("k");
  await tool().execute({ url: url("/json"), auth: { type: "none" } }, context());
  expect(last().headers.authorization).toBeUndefined();
});

test("a bad input is told before anything is sent", async () => {
  const before = seen.length;
  for (const input of [{}, { url: "not a url" }, { url: url("/json"), method: "TRACE" }, { url: url("/json"), body: { a: 1 } }, { url: url("/json"), auth: { type: "bearer" } }, { url: url("/json"), auth: { type: "magic" } }, { url: url("/json"), headers: { a: 1 } }, { url: url("/json"), successCodes: [] }, { url: url("/json"), timeoutMs: 0 }, { url: "ftp://127.0.0.1/x" }, { url: `http://me:pass@127.0.0.1:${server.port}/json` }]) {
    expect(await reasonOf(tool({ "http.allow": `127.0.0.1:${server.port},127.0.0.1` }).execute(input, context()))).toBe("invalid_input");
  }
  expect(seen.length).toBe(before);
});

test("a status: 4xx has a reason and is not retried, 5xx and 429 are plain failures; successCodes decide", async () => {
  expect(await reasonOf(tool().execute({ url: url("/missing") }, context()))).toBe("http_404");
  expect(await reasonOf(tool().execute({ url: url("/down") }, context()))).toStartWith("plain:");
  expect(await reasonOf(tool().execute({ url: url("/busy") }, context()))).toStartWith("plain:");
  expect(await tool().execute({ url: url("/missing"), successCodes: [404] }, context())).toMatchObject({ status: 404, body: "no" });
  expect(await reasonOf(tool().execute({ url: url("/json"), successCodes: [201] }, context()))).toBe("http_200");
});

test("limits: the size of a response and the time", async () => {
  expect(await reasonOf(tool().execute({ url: url("/big") }, context()))).toBe("response_too_large");
  expect(await reasonOf(tool().execute({ url: url("/stream") }, context()))).toBe("response_too_large");
  expect(await reasonOf(tool({ "http.timeoutMs": 50 }).execute({ url: url("/slow") }, context()))).toStartWith("plain:");
  expect(await reasonOf(tool().execute({ url: url("/slow"), timeoutMs: 50 }, context()))).toStartWith("plain:");
  // The input cannot ask for more than the configuration gives.
  expect(await reasonOf(tool({ "http.timeoutMs": 50 }).execute({ url: url("/slow"), timeoutMs: 60000 }, context()))).toStartWith("plain:");
});

test("redirects stay inside the list and leave credentials behind", async () => {
  expect(await tool().execute({ url: url("/moved") }, context())).toMatchObject({ status: 200, body: { hello: "world" } });
  expect(await reasonOf(tool().execute({ url: url(`/away?to=http://127.0.0.1:${other.port}/json`) }, context()))).toBe("host_not_allowed");
  expect(await reasonOf(tool().execute({ url: url("/loop") }, context()))).toBe("too_many_redirects");
  const both = tool({ "http.allow": `127.0.0.1:${server.port},127.0.0.1:${other.port}` });
  await both.execute({ url: url(`/away?to=http://127.0.0.1:${other.port}/json`), auth: { type: "bearer", token: "abc" }, headers: { "x-free": "1" } }, context());
  expect(seen.at(-1)!.headers.authorization).toBeUndefined();
  expect(seen.at(-1)!.headers["x-free"]).toBe("1");
  await both.execute({ url: url(`/away?to=http://127.0.0.1:${other.port}/json`), auth: { type: "apiKey", header: "x-key", value: "k" } }, context());
  expect(seen.at(-1)!.headers["x-key"]).toBeUndefined();
  await both.execute({ url: url("/moved"), auth: { type: "bearer", token: "abc" } }, context());
  expect(seen.at(-1)!.headers.authorization).toBe("Bearer abc");
  // 302 turns a write into a read, 307 keeps it.
  await tool().execute({ url: url("/moved"), method: "POST", body: { a: 1 } }, context());
  expect(seen.at(-1)).toMatchObject({ method: "GET", body: "" });
  await tool().execute({ url: url("/keep"), method: "POST", body: { a: 1 } }, context());
  expect(seen.at(-1)).toMatchObject({ method: "POST", body: '{"a":1}' });
});

test("a trial sends only what reads", async () => {
  const before = seen.length;
  expect(await tool().execute({ url: url("/json"), method: "POST", body: {} }, context({ dryRun: true }))).toEqual({ dryRun: true });
  expect(await tool().execute({ url: url("/json"), method: "DELETE" }, context({ dryRun: true }))).toEqual({ dryRun: true });
  expect(seen.length).toBe(before);
  expect(await tool().execute({ url: url("/json") }, context({ dryRun: true }))).toMatchObject({ status: 200, dryRun: true });
  expect(seen.length).toBe(before + 1);
});

test("the configuration says who may call it", async () => {
  expect(await reasonOf(tool().execute({ url: url("/json") }, context({ caller: "agent" })))).toBe("caller_not_allowed");
  expect(await tool({ "http.callers": "agent, workflow" }).execute({ url: url("/json") }, context({ caller: "agent" }))).toMatchObject({ status: 200 });
});

test("what is public and what is not", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) expect([address, isPublicAddress(address)]).toEqual([address, true]);
  for (const address of ["127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1", "::", "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "fe80::1%en0", "nonsense", "", "1.2.3", "1.2.3.256", "1:2:3"]) {
    expect([address, isPublicAddress(address)]).toEqual([address, false]);
  }
  expect(isPublicAddress("172.32.0.1")).toBe(true);
  expect(isPublicAddress("100.128.0.1")).toBe(true);
});

test("the list of hosts", () => {
  const allow = "api.example.com, *.example.org, local.test:8080";
  expect(hostAllowed(allow, "api.example.com", "443")).toBe(true);
  expect(hostAllowed(allow, "API.example.com.", "443")).toBe(true);
  expect(hostAllowed(allow, "other.example.com", "443")).toBe(false);
  expect(hostAllowed(allow, "a.example.org", "443")).toBe(true);
  expect(hostAllowed(allow, "a.b.example.org", "443")).toBe(true);
  expect(hostAllowed(allow, "example.org", "443")).toBe(false);
  expect(hostAllowed(allow, "evilexample.org", "443")).toBe(false);
  expect(hostAllowed(allow, "local.test", "8080")).toBe(true);
  expect(hostAllowed(allow, "local.test", "80")).toBe(false);
  expect(hostAllowed("", "api.example.com", "443")).toBe(false);
});

test("the values of a call are cut out of everything, whatever their length", () => {
  const value = { a: "x-abc-y", b: ["abc", { c: "abcabc" }], d: 1, e: null, abc: true, f: new Date(0) };
  const cut = redactValues(value, ["abc", ""]);
  expect(cut as unknown).toEqual({ a: "x-***-y", b: ["***", { c: "******" }], d: 1, e: null, "***": true, f: new Date(0) });
  expect(value.a).toBe("x-abc-y");
  expect(redactValues("long-short", ["short", "long-short"])).toBe("***");
  expect(redactValues(value, [])).toBe(value);
  const circular: Record<string, unknown> = { a: "abc" };
  circular.self = circular;
  expect((redactValues(circular, ["abc"]) as { self: { a: string } }).self.a).toBe("***");
});
