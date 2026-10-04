import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const generator = path.resolve(import.meta.dir, "../../scripts/di-generate.ts");

async function generate(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "osnova-grpc-dto-codegen-"));
  try {
    const inputs = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src/**/*.ts"] }),
      "osnv.config.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/main.ts"] } } }),
      ...files,
    };
    for (const [file, contents] of Object.entries(inputs)) {
      const location = path.join(root, file);
      await mkdir(path.dirname(location), { recursive: true });
      await Bun.write(location, contents);
    }
    const child = Bun.spawn([process.execPath, "run", generator], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const bindings = Bun.file(path.join(root, "src/generated/osnv/bindings.ts"));
    return { code, output: stdout + stderr, bindings: await bindings.exists() ? await bindings.text() : undefined };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("gRPC codegen resolves type aliases, inherited methods and same-named DTOs by exact class", async () => {
  const result = await generate({
    "src/one.ts": "export class Request { value!: string; }",
    "src/two.ts": "export class Request { value!: number; }",
    "src/main.ts": `
import type { Request as First } from './one';
import type { Request as Second } from './two';
type Input = First;
type InputStream = AsyncIterable<Second>;
@GrpcController({})
export class Base {
  @GrpcMethod('Echo') get(input: Input) { return input; }
}
@GrpcController({})
export class Derived extends Base {
  @GrpcMethod('Collect') async create(input: InputStream) { for await (const item of input) {} }
}
`,
  });
  expect(result.code, result.output).toBe(0);
  expect(result.bindings).toContain('from "../../one"');
  expect(result.bindings).toContain('from "../../two"');
  expect(result.bindings?.match(/"get": \{ model:/g)).toHaveLength(2);
  expect(result.bindings).toContain('"create": { model:');
  expect(result.bindings).toContain("requestStream: true");
}, 30_000);

test("gRPC codegen rejects ambiguous DTO unions and non-exported inferred classes without writing output", async () => {
  for (const parameter of ["First | Second", "AsyncIterable<First | Second>", "Private"]) {
    const result = await generate({ "src/main.ts": `
export class First { value!: string; }
export class Second { value!: number; }
class Private { value!: string; }
@GrpcController({})
export class Controller { @GrpcMethod('Echo') get(input: ${parameter}) { return input; } }
` });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(parameter === "Private" ? "named project exports" : "one concrete DTO class");
    expect(result.bindings).toBeUndefined();
  }
}, 30_000);
