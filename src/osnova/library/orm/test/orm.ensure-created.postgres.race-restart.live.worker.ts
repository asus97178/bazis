import { Check, Column, DbContext, DbContextOptions, Entity, Index, Key, Required, Schema, postgres } from "../index";

const schema = process.env.OSNOVA_ORM_ADDITIVE_LIVE_SCHEMA;
const url = process.env.OSNOVA_PG_URL;
const mode = process.env.OSNOVA_ORM_ADDITIVE_LIVE_MODE;

if (!schema || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || !url || !["base", "full", "fault", "retry"].includes(mode ?? "")) process.exit(2);

@Schema(schema)
@Entity({ table: "admission_rows" })
class BaseRow {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
}

@Schema(schema)
@Entity({ table: "admission_rows" })
@Index(["state", "id"], { name: "ix_admission_rows_state_id" })
@Check<FullRow>("ck_admission_rows_id", (fields) => fields.id.gte(0))
class FullRow {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
  @Required() @Column({ type: "text", default: "ready" }) state = "";
  @Column({ type: "text" }) note = "";
}

class LiveContext extends DbContext {}

let schemaDdl = 0;
const provider = postgres({
  url,
  onSql: (sql) => {
    if (sql.startsWith("osnova.schema-admission:") || /^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+(?:SCHEMA|TABLE)|ALTER\s+TABLE)\b/iu.test(sql)) schemaDdl++;
  },
});

try {
  if (mode === "fault") {
    await provider.schemaAdmissionCapability!.withSchemaAdmission([schema], async (scope) => {
      await scope.execute(`CREATE SCHEMA "${schema}"`, []);
      await scope.execute(`CREATE TABLE "${schema}"."admission_rows" ("id" bigint NOT NULL)`, []);
      throw new Error("race-restart-late-fault");
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== "race-restart-late-fault") throw error;
    });
  } else {
    const entities = mode === "base" ? [BaseRow] : [FullRow];
    const context = new LiveContext(new DbContextOptions({ provider, entities }));
    await context.database.ensureCreated();
  }
  console.log(`schema-ddl=${schemaDdl}`);
} finally {
  await provider.close();
}
