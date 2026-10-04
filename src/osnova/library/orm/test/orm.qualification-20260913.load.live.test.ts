import { describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, PostgresProvider, Schema } from "../index";

const url = process.env.OSNV_PG_URL;
const enabled = !!url && process.env.OSNV_ORM_QUALIFICATION_LIVE === "1";
class Context extends DbContext {}
class PlannedRollback extends Error {}

async function fixture(max: number) {
  if (!enabled) throw new Error("Load qualification needs an explicitly enabled disposable database.");
  const schema = `orm_load_${crypto.randomUUID().replaceAll("-", "")}`;
  const provider = new PostgresProvider({ options: { url, max } });
  @Schema(schema) @Entity({ table: "counter" })
  class Counter {
    @Key({ generated: false }) @Column({ type: "integer" }) id = 1;
    @Column({ type: "integer" }) value = 0;
  }
  @Schema(schema) @Entity({ table: "ledger" })
  class Ledger {
    @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
    @Column({ type: "text" }) payload = "";
  }
  const entities = [Counter, Ledger];
  const context = (p = provider) => new Context(new DbContextOptions({ provider: p, entities }));
  const quoted = provider.dialect.quoteId(schema);
  const close = async () => {
    try { await provider.execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`, []); }
    finally { await provider.close(); }
  };
  try { await context().database.ensureCreated(); }
  catch (error) { await close(); throw error; }
  return { provider, Counter, Ledger, context, close, schema };
}

describe.skipIf(!enabled)("ORM bounded PostgreSQL load qualification", () => {
  for (const profile of [{ max: 1, workers: 8, iterations: 20 }, { max: 4, workers: 16, iterations: 40 }]) {
    test(`shared pool ${profile.max}: ${profile.workers} concurrent contexts preserve locked updates and rollback`, async () => {
      const f = await fixture(profile.max);
      try {
        const seed = f.context(); seed.add(new f.Counter()); await seed.saveChanges();
        let committedCallbacks = 0;
        const latencies: number[] = [];
        const expectedIds: number[] = [];
        for (let worker = 0; worker < profile.workers; worker++) {
          for (let iteration = 0; iteration < profile.iterations; iteration++) {
            if (iteration % 7 !== 0) expectedIds.push(worker * profile.iterations + iteration + 1);
          }
        }
        const started = performance.now();
        const workers = await Promise.allSettled(Array.from({ length: profile.workers }, async (_, worker) => {
          for (let iteration = 0; iteration < profile.iterations; iteration++) {
            const db = f.context();
            const rollback = iteration % 7 === 0;
            const start = performance.now();
            try {
              await db.transactionScope(async tx => {
                const counter = await db.setOf(f.Counter).findForUpdate(1);
                if (!counter) throw new Error("Counter disappeared");
                counter.value++;
                db.add(Object.assign(new f.Ledger(), { id: worker * profile.iterations + iteration + 1, payload: `${worker}:${iteration}` }));
                await db.saveChanges();
                tx.afterCommit(() => { committedCallbacks++; });
                if (rollback) throw new PlannedRollback();
              });
              if (rollback) throw new Error("Planned rollback unexpectedly committed");
            } catch (error) {
              if (!rollback || !(error instanceof PlannedRollback)) throw error;
            } finally { latencies.push(performance.now() - start); }
          }
        }));
        const elapsed = performance.now() - started;
        expect(workers.filter(result => result.status === "rejected")).toEqual([]);
        const fresh = new PostgresProvider({ url });
        try {
          const db = f.context(fresh);
          expect((await db.setOf(f.Counter).asNoTracking().first()).value).toBe(expectedIds.length);
          expect((await db.setOf(f.Ledger).asNoTracking().orderBy(x => x.id).toList()).map(row => row.id)).toEqual(expectedIds);
        } finally { await fresh.close(); }
        expect(committedCallbacks).toBe(expectedIds.length);
        expect(await f.provider.query("SELECT 1 AS alive", [])).toEqual([{ alive: 1 }]);
        latencies.sort((a, b) => a - b);
        console.log(JSON.stringify({ qualification: "contended-transactions", ...profile,
          attempted: latencies.length, committed: expectedIds.length, rolledBack: latencies.length - expectedIds.length,
          elapsedMs: Math.round(elapsed), transactionsPerSecond: Math.round(latencies.length * 1000 / elapsed),
          p50Ms: Math.round(latencies[Math.floor(latencies.length * .5)]!),
          p95Ms: Math.round(latencies[Math.floor(latencies.length * .95)]!), maxMs: Math.round(latencies.at(-1)!) }));
      } finally { await f.close(); }
    }, 60_000);
  }

  test("12,000-row batch crosses native row limits and survives fresh readback without duplicates", async () => {
    const f = await fixture(4);
    try {
      const db = f.context();
      const count = 12_000;
      const rows = Array.from({ length: count }, (_, index) => Object.assign(new f.Ledger(), { id: index + 1, payload: `row-${index + 1}` }));
      db.setOf(f.Ledger).addRange(rows);
      const started = performance.now();
      expect(await db.saveChanges()).toBe(count);
      const elapsed = performance.now() - started;
      const fresh = new PostgresProvider({ url });
      try {
        const loaded = await f.context(fresh).setOf(f.Ledger).asNoTracking().orderBy(x => x.id).toList();
        expect(loaded.map(row => [row.id, row.payload])).toEqual(rows.map(row => [row.id, row.payload]));
      } finally { await fresh.close(); }
      expect(await db.saveChanges()).toBe(0);
      console.log(JSON.stringify({ qualification: "batch", rows: count, elapsedMs: Math.round(elapsed), rowsPerSecond: Math.round(count * 1000 / elapsed) }));
    } finally { await f.close(); }
  }, 60_000);
});
