import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The generated OpenAPI document describes what the server answers: the
// status of result helpers, error responses and JSDoc. Before, `Created(...)`
// was documented as 200, no error was documented and JSDoc was dropped.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

test("statuses, error responses and JSDoc reach the OpenAPI document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-openapi-accuracy-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), `import { Module } from "bazis/core/di";
import { Authorize, Controller, Created, Delete, Get, HttpContext, NotFound, NotFoundError, Ok, Post, Put, RequestModel, StatusCode } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

/** A task as the API returns it. */
export interface TaskResponse {
  id: string;
  /** Short title shown in lists. */
  title: string;
}

@RequestModel()
export class CreateTaskRequest {
  /** What has to be done. */
  @Validator({ required: true, minLength: 1 })
  title!: string;
}

class TaskNotFoundError extends NotFoundError {}

@Controller("tasks")
export class TasksController {
  @Get() getAll(): TaskResponse[] { return []; }

  /**
   * Returns one task.
   * Answers 404 when there is no such task.
   */
  @Get(":id") getById(id: string): TaskResponse {
    if (id === "0") throw new TaskNotFoundError("no task");
    return { id, title: "Buy milk" };
  }

  @Post() create(body: CreateTaskRequest, ctx: HttpContext) {
    return Created(ctx.path + "/1", { id: "1", title: body.title });
  }

  @Put(":id") @Authorize(() => true)
  update(id: string, body: CreateTaskRequest) {
    if (id === "0") return NotFound({ error: "no task" });
    if (id === "1") return StatusCode(409, { error: "busy" });
    return { id, title: body.title };
  }

  @Post("mixed") mixed(flag = false) { return flag ? Ok({ a: 1 }) : Created("/x", { a: 1 }); }

  @Delete(":id") delete(id: string) {}
}
@Module({ controllers: [TasksController], exports: [] }) export class AppModule {}
`);
  await Bun.write(path.join(root, "probe.ts"), `import { startTestApp } from "bazis/core/testing";
import { AppModule } from "./src/index";
const app = await startTestApp(AppModule, { http: { docs: true } });
const spec = await (await app.fetch("/docs/openapi.json")).json();
const statuses = (p: string, m: string) => Object.keys(spec.paths[p][m].responses);
console.log(JSON.stringify({
  getAll: statuses("/tasks", "get"),
  create: statuses("/tasks", "post"),
  createSchema: spec.paths["/tasks"].post.responses["201"].content["application/json"].schema,
  getById: statuses("/tasks/{id}", "get"),
  summary: spec.paths["/tasks/{id}"].get.summary,
  description: spec.paths["/tasks/{id}"].get.description,
  defaultSummary: spec.paths["/tasks"].get.summary,
  update: statuses("/tasks/{id}", "put"),
  notFound: spec.paths["/tasks/{id}"].put.responses["404"],
  mixed: statuses("/tasks/mixed", "post"),
  delete: statuses("/tasks/{id}", "delete"),
  error: spec.components.schemas.HttpErrorResponse.required,
  task: spec.components.schemas.TaskResponse,
  request: spec.components.schemas.CreateTaskRequest.properties.title,
}));
await app.stop();
`);
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);
  const probe = await run(root, ["probe.ts"]);
  expect(probe.exit, probe.output).toBe(0);
  const result = JSON.parse(probe.last);
  expect(result.getAll).toEqual(["200"]);
  expect(result.create).toEqual(["201", "400"]);
  expect(result.createSchema).toEqual({ type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] });
  expect(result.getById).toEqual(["200", "404"]);
  expect(result.summary).toBe("Returns one task.");
  expect(result.description).toBe("Answers 404 when there is no such task.");
  expect(result.defaultSummary).toBe("GET /tasks");
  expect(result.update).toEqual(["200", "400", "401", "403", "404", "409"]);
  expect(result.notFound).toEqual({ description: "Not Found", content: { "application/json": { schema: { $ref: "#/components/schemas/HttpErrorResponse" } } } });
  expect(result.mixed).toEqual(["200", "400"]);
  expect(result.delete).toEqual(["204"]);
  expect(result.error).toEqual(["error"]);
  expect(result.task).toEqual({
    description: "A task as the API returns it.",
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string", description: "Short title shown in lists." } },
    required: ["id", "title"],
  });
  expect(result.request).toEqual({ type: "string", minLength: 1, description: "What has to be done." });
}, 60_000);
