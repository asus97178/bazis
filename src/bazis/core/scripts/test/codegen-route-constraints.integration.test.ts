import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 0.116.0: a route constraint converts the segment, so `@Get(":id(int)")`
// handed the number 7 to `id: string` and the TypeScript type lied. Codegen
// refuses a parameter type that does not match its constraint.
test("route constraints: the parameter type must match the constraint", async () => {
  const repository = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "bazis-route-constraints-"));
  const source = path.join(root, "src/index.ts");
  const valid = `import { Controller, Get, type FromRoute } from "bazis/core/http";
@Controller("items") export class ItemsController {
  @Get(":id(int)") byId(id: number) { return id; }
  @Get("price/:value(number)") price(value: number) { return value; }
  @Get("flag/:on(bool)") flag(on: boolean) { return on; }
  @Get("slug/:slug") slug(slug: string) { return slug; }
  @Get("uuid/:ref(uuid)") ref(ref: string) { return ref; }
  @Get("explicit/:key(int)") explicit(key: FromRoute<number>) { return key; }
}
`;
  const run = async () => {
    const child = Bun.spawn([process.execPath, path.join(repository, "src/bazis/core/scripts/di-generate.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, output: out + err };
  };
  try {
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
    await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
    await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src/**/*.ts"] }));
    await Bun.write(source, valid);
    const generated = await run();
    expect(generated.exit, generated.output).toBe(0);

    const rejected: readonly (readonly [string, string, string])[] = [
      ["byId(id: number)", "byId(id: string)", 'route parameter "id" is constrained to (int), so it arrives as a number; declare it as number'],
      ["flag(on: boolean)", "flag(on: string)", 'route parameter "on" is constrained to (bool), so it arrives as a boolean; declare it as boolean'],
      ["price(value: number)", "price(value: boolean)", 'route parameter "value" is constrained to (number), so it arrives as a number; declare it as number'],
      ["ref(ref: string)", "ref(ref: number)", 'route parameter "ref" is constrained to (uuid), so it arrives as a string; declare it as string'],
      ["explicit(key: FromRoute<number>)", "explicit(key: FromRoute<string>)", 'route parameter "key" is constrained to (int), so it arrives as a number; declare it as number'],
    ];
    for (const [from, to, reason] of rejected) {
      await Bun.write(source, valid.replace(from, to));
      const result = await run();
      expect(result.exit, to).not.toBe(0);
      const output = result.output.replace(/[│\n]/g, " ").replace(/\s+/g, " ");
      expect(output, to).toContain("BAZIS_HTTP_BINDING_UNRESOLVED");
      expect(output, to).toContain(reason);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
