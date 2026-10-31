import { expect, test } from "bun:test";
import { Module } from "@/core/di";
import { createTestContainer } from "@/core/testing";
import { defineProcess, WorkflowSetupError } from "@/core/workflow";
import { ManualWorkflowClock } from "@/core/workflow/testing";

const simple = (key: string) => defineProcess({
  key,
  title: "Simple",
  document: {
    schemaVersion: "bazis.workflow/v1",
    nodes: { Start: { kind: "manualStart", title: "Start" }, End: { kind: "end", title: "End" } },
    flows: { f: { source: "Start", target: "End" } },
  },
});

async function buildError(root: Parameters<typeof createTestContainer>[0]): Promise<Error> {
  try {
    await createTestContainer(root);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the container was built");
}

test("defineProcess only describes: the result is frozen and keeps the fields", () => {
  const process = simple("orders.simple");
  expect(Object.isFrozen(process)).toBe(true);
  expect(process.key).toBe("orders.simple");
  expect(process.document.nodes.Start?.kind).toBe("manualStart");
});

test("a document with errors stops the build with the module, the key and every error", async () => {
  const broken = defineProcess({
    key: "Bad Key",
    title: "",
    document: { schemaVersion: "bazis.workflow/v1", nodes: { Start: { kind: "manualStart", title: "Start" } }, flows: { f: { source: "Start", target: "Nowhere" } } },
  });
  @Module({ processes: [broken] }) class OrdersModule {}
  const error = await buildError(OrdersModule);
  expect(error).toBeInstanceOf(WorkflowSetupError);
  expect(error.message).toContain('OrdersModule: process "Bad Key" has errors');
  expect(error.message).toContain("key must match");
  expect(error.message).toContain("title must be 1–200 characters");
  expect(error.message).toContain("flow f:");
});

test("processes must come from defineProcess", async () => {
  @Module({ processes: [{ key: "x" } as never] }) class LooseModule {}
  expect((await buildError(LooseModule)).message).toBe("LooseModule: processes must list defineProcess(...) results.");
});

test("one key in two modules stops the build", async () => {
  @Module({ processes: [simple("shared")] }) class FirstModule {}
  @Module({ processes: [simple("shared")] }) class SecondModule {}
  @Module({ imports: [FirstModule, SecondModule] }) class AppModule {}
  expect((await buildError(AppModule)).message).toBe('Process "shared" is declared twice: in FirstModule and in SecondModule.');
});

test("processes without WorkflowModule stop the build", async () => {
  @Module({ processes: [simple("lonely")] }) class LonelyModule {}
  expect((await buildError(LonelyModule)).message).toBe("LonelyModule declares processes, but the application does not import WorkflowModule (bazis/core/workflow).");
});

test("the manual clock stands still and moves only forward", () => {
  const clock = new ManualWorkflowClock("2026-11-02T09:00:00Z");
  expect(clock.manual).toBe(true);
  expect(clock.now().toISOString()).toBe("2026-11-02T09:00:00.000Z");
  expect(clock.advance("PT2H30M").toISOString()).toBe("2026-11-02T11:30:00.000Z");
  expect(clock.advance(1000).toISOString()).toBe("2026-11-02T11:30:01.000Z");
  expect(clock.set("2026-11-03T00:00:00Z").toISOString()).toBe("2026-11-03T00:00:00.000Z");
  expect(() => clock.set("2026-11-01T00:00:00Z")).toThrow("only moves forward");
  expect(() => clock.advance("P1M")).toThrow("ISO duration");
  expect(() => new ManualWorkflowClock("soon")).toThrow("must be a date");
});

test("inspectProcesses checks the processes of a module tree against its Tools without building it", async () => {
  const { Tool } = await import("@/core/agent");
  const { WorkflowModule } = await import("@/core/workflow");
  const { inspectProcesses } = await import("../definitions_module/code/inspectProcesses");
  @Tool({ name: "stock.reserve", description: "Reserves.", sideEffect: "read", callers: ["workflow"] })
  class ReserveTool { execute() { return {}; } }
  @Tool({ name: "agents.only", description: "Agents only.", sideEffect: "read", callers: ["agent"] })
  class AgentTool { execute() { return {}; } }
  const calling = (key: string, tool: string) => defineProcess({
    key,
    title: key,
    document: {
      schemaVersion: "bazis.workflow/v1",
      nodes: { Start: { kind: "manualStart", title: "Start" }, Call: { kind: "serviceTask", title: "Call", config: { tool } }, End: { kind: "end", title: "End" } },
      flows: { a: { source: "Start", target: "Call" }, b: { source: "Call", target: "End" } },
    },
  });
  @Module({ tools: [ReserveTool, AgentTool], processes: [calling("good", "stock.reserve"), calling("bad", "agents.only")] }) class OrdersModule {}
  @Module({ processes: [simple("good")] }) class OtherModule {}
  @Module({ imports: [WorkflowModule, OrdersModule, OtherModule] }) class AppModule {}

  const inspection = inspectProcesses(AppModule);
  expect(inspection.tools).toEqual(["stock.reserve"]);
  expect(inspection.errors).toEqual(['Process "good" is declared twice: in OrdersModule and in OtherModule.']);
  expect(inspection.processes.map((entry) => [entry.process.key, entry.module, entry.errors.length])).toEqual([["good", "OrdersModule", 0], ["bad", "OrdersModule", 1], ["good", "OtherModule", 0]]);
  expect(inspection.processes[1]!.errors[0]).toContain("node Call:");

  @Module({ processes: [simple("alone")] }) class AloneModule {}
  expect(inspectProcesses(AloneModule).errors).toEqual(["AloneModule declares processes, but the application does not import WorkflowModule (bazis/core/workflow)."]);
});
