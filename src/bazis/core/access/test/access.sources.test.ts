import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  AccessModule,
  AccessPolicy,
  AccessSetupError,
  AttributeLookup,
  IAccess,
  IAccessCatalog,
  PermissionSource,
  References,
  can,
  definePermissions,
  type AccessSubject,
  type AccessValue,
  type Grants,
  type PermissionDeclarations,
  type PermissionSpec,
  type ReferenceItem,
} from "@/core/access";
import { PermissionSourceLoader } from "@/core/access/catalog/PermissionSourceLoader";
import { StaticAccessPolicy } from "@/core/access/testing";
import { Module, singletonValue } from "@/core/di";
import { Authorize, Controller, Get, PRINCIPAL_STATE_KEY, UnauthorizedError, type AuthorizeCheck } from "@/core/http";
import { LOGGER, memorySource, type Logger } from "@/core/kernel";
import { createTestContainer, startTestApp } from "@/core/testing";

// ACCESS-001 §3.1: permissions that appear while the application runs.

/** The data manager of the test: its tables, their fields and the version of all that. */
const data = {
  version: 1,
  tables: {} as Record<string, PermissionSpec>,
  failure: undefined as string | undefined,
  loads: [] as (readonly string[] | "all")[],
  versions: 0,
};

class TableLookup extends AttributeLookup {
  toColumn(values: readonly AccessValue[]) { return { column: "tableId", in: values }; }
}

class UnregisteredLookup extends AttributeLookup {
  toColumn(values: readonly AccessValue[]) { return { column: "x", in: values }; }
}

class RecordReferences extends References {
  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> { return new Set(ids); }
  async describe(): Promise<readonly ReferenceItem[]> { return []; }
  async search(): Promise<readonly ReferenceItem[]> { return []; }
}

class DataPermissionSource extends PermissionSource {
  version(): string {
    data.versions += 1;
    if (data.failure !== undefined) throw new Error(data.failure);
    return String(data.version);
  }

  load(keys?: readonly string[]): PermissionDeclarations {
    data.loads.push(keys ?? "all");
    if (data.failure !== undefined) throw new Error(data.failure);
    return keys === undefined ? { ...data.tables } : Object.fromEntries(keys.filter((key) => key in data.tables).map((key) => [key, data.tables[key]!]));
  }
}

// What `bazis codegen` writes for an application: a key under the prefix is a permission key.
declare module "@/core/access" {
  interface BazisPermissionSources { data: true }
}

const ordersRead: PermissionSpec = {
  title: { en: "Orders: read", ru: "Заказы: читать" },
  scope: "request",
  on: { total: { type: "number" }, status: { type: "string" }, buyer: { ref: "dm.record", column: "buyerId" }, table: { type: "number", lookup: TableLookup } },
  owner: "createdById",
  fields: true,
};

const logged: { level: string; message: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, fields) => void logged.push({ level: "warn", message, fields }),
  error: (message, fields) => void logged.push({ level: "error", message, fields }),
};

@Module({
  imports: [AccessModule],
  permissions: definePermissions({ "dm.tables.manage": { title: "Manage tables" } }),
  permissionSources: { data: DataPermissionSource },
  references: { "dm.record": RecordReferences },
  providers: [singletonValue(LOGGER, logger), singletonValue(TableLookup, new TableLookup())],
})
class DataModule {}

/** A rights system that counts what it is asked. */
class CountingPolicy extends StaticAccessPolicy {
  readonly asked: string[] = [];
  override grants(subject: AccessSubject, permission: string): Grants {
    this.asked.push(permission);
    return super.grants(subject, permission);
  }
}

beforeEach(() => {
  data.version = 1;
  data.tables = { "data.orders.read": ordersRead, "data.orders.update": { title: "Orders: update", on: { total: { type: "number" } } } };
  data.failure = undefined;
  data.loads = [];
  data.versions = 0;
  logged.length = 0;
});

afterEach(() => { setSystemTime(); });

