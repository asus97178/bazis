import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { postgres } from "../index";

const url = process.env.OSNOVA_PG_URL;
let schema: string | undefined;
let unrelatedSchema: string | undefined;

afterEach(async () => {
  if (!url) return;
  const provider = postgres({ url });
  try {
    if (schema) await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []);
    if (unrelatedSchema) await provider.execute(`DROP SCHEMA IF EXISTS "${unrelatedSchema}" CASCADE`, []);
  } finally {
    await provider.close();
    schema = undefined;
    unrelatedSchema = undefined;
  }
});

describe.skipIf(!url)("PostgreSQL safe-additive race and restart admission (live)", () => {
  test("two independent processes serialize a data-bearing additive evolution", async () => {
    schema = freshSchema("osnova_race_additive");
    expect((await runWorker(schema, "base")).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`INSERT INTO "${schema}"."admission_rows" ("id") VALUES (1)`, []);
      const [first, second] = await Promise.all([runWorker(schema, "full"), runWorker(schema, "full")]);
      expect([first.exit, second.exit]).toEqual([0, 0]);
      const ddlCounts = [ddlCount(first.output), ddlCount(second.output)].sort((a, b) => a - b);
      expect(ddlCounts[0]).toBe(0);
      expect(ddlCounts[1]).toBeGreaterThan(0);
      expect(await provider.query(`SELECT "id", "state", "note" FROM "${schema}"."admission_rows"`, [])).toEqual([expect.objectContaining({ id: "1", state: "ready", note: null })]);
      const objects = await provider.query("SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'admission_rows' ORDER BY conname", [schema]);
      expect(objects.map((row) => row.conname)).toEqual(["ck_admission_rows_id", "pk_admission_rows"]);
      const indexes = await provider.query("SELECT ic.relname FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class ic ON ic.oid=i.indexrelid WHERE n.nspname=$1 AND t.relname='admission_rows' AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid) ORDER BY ic.relname", [schema]);
      expect(indexes.map((row) => row.relname)).toEqual(["ix_admission_rows_state_id"]);
    } finally { await provider.close(); }
  }, 30_000);

  test("a fresh restart verifies the evolved schema without generating schema DDL", async () => {
    schema = freshSchema("osnova_restart_additive");
    expect((await runWorker(schema, "base")).exit).toBe(0);
    expect((await runWorker(schema, "full")).exit).toBe(0);
    const restart = await runWorker(schema, "full");
    expect(restart.exit).toBe(0);
    expect(ddlCount(restart.output)).toBe(0);
  }, 30_000);

  test("unrelated objects are ignored while an unknown declared-table member is migration-required without repair", async () => {
    schema = freshSchema("osnova_unrelated_additive");
    unrelatedSchema = freshSchema("osnova_elsewhere");
    expect((await runWorker(schema, "base")).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`CREATE TABLE "${schema}"."unrelated_table" ("id" bigint NOT NULL)`, []);
      await provider.execute(`CREATE SCHEMA "${unrelatedSchema}"`, []);
      await provider.execute(`CREATE TABLE "${unrelatedSchema}"."outside" ("id" bigint NOT NULL)`, []);
      const matching = await runWorker(schema, "base");
      expect(matching.exit).toBe(0);
      expect(ddlCount(matching.output)).toBe(0);
      await provider.execute(`ALTER TABLE "${schema}"."admission_rows" ADD COLUMN "intruder" text`, []);
      const before = await provider.query("SELECT attname FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='admission_rows' AND a.attnum>0 AND NOT a.attisdropped ORDER BY attname", [schema]);
      const drift = await runWorker(schema, "base");
      expect(drift.exit).not.toBe(0);
      expect(drift.output).toContain("PostgreSQL schema change requires an explicit migration.");
      expect(drift.output).not.toContain(url!);
      const after = await provider.query("SELECT attname FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='admission_rows' AND a.attnum>0 AND NOT a.attisdropped ORDER BY attname", [schema]);
      expect(after).toEqual(before);
      expect((await provider.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='outside'", [unrelatedSchema])).length).toBe(1);
    } finally { await provider.close(); }
  }, 30_000);

  test("late reserved-session schema/table fault rolls back physically and a fresh process retries", async () => {
    schema = freshSchema("osnova_fault_retry");
    const fault = await runWorker(schema, "fault");
    expect(fault.exit).toBe(0);
    expect(ddlCount(fault.output)).toBeGreaterThanOrEqual(2);
    const provider = postgres({ url });
    try {
      expect(await provider.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).toHaveLength(0);
    } finally { await provider.close(); }
    const retry = await runWorker(schema, "retry");
    expect(retry.exit).toBe(0);
    expect(ddlCount(retry.output)).toBeGreaterThan(0);
    const restarted = await runWorker(schema, "retry");
    expect(restarted.exit).toBe(0);
    expect(ddlCount(restarted.output)).toBe(0);
  }, 30_000);
});

function freshSchema(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63); }

async function runWorker(physicalSchema: string, mode: "base" | "full" | "fault" | "retry"): Promise<{ readonly exit: number; readonly output: string }> {
  const worker = fileURLToPath(new URL("./orm.ensure-created.postgres.race-restart.live.worker.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "run", worker], { env: { ...process.env, OSNOVA_ORM_ADDITIVE_LIVE_SCHEMA: physicalSchema, OSNOVA_ORM_ADDITIVE_LIVE_MODE: mode }, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: `${stdout}\n${stderr}`.replaceAll(url ?? "", "[redacted]") };
}

function ddlCount(output: string): number {
  const matched = /schema-ddl=(\d+)/u.exec(output);
  if (!matched) throw new Error(`live worker did not report a schema DDL marker: ${safeOutput(output)}`);
  return Number(matched[1]);
}
function safeOutput(value: string): string { return value.replaceAll(/postgres:\/\/[^\s]+/gu, "[redacted]").slice(0, 1000); }
