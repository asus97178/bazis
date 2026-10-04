import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateProject } from "../../../cli/generateProject";

async function clearBuildFlags(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await clearBuildFlags(file);
    else if (process.platform === "darwin" && entry.isFile() && entry.name.endsWith(".bun-build")) {
      const child = Bun.spawn(["/usr/bin/chflags", "nouchg", file], { stdout: "ignore", stderr: "pipe" });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    }
  }
}

test("standalone Agent API and exact generated DTO schemas work in source and binaries outside checkout", async () => {
  const repository = path.resolve(import.meta.dir, "../../../../..");
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "osnova-agent-standalone-"));
  const project = path.join(root, "app");
  const execute = async (command: string[], cwd = project) => {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  };
  const run = async (command: string[], cwd = project) => {
    const result = await execute(command, cwd);
    expect(result.exit, `${command.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  const write = (name: string, content: string) => Bun.write(path.join(project, name), content);
  const compiler = path.join(repository, "node_modules/typescript/bin/tsc");
  try {
    await generateProject({ name: "AgentSchemaFixture", outputPath: project, frameworkPath: path.join(repository, "src/osnova") });
    await mkdir(path.join(project, "node_modules"));
    await symlink("../vendor/osnv", path.join(project, "node_modules/osnv"), "dir");
    for (const name of ["@types", "typescript"]) await symlink(path.join(repository, "node_modules", name), path.join(project, "node_modules", name), "dir");
    const compilerOptions = { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true, types: ["bun"] };
    // No paths at all: neither runtime nor type-only framework imports can borrow workspace aliases.
    await write("tsconfig.json", JSON.stringify({ compilerOptions, include: ["standalone.ts"] }));
    await write("standalone.ts", `import { createContainer } from "osnv/core/di";
import { AgentRegistry, AgentRuntime, agentMessage, agentModelResponse } from "osnv/core/agent";
const services = createContainer({ exports: [] });
try {
  const runtime = new AgentRuntime(services, AgentRegistry.fromDefinition({ name: "standalone", instructions: "Answer." }), {
    complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "standalone-ok") }); },
  });
  const result = await runtime.invoke("standalone", { input: "ping" });
  if (result.status !== "completed") throw new Error(JSON.stringify(result));
  console.log("STANDALONE_AGENT_PASS");
} finally { await services.dispose(); }
`);
    await run([process.execPath, compiler, "--noEmit"]);
    expect(await run([process.execPath, "--no-env-file", "standalone.ts"])).toBe("STANDALONE_AGENT_PASS");
    const standaloneBinary = path.join(root, "agent");
    await run([process.execPath, "build", "--compile", "standalone.ts", "--outfile", standaloneBinary]);
    expect(await run([standaloneBinary], root)).toBe("STANDALONE_AGENT_PASS");

    // The generator's public aliases point only into this copied package, never the original checkout.
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { ...compilerOptions, paths: { "@osnova/*": ["./node_modules/osnv/*"] } }, include: ["src/**/*.ts"] }));
    await write("src/alpha/contracts.ts", `export class NestedInput { declare label: string; }
export class EmptyInput {}
export class SharedInput { declare id: string; child: NestedInput = new NestedInput(); empty: EmptyInput = new EmptyInput(); }
export class SharedOutput { declare answer: string; }
`);
    await write("src/beta/contracts.ts", `export interface SharedInput { count: number; }
export interface SharedOutput { count: number; }
export interface NestedInput { count: number; }
export interface EmptyInput { count: number; }
export const unrelated = true;
`);
    await write("src/agent.ts", `import { Agent, Task, Tool, agentOutput } from "osnv/core/agent";
import { SharedInput, SharedOutput } from "./alpha/contracts";
@Tool({ name: "identity.tool", description: "Echo a declared field", input: SharedInput, output: SharedOutput })
export class IdentityTool { execute(input: SharedInput): SharedOutput { return { answer: input.id }; } }
@Agent({ name: "identity.agent", input: SharedInput, output: SharedOutput, tools: [IdentityTool] })
export class IdentityAgent {
  @Task({ name: "run", input: SharedInput, output: SharedOutput }) run(_input: SharedInput): SharedOutput { return agentOutput<SharedOutput>(); }
}
`);
    await write("src/index.ts", `import { createContainer } from "osnv/core/di";