async function application(policy: AccessPolicy = new StaticAccessPolicy({ otherwise: "all" })) {
  @Module({ imports: [DataModule], providers: [singletonValue(AccessPolicy, policy)] })
  class AppModule {}
  const container = await createTestContainer(AppModule);
  const scope = container.createScope();
  const catalog = container.resolve(IAccessCatalog);
  return {
    container,
    catalog,
    /** What the start of the application does before it takes requests. */
    start: () => container.resolve(PermissionSourceLoader).start(),
    loader: container.resolve(PermissionSourceLoader),
    as: (sub: string) => scope.resolve(IAccess).as({ sub }, scope),
  };
}

async function buildError(root: Parameters<typeof createTestContainer>[0]): Promise<Error> {
  try {
    await createTestContainer(root);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the container was built");
}

/** A second passes: the limit of version questions for a missing key is over. */
function later(): void {
  setSystemTime(new Date(Date.now() + 2000));
}

test("a source owns its prefix: declared keys and other sources stay out of it", async () => {
  @Module({ imports: [AccessModule], permissionSources: { Data: DataPermissionSource, "dm.": DataPermissionSource } }) class BadPrefixModule {}
  const bad = await buildError(BadPrefixModule);
  expect(bad).toBeInstanceOf(AccessSetupError);
  expect(bad.message).toContain("BadPrefixModule: permissionSources have errors");
  expect(bad.message).toContain('prefix "Data" must be one or several key segments in lower case');

  @Module({ imports: [AccessModule], permissionSources: { data: "DataPermissionSource" } } as never) class NoClassModule {}
  expect((await buildError(NoClassModule)).message).toContain('prefix "data" must name a PermissionSource class');

  @Module({ permissionSources: { data: DataPermissionSource } }) class LonelyModule {}
  expect((await buildError(LonelyModule)).message).toContain("LonelyModule declares access (permissions, references, roles or permission sources), but the application does not import AccessModule");

  @Module({ imports: [AccessModule], permissionSources: { data: DataPermissionSource } }) class TwiceModule {}
  @Module({ imports: [DataModule, TwiceModule] }) class TwiceApp {}
  expect((await buildError(TwiceApp)).message).toBe('Permission source prefix "data" is declared twice: in DataModule and in TwiceModule.');

  @Module({ imports: [AccessModule], permissionSources: { "data.orders": DataPermissionSource } }) class InsideModule {}
  @Module({ imports: [DataModule, InsideModule] }) class InsideApp {}
  expect((await buildError(InsideApp)).message).toBe('Permission source prefixes "data" (DataModule) and "data.orders" (InsideModule) overlap: one lies under the other.');

  @Module({ imports: [AccessModule], permissions: definePermissions({ "data.tables.manage": { title: "x" } }) }) class StaticModule {}
  @Module({ imports: [DataModule, StaticModule] }) class StaticApp {}
  expect((await buildError(StaticApp)).message).toBe('Permission "data.tables.manage" of StaticModule lies under the prefix "data" of a permission source of DataModule: a source owns every key of its prefix.');
});

test("the start reads the sources; their permissions stand in the catalog next to the declared ones", async () => {
  const app = await application();
  expect(app.catalog.permissions().map((item) => item.key)).toEqual(["access.catalog.read", "dm.tables.manage"]);
  expect(app.catalog.sources()).toEqual([{ prefix: "data", module: "DataModule", loaded: false, version: undefined, error: undefined, permissions: 0 }]);
  expect(app.loader.checkHealth().healthy).toBe(false);

  await app.start();
  expect(app.catalog.permissions().map((item) => item.key)).toEqual(["access.catalog.read", "data.orders.read", "data.orders.update", "dm.tables.manage"]);
  expect(app.catalog.permission("data.orders.read")).toMatchObject({ key: "data.orders.read", module: "DataModule", source: "data" });
  expect(app.catalog.permission("dm.tables.manage")!.source).toBeUndefined();
  expect(app.catalog.sources()).toEqual([{ prefix: "data", module: "DataModule", loaded: true, version: "1", error: undefined, permissions: 2 }]);
  expect(app.loader.checkHealth()).toEqual({ healthy: true });
  // The catalog keeps its own frozen copy: the source cannot change a permission behind its back.
  expect(Object.isFrozen(app.catalog.permission("data.orders.read")!.spec.on)).toBe(true);
  expect(app.catalog.permission("data.orders.read")!.spec).not.toBe(ordersRead);
  await app.loader.stop();
});

test("a specification of a source passes the checks of a declared one; a bad one is logged and does not exist", async () => {
  data.tables = {
    "data.orders.read": ordersRead,
    "data.bad.read": { title: "x", on: { own: { type: "string" } } },
    "other.items.read": { title: "x" },
    "data.noref.read": { title: "x", on: { buyer: { ref: "dm.nothing" } } },
    "data.nolookup.read": { title: "x", scope: { lookup: UnregisteredLookup } },
    "data.empty.read": null as never,
  };
  const app = await application();
  await app.start();
  expect(app.catalog.permissions().filter((item) => item.source === "data").map((item) => item.key)).toEqual(["data.orders.read"]);
  const problems = Object.fromEntries(logged.filter((line) => line.message === "access permission of a source rejected").map((line) => [line.fields!.permission, (line.fields!.problems as string[]).join("; ")]));
  expect(problems["data.bad.read"]).toContain('attribute "own" is a reserved word of conditions');
  expect(problems["other.items.read"]).toBe('permission "other.items.read": the key must start with "data."');
  expect(problems["data.noref.read"]).toContain('refers to kind "dm.nothing", which no module declares in references');
  expect(problems["data.nolookup.read"]).toContain("UnregisteredLookup is not registered: add it to providers of DataModule");
  expect(problems["data.empty.read"]).toContain("must be an object with a title");

  // Closed, not open: the superuser of the rights system does not get a permission that does not exist.
  expect(await app.as("user:1").can("data.bad.read")).toBe(false);
  expect(await app.as("user:1").can("data.orders.read")).toBe(true);
});

test("can, filter and fields work by a key of a source; a key the source does not give is closed for everyone", async () => {
  const policy = new CountingPolicy({
    otherwise: "all",
    grants: {
      "user:7": {
        "data.orders.read": [{ scopes: ["s1"], where: { any: [{ own: true }, { all: [{ total: { lte: 100000 } }, { status: { in: ["new", "paid"] } }] }] }, fields: { read: ["id", "total"] } }],
      },
    },
  });
  const app = await application(policy);
  await app.start();
  const user = app.as("user:7");
  expect(await user.can("data.orders.read")).toBe(true);
  expect(await user.can("data.orders.read", { scope: "s1", createdById: "8", total: "100000.00", status: "paid" })).toBe(true);
  expect(await user.can("data.orders.read", { scope: "s1", createdById: "8", total: "100000.01", status: "paid" })).toBe(false);
  expect(await user.can("data.orders.read", { scope: "s1", createdById: "7", total: "500000.00", status: "closed" })).toBe(true);
  expect(await user.can("data.orders.read", { scope: "s2", createdById: "7" })).toBe(false);
  expect(await user.filter("data.orders.read", { scope: "s1" })).toEqual({
    kind: "where",
    where: { any: [{ column: "createdById", in: ["7"] }, { all: [{ column: "total", op: "lte", value: 100000 }, { column: "status", in: ["new", "paid"] }] }] },
  });
  expect(await user.fields("data.orders.read", { scope: "s1", createdById: "7" })).toEqual({ read: ["id", "total"], write: "all" });

  // No such table: nobody has the permission, and the rights system is not asked about it.
  const admin = app.as("user:1");
  expect(await admin.can("data.orders.read", { scope: "s1" })).toBe(true);
  expect(await admin.can("data.ghosts.read")).toBe(false);
  expect(await admin.can("data.ghosts.read", { scope: "s1" })).toBe(false);
  expect(await admin.filter("data.ghosts.read", { scope: "s1" })).toEqual({ kind: "none" });
  expect(await admin.fields("data.ghosts.read", {})).toEqual({ read: [], write: [] });
  expect(await admin.grants("data.ghosts.read")).toEqual([]);
  expect(policy.asked).not.toContain("data.ghosts.read");
  expect(app.catalog.permission("data.ghosts.read")).toBeUndefined();
  expect(() => app.catalog.require("data.ghosts.read")).toThrow('Permission "data.ghosts.read" does not exist: the permission source "data" does not give it now.');
  // A key that is neither declared nor of a source stays a bug of the caller.
  await expect(admin.can("dm.ghosts.read" as never)).rejects.toThrow('Permission "dm.ghosts.read" is not declared');
});

test("changed(prefix, keys) reads only these keys now; the whole prefix follows with the next comparison of versions", async () => {
  const app = await application();
  await app.start();
  data.loads = [];

  // This instance has created a table and removed another one.
  data.tables["data.items.read"] = { title: "Items: read" };
  delete data.tables["data.orders.update"];
  data.version = 2;
  await app.catalog.changed("data", ["data.items.read", "data.orders.update"]);
  expect(data.loads).toEqual([["data.items.read", "data.orders.update"]]);
  expect(app.catalog.permissions().filter((item) => item.source === "data").map((item) => item.key)).toEqual(["data.items.read", "data.orders.read"]);
  // Other keys may have changed on another instance meanwhile: the version of the catalog stays the old one.
  expect(app.catalog.sources()[0]!.version).toBe("1");

  data.tables["data.orders.read"] = { title: "Orders: read", on: { total: { type: "number" } } };
  await app.catalog.changed("data");
  expect(data.loads).toEqual([["data.items.read", "data.orders.update"], "all"]);
  expect(app.catalog.sources()[0]!.version).toBe("2");
  expect(Object.keys(app.catalog.permission("data.orders.read")!.spec.on!)).toEqual(["total"]);

  await expect(app.catalog.changed("orders")).rejects.toThrow('No permission source owns the prefix "orders"');
});

test("a table another instance has just created does not wait for the poll", async () => {
  const app = await application();
  await app.start();

  // Another instance created the table: this one learns it only from the version.
  data.tables["data.deals.read"] = { title: "Deals: read" };
  data.version = 2;
  // Not more often than once a second for a prefix: the start has just compared the version.
  expect(await app.as("user:1").can("data.deals.read")).toBe(false);
  later();
  data.versions = 0;
  expect(await app.as("user:1").can("data.deals.read")).toBe(true);
  expect(data.versions).toBe(2); // the comparison and the reading it caused

  // A key that does not exist asks the version again only after a second.
  data.versions = 0;
  expect(await app.as("user:2").can("data.ghosts.read")).toBe(false);
  expect(await app.as("user:3").can("data.ghosts.read")).toBe(false);
  expect(data.versions).toBe(0);
  later();
  expect(await app.as("user:4").can("data.ghosts.read")).toBe(false);
  expect(data.versions).toBe(1);
});

test("a grant that names a field another instance has just added is checked against the new version before it is dropped", async () => {
  const policy = new StaticAccessPolicy({ grants: { "user:7": { "data.orders.update": [{ scopes: "all", where: { margin: { gt: 10 } } }] } } });
  const app = await application(policy);
  await app.start();

  expect(await app.as("user:7").grants("data.orders.update")).toEqual([]);
  expect(logged.filter((line) => line.message === "access grant dropped").map((line) => line.fields!.problem)).toEqual(['unknown attribute "margin"']);

  data.tables["data.orders.update"] = { title: "Orders: update", on: { total: { type: "number" }, margin: { type: "number" } } };
  data.version = 2;
  later();
  logged.length = 0;
  const user = app.as("user:7");
  expect(await user.grants("data.orders.update")).toEqual([{ scopes: "all", where: { margin: { gt: 10 } } }]);
  expect(await user.can("data.orders.update", { margin: 11 })).toBe(true);
  expect(await user.can("data.orders.update", { margin: 10 })).toBe(false);
  expect(logged).toEqual([]);
});

test("grantProblem tells a rights system why a rule cannot be saved", async () => {
  const app = await application();
  await app.start();
  const { catalog } = app;

  expect(await catalog.grantProblem("dm.tables.manage", { scopes: "all" })).toBeUndefined();
  expect(await catalog.grantProblem("dm.tables.manage", { scopes: "all", where: { own: true } })).toBe("the permission declares no owner, own cannot be used");
  expect(await catalog.grantProblem("dm.tables.drop", { scopes: "all" })).toBe('permission "dm.tables.drop" is not declared');

  expect(await catalog.grantProblem("data.orders.read", { scopes: ["s1"], where: { all: [{ total: { lte: 100000 } }, { own: true }] }, fields: { read: ["id"] } })).toBeUndefined();
  expect(await catalog.grantProblem("data.orders.read", { scopes: "all", where: { status: { gt: 5 } } })).toBe('status.gt: only an attribute of type "number" with a column can be compared');
  expect(await catalog.grantProblem("data.orders.read", { scopes: "all", where: { table: { gte: 5 } } })).toBe('table.gte: only an attribute of type "number" with a column can be compared (this one has a lookup)');
  expect(await catalog.grantProblem("data.orders.read", { scopes: "all", where: { total: { lt: "5" as never } } })).toBe("total.lt must be a number");
  expect(await catalog.grantProblem("data.orders.read", { scopes: "all", where: { total: { eq: "many" } } })).toBe("total.eq must be a number: the attribute is a number");
  expect(await catalog.grantProblem("data.orders.read", { scopes: "all", where: { total: { in: [1, "2.50"] } } })).toBeUndefined();
  expect(await catalog.grantProblem("data.orders.update", { scopes: "all", fields: { read: ["id"] } })).toBe("the permission has no field lists");
  expect(await catalog.grantProblem("data.ghosts.read", { scopes: "all" })).toBe('permission "data.ghosts.read" does not exist');

  // The administrator added a field on another instance and saves a rule with it here, within the same second.
  data.tables["data.orders.update"] = { title: "Orders: update", on: { total: { type: "number" }, margin: { type: "number" } } };
  data.tables["data.deals.read"] = { title: "Deals: read" };
  data.version = 2;
  expect(await catalog.grantProblem("data.orders.update", { scopes: "all", where: { margin: { gte: 10 } } })).toBeUndefined();
  expect(await catalog.grantProblem("data.deals.read", { scopes: "all" })).toBeUndefined();
});

test("a source that fails at the start has no permissions until a reading succeeds; a later failure keeps what was read", async () => {
  data.failure = "the database is away";
  const app = await application();
  await app.start(); // the start goes on
  expect(app.catalog.sources()).toEqual([{ prefix: "data", module: "DataModule", loaded: false, version: undefined, error: "the database is away", permissions: 0 }]);
  expect(app.loader.checkHealth()).toEqual({ healthy: false, details: 'permission source "data": not loaded: the database is away' });
  expect(await app.as("user:1").can("data.orders.read")).toBe(false);
  expect(logged.at(-1)).toMatchObject({ level: "error", message: "access permission source failed", fields: { source: "data", state: "the source has no permissions" } });

  data.failure = undefined;
  later();
  expect(await app.as("user:1").can("data.orders.read")).toBe(true);
  expect(app.loader.checkHealth()).toEqual({ healthy: true });

  // The reading after a change fails: the permissions read before it stay, the health says why.
  data.tables["data.items.read"] = { title: "Items: read" };
  data.version = 2;
  data.failure = "the database is away again";
  await app.catalog.changed("data");
  expect(app.catalog.permissions().filter((item) => item.source === "data").map((item) => item.key)).toEqual(["data.orders.read", "data.orders.update"]);
  expect(app.catalog.sources()[0]).toMatchObject({ loaded: true, version: "1", error: "the database is away again" });
  expect(app.loader.checkHealth()).toEqual({ healthy: false, details: 'permission source "data": the database is away again' });
  expect(logged.at(-1)!.fields).toMatchObject({ state: "the permissions read before stay" });

  data.failure = undefined;
  await app.catalog.changed("data");
  expect(app.catalog.permissions().filter((item) => item.source === "data").map((item) => item.key)).toEqual(["data.items.read", "data.orders.read", "data.orders.update"]);
  expect(app.catalog.sources()[0]).toMatchObject({ loaded: true, version: "2", error: undefined });
});

const signedIn: AuthorizeCheck = (ctx) => {
  const subject = ctx.header("x-user");
  if (subject === undefined) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject, findFirst: () => undefined });
  return true;
};

