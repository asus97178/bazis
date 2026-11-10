import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Codegen makes the keys of an application's permissions the type of can(...) and defineRoles(...).
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<{ root: string; exit: number; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-permissions-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await symlink(path.join(repository, "node_modules/typescript"), path.join(root, "node_modules/typescript"));
  await symlink(path.join(repository, "node_modules/@types"), path.join(root, "node_modules/@types"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"], skipLibCheck: true, noEmit: true,
  }, include: ["src/**/*.ts"] }));
  for (const [file, text] of Object.entries(files)) await Bun.write(path.join(root, file), text);
  const child = Bun.spawn([process.execPath, path.join(repository, "src/bazis/core/scripts/di-generate.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { root, exit, output: out + err };
}

async function typecheck(root: string): Promise<{ exit: number; output: string }> {
  const child = Bun.spawn([process.execPath, path.join(repository, "node_modules/typescript/bin/tsc"), "-p", root], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err };
}

const permissions = `import { definePermissions } from "bazis/core/access";
export const orderPermissions = definePermissions({
  "orders.create": { title: "Place orders" },
  "orders.read": { title: "See orders", owner: "customerId" },
});
`;

const app = (controller: string, roles: string) => `import { AccessModule, can, defineRoles } from "bazis/core/access";
import { Module } from "bazis/core/di";
import { Authorize, Controller, Get } from "bazis/core/http";
import { orderPermissions } from "./orders.permissions";

@Controller("orders")
export class OrdersController {
  @Get() @Authorize(can(${controller})) list() { return []; }
}

export const appRoles = defineRoles({ ${roles} });

@Module({ imports: [AccessModule], permissions: orderPermissions, roles: appRoles, controllers: [OrdersController], exports: [] })
export class AppModule {}
`;

test("the generated file names the permissions, and the application compiles against them", async () => {
  const { root, exit, output } = await project({
    "src/orders.permissions.ts": permissions,
    "src/index.ts": app('"orders.read"', 'admin: "all", customer: ["orders.create", "orders.read:own", "access.catalog.read"]'),
  });
  expect(exit, output).toBe(0);
  const generated = await Bun.file(path.join(root, "src/generated/bazis/permissions.ts")).text();
  expect(generated).toContain('import type { orderPermissions as Permissions_0 } from "../../orders.permissions";');
  expect(generated).toContain("interface BazisPermissions extends PermissionsOf<typeof Permissions_0> {}");
  const checked = await typecheck(root);
  expect(checked.exit, checked.output).toBe(0);
}, 120_000);

test("a typo in a permission and :own without an owner do not compile", async () => {
  const { root, exit, output } = await project({
    "src/orders.permissions.ts": permissions,
    "src/index.ts": app('"orders.raed"', 'customer: ["orders.create:own"]'),
  });
  expect(exit, output).toBe(0);
  const checked = await typecheck(root);
  expect(checked.exit).not.toBe(0);
  expect(checked.output).toContain('"orders.raed"');
  expect(checked.output).toContain('"orders.create:own"');
}, 120_000);

test("permissions written in the module itself stop codegen: there is nothing to take the type from", async () => {
  const { exit, output } = await project({
    "src/index.ts": `import { AccessModule, definePermissions } from "bazis/core/access";
import { Module } from "bazis/core/di";
@Module({ imports: [AccessModule], permissions: definePermissions({ "a.read": { title: "x" } }), exports: [] })
export class AppModule {}
`,
  });
  expect(exit).not.toBe(0);
  expect(output).toContain("BAZIS_ACCESS_PERMISSIONS_FORM");
  expect(output).toContain("export the result of definePermissions(...) as a constant");
}, 60_000);

test("an application without permissions gets no file", async () => {
  const { root, exit, output } = await project({
    "src/index.ts": `import { Module } from "bazis/core/di";
@Module({ exports: [] })
export class AppModule {}
`,
  });
  expect(exit, output).toBe(0);
  expect(await Bun.file(path.join(root, "src/generated/bazis/permissions.ts")).exists()).toBe(false);
}, 60_000);
