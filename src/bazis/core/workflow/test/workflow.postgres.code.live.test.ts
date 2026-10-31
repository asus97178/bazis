import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { DI, Module } from "@/core/di";
import { Infra } from "@/core/infra";
import { defineConfig, secret } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { startTestApp } from "@/core/testing";
import { Tool, TOOL_EXECUTION_OPTIONS, type AgentToolExecutionContext } from "@/core/agent";
import type { HttpContext } from "@/core/http";
import { postgres } from "@/library/orm";
import { defineProcess, IWorkflowDefinitions, IWorkflowRuntime, WorkflowAccess, WorkflowModule, WorkflowSetupError, type CodeProcess, type WorkflowActor } from "@/core/workflow";
import { testWorkflow } from "@/core/workflow/testing";

/**
 * Live check of stage 5 of WORKFLOW-001 on PostgreSQL: processes declared in
 * code, published at start, and `testWorkflow`. Runs only against a throwaway
 * database whose name starts with `bazis_wf_`: set `BAZIS_WORKFLOW_PG_URL`.
 * The test drops the workflow tables before it starts.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const reserved: unknown[] = [];

@Tool({ name: "stock.reserve", description: "Reserves the goods of an order.", sideEffect: "read", callers: ["workflow"] })
class ReserveTool {
  execute(input: { order: string }, _context: AgentToolExecutionContext) {
    reserved.push(input);
    return { reserved: true };
  }
}

class OpenAccess extends WorkflowAccess {
  actor(ctx: HttpContext): WorkflowActor | undefined {
    return { kind: "user", id: ctx.header("x-user") ?? "u-1" };
  }

  can(): boolean {
    return true;
  }
}

/** Reserve the goods, then a manager approves within two hours or the order is escalated. */
function approval(title = "Order approval"): CodeProcess {
  return defineProcess({
    key: "order-approval",
    title,
    retentionDays: 30,
    document: {
      schemaVersion: "bazis.workflow/v1",
      input: { fields: [{ code: "order", type: "string", required: true }] },
      nodes: {
        Start: { kind: "manualStart", title: "Start" },
        Reserve: { kind: "serviceTask", title: "Reserve", config: { tool: "stock.reserve", input: { order: "$input.order" } } },
        Approve: { kind: "userTask", title: title === "Order approval" ? "Approve the order" : "Approve", config: { assignee: { role: "manager" } } },
        Late: { kind: "boundaryTimer", title: "Two hours", attachedTo: "Approve", config: { duration: "PT2H" } },
        Escalated: { kind: "end", title: "Escalated" },
        Done: { kind: "end", title: "Done" },
      },
      flows: {
        f1: { source: "Start", target: "Reserve" },
        f2: { source: "Reserve", target: "Approve" },
        f3: { source: "Approve", target: "Done" },
        f4: { source: "Late", target: "Escalated" },
      },
    },
  });
}

const nightly = defineProcess({
  key: "nightly-report",
  title: "Nightly report",
  document: {
    schemaVersion: "bazis.workflow/v1",
    nodes: { Daily: { kind: "scheduleStart", title: "At nine", config: { cron: "0 9 * * *" } }, End: { kind: "end", title: "End" } },
    flows: { f: { source: "Daily", target: "End" } },
  },
});

const unknownTool = defineProcess({
  key: "broken",
  title: "Broken",
  document: {
    schemaVersion: "bazis.workflow/v1",
    nodes: { Start: { kind: "manualStart", title: "Start" }, Call: { kind: "serviceTask", title: "Call", config: { tool: "nobody.has" } }, End: { kind: "end", title: "End" } },
    flows: { a: { source: "Start", target: "Call" }, b: { source: "Call", target: "End" } },
  },
});

function root(dsn: string, processes: readonly CodeProcess[]) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfcode", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({ tools: [ReserveTool], processes: [...processes] }) class OrdersModule {}
  @Module({
    imports: [TestInfra, WorkflowModule, OrdersModule],
    providers: [
      DI.singleton(DI.classProvider(WorkflowAccess, OpenAccess, [])),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined })),
    ],
  })
  class AppModule {}
  return AppModule;
}

