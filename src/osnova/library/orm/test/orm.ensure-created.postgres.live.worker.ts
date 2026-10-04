import { Check, Column, DbContext, DbContextOptions, Entity, ForeignKey, Index, Key, Required, Schema, UUID, postgres } from "../index";

const schema = process.env.OSNOVA_ORM_LIVE_SCHEMA;
const url = process.env.OSNOVA_PG_URL;
const mode = process.env.OSNOVA_ORM_LIVE_MODE ?? "full";
if (!schema || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || !url) process.exit(2);

@Schema(schema)
@Entity({ table: "parents" })
@Index(["tenant", "id"], { name: "ix_parents_tenant_id" })
@Index(["id", "tenant"], { name: "ux_parents_id_tenant", unique: true })
class Parent {
  @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = "";
  @Column({ type: "text" }) id = "";
  @Index({ name: "ix_parents_label" }) @Column({ type: "text" }) label = "";
}
@Schema(schema)
@Entity({ table: "children" })
@ForeignKey(() => Parent, { name: "fk_children_parent", properties: ["tenant", "parentId"], onDelete: "noAction", onUpdate: "noAction" })
@Check<Child>("ck_children_value", (fields) => fields.value.gte(0))
class Child {
  @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = "";
  @Column({ type: "text" }) id = "";
  @Required() @Column({ type: "text" }) parentId = "";
  @Index({ unique: true, name: "ux_children_code" }) @Column({ type: "text" }) code = "";
  @Column({ type: "integer" }) value = 0;
}
@Schema(schema)
@Entity({ table: "generated" })
class Generated { @Key() @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) value = ""; }
@Schema(schema)
@Entity({ table: "plain_keys" })
class PlainKey { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; }
@Schema(schema)
@Entity({ table: "uuid_keys" })
class UuidKey { @UUID() id = ""; }
@Schema(schema)
@Entity({ table: "additive_vectors" })
class AdditiveBase { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; }
@Schema(schema)
@Entity({ table: "additive_vectors" })
@Index(["state", "id"], { name: "ux_additive_vectors_state_id", unique: true })
@Check<AdditiveFull>("ck_additive_vectors_id", (fields) => fields.id.gte(0))
class AdditiveFull { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text", default: "new" }) state = ""; @Column({ type: "datetime", default: "2026-08-06T00:00:00Z" }) at = new Date(); }
@Schema(schema)
@Entity({ table: "evolution_parents" })
class EvolutionParent { @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = ""; @Column({ type: "text" }) id = ""; }
@Schema(schema)
@Entity({ table: "evolution_children" })
class EvolutionBase { @Key() @Column({ type: "integer" }) id = 0; }
@Schema(schema)
@Entity({ table: "evolution_children" })
@ForeignKey(() => EvolutionParent, { name: "fk_evolution_children_parent", properties: ["tenant", "parentId"] })
@Index(["state", "id"], { name: "ix_evolution_children_state_id" })
@Index(["id", "state"], { name: "ux_evolution_children_id_state", unique: true })
@Check<EvolutionFull>("ck_evolution_children_id", (fields) => fields.id.gte(0))
class EvolutionFull { @Key() @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) note = ""; @Required() @Column({ type: "text", default: "new" }) state = ""; @Required() @Column({ type: "text", default: "t" }) tenant = ""; @Required() @Column({ type: "text", default: "p" }) parentId = ""; }
@Schema(schema)
@Entity({ table: "unique_vectors" })
class UniqueBase { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) code = ""; }
@Schema(schema)
@Entity({ table: "unique_vectors" })
class UniqueFull { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Index({ name: "ux_unique_vectors_code", unique: true }) @Column({ type: "text" }) code = ""; }
@Schema(schema)
@Entity({ table: "check_vectors" })
class CheckBase { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "integer" }) value = 0; }
@Schema(schema)
@Entity({ table: "check_vectors" })
@Check<CheckFull>("ck_check_vectors_value", (fields) => fields.value.gte(0))
class CheckFull { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "integer" }) value = 0; }
@Schema(schema)
@Entity({ table: "fk_parents" })
class FkParent { @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = ""; @Column({ type: "text" }) id = ""; }
@Schema(schema)
@Entity({ table: "fk_children" })
class FkBase { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text" }) tenant = ""; @Required() @Column({ type: "text" }) parentId = ""; }
@Schema(schema)
@Entity({ table: "fk_children" })
@ForeignKey(() => FkParent, { name: "fk_fk_children_parent", properties: ["tenant", "parentId"] })
class FkFull { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text" }) tenant = ""; @Required() @Column({ type: "text" }) parentId = ""; }
@Schema(schema)
@Entity({ table: "not_null_vectors" })
class NotNullBase { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; }
@Schema(schema)
@Entity({ table: "not_null_vectors" })
class NotNullFull { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text" }) requiredValue = ""; }
@Schema(schema)
@Entity({ table: "identity_add_vectors" })
class IdentityAdd { @Required() @Column({ type: "text" }) legacy = ""; @Key() @Column({ type: "integer" }) id = 0; }
@Schema(schema)
@Entity({ table: "uuid_add_vectors" })
class UuidAdd { @Required() @Column({ type: "text" }) legacy = ""; @UUID() id = ""; }
@Schema(schema)
@Entity({ table: "hard_rename_vectors" })
class HardRename { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) title = ""; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_type_vectors" })
class HardType { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_default_vectors" })
class HardDefault { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text", default: "safe" }) code = ""; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_null_vectors" })
class HardNull { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text", default: "safe" }) code = ""; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_generation_vectors" })
class HardGeneration { @Key() @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_pk_name_vectors" })
class HardPkName { @Key({ generated: false, name: "pk_hard_pk_name_expected" }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_pk_order_vectors" })
class HardPkOrder { @Key(["tenant", "id"], { name: "pk_hard_pk_order_expected" }) @Column({ type: "text" }) tenant = ""; @Column({ type: "text" }) id = ""; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "hard_pk_components_vectors" })
class HardPkComponents { @Key(["tenant", "id"], { name: "pk_hard_pk_components_expected" }) @Column({ type: "text" }) tenant = ""; @Column({ type: "text" }) id = ""; @Column({ type: "text" }) note = ""; }
@Schema(schema)
@Entity({ table: "final_drift_vectors" })
class FinalDrift { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text", default: "sealed" }) state = ""; }
@Schema(schema)
@Entity({ table: "aliased_check_vectors" })
@Check<AliasedCheckVector>("ck_aliased_check_vectors_values", (fields) => fields.tenantKey.eq("default").and(fields.leftValue.eq(fields.rightValue)))
class AliasedCheckVector { @Key({ generated: false }) @Column({ name: "row_id", type: "integer" }) id = 0; @Column({ name: "tenant_key", type: "text" }) tenantKey = ""; @Column({ name: "left_value", type: "integer" }) leftValue = 0; @Column({ name: "right_value", type: "integer" }) rightValue = 0; }
class LiveContext extends DbContext {}

const admissionTrace: Array<{ readonly sql: string; readonly params: number }> = [];
const provider = postgres({
  url,
  onSql: mode === "trace-additive" ? (sql, params) => {
    if (sql.startsWith("osnova.schema-admission:") || /^\s*(?:CREATE|ALTER)\b/iu.test(sql)) admissionTrace.push({ sql, params: params.length });
  } : undefined,
});
try {
  const entities = selectEntities(mode);
  const context = new LiveContext(new DbContextOptions({ provider, entities }));
  if (mode === "final-drift") {
    const capability = provider.schemaAdmissionCapability!;
    const poisoned = new Proxy(provider, { get(target, key) {
      if (key !== "schemaAdmissionCapability") { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; }
      return { ...capability, withSchemaAdmission: async (schemas: readonly string[], work: (scope: any) => Promise<unknown>) => capability.withSchemaAdmission(schemas, async (scope) => {
        let introspections = 0;
        return work({ ...scope, introspectExpected: async (expected: any) => {
          const actual = await scope.introspectExpected(expected);
          introspections += 1;
          return introspections === 2 ? { ...actual, tables: new Map() } : actual;
        } });
      }) };
    } });
    const poisonedContext = new LiveContext(new DbContextOptions({ provider: poisoned, entities }));
    await poisonedContext.database.ensureCreated().then(() => { throw new Error("final drift was not rejected"); }, (error) => { if ((error as { code?: string }).code !== "ORM_SCHEMA_DRIFT") throw error; });
  } else {
    await context.database.ensureCreated();
    await context.database.ensureCreated();
  }
  if (mode === "trace-additive") console.log(`admission-trace=${JSON.stringify(admissionTrace)}`);
} catch (error) {
  const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined;
  if (typeof code === "string") console.error(`orm-schema-code=${code}`);
  const verification = (error as { readonly verification?: unknown }).verification;
  if (verification !== undefined) console.error(JSON.stringify(verification));
  throw error;
} finally {
  await provider.close();
}

function selectEntities(current: string): readonly (new () => object)[] {
  switch (current) {
    case "base": return [Parent, Generated]; case "additive-base": return [AdditiveBase]; case "additive-full": return [AdditiveFull]; case "evolution-base": return [EvolutionParent, EvolutionBase]; case "evolution-full": return [EvolutionParent, EvolutionFull];
    case "unique-base": return [UniqueBase]; case "unique-full": return [UniqueFull]; case "check-base": return [CheckBase]; case "check-full": return [CheckFull]; case "fk-base": return [FkParent, FkBase]; case "fk-full": return [FkParent, FkFull];
    case "not-null-base": return [NotNullBase]; case "not-null-full": return [NotNullFull]; case "identity-add": return [IdentityAdd]; case "uuid-add": return [UuidAdd]; case "trace-additive": return [AdditiveFull];
    case "hard-rename": return [HardRename]; case "hard-type": return [HardType]; case "hard-default": return [HardDefault]; case "hard-null": return [HardNull]; case "hard-generation": return [HardGeneration]; case "hard-pk-name": return [HardPkName]; case "hard-pk-order": return [HardPkOrder]; case "hard-pk-components": return [HardPkComponents]; case "final-drift": return [FinalDrift]; case "aliased-check": return [AliasedCheckVector];
    default: return [Parent, Child, Generated, PlainKey, UuidKey];
  }
}
