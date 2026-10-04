import { SQL } from "bun";
import { describe, expect, test } from "bun:test";

// Driver qualification is deliberately separate from the ORM's connection
// quarantine tests. A working pool or query.cancelled flag is not cancellation.
const url = process.env.OSNOVA_PG_URL;
const enabled = !!url && process.env.OSNOVA_ORM_QUALIFICATION_LIVE === "1";
type Pending = Promise<unknown> & { cancel(): unknown; readonly cancelled: boolean };
type Client = { unsafe(sql: string, params?: readonly unknown[]): Pending }
  & ((strings: TemplateStringsArray, ...params: unknown[]) => Pending);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const duration = 3;

describe.skipIf(!enabled)("Bun native PostgreSQL cancellation qualification", () => {
  for (const scope of ["root", "transaction"] as const) {
    for (const form of ["unsafe-parameter", "tagged-literal", "tagged-parameter"] as const) {
      test(`${scope} / ${form}: server-acknowledged query rejects within 1.5 seconds`, async () => {
        const root = new SQL({ url, max: 1 });
        const observer = new SQL({ url, max: 1 });
        const probe = async (native: unknown) => {
          const client = native as Client;
          const identity = await client.unsafe("SELECT pg_backend_pid() AS pid") as { pid: number }[];
          const pid = identity[0]!.pid;
          const pending = form === "unsafe-parameter" ? client.unsafe("SELECT pg_sleep($1)", [duration])
            : form === "tagged-literal" ? client`SELECT pg_sleep(3)` : client`SELECT pg_sleep(${duration})`;
          const outcome = pending.then(() => "resolved" as const, () => "rejected" as const);
          const acknowledgementDeadline = performance.now() + 5_000;
          let query: string | undefined;
          while (performance.now() < acknowledgementDeadline) {
            const rows = await observer.unsafe("SELECT query FROM pg_stat_activity WHERE pid = $1 AND state = 'active'", [pid]);
            const emitted = rows[0]?.query;
            if (typeof emitted === "string" && /^SELECT pg_sleep\((?:3|\$1\s*)\)$/.test(emitted)) { query = emitted; break; }
            await delay(10);
          }
          let budgetTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            expect(query).toBeDefined();
            const started = performance.now();
            pending.cancel();
            const withinBudget = await Promise.race([outcome, new Promise<"pending">(resolve => { budgetTimer = setTimeout(() => resolve("pending"), 1_500); })]);
            clearTimeout(budgetTimer);
            const elapsedMs = Math.round(performance.now() - started);
            const stillActive = (await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query = $2", [pid, query!])).length !== 0;
            const final = await outcome; // bounded pg_sleep; retain settlement even for a failed oracle
            console.log(JSON.stringify({ qualification: "native-cancellation", scope, form, emittedQuery: query,
              withinBudget, elapsedMs, stillActive, final, cancelledFlag: pending.cancelled }));
            expect({ withinBudget, stillActive }).toEqual({ withinBudget: "rejected", stillActive: false });
          } finally { clearTimeout(budgetTimer); await outcome; }
        };
        try {
          if (scope === "transaction") await root.begin(tx => probe(tx));
          else await probe(root);
        } finally {
          // Pool health is an independent postcheck even when cancellation failed.
          try { expect((await root.unsafe("SELECT 1 AS alive"))[0]?.alive).toBe(1); }
          finally { await observer.close(); await root.close(); }
        }
      }, 15_000);
    }
  }
});