async function catalog<T>(processes: readonly CodeProcess[], work: (definitions: IWorkflowDefinitions, fetch: (path: string, init?: RequestInit) => Promise<Response>) => Promise<T>): Promise<T> {
  const app = await startTestApp(root(url!, processes));
  const scope = app.container.createScope();
  try {
    return await work(scope.resolve(IWorkflowDefinitions), app.fetch);
  } finally {
    await scope.dispose();
    await app.stop();
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const sql = postgres({ url });
  try {
    const tables = (await sql.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'bazis\\_wf\\_%'", [])) as { tablename: string }[];
    if (tables.length > 0) await sql.execute(`DROP TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`, []);
    await sql.execute(`DO $$ BEGIN IF to_regclass('public.__bazis_orm_owned_stores_v1') IS NOT NULL THEN DELETE FROM "__bazis_orm_owned_stores_v1" WHERE store_key LIKE 'bazis.workflow.%'; END IF; END $$`, []);
  } finally {
    await sql.close();
  }
});

afterAll(() => {});

test.skipIf(!enabled)("processes of the modules are published at start, once per document, and change only through code", async () => {
  await catalog([approval(), nightly], async (definitions, fetch) => {
    const process = await definitions.get("order-approval");
    expect(process).toMatchObject({ title: "Order approval", retentionDays: 30, latestVersion: 1, module: "OrdersModule", draftUpdatedBy: { kind: "system", id: "code" } });
    expect((await definitions.versions("order-approval"))[0]?.publishedBy).toEqual({ kind: "system", id: "code" });
    expect((await definitions.get("nightly-report")).latestVersion).toBe(1);

    const listed = await (await fetch("/workflow/processes")).json() as { data: { key: string; module: string | null }[] };
    expect(listed.data.map((item) => [item.key, item.module])).toEqual([["nightly-report", "OrdersModule"], ["order-approval", "OrdersModule"]]);
    const draft = await fetch("/workflow/processes/order-approval/draft", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: process.draft }) });
    expect(draft.status).toBe(409);
    const refused = await draft.json() as { error: string; details: { code: string } };
    expect(refused.details.code).toBe("conflict");
    expect(refused.error).toContain("declared in code by OrdersModule");
    await expect(definitions.update("order-approval", { title: "Other" }, { kind: "user", id: "u-1" })).rejects.toMatchObject({ code: "conflict" });
    await expect(definitions.publish("order-approval", { kind: "user", id: "u-1" })).rejects.toMatchObject({ code: "conflict" });
    expect((await definitions.update("nightly-report", { archived: true }, { kind: "user", id: "u-1" })).archived).toBe(true);
  });

  // The same code again: no new version; an archived process stays archived.
  await catalog([approval(), nightly], async (definitions) => {
    expect((await definitions.get("order-approval")).latestVersion).toBe(1);
    expect((await definitions.get("nightly-report")).archived).toBe(true);
    await definitions.update("nightly-report", { archived: false }, { kind: "user", id: "u-1" });
  });

  // A changed document is the next version; a process gone from code becomes the catalog's own.
  await catalog([approval("Approval of the order")], async (definitions) => {
    expect(await definitions.get("order-approval")).toMatchObject({ title: "Approval of the order", latestVersion: 2 });
    const left = await definitions.get("nightly-report");
    expect(left.module).toBeNull();
    expect((await definitions.saveDraft("nightly-report", left.draft, { kind: "user", id: "u-1" })).issues).toEqual([]);
  });
});

test.skipIf(!enabled)("an unknown Tool stops the start with every finding", async () => {
  const error = await startTestApp(root(url!, [approval(), unknownTool])).then(async (app) => {
    await app.stop();
    throw new Error("the application started");
  }, (failure: unknown) => failure as Error);
  expect(error).toBeInstanceOf(WorkflowSetupError);
  expect(error.message).toContain('OrdersModule: process "broken"');
  expect(error.message).toContain("node Call:");
  expect(error.message).toContain("unknown_tool");
});

test.skipIf(!enabled)("testWorkflow runs jobs only in drain and moves time by the test's clock", async () => {
  // Schedule jobs the earlier applications planned by the system clock.
  const sql = postgres({ url });
  try {
    await sql.execute(`DELETE FROM "bazis_wf_run_jobs" WHERE kind = 'schedule'`, []);
  } finally {
    await sql.close();
  }
  const wf = await testWorkflow(root(url!, [approval(), nightly]), { now: "2026-11-02T08:30:00Z" });
  try {
    reserved.length = 0;
    const approved = await wf.start("order-approval", { input: { order: "A-1" } });
    expect(approved.tokens.map((t) => [t.nodeId, t.status])).toContainEqual(["Reserve", "waiting"]);
    await Bun.sleep(100);
    expect(reserved).toEqual([]); // no worker behind the test's back
    expect(await wf.drain()).toBe(1);
    expect(reserved).toEqual([{ order: "A-1" }]);
    expect((await wf.complete(approved.id, "Approve", {})).status).toBe("completed");
    await expect(wf.complete(approved.id, "Approve")).rejects.toThrow("No step waits at Approve");

    const runtime = wf.app.container.createScope().resolve(IWorkflowRuntime);
    const starts = async () => (await runtime.instances({ processKey: "nightly-report" })).total;
    const late = await wf.start("order-approval", { input: { order: "A-2" } });
    await wf.drain();
    expect(await starts()).toBe(0);
    // 09:30: only the 09:00 firing of the schedule is due; the approval still waits.
    expect(await wf.advance("PT1H")).toBe(1);
    expect(await starts()).toBe(1);
    expect((await wf.instance(late.id)).status).toBe("running");
    await wf.advance("PT1H");
    const escalated = await wf.instance(late.id);
    expect(escalated.status).toBe("completed");
    expect(escalated.tokens.map((t) => t.nodeId)).toContain("Escalated");
    expect((await wf.history(late.id)).find((entry) => entry.type === "timer")?.data).toEqual({ firedAt: "2026-11-02T10:30:00.000Z", interrupting: true });

    // Three days later the missed firings are not caught up: one, then the next is planned from now.
    await wf.advance("P3D");
    expect(await starts()).toBe(2);
    await wf.advance("PT1M");
    expect(await starts()).toBe(2);
  } finally {
    await wf.stop();
  }
});
