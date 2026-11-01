import { expect, setDefaultTimeout, test } from "bun:test";
import { IWorkflowRuntime } from "bazis/core/workflow";
import { testWorkflow } from "bazis/core/workflow/testing";
import { AppInfra } from "../infra/App.infra";
import { AppModule } from "../modules/App.module";
import { IOrderService } from "../modules/order/services/IOrder.service";
import { registerBazisGeneratedRuntime } from "../../generated/bazis/runtime";

setDefaultTimeout(30_000);

// The process on a clock that stands still: needs PostgreSQL (BAZIS_DB__HOST), otherwise skipped.
const enabled = Boolean(process.env.BAZIS_DB__HOST);

async function run(work: (wf: Awaited<ReturnType<typeof testWorkflow>>, place: (amount: number) => Promise<string>, status: (id: string) => Promise<string | undefined>) => Promise<void>) {
  await registerBazisGeneratedRuntime();
  const wf = await testWorkflow(AppModule, { infra: AppInfra, now: "2026-11-02T09:00:00Z", http: false });
  const inScope = async <T>(body: (orders: IOrderService) => Promise<T>) => {
    const scope = wf.app.container.createScope();
    try {
      return await body(scope.resolve(IOrderService));
    } finally {
      await scope.dispose();
    }
  };
  try {
    await work(
      wf,
      (amount) => inScope(async (orders) => (await orders.place(amount, { kind: "user", id: "ann" })).id),
      (id) => inScope(async (orders) => (await orders.get(id))?.status),
    );
  } finally {
    await wf.stop();
  }
}

/** The instance of the order just placed: the newest one of the process. */
async function instanceOf(wf: Awaited<ReturnType<typeof testWorkflow>>, orderId: string) {
  const scope = wf.app.container.createScope();
  try {
    const page = await scope.resolve(IWorkflowRuntime).instances({ businessKey: `order:${orderId}` });
    return page.items[0]!.id;
  } finally {
    await scope.dispose();
  }
}

test.skipIf(!enabled)("a small order is approved without a manager", async () => {
  await run(async (wf, place, status) => {
    const id = await place(100);
    await wf.drain();
    expect(await status(id)).toBe("approved");
  });
});

test.skipIf(!enabled)("a manager decides on a big order", async () => {
  await run(async (wf, place, status) => {
    const approved = await place(5000);
    const rejected = await place(6000);
    await wf.drain();
    expect(await status(approved)).toBe("new");

    await wf.complete(await instanceOf(wf, approved), "Review", { approved: true });
    await wf.complete(await instanceOf(wf, rejected), "Review", { approved: false });
    await wf.drain();
    expect(await status(approved)).toBe("approved");
    expect(await status(rejected)).toBe("rejected");
  });
});

test.skipIf(!enabled)("a big order nobody looked at for two days is rejected", async () => {
  await run(async (wf, place, status) => {
    const id = await place(7000);
    await wf.drain();
    await wf.advance("P2D");
    expect(await status(id)).toBe("rejected");
  });
});
