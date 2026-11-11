import { expect, setDefaultTimeout, test } from "bun:test";
import { IWorkflowRuntime } from "bazis/core/workflow";
import { testWorkflow, type TestWorkflow } from "bazis/core/workflow/testing";
import { OrdersApp } from "../App";
import { orderApproval } from "../modules/order/process/OrderApproval.process";
import { orderBatch } from "../modules/order/process/OrderBatch.process";
import { IOrderService } from "../modules/order/services/IOrder.service";

setDefaultTimeout(30_000);

// The process on a clock that stands still: needs PostgreSQL (BAZIS_DB__HOST), otherwise skipped.
const enabled = Boolean(process.env.BAZIS_DB__HOST);

/** The application of src/app/App.ts without its HTTP server; jobs run only in `wf.drain()`. */
async function run(work: (wf: TestWorkflow) => Promise<void>) {
  const wf = await testWorkflow(OrdersApp, { now: "2026-11-02T09:00:00Z", http: false });
  try {
    await work(wf);
  } finally {
    await wf.stop();
  }
}

const place = (wf: TestWorkflow, amount: number) => wf.use(IOrderService, async (orders) => (await orders.place(amount, { kind: "user", id: "ann" })).id);
const status = (wf: TestWorkflow, id: string) => wf.use(IOrderService, async (orders) => (await orders.get(id))?.status);
/** The instance of an order: the service starts it with the business key `order:<id>`. */
const approvalOf = (wf: TestWorkflow, orderId: string) => wf.instanceByKey(`order:${orderId}`);
const instancesOf = (wf: TestWorkflow, processKey: string) => wf.use(IWorkflowRuntime, async (runtime) => (await runtime.instances({ processKey })).items);

test.skipIf(!enabled)("a small order is approved without a manager", async () => {
  await run(async (wf) => {
    const id = await place(wf, 100);
    await wf.drain();
    expect(await status(wf, id)).toBe("approved");
    const instance = await approvalOf(wf, id);
    expect(instance.output).toEqual({ decision: "approved" });
    expect((await wf.history(instance.id)).find((entry) => entry.nodeId === "Classify" && entry.type === "assigned")?.data).toEqual({ values: { needsReview: false } });
  });
});

test.skipIf(!enabled)("a manager decides on a big order", async () => {
  await run(async (wf) => {
    const approved = await place(wf, 5000);
    const rejected = await place(wf, 6000);
    await wf.drain();
    expect(await status(wf, approved)).toBe("new");

    await wf.complete((await approvalOf(wf, approved)).id, "Review", { approved: true });
    await wf.complete((await approvalOf(wf, rejected)).id, "Review", { approved: false });
    await wf.drain();
    expect(await status(wf, approved)).toBe("approved");
    expect(await status(wf, rejected)).toBe("rejected");
  });
});

test.skipIf(!enabled)("a big order nobody looked at for two days is rejected", async () => {
  await run(async (wf) => {
    const id = await place(wf, 7000);
    await wf.drain();
    await wf.advance("P2D");
    expect(await status(wf, id)).toBe("rejected");
    expect((await approvalOf(wf, id)).output).toEqual({ decision: "rejected" });
  });
});

test.skipIf(!enabled)("a batch calls the approval of each order and gives back the decisions in order", async () => {
  await run(async (wf) => {
    const small = await place(wf, 100);
    const big = await place(wf, 5000);
    await wf.drain();
    const batch = await wf.start(orderBatch, { input: { orders: [{ orderId: small, amount: 100 }, { orderId: big, amount: 5000 }] } });
    await wf.drain();
    expect((await wf.instance(batch.id)).status).toBe("running");

    const children = await wf.use(IWorkflowRuntime, (runtime) => runtime.instances({ parentInstanceId: batch.id }));
    expect(children.total).toBe(2);
    // The batch acts for itself, and so do the approvals it called.
    expect(children.items[0]!.startedBy).toEqual({ kind: "system", id: "process:order-batch" });

    const waiting = children.items.find((item) => item.status === "running")!;
    await wf.complete(waiting.id, "Review", { approved: false });
    await wf.drain();
    const done = await wf.instance(batch.id);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ decisions: ["approved", "rejected"] });
    expect(await status(wf, big)).toBe("rejected");
  });
});

test.skipIf(!enabled)("the digest runs on weekday mornings in Moscow and counts what waits", async () => {
  await run(async (wf) => {
    await wf.drain();
    const digests = () => instancesOf(wf, "order-digest");
    // Monday, 9:00 in Moscow is 6:00 UTC. The tests share a database: a firing due from before comes first.
    wf.clock.set("2026-12-07T05:59:00Z");
    await wf.drain();
    const before = (await digests()).length;
    await place(wf, 5000);
    await wf.drain();
    wf.clock.set("2026-12-07T06:00:00Z");
    await wf.drain();
    const after = await digests();
    expect(after.length).toBe(before + 1);
    const output = (await wf.instance(after[0]!.id)).output;
    expect(output?.waiting).toBeGreaterThanOrEqual(1);
  });
});

test.skipIf(!enabled)("big orders of one customer make one alert about the last of them", async () => {
  await run(async (wf) => {
    const alerts = () => instancesOf(wf, "big-order-alert");
    const small = await place(wf, 100);
    const first = await place(wf, 100000);
    const last = await place(wf, 200000);
    await wf.drain();
    expect(await alerts()).toEqual([]);
    await wf.advance("PT10M");
    const [alert, ...rest] = await alerts();
    expect(rest).toEqual([]);
    const about = (await wf.instance(alert!.id)).output?.about;
    expect(about).toBe(last);
    expect([small, first]).not.toContain(about);
  });
});

test.skipIf(!enabled)("a trial of the approval changes no order and asks only who started it", async () => {
  await run(async (wf) => {
    const id = await place(wf, 5000);
    await wf.drain();
    const trial = await wf.start(orderApproval, { test: true, input: { orderId: id, amount: 100 }, actor: { kind: "user", id: "ann" } });
    await wf.drain();
    const done = await wf.instance(trial.id);
    expect(done).toMatchObject({ status: "completed", test: true });
    // The small order would be approved at once: the step did not run, and the order is as it was.
    expect((await wf.history(trial.id)).filter((entry) => entry.type === "tool").map((entry) => entry.data?.dryRun)).toEqual(["not called"]);
    expect(await status(wf, id)).toBe("new");
  });
});
