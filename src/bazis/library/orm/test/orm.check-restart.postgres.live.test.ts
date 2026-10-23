import { afterEach, describe, expect, test } from "bun:test";
import { Check, Column, DbContext, DbContextOptions, Entity, Key, postgres, Schema } from "../index";

// 0.115.0: PostgreSQL stores `in([...])` as `= ANY (ARRAY[...])` and prints an
// AND chain without inner parentheses. The second start read both back as a
// different CHECK and refused to start.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

describe.skipIf(!url)("PostgreSQL CHECK constraints survive a restart (live)", () => {
  test("in([...]) and a chain of three conditions are read back as declared", async () => {
    schema = `bazis_checks_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "tasks" })
    @Check<Task>("ck_tasks_status", (t) => t.status.in(["open", "done"]))
    @Check<Task>("ck_tasks_range", (t) => t.priority.gte(0).and(t.priority.lte(9)).and(t.status.ne("x")))
    class Task {
      @Key() id = 0;
      @Column({ type: "text" }) status = "open";
      @Column({ type: "integer" }) priority = 0;
    }
    class TasksDb extends DbContext { readonly tasks = this.set(Task); }
    const provider = postgres({ url: url! });
    try {
      await new TasksDb(new DbContextOptions({ provider, entities: [Task] })).database.ensureCreated();
      await expect(new TasksDb(new DbContextOptions({ provider, entities: [Task] })).database.ensureCreated()).resolves.toBeDefined();
    } finally { await provider.close(); }
  }, 30_000);
});