@Controller("data")
class DataController {
  @Get("orders")
  @Authorize(can("data.orders.read"))
  orders() { return { ok: true }; }

  @Get("deals")
  @Authorize(can("data.deals.read"))
  deals() { return { ok: true }; }
}

test("a started application: the sources are read before the first request, the poll brings the changes of other instances, the HTTP catalog shows them", async () => {
  @Module({ imports: [DataModule], controllers: [DataController], providers: [singletonValue(AccessPolicy, new StaticAccessPolicy({ otherwise: "all" }))] })
  class AppModule {}
  const app = await startTestApp(AppModule, { http: { authorize: signedIn }, configure: (builder) => builder.addConfigSource(memorySource({ access: { sourcePollSeconds: 0.05 } })) });
  try {
    const as = { headers: { "x-user": "1" } };
    expect((await app.fetch("/data/orders", as)).status).toBe(200);
    expect((await app.fetch("/data/deals", as)).status).toBe(403);

    const catalog = await (await app.fetch("/access/catalog", as)).json() as { data: { key: string; source?: string; attributes: unknown[] }[] };
    expect(catalog.data.map((item) => item.key)).toEqual(["access.catalog.read", "data.orders.read", "data.orders.update", "dm.tables.manage"]);
    expect(catalog.data[1]).toMatchObject({ key: "data.orders.read", module: "DataModule", source: "data", scope: "request", own: true, fields: true });
    expect(catalog.data[1]!.attributes).toEqual([
      { name: "total", type: "number", compare: true },
      { name: "status", type: "string" },
      { name: "buyer", ref: "dm.record" },
      { name: "table", type: "number" }, // a lookup cannot turn a range into a column
    ]);
    expect(catalog.data[3]!.source).toBeUndefined();

    // Another instance created a table; nobody tells this one.
    data.tables["data.deals.read"] = { title: "Deals: read" };
    data.version = 2;
    const deadline = Date.now() + 3000;
    while (app.container.resolve(IAccessCatalog).permission("data.deals.read") === undefined && Date.now() < deadline) await Bun.sleep(20);
    expect(app.container.resolve(IAccessCatalog).sources()[0]).toMatchObject({ version: "2", permissions: 3 });
    expect((await app.fetch("/data/deals", as)).status).toBe(200);
  } finally {
    await app.stop();
  }
});

test("without a poll the versions are compared only on demand", async () => {
  @Module({ imports: [DataModule], providers: [singletonValue(AccessPolicy, new StaticAccessPolicy({ otherwise: "all" }))] })
  class AppModule {}
  const app = await startTestApp(AppModule, { http: { authorize: signedIn }, configure: (builder) => builder.addConfigSource(memorySource({ access: { sourcePollSeconds: 0 } })) });
  try {
    data.versions = 0;
    await Bun.sleep(120);
    expect(data.versions).toBe(0);
  } finally {
    await app.stop();
  }
});
