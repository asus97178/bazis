import { strict as assert } from "node:assert";
import { chmod, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run only through ops/codex/verify.py --tools, against its owned temporary DB.
const base = "http://127.0.0.1:3102", checks: Record<string, boolean> = {};
const sockets: WebSocket[] = [];
let token = "";
async function http(method: string, path: string, body?: unknown, expected = 200, cookie?: string) {
  const response = await fetch(base + path, { method, headers: { origin: base, "content-type": "application/json",
    ...(path.startsWith("/api/client") ? {} : { authorization: `Bearer ${token}` }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, `${method} ${path}: ${response.status}`);
  return { response, data: response.status === 204 ? null : await response.json() as any };
}
async function user(name: string) {
  const result = await http("POST", "/api/client/auth/register", {
    name, email: `${name}@agent.example.test`, password: "Agent-Fixture-2026!",
  }, 201);
  return result.response.headers.get("set-cookie")!.split(";")[0]!;
}
async function connect(cookie: string) {
  const socket = new WebSocket(base.replace("http", "ws") + "/api/client/chat/ws", { headers: { origin: base, cookie } });
  sockets.push(socket);
  const packets: any[] = [];
  socket.onmessage = event => packets.push(JSON.parse(String(event.data)));
  socket.onerror = () => {};
  async function until(fn: () => any) {
    const end = Date.now() + 12000;
    while (Date.now() < end) { const value = fn(); if (value) return value; await Bun.sleep(10); }
    throw new Error("WebSocket event timeout");
  }
  await until(() => packets.some(packet => packet.type === "connected"));
  async function rpc(command: string, data: unknown, status = 200) {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ v: 1, type: "event", event: "chat.command", id, data: { command, data } }));
    const result = await until(() => packets.find(packet => packet.id === id));
    assert.equal(result.type, "ack");
    if (status !== 200) { assert.equal(result.data?.error?.status, status); return result.data; }
    assert.equal(result.data.ok, true, JSON.stringify(result.data)); return result.data.data;
  }
  return { packets, rpc, terminal: (id: string) => until(() => packets.find(packet => packet.event === "chat.turn"
    && packet.data.id === id && packet.data.status !== "pending")?.data) };
}
const auth = resolve(".cache/agent-run/physical/cli-auth.json");
try {
  token = (await http("POST", "/api/admin/auth/bootstrap", {
    name: "Agent checker", email: "admin@agent.example.test", password: "Agent-Fixture-Admin-2026!",
  })).data.accessToken;
  for (const [id, profile, tools, enabled] of [
    ["tools-local", "", ["agents.getAll"], true],
    ["tools-codex", "codex.fixture-model", ["agents.getAll"], true],
    ["tools-codex-empty", "codex.fixture-model", [], true],
    ["tools-unknown", "", ["private.delete"], true],
    ["tools-disabled", "", [], false],
  ] as const) {
    await http("POST", "/api/agents", { id, name: id, instructions: "PRIVATE-INSTRUCTIONS-SENTINEL",
      modelProfile: profile, toolNames: tools, enabled }, 201);
  }
  const cookie = await user("alice"), other = await user("bob");
  const a = await connect(cookie), b = await connect(other);
  const unknown = (await a.rpc("conversations.create", { agentId: "tools-unknown" })).id;
  await a.rpc("message.send", { conversationId: unknown, requestId: crypto.randomUUID(), text: "Read" }, 409);
  assert.deepEqual((await a.rpc("conversation.get", { conversationId: unknown })).turns, []);
  checks.unknown_assignment_rejected_before_pending = true;
  function publicResult(text: string) {
    assert(text.startsWith("Данные: "), text);
    const result = JSON.parse(text.slice("Данные: ".length));
    assert(result.items.some((item: any) => item.id === "main"));
    assert(!result.items.some((item: any) => item.id === "tools-disabled"));
    for (const item of result.items) assert.deepEqual(Object.keys(item).sort(), ["description", "id", "name"]);
    assert(!text.includes("PRIVATE-INSTRUCTIONS-SENTINEL"));
    assert.equal(result.page, 1); assert.equal(result.hasMore, false);
  }
  for (const agentId of ["tools-local", "tools-codex"]) {
    const conversationId = (await a.rpc("conversations.create", { agentId })).id;
    const requestId = crypto.randomUUID();
    await a.rpc("message.send", { conversationId, requestId, text: "tool-read" });
    const turn = await a.terminal(requestId);
    assert.equal(turn.status, "completed", JSON.stringify(turn)); publicResult(turn.assistantText);
    const progress = a.packets.filter(packet => packet.event === "chat.tool" && packet.data.requestId === requestId);
    assert.deepEqual(progress.map(packet => packet.data.status), ["running", "completed"]);
    assert(progress.every(packet => packet.data.name === "agents.getAll" && packet.data.conversationId === conversationId));
    assert(a.packets.indexOf(progress[1]) < a.packets.findIndex(packet => packet.event === "chat.turn" && packet.data.id === requestId && packet.data.status === "completed"));
    assert.equal((await a.rpc("conversation.get", { conversationId })).turns[0].assistantText, turn.assistantText);
    checks[agentId + "_orm_tool_stream_and_persistence"] = true;
  }
  assert(!b.packets.some(packet => ["chat.tool", "chat.text", "chat.turn"].includes(packet.event)));
  checks.owner_isolation_and_public_projection = true;
  for (const agentId of ["main", "tools-codex-empty"]) {
    const conversationId = (await a.rpc("conversations.create", { agentId })).id, requestId = crypto.randomUUID();
    await a.rpc("message.send", { conversationId, requestId, text: "tool-unknown" });
    assert.equal((await a.terminal(requestId)).status, "failed");
    assert(!a.packets.some(packet => packet.event === "chat.tool" && packet.data.requestId === requestId));
  }
  checks.unassigned_model_calls_denied_for_both_providers = true;
  await writeFile(auth, JSON.stringify({ server: base, email: "alice@agent.example.test", password: "Agent-Fixture-2026!" }), { mode: 0o600 });
  await chmod(auth, 0o600);
  const child = Bun.spawn([resolve("bin/osnova"), "agent", "run", "tools-local", "--server", base, "--auth-file", auth, "--message", "tool-read"],
    { cwd: resolve(".cache/agent-run/physical/runtime"), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, error); publicResult(output.trim());
  } finally { clearTimeout(timeout); }
  const listed = (await http("GET", "/api/client/chat/conversations", undefined, 200, cookie)).data.items;
  const cliConversation = listed.find((item: any) => item.agentId === "tools-local");
  assert(cliConversation);
  assert.equal((await http("GET", `/api/client/chat/conversations/${cliConversation.id}`, undefined, 200, cookie)).data.turns[0].status, "completed");
  checks.compiled_cli_uses_same_authenticated_run_and_history = true;
  console.log(JSON.stringify({ status: "PASS", checks }));
} finally { for (const socket of sockets) socket.close(); await rm(auth, { force: true }); }
