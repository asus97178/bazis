import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// createTestContainer and startTestApp in a real project: codegen, then the
// project's own bun test. The fake replaces a store the module itself uses.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

const files: Record<string, string> = {
  "src/app/Task.ts": `import { Controller, Get, NotFoundError } from "bazis/core/http";
export abstract class ITaskStore { abstract find(id: string): Promise<{ id: string; title: string } | undefined>; }
export class PgTaskStore implements ITaskStore { async find(): Promise<undefined> { throw new Error("no database here"); } }
export class TaskService {
  constructor(private readonly store: ITaskStore) {}
  async title(id: string) {
    const task = await this.store.find(id);
    if (!task) throw new NotFoundError("task " + id + " not found");
    return task.title.toUpperCase();
  }
}
@Controller("tasks") export class TaskController {
  constructor(private readonly tasks: TaskService) {}
  @Get(":id") async get(id: string) { return { title: await this.tasks.title(id) }; }
}
`,
  "src/app/App.module.ts": `import { Module, scoped } from "bazis/core/di";
import { ITaskStore, PgTaskStore, TaskController, TaskService } from "./Task";
@Module({ providers: [scoped(ITaskStore, PgTaskStore), scoped(TaskService)], controllers: [TaskController], exports: [TaskService] })
export class AppModule {}
`,
  "src/index.ts": `import { runApp } from "bazis/core/app";
import { AppModule } from "./app/App.module";
await runApp(AppModule, { http: { port: 3000 } });
`,
  "test/task.test.ts": `import { expect, test } from "bun:test";
import { singleton } from "bazis/core/di";
import { createTestContainer, startTestApp } from "bazis/core/testing";
import { AppModule } from "../src/app/App.module";
import { ITaskStore, TaskService } from "../src/app/Task";

class FakeStore implements ITaskStore {
  async find(id: string) { return id === "1" ? { id, title: "write docs" } : undefined; }
}

test("module test with an override", async () => {
  const container = await createTestContainer(AppModule, { overrides: [singleton(ITaskStore, FakeStore)] });
  expect(await container.createScope().resolve(TaskService).title("1")).toBe("WRITE DOCS");
});

test("HTTP test in process", async () => {
  const app = await startTestApp(AppModule, { overrides: [singleton(ITaskStore, FakeStore)] });
  try {
    expect(app.url).toMatch(/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/);
    const ok = await app.fetch("/tasks/1");
    expect([ok.status, await ok.json()]).toEqual([200, { title: "WRITE DOCS" }]);
    expect((await app.fetch("/tasks/2")).status).toBe(404);
  } finally {
    await app.stop();
  }
});

test("without overrides the real store is used", async () => {
  const app = await startTestApp(AppModule);
  try {
    expect((await app.fetch("/tasks/1")).status).toBe(500);
  } finally {
    await app.stop();
  }
});
`,
};

test("createTestContainer and startTestApp work in a project test suite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-testing-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts", "test/**/*.ts"] }));
  for (const [name, content] of Object.entries(files)) await Bun.write(path.join(root, name), content);

  const codegen = Bun.spawn([process.execPath, path.join(repository, "src/bazis/core/scripts/di-generate.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(await codegen.exited, await new Response(codegen.stderr).text()).toBe(0);

  const run = Bun.spawn([process.execPath, "test", "test/task.test.ts"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, BAZIS_ENV: "" } });
  const [exit, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  expect(exit, out + err).toBe(0);
  expect(out + err).toContain("3 pass");
}, 60_000);
