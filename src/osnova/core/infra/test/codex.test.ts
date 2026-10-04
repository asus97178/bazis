import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig } from "../../kernel";
import { codexAppServerConnect } from "../connectors/codex";
import { CodexAppServerClient } from "../connectors/codex/CodexAppServerClient";
import { CodexAppServer } from "../connectors/codex/CodexAppServer";
import { checkCodexPolicy, codexConversation, codexPaths, codexProcessOptions } from "../connectors/codex/CodexPolicy";
import { CodexError, type CodexRunInput } from "../connectors/codex/contracts";

const binary = resolve(import.meta.dir, "fixtures/codex-server.py");
async function fixture(authorized = true) {
  await chmod(binary, 0o700);
  const directory = await mkdtemp(join(tmpdir(), "osnova-codex-test-"));
  const home = join(directory, "home"); await mkdir(home);
  if (authorized) await writeFile(join(home, "fixture-account"), "fixture");
  const client = new CodexAppServerClient({ enabled: true, binary, stateDirectory: directory });
  return { client, home, directory, wire: async () => (await readFile(join(home, "fixture-wire.jsonl"), "utf8")).trim().split('\n').map(line => JSON.parse(line)),
    close: async () => { await client.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
const input = (message = "привет", overrides: Partial<CodexRunInput> = {}): CodexRunInput => ({
  instructions: "Отвечай кратко", messages: [{ role: "user", text: message }], signal: new AbortController().signal, onTextDelta() {}, ...overrides,
});

test("disables bundled skills before admitting work and rechecks the catalog for every thread", async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    await f.client.run(input());
    await f.client.run(input("ещё"));
    const wire = await f.wire();
    const writes = wire.filter(item => item.method === "skills/config/write");
    expect(writes).toHaveLength(6);
    expect(writes.every(item => item.params.enabled === false)).toBe(true);
    expect(new Set(writes.map(item => item.params.path)).size).toBe(6);
    const lists = wire.filter(item => item.method === "skills/list");
    expect(lists).toHaveLength(4);
    const workspace = await realpath(join(f.directory, "workspace"));
    expect(lists.every(item => item.params.forceReload === true && item.params.cwds[0] === workspace)).toBe(true);
    for (let index = 0; index < wire.length; index++) {
      if (wire[index].method !== "thread/start") continue;
      expect(wire[index - 1].method).toBe("skills/list");
      expect(wire[index].params.developerInstructions).toContain("No skills are enabled in this session.");
    }
  } finally { await f.close(); }
});

test.each(["reject-write", "ignore-write", "bad-write-response", "discovery-error", "missing-data", "wrong-cwd", "duplicate-path", "bad-enabled", "relative-path", "too-many"])("skill admission fails closed before generation: %s", async mode => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "fixture-skills-mode"), mode);
    const error = await f.client.run(input()).catch(error => error);
    expect(error).toBeInstanceOf(CodexError);
    expect(error.message).not.toContain("private-token");
    const wire = await f.wire();
    expect(wire.some(item => ["thread/start", "turn/start"].includes(item.method))).toBe(false);
  } finally { await f.close(); }
});

test.each(["reenabled", "new-skill", "discovery-error"])("a changed skill catalog blocks the next thread: %s", async mode => {
  const f = await fixture();
  try {
    await f.client.connect();
    await writeFile(join(f.home, "fixture-skills-mode"), mode);
    await expect(f.client.run(input())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect((await f.wire()).some(item => item.method === "thread/start")).toBe(false);
    expect((await f.client.status()).activeRuns).toBe(0);
  } finally { await f.close(); }
});

test("dynamic tools round-trip through the host with thread isolation and streamed text", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const tool = { name: "osnova_tool_0", description: "Read", inputSchema: { type: "object" } };
    const answers = await Promise.all([1, 2].map(index => f.client.run(input("tool", {
      tools: [tool], onToolCall: async call => { calls.push(call.id); return { success: true, text: "owner-" + index }; },
    }))));
    expect(answers).toEqual(["Данные: owner-1", "Данные: owner-2"]);
    expect(new Set(calls).size).toBe(2);
    const wire = await f.wire();
    expect(wire.filter(item => item.method === "thread/start").every(item => item.params.dynamicTools[0].type === "function")).toBe(true);
    expect(wire.filter(item => item.result?.contentItems).length).toBe(2);
  } finally { await f.close(); }
});

