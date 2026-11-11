import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);
import { AccessPolicy, type References, type AccessSubject, type Grants, type Scope, type ScopePrincipals } from "@/core/access";
import { TOOL_EXECUTION_OPTIONS, ToolRunner, type AgentToolResult, type BoundToolRunner } from "@/core/agent";
import { Module, singleton } from "@/core/di";
import { DI } from "@/core/di/lowLevel";
import type { AuthorizeContext } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, secret } from "@/core/kernel";
import { Column, DbContext, Entity, ormBazisConnect, UUID, Nullable } from "@/core/orm";
import { ormEntityTools, StandardToolsModule } from "@/core/tools";
import { defineProcess, IWorkflowDefinitions, WorkflowModule, WorkflowPartitions, type ProcessPartition } from "@/core/workflow";
import { dropWorkflowTables, testWorkflow, type TestWorkflow } from "@/core/workflow/testing";
import { postgres } from "@/library/orm";
import type { ProcessDocument } from "@/library/workflow";

/**
 * `ormEntityTools` on PostgreSQL (WORKFLOW-002 §7.4). Runs only against a throwaway
 * database whose name starts with `bazis_wf_`: set `BAZIS_WORKFLOW_PG_URL`.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

@Entity({ table: "bazis_wf_tool_orders" })
class ToolOrder {
  @UUID()
  id = "";

  @Nullable()
  @Column({ type: "text" })
  shopId = "";

  @Nullable()
  @Column({ type: "text" })
  status = "new";

  @Nullable()
  @Column({ type: "integer" })
  amount = 0;

  @Nullable()
  @Column({ type: "text" })
  secretNote = "";

  @Nullable()
  @Column({ type: "datetime" })
  paidAt: Date | null = null;
}

@Entity({ table: "bazis_wf_tool_notes" })
class ToolNote {
  @UUID()
  id = "";

  @Nullable()
  @Column({ type: "text" })
  text = "";
}

class ToolsDbContext extends DbContext {
  readonly orders = this.set(ToolOrder);
  readonly notes = this.set(ToolNote);
}

class OpenPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext): AccessSubject {
    return { sub: ctx.header("x-user") ?? "admin" };
  }

  grants(): Grants {
    return "all";
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return [subject.sub];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    return scopes.map((scope) => ({ scope, principals: [`user:${subject.sub}`] }));
  }
}

class ShopPartitions extends WorkflowPartitions {
  of(): readonly ProcessPartition[] {
    return [{ partition: null, enabled: true }, { partition: "shop-a", enabled: true }];
  }
}

const orderTools = ormEntityTools(ToolOrder, { context: ToolsDbContext, ops: ["find", "create", "update", "delete"], fields: ["status", "amount", "paidAt"], partitionField: "shopId", name: "order", maxRows: 50, maxChanges: 3 });
const noteTools = ormEntityTools(ToolNote, { context: ToolsDbContext, ops: ["find", "create"], fields: ["text"] });

const PROCESS = defineProcess({
  key: "tool-order",
  title: "Tool order",
  document: {
    schemaVersion: "bazis.workflow/v2",
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Create: { kind: "serviceTask", title: "Create", config: { tool: "orm.order.create", input: { values: { status: "new", amount: { path: "$input.amount" } } }, saveTo: "made" } },
      End: { kind: "end", title: "End" },
    },
    flows: { a: { source: "Start", target: "Create" }, b: { source: "Create", target: "End" } },
    variables: [{ name: "amount", type: "integer", direction: "in" }, { name: "made", type: "object", direction: "out" }],
  } as unknown as ProcessDocument,
});

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wftools", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule, StandardToolsModule],
    ormBazis: { context: ToolsDbContext, entities: [ToolOrder, ToolNote], ensureCreated: true },
    tools: [orderTools, noteTools],
    processes: [PROCESS],
    providers: [
      singleton(AccessPolicy, OpenPolicy),
      singleton(WorkflowPartitions, ShopPartitions),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined, approvalPolicy: () => true })),
    ],
  })
  class AppModule {}
  return AppModule;
}

let wf: TestWorkflow;
let tools: BoundToolRunner;
const ACTOR = { kind: "system", id: "test" } as const;

beforeAll(async () => {
  if (!enabled) return;
  // The database is a throwaway one: its name was checked above.
  await dropWorkflowTables(url!, { force: true });
  wf = await testWorkflow(root(url!), { now: "2026-11-02T09:00:00Z" });
  tools = wf.app.container.resolve(ToolRunner).as("workflow");
});

afterAll(async () => {
  if (enabled) await wf.stop();
});

const call = (name: string, input: unknown, partition: string | null = "shop-a", dryRun = false): Promise<AgentToolResult> => tools.run(name, input, { actor: ACTOR, metadata: { partition }, ...(dryRun ? { dryRun } : {}) });
const output = async <T = Record<string, any>>(name: string, input: unknown, partition: string | null = "shop-a", dryRun = false): Promise<T> => {
  const result = await call(name, input, partition, dryRun);
  expect(result.error).toBeUndefined();
  return result.output as T;
};
const reason = async (name: string, input: unknown, partition: string | null = "shop-a") => ((await call(name, input, partition)).error?.details as { reason?: string } | undefined)?.reason;

test.skipIf(!enabled)("the contract names the open fields, and the palette shows it", async () => {
  const contract = tools.describe("orm.order.update");
  expect(contract).toMatchObject({ sideEffect: "write", dryRun: "supported", input: { kind: "json-schema" } });
  const schema = (contract!.input as unknown as { schema: { properties: { values: { properties: Record<string, unknown>; "x-ref-keys": string; "x-ref-scope": string } } } }).schema;
  expect(Object.keys(schema.properties.values.properties).sort()).toEqual(["amount", "paidAt", "status"]);
  expect(schema.properties.values["x-ref-keys"]).toBe("orm.field");
  expect(schema.properties.values["x-ref-scope"]).toBe("ToolOrder");
  expect(tools.describe("orm.tool-note.find")?.sideEffect).toBe("read");
  expect(tools.describe("orm.tool-note.delete")).toBeUndefined();
  const scope = wf.app.container.createScope();
  try {
    const names = scope.resolve(IWorkflowDefinitions).palette().tools.map((tool) => tool.name);
    expect(names).toContain("orm.order.find");
    expect(names).toContain("orm.tool-note.create");
  } finally {
    await scope.dispose();
  }
});

test.skipIf(!enabled)("create writes the partition itself, and a process can call it", async () => {
  const { item } = await output("orm.order.create", { values: { status: "new", amount: 10 } });
  expect(item).toMatchObject({ status: "new", amount: 10, paidAt: null });
  expect(item.id).toBeString();
  expect(item.shopId).toBeUndefined();
  expect(item.secretNote).toBeUndefined();
  const started = await wf.start("tool-order", { input: { amount: 20 }, partition: "shop-a" });
  await wf.drain();
  const done = await wf.instance(started.id);
  expect(done.status).toBe("completed");
  expect(done.output?.made).toMatchObject({ item: { amount: 20, status: "new" } });
});

test.skipIf(!enabled)("every query stays in the partition; without one the Tools refuse", async () => {
  const scope = wf.app.container.createScope();
  try {
    const db = scope.resolve(ToolsDbContext);
    db.orders.add(Object.assign(new ToolOrder(), { shopId: "shop-b", status: "foreign", amount: 999 }));
    await db.saveChanges();
  } finally {
    await scope.dispose();
  }
  const { items } = await output("orm.order.find", {});
  expect(items.some((item: { status: string }) => item.status === "foreign")).toBe(false);
  expect((await output("orm.order.update", { where: { status: "foreign" }, values: { amount: 1 } })).updated).toBe(0);
  expect((await output("orm.order.delete", { where: { status: "foreign" } })).deleted).toBe(0);
  expect(await reason("orm.order.find", {}, null)).toBe("partition_required");
  expect(await reason("orm.order.create", { values: { status: "x" } }, null)).toBe("partition_required");
  // An entity without a partition field does not ask.
  expect((await output("orm.tool-note.create", { values: { text: "hi" } }, null)).item.text).toBe("hi");
  expect((await output("orm.tool-note.find", { where: { text: "hi" } }, null)).total).toBe(1);
});

test.skipIf(!enabled)("find filters, sorts and limits by open fields only", async () => {
  await output("orm.order.create", { values: { status: "paid", amount: 300, paidAt: "2026-10-01T00:00:00Z" } });
  await output("orm.order.create", { values: { status: "paid", amount: 200, paidAt: "2026-10-02T00:00:00Z" } });
  const found = await output("orm.order.find", { where: { status: "paid", amount: { gte: 100, lt: 300 } } });
  expect(found.items.map((item: { amount: number }) => item.amount)).toEqual([200]);
  const sorted = await output("orm.order.find", { where: { status: { in: ["paid"] } }, sort: [{ field: "amount", dir: "desc" }], limit: 1 });
  expect(sorted).toMatchObject({ total: 2, items: [{ amount: 300, paidAt: "2026-10-01T00:00:00.000Z" }] });
  expect((await output("orm.order.find", { where: { paidAt: { gt: "2026-10-01T12:00:00Z" } } })).total).toBe(1);
  expect((await output("orm.order.find", { where: { paidAt: null, status: { ne: "paid" } } })).total).toBeGreaterThan(0);
  expect(await reason("orm.order.find", { where: { secretNote: "x" } })).toBe("invalid_input");
  expect(await reason("orm.order.find", { where: { shopId: "shop-b" } })).toBe("invalid_input");
  expect(await reason("orm.order.find", { sort: [{ field: "secretNote" }] })).toBe("invalid_input");
  expect(await reason("orm.order.find", { limit: 51 })).toBe("invalid_input");
  expect(await reason("orm.order.find", { where: { amount: { like: "x" } } })).toBe("invalid_input");
  expect(await reason("orm.order.find", { where: { amount: "many" } })).toBe("invalid_input");
});

test.skipIf(!enabled)("writing is limited to open fields and to a named set of records", async () => {
  expect(await reason("orm.order.create", { values: { secretNote: "x" } })).toBe("invalid_input");
  expect(await reason("orm.order.create", { values: { shopId: "shop-b" } })).toBe("invalid_input");
  expect(await reason("orm.order.create", { values: { id: "x" } })).toBe("invalid_input");
  expect(await reason("orm.order.create", { values: { amount: "many" } })).toBe("invalid_input");
  expect(await reason("orm.order.update", { where: {}, values: { amount: 1 } })).toBe("invalid_input");
  expect(await reason("orm.order.update", { where: { status: "paid" }, values: {} })).toBe("invalid_input");
  expect(await reason("orm.order.delete", { where: {} })).toBe("invalid_input");
  for (let n = 0; n < 4; n += 1) await output("orm.order.create", { values: { status: "many", amount: n } });
  expect(await reason("orm.order.update", { where: { status: "many" }, values: { amount: 0 } })).toBe("too_many_records");
  expect(await reason("orm.order.delete", { where: { status: "many" } })).toBe("too_many_records");
  expect((await output("orm.order.find", { where: { status: "many", amount: 3 } })).total).toBe(1);
  expect((await output("orm.order.update", { where: { status: "many", amount: { gte: 2 } }, values: { status: "few" } })).updated).toBe(2);
  expect((await output("orm.order.delete", { where: { status: "few" } })).deleted).toBe(2);
});

test.skipIf(!enabled)("a dry run writes nothing and says what would happen", async () => {
  const before = (await output("orm.order.find", {})).total;
  const made = await output("orm.order.create", { values: { status: "dry", amount: 5 } }, "shop-a", true);
  expect(made).toMatchObject({ dryRun: true, item: { status: "dry", amount: 5 } });
  expect((await output("orm.order.find", {})).total).toBe(before);
  const changed = await output("orm.order.update", { where: { status: "paid" }, values: { amount: 1 } }, "shop-a", true);
  expect(changed).toEqual({ updated: 2, dryRun: true });
  expect((await output("orm.order.find", { where: { status: "paid", amount: 1 } })).total).toBe(0);
  expect(await output<unknown>("orm.order.delete", { where: { status: "paid" } }, "shop-a", true)).toEqual({ deleted: 2, dryRun: true });
  expect((await output("orm.order.find", { where: { status: "paid" } })).total).toBe(2);
});

test.skipIf(!enabled)("a wrong setup is told at once", () => {
  const options = { context: ToolsDbContext, ops: ["find"] as const };
  expect(() => ormEntityTools(ToolOrder, { ...options, fields: ["nope"] })).toThrow("no field nope");
  expect(() => ormEntityTools(ToolOrder, { ...options, fields: ["id"] })).toThrow("is the key");
  expect(() => ormEntityTools(ToolOrder, { ...options, fields: ["shopId"], partitionField: "shopId" })).toThrow("partition field");
  expect(() => ormEntityTools(ToolOrder, { ...options, fields: [], partitionField: "nope" })).toThrow("no field nope");
  expect(() => ormEntityTools(ToolOrder, { ...options, ops: [], fields: [] })).toThrow("ops");
  expect(() => ormEntityTools(ToolOrder, { ...options, fields: [], name: "Bad Name" })).toThrow("Tool name");
  expect(() => ormEntityTools(ToolOrder, { ...options, fields: [], maxRows: 5000 })).toThrow("maxRows");
});

test.skipIf(!enabled)("the reference kinds name what is open", async () => {
  const scope = wf.app.container.createScope();
  try {
    const { OrmEntityReferences, OrmFieldReferences } = await import("@/core/tools/orm/OrmEntity.references");
    const entities: References = scope.resolve(OrmEntityReferences);
    const fields: References = scope.resolve(OrmFieldReferences);
    const context = { scope: null };
    expect([...await entities.exists(["ToolOrder", "Nope"], context)]).toEqual(["ToolOrder"]);
    expect([...await fields.exists(["ToolOrder.status", "ToolOrder.secretNote", "ToolNote.text"], context)].sort()).toEqual(["ToolNote.text", "ToolOrder.status"]);
    expect((await fields.search("note.", context, { limit: 10, offset: 0 })).map((item) => item.id)).toEqual(["ToolNote.id", "ToolNote.text"]);
  } finally {
    await scope.dispose();
  }
});