import { AgentRegistry, AgentRuntime, AgentToolExecutor, describeTool, agentMessage, agentModelResponse, agentToolCall } from "osnv/core/agent";
import { modelValidatorAdapter } from "osnv/library/validation";
import { getGeneratedOpenApiSchemaName, getGeneratedOpenApiMetadata } from "osnv/core/http/OpenApi/generatedOpenApiRegistry";
import { SharedInput, SharedOutput, NestedInput, EmptyInput } from "./alpha/contracts";
import { unrelated } from "./beta/contracts";
import { IdentityAgent, IdentityTool } from "./agent";
import { AppModule } from "./app/modules/App.module";
import { registerOsnovaGeneratedRuntime } from "./generated/osnova/runtime";
await registerOsnovaGeneratedRuntime();
const names = [SharedInput, SharedOutput, NestedInput, EmptyInput].map(model => getGeneratedOpenApiSchemaName(model));
if (!unrelated || names.some(name => !name) || names.some(name => ["SharedInput", "SharedOutput", "NestedInput", "EmptyInput"].includes(name!))) throw new Error("Missing exact generated names");
const schemas = getGeneratedOpenApiMetadata().schemas;
if (!names.every(name => schemas[name!])) throw new Error("Agent schema removed by codegen filtering");
const modules = [{ imports: [AppModule], agents: [IdentityAgent], tools: [IdentityTool], exports: [] }];
const services = createContainer(modules[0]!);
try {
  const registry = AgentRegistry.fromModules(modules);
  const contract = describeTool(registry.getTool("identity.tool")!);
  if (contract.input?.kind !== "json-schema" || contract.input.name !== names[0] || contract.output?.name !== names[1]) throw new Error("Tool schema identity lost");
  const executor = new AgentToolExecutor(services, registry, { schemaValidator: modelValidatorAdapter });
  const input = { id: "alice", child: { label: "nested" } };
  const result = await executor.execute(agentToolCall({ id: "identity", name: "identity.tool", input }), { agentName: "identity.agent" });
  if (result.status !== "success" || JSON.stringify(result.output) !== '{"answer":"alice"}') throw new Error(JSON.stringify(result));
  const invalid = await executor.execute(agentToolCall({ id: "invalid", name: "identity.tool", input: { id: "alice", child: { count: 1 } } }), { agentName: "identity.agent" });
  if (invalid.status !== "error") throw new Error("Nested DTO accepted wrong schema");
  const runtime = new AgentRuntime(services, registry, {
    complete(request) {
      if (request.output?.schema?.kind !== "json-schema" || request.output.schema.name !== names[1]) throw new Error("Agent/Task output identity lost");
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"answer":"runtime-ok"}') });
    },
  });
  for (const result of [await runtime.invoke("identity.agent", { input }), await runtime.invokeTask("identity.agent", "run", input)]) {
    if (result.status !== "completed" || JSON.stringify(result.output) !== '{"answer":"runtime-ok"}') throw new Error(JSON.stringify(result));
  }
  console.log("AGENT_SCHEMA_IDENTITY_PASS");
} finally { await services.dispose(); }
`);
    const generator = path.join(project, "vendor/osnv/core/scripts/di-generate.ts");
    await run([process.execPath, "--no-env-file", generator]);
    await run([process.execPath, compiler, "--noEmit"]);
    expect(await run([process.execPath, "--no-env-file", "src/index.ts"])).toBe("AGENT_SCHEMA_IDENTITY_PASS");
    const schemaBinary = path.join(root, "schema-agent");
    await run([process.execPath, "build", "--compile", "src/index.ts", "--outfile", schemaBinary]);
    expect(await run([schemaBinary], root)).toBe("AGENT_SCHEMA_IDENTITY_PASS");
    const generatedBefore = await Bun.file(path.join(project, "src/generated/osnova/openapi.ts")).text();
    const contracts = await Bun.file(path.join(project, "src/alpha/contracts.ts")).text();
    await write("src/alpha/contracts.ts", contracts.replace("export class NestedInput", "class NestedInput"));
    const rejected = await execute([process.execPath, "--no-env-file", generator]);
    expect(rejected.exit).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain("OSNOVA_AGENT_SCHEMA_MODEL_UNIMPORTABLE");
    expect(await Bun.file(path.join(project, "src/generated/osnova/openapi.ts")).text()).toBe(generatedBefore);
    console.log("Agent standalone types/source/binary and nominal schema generation/types/source/binary: PASS");
  } finally {
    await clearBuildFlags(root);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
