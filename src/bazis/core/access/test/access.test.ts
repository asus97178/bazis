import { expect, test } from "bun:test";
import {
  IAccess,
  AccessFilterTooLargeError,
  AccessModule,
  AccessPolicy,
  AccessSetupError,
  AttributeLookup,
  References,
  can,
  definePermissions,
  defineRoles,
  grantsToWhere,
  maskFields,
  type AccessValue,
  type ReferenceItem,
} from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { Module, singleton, singletonValue } from "@/core/di";
import { Authorize, Controller, Get, NotFoundError, PRINCIPAL_STATE_KEY, UnauthorizedError, type AuthorizeCheck, type HttpContext } from "@/core/http";
import { memorySource } from "@/core/kernel";
import { createTestContainer, startTestApp } from "@/core/testing";

class FolderLookup extends AttributeLookup {
  static values = 3;
  toColumn(values: readonly AccessValue[]) {
    const keys = values.includes("sales") ? Array.from({ length: FolderLookup.values }, (_, i) => `invoice-${i}`) : [];
    return { column: "processKey", in: keys };
  }
}

class ProcessReferences extends References {
  private readonly items: ReferenceItem[] = [{ id: "invoice", title: { en: "Invoice", ru: "Счёт" } }, { id: "act", title: "Act" }];
  async exists(ids: readonly string[]) { return new Set(ids.filter((id) => this.items.some((item) => item.id === id))); }
  async describe(ids: readonly string[]) { return this.items.filter((item) => ids.includes(item.id)); }
  async search(text: string) { return this.items.filter((item) => item.id.includes(text)); }
}

const orderPermissions = definePermissions({
  "orders.read": {
    title: { en: "See orders", ru: "Видеть заказы" },
    scope: { column: "shopId" },
    on: { status: { type: "string" }, process: { ref: "orders.process", column: "processKey" }, folder: { type: "string", lookup: FolderLookup } },
    owner: "customerId",
    fields: true,
  },
  "orders.create": { title: "Create orders", scope: "request", on: { process: { ref: "orders.process" } } },
  "orders.export": { title: "Export orders" },
});

@Module({
  imports: [AccessModule],
  permissions: orderPermissions,
  references: { "orders.process": ProcessReferences },
  providers: [singleton(FolderLookup), singleton(ProcessReferences)],
})
class OrdersModule {}

