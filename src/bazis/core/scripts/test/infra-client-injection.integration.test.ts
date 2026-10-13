import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Infra clients are injected by type, like the rest of the application:
// constructor(sql: IPostgres, redis: IRedis, search: IOpenSearch).
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test("IPostgres, IRedis and IOpenSearch bind by type without an explicit deps list", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-infra-clients-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), `import { Module, scoped } from "bazis/core/di";
import type { IOpenSearch, IPostgres, IRedis } from "bazis/core/infra";
export class ReportsService {
  constructor(private readonly sql: IPostgres, private readonly redis: IRedis, private readonly search: IOpenSearch) {}
}
@Module({ providers: [scoped(ReportsService)], exports: [] })
export class AppModule {}
`);
  const child = Bun.spawn([process.execPath, path.join(repository, "src/bazis/core/scripts/di-generate.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, out + err).toBe(0);
  const deps = await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text();
  for (const token of ["IPostgres", "IRedis", "IOpenSearch"]) expect(deps).toContain(token);
}, 60_000);
