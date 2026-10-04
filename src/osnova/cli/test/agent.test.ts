import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentClientService, parseAgentRun } from "../AgentClient.service";
import { runCli } from "../main";

test("CLI delegates authenticated execution to the application and revokes its temporary session", async () => {
  const seen: string[] = [];
  const token = "a".repeat(64), id = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    seen.push(path);
    if (path.endsWith("/auth/login")) {
      expect(await request.json()).toEqual({ email: "client@example.test", password: "fixture-password" });
      return Response.json({ id: 7 }, { headers: { "set-cookie": "osnova_client_session=" + token + "; Path=/api/client" } });
    }
    expect(request.headers.get("cookie")).toBe("osnova_client_session=" + token);
    if (path.endsWith("/chat/conversations")) {
      expect(await request.json()).toEqual({ agentId: "main" });
      return Response.json({ id }, { status: 201 });
    }
    if (path.endsWith("/messages")) {
      expect(await request.json()).toMatchObject({ text: "Read", model: "test-model", reasoningEffort: "high" });
      return Response.json({ status: "completed", assistantText: "Main" });
    }
    if (path.endsWith("/auth/logout")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  } });
  const directory = await mkdtemp(join(tmpdir(), "osnova-agent-cli-"));
  const auth = join(directory, "auth.json"), logs: string[] = [];
  try {
    const origin = "http://127.0.0.1:" + server.port;
    await writeFile(auth, JSON.stringify({ server: origin, email: "client@example.test", password: "fixture-password" }), { mode: 0o600 });
    const args = ["agent", "run", "main", "--server", origin, "--auth-file", auth, "--message", "Read", "--model", "test-model", "--reasoning", "high"];
    expect(await runCli(args, { log: line => logs.push(line), error: line => logs.push(line), codegen: async () => { throw new Error("Unexpected codegen"); } })).toBe(0);
    expect(logs).toEqual(["Main"]);
    expect(seen).toEqual(["/api/client/auth/login", "/api/client/chat/conversations", "/api/client/chat/conversations/" + id + "/messages", "/api/client/auth/logout"]);
    await chmod(auth, 0o644);
    await expect(new AgentClientService().run(parseAgentRun(args.slice(1)))).rejects.toThrow("private");
    expect(seen).toHaveLength(4);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("CLI rejects invalid destinations, unknown options and unbounded input before network access", () => {
  for (const server of ["http://remote.test", "https://user:password@server.test", "https://server.test/path", "https://server.test?secret=value"]) {
    expect(() => parseAgentRun(["run", "main", "--server", server, "--auth-file", "private", "--message", "Read"])).toThrow();
  }
  expect(() => parseAgentRun(["run", "../main"])).toThrow();
  expect(() => parseAgentRun(["run", "main", "--unknown", "value"])).toThrow();
});