async function buildError(root: Parameters<typeof createTestContainer>[0]): Promise<Error> {
  try {
    await createTestContainer(root);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the container was built");
}

async function accessWith(policy: AccessPolicy) {
  @Module({ imports: [OrdersModule], providers: [singletonValue(AccessPolicy, policy)] })
  class AppModule {}
  const scope = (await createTestContainer(AppModule)).createScope();
  return { as: (subject: { sub: string }) => scope.resolve(IAccess).as(subject, scope) };
}

test("declarations are checked when the application is built", async () => {
  const bad = definePermissions({
    Orders: { title: "" },
    "orders.read": { title: "x", on: { own: { type: "string" }, both: { ref: "a.b", type: "string" } } },
  } as never);
  @Module({ imports: [AccessModule], permissions: bad }) class BadModule {}
  const error = await buildError(BadModule);
  expect(error).toBeInstanceOf(AccessSetupError);
  expect(error.message).toContain("BadModule: permissions have errors");
  expect(error.message).toContain('permission "Orders": the key must look like');
  expect(error.message).toContain('attribute "own" is a reserved word of conditions');
  expect(error.message).toContain('attribute "both" needs exactly one of ref and type');

  @Module({ permissions: { "a.b": { title: "x" } } as never }) class LooseModule {}
  expect((await buildError(LooseModule)).message).toBe("LooseModule: permissions must be a definePermissions(...) result.");
});

test("the graph must import AccessModule, own every reference kind and register the lookups", async () => {
  @Module({ permissions: definePermissions({ "a.read": { title: "x" } }) }) class LonelyModule {}
  expect((await buildError(LonelyModule)).message).toBe("LonelyModule declares access (permissions, references or roles), but the application does not import AccessModule (bazis/core/access).");

  @Module({ imports: [AccessModule], permissions: definePermissions({ "a.read": { title: "x", on: { table: { ref: "dm.table" } } } }) }) class NoKindModule {}
  expect((await buildError(NoKindModule)).message).toContain('attribute "table" refers to kind "dm.table", which no module declares in references');

  @Module({ imports: [AccessModule], permissions: definePermissions({ "a.read": { title: "x", scope: { lookup: FolderLookup } } }) }) class NoLookupModule {}
  expect((await buildError(NoLookupModule)).message).toBe('NoLookupModule: FolderLookup of permission "a.read" is not registered: add it to the module\'s providers.');

  @Module({ imports: [AccessModule], permissions: definePermissions({ "orders.read": { title: "again" } }) }) class TwiceModule {}
  @Module({ imports: [OrdersModule, TwiceModule] }) class AppModule {}
  expect((await buildError(AppModule)).message).toBe('Permission "orders.read" is declared twice: in OrdersModule and in TwiceModule.');
});

test("roles name declared permissions with valid conditions", async () => {
  @Module({ imports: [OrdersModule], roles: defineRoles({ clerk: ["orders.delete"] }) }) class UnknownModule {}
  expect((await buildError(UnknownModule)).message).toBe('UnknownModule: role "clerk" names permission "orders.delete", which no module declares.');

  @Module({ imports: [OrdersModule], roles: defineRoles({ clerk: [{ permission: "orders.export", where: { own: true } }] }) }) class OwnModule {}
  expect((await buildError(OwnModule)).message).toBe('OwnModule: role "clerk", permission "orders.export": the permission declares no owner, own cannot be used.');

  @Module({ imports: [OrdersModule], roles: defineRoles({ clerk: [{ permission: "orders.read", where: { status: { eq: null } } }] }) } as never) class NullModule {}
  expect((await buildError(NullModule)).message).toContain("status.eq must be a string, number or boolean (an empty value is tested with isNull)");
});

test("can: partition, own, conditions in three-valued logic", async () => {
  const access = (await accessWith(new StaticAccessPolicy({
    grants: {
      "user:7": {
        // own, or a public order of shop 1 that is not cancelled
        "orders.read": [{ scopes: ["s1"], where: { any: [{ own: true }, { all: [{ status: { in: ["new", "paid"] } }, { not: { status: { eq: "cancelled" } } }] }] } }],
        "orders.export": [{ scopes: "all" }],
      },
    },
  }))).as({ sub: "user:7" });

  expect(await access.can("orders.read")).toBe(true);
  expect(await access.can("orders.read", { scope: "s1", customerId: 7, status: "cancelled" })).toBe(true);
  expect(await access.can("orders.read", { scope: "s1", customerId: 8, status: "paid" })).toBe(true);
  expect(await access.can("orders.read", { scope: "s1", customerId: 8, status: "cancelled" })).toBe(false);
  expect(await access.can("orders.read", { scope: "s2", customerId: 7 })).toBe(false);
  expect(await access.can("orders.read", { scope: ["s2", "s1"], customerId: 7 })).toBe(true);
  // the status is unknown: «not cancelled» cannot be proven
  expect(await access.can("orders.read", { scope: "s1", customerId: 8 })).toBe(false);
  expect(await access.can("orders.export", {})).toBe(true);
  expect(await access.can("orders.create")).toBe(false);
  await expect(access.can("orders.read", { customerId: 7 })).rejects.toThrow('can("orders.read") needs the object\'s partition');
  await expect(access.can("orders.delete")).rejects.toThrow('Permission "orders.delete" is not declared');
});

test("filter: grants become one column condition; lookups and limits apply", async () => {
  const access = (await accessWith(new StaticAccessPolicy({
    grants: {
      "user:7": {
        "orders.read": [
          { scopes: ["s1", null], where: { own: true } },
          { scopes: "all", where: { all: [{ folder: { eq: "sales" } }, { not: { process: { in: ["act"] } } }] } },
        ],
        "orders.create": [{ scopes: ["s1"] }],
      },
    },
  }))).as({ sub: "user:7" });

  const filter = await access.filter("orders.read");
  expect(filter).toEqual({
    kind: "where",
    where: {
      any: [
        { all: [{ any: [{ column: "shopId", in: ["s1"] }, { column: "shopId", isNull: true }] }, { column: "customerId", in: ["7"] }] },
        { all: [{ column: "processKey", in: ["invoice-0", "invoice-1", "invoice-2"] }, { not: { column: "processKey", in: ["act"] } }] },
      ],
    },
  });
  expect(grantsToWhere(filter)).not.toBeString();

  expect(await access.filter("orders.create", { scope: "s1" })).toEqual({ kind: "all" });
  expect(await access.filter("orders.create", { scope: "s2" })).toEqual({ kind: "none" });
  expect(grantsToWhere(await access.filter("orders.export"))).toBe("none");
  await expect(access.filter("orders.create")).rejects.toThrow("needs the partition of the request");

  FolderLookup.values = 1001;
  try {
    await expect(access.filter("orders.read")).rejects.toBeInstanceOf(AccessFilterTooLargeError);
  } finally {
    FolderLookup.values = 3;
  }
});

test("a grant the permission cannot use is dropped, not widened", async () => {
  const access = (await accessWith(new StaticAccessPolicy({
    grants: { "user:7": { "orders.read": [{ scopes: "all", where: { color: { eq: "red" } } } as never, { scopes: ["s1"] }] } },
  }))).as({ sub: "user:7" });
  expect(await access.grants("orders.read")).toEqual([{ scopes: ["s1"] }]);
  expect(await access.can("orders.read", { scope: "s2" })).toBe(false);
});

test("fields: lists of matching grants add up; maskFields keeps them", async () => {
  const access = (await accessWith(new StaticAccessPolicy({
    grants: {
      "user:7": {
        "orders.read": [
          { scopes: "all", where: { own: true }, fields: { read: ["id", "total"], write: ["comment"] } },
          { scopes: "all", where: { status: { eq: "paid" } }, fields: { read: ["id", "status"] } },
        ],
      },
    },
  }))).as({ sub: "user:7" });
  const fields = await access.fields("orders.read", { scope: "s1", customerId: "7", status: "paid" });
  expect(fields.read).toEqual(["id", "total", "status"]);
  expect(fields.write).toBe("all");
  expect(maskFields({ id: 1, total: 10, secret: "x" }, ["id", "total"])).toEqual({ id: 1, total: 10 });
});

/** Puts the principal of `x-user` / `x-roles` the way an application's check does. */
const signedIn: AuthorizeCheck = (ctx) => {
  const subject = ctx.header("x-user");
  if (subject === undefined) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject, findFirst: (claim: string) => (claim === "role" ? ctx.header("x-roles") : claim === "kind" ? "staff" : undefined) });
  return true;
};

