/** Source/binary integration probe. All service ports are synthetic; no database or external model. */
import assert from "node:assert/strict";
import { AgentRegistry, agentMessage, agentModelResponse, agentToolCall, type AgentModelProvider } from "@osnova/core/agent";
import { HOSTED_SERVICE, createContainer, singletonValue, type OsnovaModuleMetadata } from "@osnova/core/di";
import { HttpServer, httpModule } from "@osnova/core/http";
import type { CodexClient } from "@osnova/core/infra";
import { hs256, TokenService } from "@osnova/library/jwt";
import { registerOsnovaGeneratedRuntime } from "../../src/generated/osnv/runtime";
import { AppModule } from "../../src/app/modules/App.module";
import { ACCESS_TOKEN_VALIDATOR } from "../../src/app/modules/auth/accessTokenValidation";
import { TokenKind } from "../../src/app/modules/auth/tokenKinds";
import type { AgentDocument } from "../../src/app/modules/agents/contracts/Agent.document";
import { IAgentsService } from "../../src/app/modules/agents/services/IAgents.service";
import { RunService } from "../../src/app/modules/agents/services/Run.service";
import { ToolsModule } from "../../src/app/modules/agents/tools/Tools.module";

await registerOsnovaGeneratedRuntime();
assert.deepEqual(AgentRegistry.fromModules([AppModule]).listTools().map(tool => tool.metadata.name), ["agents.getAll"]);
const definition: AgentDocument = { id: "probe", name: "Probe", description: "", instructions: "Read the agent catalog.",
  toolNames: ["agents.getAll"], modelProfile: "", enabled: true, revision: 1, createdAt: "", updatedAt: "" };
let reads = 0;
const agents = { getAll: async () => {
  reads++;
  return { data: [{ ...definition, name: "Public reader", instructions: "PRIVATE-CATALOG-INSTRUCTIONS" }],
    meta: { total: 1, page: 1, size: 20, pageCount: 1 } };
} } as unknown as IAgentsService;
const tokens = new TokenService({ admin: { issuer: "tools-probe", audience: "admin", algorithm: hs256("synthetic-tools-probe-key-32-bytes-only"),
  accessTtlSeconds: 600, refreshTtlSeconds: 3600, clockSkewSeconds: 0 } });
const declarations = ToolsModule as typeof ToolsModule & OsnovaModuleMetadata;
const fixture = { tools: declarations.tools, controllers: declarations.controllers, background: declarations.background,
  providers: [...declarations.providers!, singletonValue(IAgentsService, agents), singletonValue(TokenService, tokens),
    singletonValue(ACCESS_TOKEN_VALIDATOR, { supports: (kind: TokenKind) => kind === TokenKind.Admin, validate: () => true })], exports: [] };
const container = createContainer({ imports: [httpModule({ imports: [fixture], port: 0, hostname: "127.0.0.1", prefix: "api" })] }, { validateOnBuild: true });
const hosted = container.resolveAll(HOSTED_SERVICE);
const server = hosted.find(service => service instanceof HttpServer) as HttpServer;
try {
  for (const service of hosted.filter(value => value !== server)) await service.start();
  assert.equal(reads, 0);
  await server.start();
  const base = `http://127.0.0.1:${server.port}/api/agent-tools`;
  assert.equal((await fetch(base)).status, 401);
  const headers = { authorization: `Bearer ${(await tokens.forKind("admin").issue("probe-admin")).accessToken}` };
  const response = await fetch(base, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).items[0].name, "agents.getAll");
  const detail = await (await fetch(base + "/agents.getAll", { headers })).json();
  assert.equal(detail.inputSchema.properties.page.type, "integer");
  assert.equal(detail.outputSchema, null);
  assert.equal(reads, 0);

  let steps = 0;
  const model: AgentModelProvider = { complete: request => {
    assert.deepEqual(request.tools.map(tool => tool.name), ["agents.getAll"]);
    assert.equal(request.tools[0]!.input?.kind, "json-schema");
    if (++steps === 1) return agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls",
      toolCalls: [agentToolCall({ id: "read", name: "agents.getAll", input: { page: 1 } })] });
    assert.match(JSON.stringify(request.messages), /Public reader/);
    assert.doesNotMatch(JSON.stringify(request.messages), /PRIVATE-CATALOG-INSTRUCTIONS/);
    return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done") });
  } };
  const codex = { run: async (request: Parameters<CodexClient["run"]>[0]) => {
    assert.equal(request.tools!.length, 1);
    const result = await request.onToolCall!({ id: "codex-read", name: request.tools![0]!.name, arguments: { page: 1 } }, request.signal);
    assert.equal(result.success, true);
    assert.equal(JSON.parse(result.text).items[0].name, "Public reader");
    return "Codex done";
  } } as CodexClient;
  const run = new RunService(container, model, codex);
  const input = { requestId: "binary-probe", clientUserId: 1, text: "Read agents", history: [], signal: new AbortController().signal };
  assert.equal(await run.run(run.prepare(definition), input), "Done");
  assert.equal(await run.run(run.prepare({ ...definition, modelProfile: "codex" }), { ...input, requestId: "codex-probe" }), "Codex done");
  assert.throws(() => run.prepare({ ...definition, toolNames: ["unregistered.tool"] }));
  assert.equal(reads, 2);
  console.log(JSON.stringify({ result: "PASS", catalog: "registered", http: "Admin/no-store/schema", normalRun: "PASS", codexRun: "PASS", reads }));
} finally {
  await server.stop();
  for (const service of hosted.filter(value => value !== server)) await service.stop();
  await container.dispose();
}
