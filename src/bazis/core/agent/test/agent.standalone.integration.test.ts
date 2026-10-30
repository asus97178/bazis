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

test("standalone AgentRuntime and exact generated Tool DTO schemas work in source and binaries outside checkout", async () => {
  const repository = path.resolve(import.meta.dir, "../../../../..");
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "bazis-agent-standalone-"));
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
    await generateProject({ name: "AgentSchemaFixture", outputPath: project, frameworkPath: path.join(repository, "src/bazis"), vendor: true });
    await mkdir(path.join(project, "node_modules"));
    await symlink("../vendor/bazis", path.join(project, "node_modules/bazis"), "dir");
    for (const name of ["@types", "typescript"]) await symlink(path.join(repository, "node_modules", name), path.join(project, "node_modules", name), "dir");
    const compilerOptions = { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true, types: ["bun"] };
    // No paths at all: neither runtime nor type-only framework imports can borrow workspace aliases.
    await write("tsconfig.json", JSON.stringify({ compilerOptions, include: ["standalone.ts"] }));
    await write("standalone.ts", `import { createContainer } from "bazis/core/di";
import { AgentRuntime, agentMessage, agentModelResponse } from "bazis/core/agent";
const services = createContainer({ exports: [] });
try {
  const runtime = new AgentRuntime(services, {
    complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "standalone-ok") }); },
  });
  const result = await runtime.run({ name: "standalone", instructions: "Answer." }, { input: "ping" });
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
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { ...compilerOptions, paths: { "bazis/*": ["./node_modules/bazis/*"] } }, include: ["src/**/*.ts"] }));
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
    await write("src/agent.ts", `import { Tool } from "bazis/core/agent";
import { SharedInput, SharedOutput } from "./alpha/contracts";
@Tool({ callers: ["agent"], name: "identity.tool", description: "Echo a declared field", input: SharedInput, output: SharedOutput })
export class IdentityTool { execute(input: SharedInput): SharedOutput { return { answer: input.id }; } }
`);
    await write("src/index.ts", `import { createContainer } from "bazis/core/di";
import { AgentRuntime, describeTool, agentClassSchema, agentMessage, agentModelResponse, agentOutputContract, agentToolCall } from "bazis/core/agent";
import { getGeneratedOpenApiSchemaName, getGeneratedOpenApiMetadata } from "bazis/core/http/OpenApi/generatedOpenApiRegistry";
import { SharedInput, SharedOutput, NestedInput, EmptyInput } from "./alpha/contracts";
import { unrelated } from "./beta/contracts";
import { IdentityTool } from "./agent";
import { AppModule } from "./app/modules/App.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const names = [SharedInput, SharedOutput, NestedInput, EmptyInput].map(model => getGeneratedOpenApiSchemaName(model));
if (!unrelated || names.some(name => !name) || names.some(name => ["SharedInput", "SharedOutput", "NestedInput", "EmptyInput"].includes(name!))) throw new Error("Missing exact generated names");
const schemas = getGeneratedOpenApiMetadata().schemas;
if (!names.every(name => schemas[name!])) throw new Error("Tool schema removed by codegen filtering");
const services = createContainer({ imports: [AppModule], tools: [IdentityTool], exports: [] });
try {
  const input = { id: "alice", child: { label: "nested" } };
  let step = 0;
  const runtime = new AgentRuntime(services, {
    complete(request) {
      step += 1;
      if (step === 1) return agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [
        agentToolCall({ id: "identity", name: "identity.tool", input }),
        agentToolCall({ id: "invalid", name: "identity.tool", input: { id: "alice", child: { count: 1 } } }),
      ] });
      if (request.output?.schema?.kind !== "json-schema" || request.output.schema.name !== names[1]) throw new Error("Output schema identity lost");
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"answer":"runtime-ok"}') });
    },
  });
  const contract = describeTool(runtime.listTools()[0]!);
  if (contract.input?.kind !== "json-schema" || contract.input.name !== names[0] || contract.output?.name !== names[1]) throw new Error("Tool schema identity lost");
  const result = await runtime.run({ name: "identity.agent", instructions: "", toolNames: ["identity.tool"] }, {
    input, output: agentOutputContract({ mode: "json", schema: agentClassSchema(names[1]!) }),
    toolExecution: { approvalPolicy: () => true },
  });
  if (result.status !== "completed" || JSON.stringify(result.output) !== '{"answer":"runtime-ok"}') throw new Error(JSON.stringify(result));
  if (result.toolResults[0]?.status !== "success" || JSON.stringify(result.toolResults[0].output) !== '{"answer":"alice"}') throw new Error(JSON.stringify(result.toolResults[0]));
  if (result.toolResults[1]?.status !== "error") throw new Error("Nested DTO accepted wrong schema");
  console.log("AGENT_SCHEMA_IDENTITY_PASS");
} finally { await services.dispose(); }
`);
    const generator = path.join(project, "vendor/bazis/core/scripts/di-generate.ts");
    await run([process.execPath, "--no-env-file", generator]);
    await run([process.execPath, compiler, "--noEmit"]);
    expect(await run([process.execPath, "--no-env-file", "src/index.ts"])).toBe("AGENT_SCHEMA_IDENTITY_PASS");
    const schemaBinary = path.join(root, "schema-agent");
    await run([process.execPath, "build", "--compile", "src/index.ts", "--outfile", schemaBinary]);
    expect(await run([schemaBinary], root)).toBe("AGENT_SCHEMA_IDENTITY_PASS");
    const generatedBefore = await Bun.file(path.join(project, "src/generated/bazis/openapi.ts")).text();
    const contracts = await Bun.file(path.join(project, "src/alpha/contracts.ts")).text();
    await write("src/alpha/contracts.ts", contracts.replace("export class NestedInput", "class NestedInput"));
    const rejected = await execute([process.execPath, "--no-env-file", generator]);
    expect(rejected.exit).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain("BAZIS_TOOL_SCHEMA_MODEL_UNIMPORTABLE");
    expect(await Bun.file(path.join(project, "src/generated/bazis/openapi.ts")).text()).toBe(generatedBefore);
    console.log("Agent standalone types/source/binary and nominal schema generation/types/source/binary: PASS");
  } finally {
    await clearBuildFlags(root);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