@Controller("orders")
class OrdersController {
  @Get("export")
  @Authorize(can("orders.export"))
  exportAll() {
    return { ok: true };
  }

  @Get(":id")
  async get(ctx: HttpContext) {
    const order = { id: ctx.params.id, shopId: "s1", customerId: ctx.params.id === "1" ? "5" : "6", total: 10 };
    const access = await ctx.services.resolve(IAccess).for(ctx);
    if (!(await access.can("orders.read", { ...order, scope: order.shopId }))) throw new NotFoundError();
    return order;
  }
}

test("the default rights system: roles from the token, permissions from @Module({ roles }); HTTP catalog", async () => {
  @Module({
    imports: [OrdersModule],
    roles: defineRoles({ admin: "all", clerk: ["orders.read:own", "access.catalog.read"], auditor: ["orders.export"] }),
    controllers: [OrdersController],
  })
  class AppModule {}
  const app = await startTestApp(AppModule, { http: { authorize: signedIn }, configure: (builder) => builder.addConfigSource(memorySource({ access: { kindClaim: "kind" } })) });
  try {
    const as = (user: string, roles: string) => ({ headers: { "x-user": user, "x-roles": roles } });
    expect((await app.fetch("/orders/export")).status).toBe(401);
    expect((await app.fetch("/orders/export", as("5", "clerk"))).status).toBe(403);
    expect((await app.fetch("/orders/export", as("5", "clerk auditor"))).status).toBe(200);
    expect((await app.fetch("/orders/1", as("5", "clerk"))).status).toBe(200);
    expect((await app.fetch("/orders/2", as("5", "clerk"))).status).toBe(404);
    expect((await app.fetch("/orders/2", as("9", "admin"))).status).toBe(200);

    const catalog = await (await app.fetch("/access/catalog", as("5", "clerk"))).json() as { data: { key: string; scope: string; own: boolean; attributes: unknown[] }[] };
    expect(catalog.data.map((item) => item.key)).toEqual(["access.catalog.read", "orders.create", "orders.export", "orders.read"]);
    expect(catalog.data[3]).toMatchObject({ key: "orders.read", scope: "column", own: true, fields: true });
    expect(catalog.data[3]!.attributes).toEqual([{ name: "status", type: "string" }, { name: "process", ref: "orders.process" }, { name: "folder", type: "string" }]);
    const refs = await (await app.fetch("/access/references/orders.process?search=inv", as("5", "clerk"))).json();
    expect(refs).toEqual({ data: [{ id: "invoice", title: { en: "Invoice", ru: "Счёт" } }] });
    expect((await app.fetch("/access/references/dm.table", as("5", "clerk"))).status).toBe(404);
    expect((await app.fetch("/access/catalog", as("5", "auditor"))).status).toBe(403);

    const scope = app.container.createScope();
    const subject = { sub: "staff:5", id: "5", roles: ["clerk"] };
    expect(await scope.resolve(IAccess).as(subject, scope).principals(["s1"])).toEqual([{ scope: "s1", principals: ["user:5", "role:clerk"] }]);
  } finally {
    await app.stop();
  }
});
