import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildDynamicModel, DbContext, DbContextOptions, postgres } from "../index";

const url = process.env.OSNV_PG_URL;
let schema: string | undefined;

class DynamicAdmissionContext extends DbContext {}

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

describe.skipIf(!url)("PostgreSQL ensure-created admission (live)", () => {
  test("two fresh Bun processes serialize composite-schema creation and replay verification", async () => {
    schema = `osnova_admission_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    const [first, second] = await Promise.all([runWorker(schema), runWorker(schema)]);
    if (first.exit !== 0 || second.exit !== 0) throw new Error(`schema admission worker failed: ${safeOutput(first.output)} ${safeOutput(second.output)}`);
    const provider = postgres({ url });
    try {
      const constraints = await provider.query(`SELECT conname, contype FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 ORDER BY conname`, [schema]);
      expect(constraints.map((row) => `${row.conname}:${row.contype}`)).toEqual(["ck_children_value:c", "fk_children_parent:f", "pk_children:p", "pk_generated:p", "pk_parents:p", "pk_plain_keys:p", "pk_uuid_keys:p"]);
      const indexes = await provider.query(`SELECT ic.relname AS name, i.indisunique AS unique, am.amname AS method, array_agg(a.attname ORDER BY k.ord) AS columns FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid=ic.relam JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) ON true JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) GROUP BY ic.relname,i.indisunique,am.amname ORDER BY ic.relname`, [schema]);
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "ix_parents_label", unique: false, method: "btree", columns: ["label"] }),
        expect.objectContaining({ name: "ix_parents_tenant_id", unique: false, method: "btree", columns: ["tenant", "id"] }),
        expect.objectContaining({ name: "ux_parents_id_tenant", unique: true, method: "btree", columns: ["id", "tenant"] }),
        expect.objectContaining({ name: "ux_children_code", unique: true, method: "btree", columns: ["code"] }),
      ]));
      const columns = await provider.query(`SELECT c.relname AS table_name, a.attname AS column_name, a.attidentity AS identity_kind, pg_get_expr(d.adbin, d.adrelid) AS default_expr FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`, [schema]);
      expect(columns.find((row) => row.table_name === "generated" && row.column_name === "id")?.identity_kind).toBe("d");
      expect(columns.find((row) => row.table_name === "plain_keys" && row.column_name === "id")?.identity_kind).toBe("");
      expect(String(columns.find((row) => row.table_name === "uuid_keys" && row.column_name === "id")?.default_expr)).toContain("gen_random_uuid");
      await provider.execute(`ALTER TABLE "${schema}"."uuid_keys" ALTER COLUMN "id" DROP DEFAULT`, []);
      const drift = await runWorker(schema);
      expect(drift.exit).not.toBe(0);
      expect(drift.output).toContain("PostgreSQL schema change requires an explicit migration.");
      expect(drift.output).not.toContain("postgres://");
    } finally { await provider.close(); }
  }, 30_000);

  test("reserved-session schema admission rolls back DDL after a late fault", async () => {
    schema = `osnova_rollback_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    const provider = postgres({ url });
    try {
      const capability = provider.schemaAdmissionCapability!;
      await expect(capability.withSchemaAdmission([schema], async (scope) => {
        await scope.execute(`CREATE SCHEMA "${schema}"`, []);
        await scope.execute(`CREATE TABLE "${schema}"."partial" ("id" bigint NOT NULL)`, []);
        throw new Error("admission-rollback-sentinel");
      })).rejects.toThrow("admission-rollback-sentinel");
      const present = await provider.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
      expect(present).toHaveLength(0);
    } finally { await provider.close(); }
  });

  test("ambient transaction keeps schema admission DDL on its rollback owner", async () => {
    schema = freshSchema("osnova_ambient_rollback");
    const provider = postgres({ url });
    try {
      const dynamic = buildDynamicModel({ name: `AmbientRollback${schema}`, tableName: "created_inside_outer_tx", fields: [{ name: "id", type: "int", isKey: true }, { name: "value", type: "string", required: true }] });
      const model = { ...dynamic, schema, tableName: "created_inside_outer_tx" };
      const options = new DbContextOptions({ provider, entities: [], validateOnSave: false }); options.model.registerModel(model);
      const context = new DynamicAdmissionContext(options);
      await expect(provider.transaction(async () => {
        await context.database.ensureCreated();
        context.setByName(model.name).add(Object.assign(new model.ctor(), { value: "rolled-back" }));
        await context.saveChanges();
        throw new Error("ambient-admission-rollback-sentinel");
      })).rejects.toThrow("ambient-admission-rollback-sentinel");
      const fresh = postgres({ url });
      try {
        expect(await fresh.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).toHaveLength(0);
        const retryOptions = new DbContextOptions({ provider: fresh, entities: [], validateOnSave: false }); retryOptions.model.registerModel(model);
        await new DynamicAdmissionContext(retryOptions).database.ensureCreated();
      }
      finally { await fresh.close(); }
    } finally { await provider.close(); }
  });

  test("exact admission rejects NOT VALID foreign keys", async () => {
    schema = freshSchema("osnova_exact_not_valid");
    expect((await runWorker(schema)).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`ALTER TABLE ${qualified("children")} DROP CONSTRAINT "fk_children_parent"`, []);
      await provider.execute(`ALTER TABLE ${qualified("children")} ADD CONSTRAINT "fk_children_parent" FOREIGN KEY ("tenant", "parentId") REFERENCES ${qualified("parents")} ("tenant", "id") NOT VALID`, []);
      const drift = await runWorker(schema);
      expect(drift.exit).not.toBe(0); expect(drift.output).toContain("orm-schema-code=ORM_SCHEMA_CATALOG_UNSUPPORTED");
    } finally { await provider.close(); }
  });

  test("exact admission rejects unique indexes with INCLUDE columns", async () => {
    schema = freshSchema("osnova_exact_include");
    expect((await runWorker(schema)).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`DROP INDEX ${qualified("ux_parents_id_tenant")}`, []);
      await provider.execute(`CREATE UNIQUE INDEX "ux_parents_id_tenant" ON ${qualified("parents")} ("id") INCLUDE ("tenant")`, []);
      const drift = await runWorker(schema);
      expect(drift.exit).not.toBe(0); expect(drift.output).toContain("orm-schema-code=ORM_SCHEMA_CATALOG_UNSUPPORTED");
    } finally { await provider.close(); }
  });

  test("exact admission rejects narrowed physical integer columns", async () => {
    schema = freshSchema("osnova_exact_smallint");
    expect((await runWorker(schema)).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`ALTER TABLE ${qualified("plain_keys")} ALTER COLUMN "id" TYPE smallint`, []);
      const drift = await runWorker(schema);
      expect(drift.exit).not.toBe(0); expect(drift.output).toContain("orm-schema-code=ORM_SCHEMA_MIGRATION_REQUIRED");
    } finally { await provider.close(); }
  });
  test("creates and exactly replays an aliased CHECK using physical column identifiers", async () => {
    schema = freshSchema("osnova_aliased_check");
    expect((await runWorker(schema, "aliased-check")).exit).toBe(0);
    expect((await runWorker(schema, "aliased-check")).exit).toBe(0);
    const provider = postgres({ url });
    try {
      const definition = String((await provider.query("SELECT pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='aliased_check_vectors' AND c.conname='ck_aliased_check_vectors_values'", [schema]))[0]?.definition);
      expect(definition).toContain("tenant_key");
      expect(definition).toContain("left_value");
      expect(definition).toContain("right_value");
      expect(definition).not.toContain("tenantKey");
      expect(definition).not.toContain("leftValue");
      expect(definition).not.toContain("rightValue");
      await provider.execute(`INSERT INTO "${schema}"."aliased_check_vectors" ("row_id", "tenant_key", "left_value", "right_value") VALUES (1, 'default', 7, 7)`, []);
      await expect(provider.execute(`INSERT INTO "${schema}"."aliased_check_vectors" ("row_id", "tenant_key", "left_value", "right_value") VALUES (2, 'wrong', 7, 7)`, [])).rejects.toBeDefined();
    } finally { await provider.close(); }
  }, 30_000);
  test("fresh full model creates one missing whole table without altering a compatible base table", async () => {
    schema = `osnova_evolution_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    expect((await runWorker(schema, "base")).exit).toBe(0);
    const provider = postgres({ url });
    try {
      const before = await provider.query("SELECT relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='parents'", [schema]);
      expect((await runWorker(schema, "full")).exit).toBe(0);
      const after = await provider.query("SELECT relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='parents'", [schema]);
      expect(after).toEqual(before);
      expect((await provider.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='children'", [schema])).length).toBe(1);
      expect((await runWorker(schema, "full")).exit).toBe(0);
    } finally { await provider.close(); }
  });
  test("evolves a data-bearing table with a literal-default column, CHECK and composite unique index", async () => {
    schema = `osnova_additive_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    expect((await runWorker(schema, "additive-base")).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`INSERT INTO "${schema}"."additive_vectors" ("id") VALUES (1)`, []);
      expect((await runWorker(schema, "additive-full")).exit).toBe(0);
      expect(await provider.query(`SELECT "id", "state", "at" FROM "${schema}"."additive_vectors"`, [])).toEqual([expect.objectContaining({ state: "new", at: expect.any(Date) })]);
      const constraints = await provider.query(`SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='additive_vectors' ORDER BY conname`, [schema]);
      expect(constraints.map((row) => row.conname)).toEqual(["ck_additive_vectors_id", "pk_additive_vectors"]);
      await expect(provider.execute(`INSERT INTO "${schema}"."additive_vectors" ("id", "state") VALUES (-1, 'bad')`, [])).rejects.toBeDefined();
      expect((await runWorker(schema, "additive-full")).exit).toBe(0);
    } finally { await provider.close(); }
  }, 30_000);
  test("evolves one data-bearing unit with nullable/default columns, composite indexes, CHECK and composite FK", async () => {
    schema = `osnova_evolution_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    expect((await runWorker(schema, "evolution-base")).exit).toBe(0);
    const provider = postgres({ url });
    try {
      await provider.execute(`INSERT INTO "${schema}"."evolution_children" ("id") VALUES (1)`, []);
      await provider.execute(`INSERT INTO "${schema}"."evolution_parents" ("tenant", "id") VALUES ('t', 'p')`, []);
      const evolution = await runWorker(schema, "evolution-full");
      if (evolution.exit !== 0) throw new Error(safeOutput(evolution.output));
      expect(await provider.query(`SELECT "note", "state", "tenant", "parentId" FROM "${schema}"."evolution_children"`, [])).toEqual([expect.objectContaining({ note: null, state: "new", tenant: "t", parentId: "p" })]);
      const constraints = await provider.query(`SELECT conname, contype FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='evolution_children' ORDER BY conname`, [schema]);
      expect(constraints.map((row) => `${row.conname}:${row.contype}`)).toEqual(["ck_evolution_children_id:c", "fk_evolution_children_parent:f", "pk_evolution_children:p"]);
      const indexes = await provider.query(`SELECT ic.relname FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class ic ON ic.oid=i.indexrelid WHERE n.nspname=$1 AND t.relname='evolution_children' AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid) ORDER BY ic.relname`, [schema]);
      expect(indexes.map((row) => row.relname)).toEqual(["ix_evolution_children_state_id", "ux_evolution_children_id_state"]);
      expect((await runWorker(schema, "evolution-full")).exit).toBe(0);
    } finally { await provider.close(); }
  }, 30_000);

  test("rolls back duplicate unique, invalid CHECK and orphan composite FK additions without changing data or catalog", async () => {
    schema = freshSchema("osnova_additive_reject");
    const provider = postgres({ url });
    try {
      for (const scenario of [
        { base: "unique-base", full: "unique-full", table: "unique_vectors", seed: `INSERT INTO ${qualified("unique_vectors")} ("id", "code") VALUES (1, 'duplicate'), (2, 'duplicate')` },
        { base: "check-base", full: "check-full", table: "check_vectors", seed: `INSERT INTO ${qualified("check_vectors")} ("id", "value") VALUES (1, -1)` },
        { base: "fk-base", full: "fk-full", table: "fk_children", seed: `INSERT INTO ${qualified("fk_children")} ("id", "tenant", "parentId") VALUES (1, 'tenant', 'orphan')` },
      ]) {
        expect((await runWorker(schema, scenario.base)).exit).toBe(0);
        await provider.execute(scenario.seed, []);
        const before = await tableSnapshot(provider, scenario.table);
        const rejected = await runWorker(schema, scenario.full);
        expect(rejected.exit).not.toBe(0);
        expect(rejected.output).toContain("orm-schema-code=ORM_SCHEMA_ADDITIVE_DATA_VIOLATION");
        expect(await tableSnapshot(provider, scenario.table)).toEqual(before);
      }
    } finally { await provider.close(); }
  }, 45_000);

  test("rejects existing-table identity, UUID and NOT NULL-without-default changes before any DDL", async () => {
    schema = freshSchema("osnova_additive_hard_add");
    const provider = postgres({ url });
    try {
      await provider.execute(`CREATE SCHEMA "${schema}"`, []);
      await provider.execute(`CREATE TABLE ${qualified("identity_add_vectors")} ("legacy" text NOT NULL, CONSTRAINT "pk_identity_add_vectors_legacy" PRIMARY KEY ("legacy"))`, []);
      await provider.execute(`CREATE TABLE ${qualified("uuid_add_vectors")} ("legacy" text NOT NULL, CONSTRAINT "pk_uuid_add_vectors_legacy" PRIMARY KEY ("legacy"))`, []);
      expect((await runWorker(schema, "not-null-base")).exit).toBe(0);
      await provider.execute(`INSERT INTO ${qualified("identity_add_vectors")} ("legacy") VALUES ('identity-row')`, []);
      await provider.execute(`INSERT INTO ${qualified("uuid_add_vectors")} ("legacy") VALUES ('uuid-row')`, []);
      await provider.execute(`INSERT INTO ${qualified("not_null_vectors")} ("id") VALUES (7)`, []);
      for (const scenario of [
        { mode: "identity-add", table: "identity_add_vectors" }, { mode: "uuid-add", table: "uuid_add_vectors" }, { mode: "not-null-full", table: "not_null_vectors" },
      ]) {
        const before = await tableSnapshot(provider, scenario.table);
        const rejected = await runWorker(schema, scenario.mode);
        expect(rejected.exit).not.toBe(0);
        expect(rejected.output).toContain("orm-schema-code=ORM_SCHEMA_MIGRATION_REQUIRED");
        if (scenario.mode !== "not-null-full") expect(rejected.output).toContain("column.missing");
        expect(await tableSnapshot(provider, scenario.table)).toEqual(before);
      }
    } finally { await provider.close(); }
  }, 45_000);

  test("hard drift never repairs a missing safe member: rename, type/default/null/generation and PK matrix", async () => {
    schema = freshSchema("osnova_additive_hard_matrix");
    const provider = postgres({ url });
    try {
      await provider.execute(`CREATE SCHEMA "${schema}"`, []);
      const tables: Array<{ readonly mode: string; readonly table: string; readonly ddl: string }> = [
        { mode: "hard-rename", table: "hard_rename_vectors", ddl: `CREATE TABLE ${qualified("hard_rename_vectors")} ("id" bigint NOT NULL, "legacy" text, CONSTRAINT "pk_hard_rename_vectors" PRIMARY KEY ("id"))` },
        { mode: "hard-type", table: "hard_type_vectors", ddl: `CREATE TABLE ${qualified("hard_type_vectors")} ("id" text NOT NULL, CONSTRAINT "pk_hard_type_vectors" PRIMARY KEY ("id"))` },
        { mode: "hard-default", table: "hard_default_vectors", ddl: `CREATE TABLE ${qualified("hard_default_vectors")} ("id" bigint NOT NULL, "code" text, CONSTRAINT "pk_hard_default_vectors" PRIMARY KEY ("id"))` },
        { mode: "hard-null", table: "hard_null_vectors", ddl: `CREATE TABLE ${qualified("hard_null_vectors")} ("id" bigint NOT NULL, "code" text DEFAULT 'safe', CONSTRAINT "pk_hard_null_vectors" PRIMARY KEY ("id"))` },
        { mode: "hard-generation", table: "hard_generation_vectors", ddl: `CREATE TABLE ${qualified("hard_generation_vectors")} ("id" bigint NOT NULL, CONSTRAINT "pk_hard_generation_vectors" PRIMARY KEY ("id"))` },
        { mode: "hard-pk-name", table: "hard_pk_name_vectors", ddl: `CREATE TABLE ${qualified("hard_pk_name_vectors")} ("id" bigint NOT NULL, CONSTRAINT "pk_hard_pk_name_actual" PRIMARY KEY ("id"))` },
        { mode: "hard-pk-order", table: "hard_pk_order_vectors", ddl: `CREATE TABLE ${qualified("hard_pk_order_vectors")} ("tenant" text NOT NULL, "id" text NOT NULL, CONSTRAINT "pk_hard_pk_order_expected" PRIMARY KEY ("id", "tenant"))` },
        { mode: "hard-pk-components", table: "hard_pk_components_vectors", ddl: `CREATE TABLE ${qualified("hard_pk_components_vectors")} ("tenant" text NOT NULL, "id" text NOT NULL, CONSTRAINT "pk_hard_pk_components_expected" PRIMARY KEY ("id"))` },
      ];
      for (const scenario of tables) {
        await provider.execute(scenario.ddl, []);
        const before = await tableSnapshot(provider, scenario.table);
        const rejected = await runWorker(schema, scenario.mode);
        expect(rejected.exit).not.toBe(0);
        expect(rejected.output).toContain("orm-schema-code=ORM_SCHEMA_MIGRATION_REQUIRED");
        expect(await tableSnapshot(provider, scenario.table)).toEqual(before);
        expect((await provider.query("SELECT 1 FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND a.attname='note' AND NOT a.attisdropped", [schema, scenario.table]))).toEqual([]);
      }
    } finally { await provider.close(); }
  }, 60_000);

  test("rolls back real staged DDL when final PostgreSQL catalog verification is incompatible", async () => {
    schema = freshSchema("osnova_additive_final_drift");
    const result = await runWorker(schema, "final-drift");
    expect(result.exit).toBe(0);
    const provider = postgres({ url });
    try {
      expect(await provider.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).toEqual([]);
    } finally { await provider.close(); }
  }, 30_000);

  test("exposes only stable schema-admission operation markers to ordinary SQL tracing", async () => {
    schema = freshSchema("osnova_additive_trace");
    expect((await runWorker(schema, "additive-base")).exit).toBe(0);
    const traced = await runWorker(schema, "trace-additive");
    expect(traced.exit).toBe(0);
    const match = /admission-trace=(\[[^\n]*\])/u.exec(traced.output);
    expect(match).not.toBeNull();
    const trace = JSON.parse(match![1]!) as Array<{ sql: string; params: number }>;
    expect(trace).toEqual(expect.arrayContaining([
      { sql: "osnova.schema-admission:addColumn", params: 0 },
      { sql: "osnova.schema-admission:addCheck", params: 0 },
      { sql: "osnova.schema-admission:createIndex", params: 0 },
    ]));
    expect(trace.every((entry) => entry.sql.startsWith("osnova.schema-admission:"))).toBeTrue();
    expect(traced.output).not.toContain("DEFAULT 'new'");
    expect(traced.output).not.toContain("ck_additive_vectors_id");
  }, 30_000);
});

async function runWorker(physicalSchema: string, mode = "full"): Promise<{ readonly exit: number; readonly output: string }> {
  const worker = fileURLToPath(new URL("./orm.ensure-created.postgres.live.worker.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "run", worker], { env: { ...process.env, OSNV_ORM_LIVE_SCHEMA: physicalSchema, OSNV_ORM_LIVE_MODE: mode }, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: `${stdout}\n${stderr}`.replaceAll(url ?? "", "[redacted]") };
}

function safeOutput(value: string): string { return value.replaceAll(/postgres:\/\/[^\s]+/gu, "[redacted]").slice(0, 2000); }
function freshSchema(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63); }
function qualified(table: string): string { return `"${schema}"."${table}"`; }
async function tableSnapshot(provider: ReturnType<typeof postgres>, table: string): Promise<{ readonly columns: readonly unknown[]; readonly constraints: readonly unknown[]; readonly indexes: readonly unknown[]; readonly rows: readonly unknown[] }> {
  const columns = await provider.query("SELECT a.attname, a.attnotnull, format_type(a.atttypid,a.atttypmod) AS type_name, a.attidentity, pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=$1 AND t.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [schema!, table]);
  const constraints = await provider.query("SELECT conname, contype, pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 ORDER BY conname", [schema!, table]);
  const indexes = await provider.query("SELECT ic.relname, i.indisunique, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class ic ON ic.oid=i.indexrelid WHERE n.nspname=$1 AND t.relname=$2 ORDER BY ic.relname", [schema!, table]);
  const rows = await provider.query(`SELECT to_jsonb(t)::text AS row FROM "${schema}"."${table}" t ORDER BY ctid`, []);
  return { columns, constraints, indexes, rows };
}
