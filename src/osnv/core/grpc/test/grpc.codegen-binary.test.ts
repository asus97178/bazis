import { expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = path.resolve(import.meta.dir, "../../../../..");

async function run(cmd: string[], cwd: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (code !== 0) console.error(stdout + stderr);
  return { code, output: stdout + stderr };
}

async function removeTemporaryProject(root: string): Promise<void> {
  // The qualified launcher seals its runtime. On macOS bun --compile leaves
  // an immutable private staging copy; unseal only this test's unlinked copy,
  // never process.execPath, the launcher, or a shared/pinned runtime.
  if (process.platform === "darwin") {
    for (const entry of await readdir(root).catch(() => [] as string[])) {
      if (!/^\.[a-f0-9]+-[a-f0-9]+\.bun-build$/.test(entry)) continue;
      const file = path.join(root, entry);
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1) throw new Error("Unexpected shared build staging file: " + file);
      const result = await run(["/usr/bin/chflags", "nouchg", file], root);
      if (result.code !== 0) throw new Error(result.output);
    }
  }
  await rm(root, { recursive: true, force: true });
}

test("codegen wires gRPC DI and DTO validation; runApp serves HTTP + gRPC from source and standalone binary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "osnv-grpc-qualification-"));
  try {
    await cp(path.join(workspace, "src/osnv"), path.join(root, "src/osnv"), {
      recursive: true,
      filter: (file) => !["node_modules", "test"].includes(path.basename(file)) && !file.endsWith(".test.ts"),
    });
    await mkdir(path.join(root, "node_modules"));
    for (const name of ["typescript", "@types"]) {
      await symlink(path.join(workspace, "node_modules", name), path.join(root, "node_modules", name));
    }
    const peer = await Bun.file(path.join(import.meta.dir, "fixtures/nativeClient.ts")).text();
    await Bun.write(path.join(root, "src/nativeClient.ts"), peer.replace('"../../Metadata"', '"osnv/core/grpc"'));
    const config = await Bun.file(path.join(workspace, "tsconfig.json")).json();
    await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify(config));
    await Bun.write(path.join(root, "osnv.config.json"), JSON.stringify({
      version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/main.ts"] } },
    }));
    const proto = await Bun.file(path.join(import.meta.dir, "fixtures/echo.proto")).text();
    await Bun.write(path.join(root, "src/echo.proto"), proto.replace(/(rpc \w+ \()(stream )?Message(\))/g, "$1$2Request$3") + `
message Contact { string email = 1; }
message Request { string text = 1; int32 count = 2; Contact contact = 3; repeated Contact contacts = 4; bytes data = 5; int64 id = 6; }
`);
    await Bun.write(path.join(root, "src/requests.ts"), `
import { Validator } from "osnv/library/validation";
export class ContactModel { @Validator({ required: true, email: true }) email!: string; }
export class MessageModel {
  @Validator({ required: true, minLength: 2 }) text!: string;
  @Validator({ min: 0 }) count!: number;
  @Validator({ nested: true }) contact?: ContactModel | null;
  @Validator({ nested: true }) contacts?: ContactModel[];
  data?: Buffer;
  id?: bigint;
}
`);
    await Bun.write(path.join(root, "src/proto.d.ts"), 'declare module "*.proto" { const filename: string; export default filename; }');
    await Bun.write(path.join(root, "src/feature.ts"), `
import { Module, scoped, singleton, Controller, Get, GrpcController, GrpcMethod, GrpcError, GrpcStatus, grpcService, loadGrpcPackage, GrpcClient, grpcClientProvider } from "osnv";
import protoPath from "./echo.proto" with { type: "file" };
import type { MessageModel as Request } from "./requests";
import { MessageModel, ContactModel } from "./requests";
export const service = grpcService(loadGrpcPackage(protoPath, { defaults: true }), "osnv.test.Echo");
export interface Message { text: string; count: number }
export let handlerCalls = 0;
export const clientOptions = { address: "127.0.0.1:1", timeoutMs: 2000 };
export class ClientProbe {
  constructor(readonly client: GrpcClient) {}
  unary() { return this.client.unary<Message, Message>("Echo", { text: "own-client", count: 4 }); }
}
export class PrivateGreeter {
  greet(text: string) { return "hello " + text; }
}
@GrpcController(service)
export class GeneratedGrpcController {
  constructor(private readonly greeter: PrivateGreeter) {}
  @GrpcMethod("Echo")
  echo(input: Request): Message {
    handlerCalls++;
    if (!(input instanceof MessageModel)) throw new Error("Missing DTO hydration");
    if (input.contact && !(input.contact instanceof ContactModel)) throw new Error("Missing nested hydration");
    if (input.contacts?.some(item => !(item instanceof ContactModel))) throw new Error("Missing array hydration");
    if (input.data && !Buffer.isBuffer(input.data)) throw new Error("Missing protobuf bytes");
    if (input.id !== undefined && typeof input.id !== "bigint") throw new Error("Missing protobuf bigint");
    if (input.text === "missing") throw new GrpcError(GrpcStatus.NOT_FOUND, "Missing message.");
    return { text: this.greeter.greet(input.text), count: input.count };
  }
  @GrpcMethod("Expand")
  async *expand(input: Request) { yield this.echo(input); }
  @GrpcMethod("Collect")
  async collect(input: AsyncIterable<Request>) {
    let count = 0; for await (const message of input) { if (!(message instanceof MessageModel)) throw new Error("Missing stream hydration"); count += message.count; }
    return { text: "sum", count };
  }
  @GrpcMethod("Chat")
  async *chat(input: AsyncIterable<Request>) { for await (const message of input) yield this.echo(message); }
}
@Controller("probe")
export class GeneratedHttpController {
  constructor(private readonly greeter: PrivateGreeter) {}
  @Get() get() { return { text: this.greeter.greet("http") }; }
}
@Module({ providers: [scoped(PrivateGreeter), grpcClientProvider(service, clientOptions), singleton(ClientProbe)], controllers: [GeneratedHttpController], grpcControllers: [GeneratedGrpcController], exports: [ClientProbe] })
export class FeatureModule {}
`);
    await Bun.write(path.join(root, "src/main.ts"), `
import { strict as assert } from "node:assert";
import { echoClient } from "./nativeClient";
import { runApp } from "osnv/core/app";
import { DI, Module, HOSTED_SERVICE, SERVICE_PROVIDER } from "osnv/core/di";
import { GrpcServer } from "osnv/core/grpc";
import { HttpServer } from "osnv/core/http";
import { ApplicationLifetime } from "osnv/core/kernel";
import { modelValidatorAdapter } from "osnv/library/validation";
import { registerOsnvGeneratedRuntime } from "./generated/osnv/runtime";
import { FeatureModule, ClientProbe, clientOptions, handlerCalls } from "./feature";
let ownClient: import("osnv/core/grpc").GrpcClient | undefined;
const grpcOnly = process.argv.includes("--grpc-only");
const custom = process.argv.includes("--custom-validator");
const override = process.argv.includes("--grpc-override");
const customValidator = { validate(instance: object) {
  return (instance as {text?:string}).text === "custom-reject"
    ? {isValid:false,errors:[{property:"text",message:"Custom validator",code:"custom-limit"}]}
    : modelValidatorAdapter.validate(instance);
} };
await registerOsnvGeneratedRuntime();
@Module({
  imports: [FeatureModule], exports: [],
  providers: [DI.singleton(DI.factoryProviderWithResolver(HOSTED_SERVICE, [], resolver => ({
    phase: 20,
    async start() {
      const provider = resolver.resolve(SERVICE_PROVIDER);
      const hosted = provider.resolveAll(HOSTED_SERVICE);
      const grpc = hosted.find(s => s instanceof GrpcServer) as GrpcServer;
      const http = hosted.find(s => s instanceof HttpServer) as HttpServer;
      const client = echoClient(grpc.port!);
      try {
        clientOptions.address = "127.0.0.1:" + grpc.port;
        const probe = resolver.resolve(ClientProbe);
        ownClient = probe.client;
        if (custom) {
          const result = await ownClient.unary("Echo", {text:"custom-reject",count:1}).catch(error => error);
          if (override) assert.equal(result.data.text, "hello custom-reject");
          else {
            assert.equal(result.code, 3);
            assert.equal(JSON.parse(result.metadata.get("osnv-validation-errors-bin")[0].toString()).errors[0].code, "custom-limit");
          }
        }
        assert.deepEqual((await probe.unary()).data, {text:"hello own-client",count:4});
        const expanded = []; for await (const item of ownClient.serverStream("Expand", {text:"own-stream",count:2})) expanded.push(item);
        assert.deepEqual(expanded, [{text:"hello own-stream",count:2}]);
        assert.deepEqual((await ownClient.clientStream("Collect", [{text:"two",count:2},{text:"three",count:3}])).data, {text:"sum",count:5});
        const ownDuplex = []; for await (const item of ownClient.bidi("Chat", [{text:"own-bidi",count:1}])) ownDuplex.push(item);
        assert.deepEqual(ownDuplex, [{text:"hello own-bidi",count:1}]);
        console.log("GRPC_CLIENT_CODEGEN_BINARY_PASS");
        const invalid = {text:"x",count:-1};
        const beforeInvalid = handlerCalls;
        const failures = [
          await ownClient.unary("Echo", invalid).catch(error => error),
          await (async () => { for await (const item of ownClient!.serverStream("Expand", invalid)) {} })().catch(error => error),
          await ownClient.clientStream("Collect", [invalid]).catch(error => error),
          await (async () => { for await (const item of ownClient!.bidi("Chat", [invalid])) {} })().catch(error => error),
          await ownClient.unary("Echo", {text:"nested",contact:{email:"bad"}}).catch(error => error),
          await ownClient.unary("Echo", {text:"array",contacts:[{email:"bad"}]}).catch(error => error),
        ];
        for (const failure of failures) {
          assert.equal(failure?.code, 3);
          assert.ok(JSON.parse(failure.metadata.get("osnv-validation-errors-bin")[0].toString()).errors.length);
        }
        assert.equal(handlerCalls, beforeInvalid);
        assert.deepEqual((await ownClient.unary("Echo", {text:"nested",count:1,contact:{email:"user@example.test"},contacts:[{email:"user@example.test"}],data:Buffer.from([0,255]),id:9007199254740993n})).data, {text:"hello nested",count:1});
        console.log("GRPC_VALIDATION_CODEGEN_BINARY_PASS");
        for (let i = 0; i < 12; i++) {
          const result = await new Promise((resolve, reject) => client.Echo!({ text: "grpc", count: i }, { deadline: Date.now() + 2000 }, (error, response) => error ? reject(error) : resolve(response)));
          assert.deepEqual(result, { text: "hello grpc", count: i });
        }
        const failure = await new Promise(resolve => client.Echo!({text:"missing"},{deadline: Date.now()+2000}, error => resolve(error)));
        assert.equal((failure as {code:number}).code, 5);
        const duplex = client.Chat!({deadline: Date.now()+2000});
        duplex.write({text:"stream",count:1}); duplex.end();
        const replies = []; for await(const response of duplex) replies.push(response);
        assert.deepEqual(replies,[{text:"hello stream",count:1}]);
        if (!grpcOnly) {
          const response = await fetch("http://127.0.0.1:" + http.port + "/probe");
          assert.equal(response.status, 200); assert.deepEqual(await response.json(), {text:"hello http"});
        }
        console.log("GRPC_HTTP_CODEGEN_BINARY_PASS");
      } finally { client.close(); }
      resolver.resolve(ApplicationLifetime).stop();
    }, stop() {},
  })))],
})
class AppModule {}
const code = await runApp(AppModule, { validator: custom ? customValidator : undefined, http: grpcOnly ? undefined : {port: 0, hostname: "127.0.0.1"}, grpc: {address: "127.0.0.1:0", validator: override ? modelValidatorAdapter : undefined}, kernel: {signals: [], startupReport: false} });
if (code !== 0) throw new Error("runApp failed: " + code);
assert.ok(ownClient);
await assert.rejects(ownClient.unary("Echo", {}), {code:1});
`);
    const generated = await run([process.execPath, "run", "src/osnv/core/scripts/di-generate.ts"], root);
    expect(generated.code, generated.output).toBe(0);
    const deps = await Bun.file(path.join(root, "src/generated/osnv/deps.ts")).text();
    expect(deps).toContain("GeneratedGrpcController");
    expect(deps).toContain("PrivateGreeter");
    expect(deps).toContain("ClientProbe");
    expect(deps).toContain("GrpcClient");
    const bindings = await Bun.file(path.join(root, "src/generated/osnv/bindings.ts")).text();
    expect(bindings).toContain("GRPC_REQUEST_BINDINGS");
    expect(bindings).toContain('"collect": { model:');
    expect(bindings).toContain("requestStream: true");
    const shapes = await Bun.file(path.join(root, "src/generated/osnv/httpRequestModels.ts")).text();
    expect(shapes).toContain('"contacts": { model:');
    const source = await run([process.execPath, "run", "src/main.ts"], root);
    expect(source.code, source.output).toBe(0);
    expect(source.output).toContain("GRPC_HTTP_CODEGEN_BINARY_PASS");
    expect(source.output).toContain("GRPC_CLIENT_CODEGEN_BINARY_PASS");
    expect(source.output).toContain("GRPC_VALIDATION_CODEGEN_BINARY_PASS");
    const binary = path.join(root, "grpc-host");
    const built = await run([process.execPath, "build", "--compile", "src/main.ts", "--outfile", binary], root);
    expect(built.code, built.output).toBe(0);
    // Move the binary out of its project and remove every source/dependency:
    // success must not depend on a development checkout or external .proto.
    const standalone = await mkdtemp(path.join(tmpdir(), "osnv-grpc-binary-"));
    try {
      const executable = path.join(standalone, "grpc-host");
      await cp(binary, executable);
      await removeTemporaryProject(root);
      const compiled = await run([executable], standalone);
      expect(compiled.code, compiled.output).toBe(0);
      expect(compiled.output).toContain("GRPC_HTTP_CODEGEN_BINARY_PASS");
      expect(compiled.output).toContain("GRPC_CLIENT_CODEGEN_BINARY_PASS");
      expect(compiled.output).toContain("GRPC_VALIDATION_CODEGEN_BINARY_PASS");
      const grpcOnly = await run([executable, "--grpc-only"], standalone);
      expect(grpcOnly.code, grpcOnly.output).toBe(0);
      expect(grpcOnly.output).toContain("GRPC_HTTP_CODEGEN_BINARY_PASS");
      expect(grpcOnly.output).toContain("GRPC_CLIENT_CODEGEN_BINARY_PASS");
      expect(grpcOnly.output).toContain("GRPC_VALIDATION_CODEGEN_BINARY_PASS");
      for (const args of [["--custom-validator"], ["--custom-validator", "--grpc-only"], ["--custom-validator", "--grpc-override"]]) {
        const configured = await run([executable, ...args], standalone);
        expect(configured.code, configured.output).toBe(0);
        expect(configured.output).toContain("GRPC_VALIDATION_CODEGEN_BINARY_PASS");
      }
    } finally { await removeTemporaryProject(standalone); }
  } finally { await removeTemporaryProject(root); }
}, 60_000);