test.each(["tool-unknown", "tool-duplicate", "tool-cross-turn", "tool-namespace"])("rejects %s without repeating host execution", async message => {
  const f = await fixture(); let calls = 0;
  try {
    await expect(f.client.run(input(message, { tools: [{ name: "osnova_tool_0", description: "Read", inputSchema: {} }],
      onToolCall: async () => { calls++; return { success: true, text: "ok" }; },
    }))).rejects.toBeInstanceOf(CodexError);
    expect(calls).toBe(message === "tool-duplicate" ? 1 : 0);
  } finally { await f.close(); }
});

test("aborting a tool that ignores its signal still settles the turn", async () => {
  const f = await fixture(), abort = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const running = f.client.run(input("tool", { signal: abort.signal,
      tools: [{ name: "osnova_tool_0", description: "Read", inputSchema: {} }],
      onToolCall: async () => { entered(); return new Promise(() => {}); },
    }));
    const outcome = running.catch(error => error);
    await started; abort.abort(); expect(await outcome).toBeInstanceOf(Error);
    expect((await f.client.status()).activeRuns).toBe(0);
  } finally { await f.close(); }
});

test("a terminal notification cannot report success while its host tool is unfinished", async () => {
  const f = await fixture();
  try {
    await expect(f.client.run(input("tool-early-complete", {
      tools: [{ name: "osnova_tool_0", description: "Read", inputSchema: {} }],
      onToolCall: () => new Promise(() => {}),
    }))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect((await f.client.status()).activeRuns).toBe(0);
  } finally { await f.close(); }
});

test("disabled connector needs no process or credentials and remains disposed", async () => {
  const config = defineConfig("codex-test", { default: { enabled: false, binary: "/does/not/exist", stateDirectory: "/does/not/exist" } });
  const connector = codexAppServerConnect(config), client = connector.create();
  await connector.connect(client);
  expect((await client.status()).configured).toBe(false);
  await expect(client.run(input())).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  await connector.dispose(client);
  await expect(client.status()).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

test("managed shared login, idempotent pending login, cancel, models and logout", async () => {
  const f = await fixture(false);
  try {
    await expect(f.client.run(input())).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    const first = await f.client.login("device"), repeated = await f.client.login("browser");
    expect(first.login?.userCode).toBe("FIXT-1234"); expect(repeated.login).toEqual(first.login);
    expect((await f.wire()).filter(item => item.method === "account/login/start")).toHaveLength(1);
    expect((await f.client.cancelLogin()).login).toBeNull();
    await f.client.login("browser"); await writeFile(join(f.home, "fixture-login-success"), "done");
    expect((await f.client.status()).connected).toBe(true);
    expect((await f.client.status()).login).toBeNull();
    expect((await f.client.models())[0]).toMatchObject({ id: "fixture-model", name: "Fixture model", isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] });
    expect((await f.client.logout()).connected).toBe(false);
  } finally { await f.close(); }
});

test("stream deltas precede completion; canonical final text is not duplicated", async () => {
  const f = await fixture(); const deltas: string[] = []; let finished = false;
  try {
    const result = await f.client.run(input("привет", { onTextDelta: text => { expect(finished).toBe(false); deltas.push(text); } }));
    finished = true;
    expect(deltas.length).toBeGreaterThan(1); expect(deltas.join('')).toBe(result); expect(result).toBe("Ответ: привет");
    const wire = await f.wire(); expect(wire.filter(item => item.method === "turn/start")).toHaveLength(1);
    expect(wire.some(item => item.method === "thread/unsubscribe")).toBe(true);
    const start = wire.find(item => item.method === "thread/start").params;
    expect(start).toMatchObject({ ephemeral: true, approvalPolicy: "never", sandbox: "read-only", allowProviderModelFallback: false });
    expect(wire.find(item => item.method === "turn/start").params.effort).toBe("medium");
  } finally { await f.close(); }
});

test("model-specific reasoning choices reach turn/start; unsupported choices never start work", async () => {
  const f = await fixture();
  try {
    expect(await f.client.run(input("выбор", { model: "fixture-fast", reasoningEffort: "high" }))).toBe("Ответ: выбор");
    for (const effort of ["xhigh", "missing", "", null, 123]) {
      await expect(f.client.run(input("не отправлять", { model: "fixture-fast", reasoningEffort: effort as string }))).rejects.toMatchObject({ code: "REASONING_UNAVAILABLE" });
    }
    const wire = await f.wire(), starts = wire.filter(item => item.method === "turn/start");
    expect(starts).toHaveLength(1); expect(starts[0].params.effort).toBe("high");
    expect(wire.filter(item => item.method === "thread/start").map(item => item.params.model)).toEqual(["fixture-fast"]);
    expect((await f.client.status()).activeRuns).toBe(0);
  } finally { await f.close(); }
});

test("cancel interrupts one thread, preserves other work, and locks account mutations", async () => {
  const f = await fixture(); const abort = new AbortController(); let early!: () => void;
  const partial = new Promise<void>(resolve => { early = resolve; });
  try {
    const first = f.client.run(input("slow-cancel", { signal: abort.signal, onTextDelta: () => early() })).catch(error => error);
    await partial;
    await expect(f.client.logout()).rejects.toMatchObject({ code: "BUSY" });
    const second = f.client.run(input("другой диалог"));
    abort.abort(); expect(await first).toBeInstanceOf(Error);
    expect(await second).toBe("Ответ: другой диалог");
    const wire = await f.wire(); expect(wire.filter(item => item.method === "turn/interrupt")).toHaveLength(1);
    expect((await f.client.status()).activeRuns).toBe(0);
  } finally { await f.close(); }
});

test.each(["failure", "dead", "large", "unsupported"])("fails honestly after partial text: %s", async message => {
  const f = await fixture(); const deltas: string[] = [];
  try {
    await expect(f.client.run(input(message, { onTextDelta: text => deltas.push(text) }))).rejects.toBeInstanceOf(Error);
    expect(deltas.join('')).toBe("Ответ: ");
    if (message === "unsupported") expect((await f.wire()).some(item => item.id === "approval" && item.error)).toBe(true);
    expect((await f.client.status()).activeRuns).toBe(0);
  } finally { await f.close(); }
});

test("early events and concurrent conversations keep separate text and context", async () => {
  const f = await fixture();
  try {
    expect(await f.client.run(input("early"))).toBe("Ранний ответ");
    const values = await Promise.all([f.client.run(input("один")), f.client.run(input("два"))]);
    expect(values).toEqual(["Ответ: один", "Ответ: два"]);
    await expect(f.client.run(input("x", { model: "missing-model" }))).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect((await f.wire()).filter(item => item.method === "turn/start")).toHaveLength(3);
  } finally { await f.close(); }
});

test.each(["test/hang", "test/bad-result", "test/malformed", "test/huge", "test/error", "test/invalid-request-id"])("RPC timeout, malformed frames and provider errors settle without secrets: %s", async method => {
  const directory = await mkdtemp(join(tmpdir(), "osnova-codex-rpc-")); await chmod(binary, 0o700);
  const paths = await codexPaths(directory), options = codexProcessOptions(paths);
  const rpc = new CodexAppServer(binary, options.args, options.options);
  try {
    const result = await rpc.request(method, {}, 250).catch(error => error);
    expect(result).toBeInstanceOf(CodexError); expect(result.message).not.toContain("private-token");
  } finally { await rpc.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("context is bounded by whole turns; child environment drops application secrets", async () => {
  const history = Array.from({ length: 20 }, () => [{ role: "user" as const, text: "old".repeat(1000) }, { role: "assistant" as const, text: "answer".repeat(1000) }]).flat();
  const encoded = codexConversation([...history, { role: "user", text: "current" }], "instructions");
  expect(encoded.length).toBeLessThanOrEqual(48_000); expect(JSON.parse(encoded).history.length % 2).toBe(0);
  const directory = await mkdtemp(join(tmpdir(), "osnova-codex-policy-"));
  try {
    const paths = await codexPaths(directory), options = codexProcessOptions(paths);
    expect(options.options.env.CODEX_HOME).toBe(paths.home);
    expect(options.options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.options.env).not.toHaveProperty("OSNOVA_DB__PASSWORD");
    expect(() => checkCodexPolicy({ config: { features: {} } })).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
