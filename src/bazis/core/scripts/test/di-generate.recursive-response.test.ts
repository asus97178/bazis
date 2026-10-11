import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const GENERATOR = path.resolve(import.meta.dir, "../di-generate.ts");

test("a response holding a recursive JSON type generates instead of overflowing the stack", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-codegen-recursive-"));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", lib: ["ESNext"], types: [], strict: true }, include: ["src/**/*.ts"] }),
    "bazis.config.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
    // The shape of JsonValue from bazis/core/agent: the loop closes through a readonly array.
    "src/json.ts": "export type Json = string | number | boolean | null | readonly Json[] | JsonObject;\nexport interface JsonObject { readonly [key: string]: Json; }\n",
    "src/index.ts": `import type { Json } from "./json";
declare function Ok<T>(body: T): T;
@Controller("json")
export class JsonController {
  @Get()
  get() {
    const value = undefined as unknown as Json;
    return Ok({ value, list: [value] });
  }
}
@Module({ controllers: [JsonController] })
export class AppModule {}
`,
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await Bun.write(path.join(root, file), content);
    }
    const child = Bun.spawn([process.execPath, "run", GENERATOR, "--target", "all"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout + stderr).not.toContain("Maximum call stack size exceeded");
    expect(exit, stdout + stderr).toBe(0);
    const openApi = await Bun.file(path.join(root, "src/generated/bazis/openapi.ts")).text();
    expect(openApi).toContain("JsonController");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
