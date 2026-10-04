import { strict as assert } from "node:assert";
const base = process.env.CHAT_CHECK_URL ?? "http://127.0.0.1:3101";
const checks: Record<string, boolean> = {};
const timings: Record<string, number> = {};
const sockets: WebSocket[] = [];
const password = "Isolated-Socket-Check-2026!";
const suffix = crypto.randomUUID();
async function http(path: string, body?: unknown, cookie?: string) {
  const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert(response.ok, `HTTP ${path}: ${response.status}`);
  return { response, data: response.status === 204 ? null : await response.json() as any };
}
async function account(name: string) {
  const result = await http("/api/client/auth/register", { name, email: `${name}-${suffix}@socket.example.test`, password });
  return { cookie: result.response.headers.get("set-cookie")!.split(";")[0]!, user: result.data };
}
async function rejectUpgrade(headers: Record<string, string>, status: number, query = "") {
  const response = await fetch(base + "/api/client/chat/ws" + query, { headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers,
  } });
  assert.equal(response.status, status);
}
async function connect(cookie: string) {
  const socket = new WebSocket(base.replace(/^http/, "ws") + "/api/client/chat/ws", { headers: { origin: base, cookie } });
  sockets.push(socket);
  const packets: any[] = [];
  let closed: number | undefined;
  socket.onmessage = event => packets.push(JSON.parse(String(event.data)));
  socket.onclose = event => { closed = event.code; };
  socket.onerror = () => {};
  async function until(predicate: () => any, timeout = 12_000): Promise<any> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = predicate(); if (value) return value; await Bun.sleep(10); }
    throw new Error(`WebSocket wait timed out; closed=${closed}`);
  }
  await until(() => packets.find(packet => packet.type === "connected"));
  async function rpc(command: string, data: unknown = {}, expected = 200): Promise<any> {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ v: 1, type: "event", event: "chat.command", id, data: { command, data } }));
    const packet = await until(() => packets.find(packet => packet.id === id));
    assert.equal(packet.type, "ack", JSON.stringify(packet));
    if (expected !== 200) { assert.equal(packet.data?.error?.status, expected, JSON.stringify(packet)); return packet.data; }
    assert.equal(packet.data?.ok, true, JSON.stringify(packet)); return packet.data.data;
  }
  return { socket, rpc, packets, until, closed: () => closed,
    turn: (id: string) => until(() => packets.find(packet => packet.event === "chat.turn" && packet.data.id === id && packet.data.status !== "pending")?.data) };
}
try {
  await rejectUpgrade({ origin: base }, 401);
  await rejectUpgrade({}, 403);
  const alice = await account("socket-alice"), bob = await account("socket-bob");
  await rejectUpgrade({ origin: "https://untrusted.example", cookie: alice.cookie }, 403);
  await rejectUpgrade({ origin: base, cookie: alice.cookie + "; " + alice.cookie }, 401);
  await rejectUpgrade({ origin: base, cookie: alice.cookie }, 400, "?sid=forged");
  checks.upgrade_auth_origin_duplicate_cookie = true;
  const a = await connect(alice.cookie), a2 = await connect(alice.cookie), b = await connect(bob.cookie);
  assert((await a.rpc("agents.list")).some((agent: any) => agent.id === "main"));
  const conversation = await a.rpc("conversations.create", { agentId: "main" });
  const conversationId = conversation.id;
  assert((await a.rpc("conversations.list")).items.some((item: any) => item.id === conversationId));
  await b.rpc("conversation.get", { conversationId, ownerId: alice.user.id }, 404);
  await b.rpc("message.send", { conversationId, requestId: crypto.randomUUID(), text: "forbidden", ownerId: alice.user.id }, 404);
  await a.rpc("message.send", { conversationId, requestId: "bad", text: "x" }, 400);
  await a.rpc("unknown.command", {}, 400);
  checks.catalog_history_validation_owner_isolation = true;
  const slowId = crypto.randomUUID(), started = Date.now();
  const pending = await a.rpc("message.send", { conversationId, requestId: slowId, text: "slow-cancel" });
  assert.equal(pending.status, "pending"); assert(Date.now() - started < 2500);
  await a.rpc("session.check");
  await a2.until(() => a2.packets.find(packet => packet.event === "chat.turn" && packet.data.id === slowId && packet.data.status === "pending"));
  const firstText = await a.until(() => a.packets.find(packet => packet.event === "chat.text" && packet.data.requestId === slowId));
  assert(firstText.data.text.length > 0);
  await a2.until(() => a2.packets.find(packet => packet.event === "chat.text" && packet.data.requestId === slowId));
  const active = (await a2.rpc("conversation.get", { conversationId })).turns.find((turn: any) => turn.id === slowId);
  assert.equal(active.status, "pending"); assert(active.assistantText.startsWith(firstText.data.text));
  await b.rpc("message.cancel", { conversationId, requestId: slowId }, 404);
  const cancelled = await a.rpc("message.cancel", { conversationId, requestId: slowId });
  assert.equal(cancelled.status, "cancelled");
  assert(cancelled.assistantText.startsWith(firstText.data.text));
  assert.equal((await a2.turn(slowId)).status, "cancelled");
  assert.equal((await a.rpc("message.send", { conversationId, requestId: slowId, text: "slow-cancel" })).status, "cancelled");
  await a.rpc("message.send", { conversationId, requestId: slowId, text: "changed" }, 409);
  checks.early_ack_same_socket_cancel_idempotency_multi_tab = true;
  checks.partial_text_persisted_on_cancel_and_visible_in_live_snapshot = true;
  const normalId = crypto.randomUUID();
  const normalStart = Date.now();
  await a.rpc("message.send", { conversationId, requestId: normalId, text: "normal" });
  const liveText = await a.until(() => a.packets.find(packet => packet.event === "chat.text" && packet.data.requestId === normalId));
  timings.first_text_ms = Date.now() - normalStart;
  assert(liveText.data.text.length > 0);
  assert(!a.packets.some(packet => packet.event === "chat.turn" && packet.data.id === normalId && packet.data.status !== "pending"));
  assert.equal((await a.turn(normalId)).assistantText, "Контрольный ответ: normal");
  timings.completed_ms = Date.now() - normalStart;
  assert(timings.completed_ms - timings.first_text_ms > 500);
  checks.real_incremental_text_before_completion = true;
  assert.equal((await a.rpc("conversation.get", { conversationId })).turns.find((turn: any) => turn.id === normalId).status, "completed");
  assert(!b.packets.some(packet => packet.event === "chat.turn" || packet.event === "chat.text"));
  checks.completed_push_persisted_private = true;
  const brokenId = crypto.randomUUID();
  await a.rpc("message.send", { conversationId, requestId: brokenId, text: "stream-failure" });
  const broken = await a.turn(brokenId);
  assert.equal(broken.status, "failed"); assert(broken.assistantText.length > 0); assert(broken.error);
  assert.equal((await a.rpc("conversation.get", { conversationId })).turns.find((turn: any) => turn.id === brokenId).assistantText, broken.assistantText);
  checks.broken_stream_failed_with_saved_partial_and_no_fallback = true;
  const largeId = crypto.randomUUID();
  await a.rpc("message.send", { conversationId, requestId: largeId, text: "large" });
  const large = await a.turn(largeId); assert.equal(large.assistantText.length, 16_000);
  assert(JSON.stringify(await a.rpc("conversation.get", { conversationId })).length > 64 * 1024);
  checks.large_history_without_larger_ingress_limit = true;
  // New conversation avoids the intentionally large context above.
  const reconnectConversation = await a.rpc("conversations.create", { agentId: "main" });
  const reconnectId = crypto.randomUUID();
  await a.rpc("message.send", { conversationId: reconnectConversation.id, requestId: reconnectId, text: "slow-disconnect" });
  const disconnectText = await a.until(() => a.packets.find(packet => packet.event === "chat.text" && packet.data.requestId === reconnectId));
  a.socket.close();
  const restored = await connect(alice.cookie);
  const snapshot = await restored.rpc("conversation.get", { conversationId: reconnectConversation.id });
  const turn = snapshot.turns.find((turn: any) => turn.id === reconnectId);
  assert.equal(turn.status === "pending" ? (await restored.turn(reconnectId)).status : turn.status, "cancelled");
  const recovered = (await restored.rpc("conversation.get", { conversationId: reconnectConversation.id })).turns.find((turn: any) => turn.id === reconnectId);
  assert(recovered.assistantText.startsWith(disconnectText.data.text));
  checks.disconnect_cancellation_and_reconnect_snapshot = true;
  await http("/api/client/auth/logout", {}, alice.cookie);
  restored.socket.send(JSON.stringify({ v: 1, type: "event", event: "chat.command", id: crypto.randomUUID(), data: { command: "session.check" } }));
  await restored.until(() => restored.closed()); assert.equal(restored.closed(), 4401);
  await rejectUpgrade({ origin: base, cookie: alice.cookie }, 401);
  checks.logout_revokes_existing_and_new_socket = true;
  const big = await connect(bob.cookie);
  big.socket.send(JSON.stringify({ v: 1, type: "event", event: "chat.command", id: "oversize", data: { command: "message.send", text: "x".repeat(70_000) } }));
  await big.until(() => big.closed());
  assert([1006, 1009].includes(big.closed()!));
  checks.oversized_frame_rejected = true;
  console.log(JSON.stringify({ status: "PASS", checks, timings }));
} finally { for (const socket of sockets) socket.close(); }
