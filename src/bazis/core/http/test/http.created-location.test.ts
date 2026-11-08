import { expect, test } from "bun:test";
import { Module } from "@/core/di";
import { Controller, Created, Get, HttpCode, Post, type HttpContext } from "@/core/http";
import { startTestApp } from "@/core/testing";
import { contextOnlyController } from "../Routing/contextOnlyControllers";

// A 201 whose body has `id` gets `Location: <request path>/<id>` when a GET
// route answers that address; an explicit Location always wins.

@Controller("users")
class UsersController {
  @Get(":id")
  get(ctx: HttpContext) {
    return { id: ctx.params.id };
  }

  @Post({ code: 201 })
  create(ctx: HttpContext) {
    const name = ctx.url.searchParams.get("id") ?? "1";
    return /^\d+$/u.test(name) ? { id: Number(name), name } : { id: name };
  }

  @Post("explicit")
  explicit(_ctx: HttpContext) {
    return Created({ id: 7 }, "/elsewhere/7");
  }

  @Post("no-id")
  @HttpCode(201)
  noId(_ctx: HttpContext) {
    return { name: "Anna" };
  }

  @Post("list")
  @HttpCode(201)
  list(_ctx: HttpContext) {
    return [{ id: 1 }];
  }

  @Post("text")
  text(_ctx: HttpContext) {
    return Created("created");
  }

  @Post("ok")
  ok(_ctx: HttpContext) {
    return { id: 5 };
  }
}
contextOnlyController(UsersController);

@Controller("tasks")
class TasksController {
  @Post(":id/complete", { code: 201 })
  complete(_ctx: HttpContext) {
    return { id: 9 };
  }
}
contextOnlyController(TasksController);

@Controller("items")
class ItemsController {
  @Get(":id")
  get(ctx: HttpContext) {
    return { id: ctx.params.id };
  }

  @Post()
  create(_ctx: HttpContext) {
    return Created({ id: 3, name: "Ann" });
  }
}
contextOnlyController(ItemsController);

@Module({ controllers: [UsersController, TasksController, ItemsController] })
class LocationApp {}

test("201 with id gets Location from the request path when a GET route answers it", async () => {
  const app = await startTestApp(LocationApp);
  try {
    const created = await app.fetch("/users", { method: "POST" });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/users/1");
    expect(await created.json()).toEqual({ id: 1, name: "1" });

    const trailing = await app.fetch("/users/", { method: "POST" });
    expect(trailing.headers.get("location")).toBe("/users/1");

    const cyrillic = await app.fetch(`/users?id=${encodeURIComponent("анна мария")}`, { method: "POST" });
    expect(cyrillic.headers.get("location")).toBe(`/users/${encodeURIComponent("анна мария")}`);

    expect((await app.fetch("/users/explicit", { method: "POST" })).headers.get("location")).toBe("/elsewhere/7");
    expect((await app.fetch("/users/no-id", { method: "POST" })).headers.get("location")).toBeNull();
    expect((await app.fetch("/users/list", { method: "POST" })).headers.get("location")).toBeNull();

    const helper = await app.fetch("/items", { method: "POST" });
    expect(helper.status).toBe(201);
    expect(helper.headers.get("location")).toBe("/items/3");
    expect(await helper.json()).toEqual({ id: 3, name: "Ann" });
    const text = await app.fetch("/users/text", { method: "POST" });
    expect(text.status).toBe(201);
    expect(text.headers.get("location")).toBeNull();
    expect(await text.text()).toBe("created");

    const ok = await app.fetch("/users/ok", { method: "POST" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("location")).toBeNull();

    // No GET /tasks/:id/complete/:id: no made-up address.
    const completed = await app.fetch("/tasks/5/complete", { method: "POST" });
    expect(completed.status).toBe(201);
    expect(completed.headers.get("location")).toBeNull();
  } finally {
    await app.stop();
  }
});

test("OpenAPI documents Location on a 201 that has a GET item route", async () => {
  const app = await startTestApp(LocationApp, { http: { docs: true } });
  try {
    const document = await (await app.fetch("/docs/openapi.json")).json() as {
      paths: Record<string, Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>>;
    };
    expect(document.paths["/users"]!.post!.responses["201"]!.headers?.Location).toBeDefined();
    expect(document.paths["/tasks/{id}/complete"]!.post!.responses["201"]!.headers).toBeUndefined();
  } finally {
    await app.stop();
  }
});
