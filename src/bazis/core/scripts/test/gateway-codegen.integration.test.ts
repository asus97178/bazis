import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A gateway declared by `gateways` of its module gets its constructor wired by
// codegen like a controller, in a file that has no controller of its own.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-gateway-codegen-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"],
  }, include: ["src/**/*.ts"] }));
  for (const [name, content] of Object.entries(files)) await Bun.write(path.join(root, name), content);
  return root;
}

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, env: { ...process.env, BAZIS_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err };
}

const server = `import { startTestApp } from "bazis/core/testing";
import { AppModule } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const app = await startTestApp(AppModule, { http: {} });
const ws = new WebSocket(app.url.replace("http", "ws") + "/ws/chat");
ws.onmessage = (event) => {
  const packet = JSON.parse(String(event.data));
  if (packet.type === "connected") ws.send(JSON.stringify({ v: 1, type: "event", event: "hi", id: "1" }));
  else { console.log("answer=" + JSON.stringify(packet.data)); ws.close(); }
};
ws.onclose = async () => { await app.stop(); process.exit(0); };
`;

test("codegen wires the constructor of a gateway declared by gateways", async () => {
  const root = await project({
    "src/chat.gateway.ts": `import { SubscribeMessage, WebSocketGateway, type BazisSocket } from "bazis/core/websocket";
export class Greeting { text = "hello from the module"; }
@WebSocketGateway({ namespace: "chat" })
export class ChatGateway {
  constructor(private readonly greeting: Greeting) {}
  @SubscribeMessage("hi") hi(_socket: BazisSocket) { return this.greeting.text; }
}
`,
    "src/index.ts": `import { Module, singleton } from "bazis/core/di";
import { ChatGateway, Greeting } from "./chat.gateway";
@Module({ gateways: [ChatGateway], providers: [singleton(Greeting)], exports: [] })
export class AppModule {}
`,
    "server.ts": server,
  });
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);
  const served = await run(root, ["server.ts"]);
  expect(served.output).toContain('answer="hello from the module"');
}, 60_000);
