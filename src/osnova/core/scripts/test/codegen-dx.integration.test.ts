import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("invalid HTTP bindings and ORM logic stop real codegen before replacing output", async () => {
  const repository = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "osnova-dx-codegen-"));
  const source = path.join(root, "src/index.ts");
  const valid = `import { Validator } from "osnv/library/validation";
import { Controller, Get, HttpContext, Post } from "osnv/core/http";
@Controller("probe") export class ProbeController {
  @Get() getAll(state: string) { return state; }
  @Get("context") context(ctx: HttpContext) { return ctx.path; }
  @Post(":id") update(id: number, input: ProbeInput, ctx: HttpContext) { return input; }
}
export class ProbeInput { @Validator({ required: true, minLength: 3 }) name = "";
}
`;
  const run = async () => {
    const child = Bun.spawn([process.execPath, path.join(repository, "src/osnova/core/scripts/di-generate.ts")],
      { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, output: out + err };
  };
  try {
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.join(repository, "src/osnova"), path.join(root, "node_modules/osnv"));
    await Bun.write(path.join(root, "osnova.codegen.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
    await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true,
    }, include: ["src/**/*.ts"] }));
    await Bun.write(source, valid);
    const generated = await run();
    expect(generated.exit, generated.output).toBe(0);
    const output = path.join(root, "src/generated/osnova/bindings.ts");
    const before = await Bun.file(output).text();
    expect(before).toContain('"source":"route","name":"id"');
    expect(before).toContain('"source":"body","model":"ProbeInput"');
    expect(before).toContain('"source":"context"');
    // Exercise the actual generated descriptors in a fresh process: the DTO
    // has no registration decorator, and no controller owns manual bindings.
    await Bun.write(path.join(root, "runtime-probe.ts"), `
import { ProbeController, ProbeInput } from "./src/index";
import { registerOsnovaGeneratedRuntime } from "./src/generated/osnova/runtime";
import { resolveGeneratedBindings } from "./node_modules/osnv/core/http/Binding/autoBindings";
import { bindArguments } from "./node_modules/osnv/core/http/Binding/ParameterBinder";
import { HttpContext } from "./node_modules/osnv/core/http/HttpContext/HttpContext";
import { modelValidatorAdapter } from "osnv/library/validation";
await registerOsnovaGeneratedRuntime();
const bindings = resolveGeneratedBindings(ProbeController, "update");
for (const [name, expectedStatus] of [["Alice", 200], ["x", 400]]) {
  const request = new Request("http://localhost/probe/42", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, extra: "strip" }) });
  const ctx = new HttpContext(request, new URL(request.url), { id: "42" }, {}, undefined, undefined, "127.0.0.1", modelValidatorAdapter);
  let status = 200;
  try {
    const [id, input, context] = await bindArguments(bindings, ctx, {});
    if (id !== 42 || !(input instanceof ProbeInput) || input.name !== name || "extra" in input || context !== ctx) throw new Error("Generated binding contract changed");
  } catch (error) { status = error.status; }
  if (status !== expectedStatus) throw new Error("Generated validation contract changed");
}
console.log("automatic route/body/context/validation: PASS");
`);
    const runtime = Bun.spawn([process.execPath, path.join(root, "runtime-probe.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [runtimeExit, runtimeOut, runtimeErr] = await Promise.all([runtime.exited, new Response(runtime.stdout).text(), new Response(runtime.stderr).text()]);
    expect(runtimeExit, runtimeOut + runtimeErr).toBe(0);
    expect(runtimeOut).toContain("automatic route/body/context/validation: PASS");
    for (const [code, diagnostic] of [
      [valid.replace("state: string", 'state: "active" | "inactive"'), "OSNOVA_HTTP_BINDING_UNRESOLVED"],
      [valid + `import type { FieldSelector } from "osnv/library/orm";
interface User { tenantId: string; age: number; }
export function filter(u: FieldSelector<User>) { return u.tenantId.eq("a") && u.age.gte(18); }`, "OSNOVA_ORM_PREDICATE_LOGIC"],
      [valid + `import type { FieldSelector } from "osnv/library/orm";
interface User { age: number; }
export function filter(u: FieldSelector<User>) { return u.age.lt(18) || u.age.gt(65); }`, "OSNOVA_ORM_PREDICATE_LOGIC"],
    ] as const) {
      await Bun.write(source, code);
      const rejected = await run();
      expect(rejected.exit).not.toBe(0);
      expect(rejected.output).toContain(diagnostic);
      expect(await Bun.file(output).text()).toBe(before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
