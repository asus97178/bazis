import type { EntityModel } from "./Metadata/types";
import type { OrmModel } from "./Metadata/OrmModel";
import type { DatabaseProvider, DbExecutor, ExecuteResult, ForeignKeyConstraint, Row, SqlParam } from "./Providers/types";
import { Migrator, type MigrationResult } from "./Schema/Migrator";
import { MigrationRunner, type Migration, type VersionedMigrationResult } from "./Schema/MigrationRunner";
import { SchemaDiffer } from "./Schema/SchemaDiffer";
import { SchemaAdmissionEngine, type EnsureCreatedResult } from "./Schema/SchemaAdmission";
import { SchemaAdmissionError } from "./errors";
import { physicalColumnTypes } from "./Schema/physicalColumnTypes";
import { bindResolvedForeignKey } from "./Providers/resolvedForeignKey";

/**
 * Management of the database itself: schema creation, raw SQL, transactions, ping.
 * Available as `dbContext.database`.
 */
export class DatabaseFacade {
  constructor(
    private readonly provider: DatabaseProvider,
    private readonly models: OrmModel,
  ) {}

  /**
   * PostgreSQL admission compiles the explicit entity/decorator unit, acquires
   * sorted schema advisory locks and uses one reserved-session transaction:
   * preflight exact-verifies existing tables, creates only missing schemas and
   * whole tables, then exact-verifies again before commit. Existing tables are
   * never altered or repaired.
   */
  async ensureCreated(): Promise<EnsureCreatedResult> {
    if (this.provider.name === "postgres") {
      return new SchemaAdmissionEngine(this.provider, this.models).ensureCreated();
    }
    // The physical default contract belongs exclusively to exact PostgreSQL
    // admission. Other providers must reject it rather than silently ignore it.
    if (this.models.entities.some((model) => model.properties.some((property) => property.generation === "none" && property.databaseDefault.kind !== "none"))) {
      throw new SchemaAdmissionError("ORM_SCHEMA_PROVIDER_UNSUPPORTED", "Database defaults in exact schema admission require PostgreSQL.");
    }
    const dialect = this.provider.dialect;
    // Create tables in FK dependency order: databases with strict FKs (PostgreSQL)
    // require the referenced table to exist already.
    for (const model of this.orderByDependencies(this.models.entities)) {
      await this.provider.execute(dialect.createTableSql(model, this.foreignKeysFor(model)), []);
      for (const indexSql of dialect.createIndexSql(model)) {
        await this.provider.execute(indexSql, []);
      }
    }
    return { warnings: [] };
  }

  /**
   * Additive auto-migration of the schema for all context entities (enabled in
   * the module: `ormBazis: { migrateOnStart: true }`): introspects the database,
   * compares it with the model and applies the missing tables/columns/indexes in
   * one transaction. Destructive differences are not applied; they are
   * returned as `warnings`.
   */
  async migrate(): Promise<MigrationResult> {
    this.assertNoPostgresOnlyDefaults();
    const work = () => this.migrateCore();
    return this.provider.withMigrationLock ? this.provider.withMigrationLock(work) : work();
  }

  private assertNoPostgresOnlyDefaults(): void {
    if (this.models.entities.some((model) => model.properties.some((property) => property.generation === "none" && property.databaseDefault.kind !== "none"))) {
      throw new SchemaAdmissionError("ORM_SCHEMA_PROVIDER_UNSUPPORTED", "Database defaults in exact schema admission require PostgreSQL.");
    }
  }

  private async migrateCore(): Promise<MigrationResult> {
    // The diff orders createTable by FK dependencies (referenced -> dependent).
    const targets = this.orderByDependencies(this.models.entities);
    const types = this.provider.dialect.name === "postgres" ? physicalColumnTypes(this.models.entities) : undefined;
    const foreignKeys = new Map(targets.map((model) => [model, this.foreignKeysFor(model, types)]));
    const schema = await this.provider.introspect();
    const { operations, warnings } = new SchemaDiffer(types).diff(targets, schema);
    const migrator = new Migrator(this.provider, (model) => foreignKeys.get(model)!);
    const applied = await migrator.apply(operations);
    return { applied: applied.length, operations: applied, warnings };
  }

  /**
   * Topological sort of entities: the model referenced by an FK comes before
   * the dependent one. Self-references are ignored; cycles (rare, through
   * nullable FKs) do not loop the traversal, their order is arbitrary.
   */
  private orderByDependencies(models: readonly EntityModel[]): EntityModel[] {
    const set = new Set(models);
    const ordered: EntityModel[] = [];
    const done = new Set<EntityModel>();
    const onStack = new Set<EntityModel>();

    const visit = (model: EntityModel): void => {
      if (done.has(model) || onStack.has(model)) {
        return;
      }
      onStack.add(model);
      for (const fk of model.foreignKeys) {
        const target = this.tryTargetModel(fk.target);
        if (target && target !== model && set.has(target)) {
          visit(target);
        }
      }
      onStack.delete(model);
      done.add(model);
      ordered.push(model);
    };

    for (const model of models) {
      visit(model);
    }
    return ordered;
  }

  private tryTargetModel(target: () => new () => object): EntityModel | undefined {
    try {
      return this.models.targetModel(target);
    } catch {
      return undefined;
    }
  }

  /** Resolves the model's FK metadata into column/table names for DDL. */
  private foreignKeysFor(model: EntityModel, types?: ReturnType<typeof physicalColumnTypes>): ForeignKeyConstraint[] {
    const constraints: ForeignKeyConstraint[] = [];
    for (const fk of model.foreignKeys) {
      const columns = fk.properties.map((name) => model.propertyByName(name));
      if (columns.some((column) => !column)) {
        continue;
      }
      const target = this.models.targetModel(fk.target);
      const constraint: ForeignKeyConstraint = {
        column: columns[0]!.columnName,
        columns: columns.map((column) => column!.columnName),
        name: fk.name,
        referencedTable: this.referencedTableName(target),
        referencedColumn: target.key[0].columnName,
        referencedColumns: target.key.map((property) => property.columnName),
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
        columnType: types?.get(columns[0]!),
      };
      if (types) bindResolvedForeignKey(constraint, {
        target,
        columnTypes: new Map(columns.map((column) => [column!.columnName, types.get(column!)!])),
      });
      constraints.push(constraint);
    }
    return constraints;
  }

  /** Table name for FK/DDL: PostgreSQL uses `schema.table`. */
  private referencedTableName(model: EntityModel): string {
    if (this.provider.dialect.name === "postgres" && model.schema !== undefined) {
      return `${model.schema}.${model.tableName}`;
    }
    return model.tableName;
  }

  /**
   * Runs raw modifying SQL with safe parameter substitution through the
   * `{0}`, `{1}`, ... placeholders: values go into parameters, not into the string.
   *
   * ```ts
   * await ctx.database.executeSqlRaw("UPDATE Users SET active = {0} WHERE id = {1}", false, id);
   * ```
   */
  executeSqlRaw(sql: string, ...params: SqlParam[]): Promise<ExecuteResult> {
    return this.provider.execute(this.rewritePlaceholders(sql, params.length), params);
  }

  /** Raw SELECT with safe `{0}` parameter substitution. */
  querySqlRaw(sql: string, ...params: SqlParam[]): Promise<Row[]> {
    return this.provider.query(this.rewritePlaceholders(sql, params.length), params);
  }

  /**
   * Applies versioned migrations with history (`__BazisMigrations`).
   * Compile-safe: migrations are passed as an explicit array.
   */
  migrateVersioned(migrations: readonly Migration[]): Promise<VersionedMigrationResult> {
    return new MigrationRunner(this.provider, migrations).migrate();
  }

  /** Rolls back the last `steps` versioned migrations (requires `down`). */
  rollbackVersioned(migrations: readonly Migration[], steps = 1): Promise<VersionedMigrationResult> {
    return new MigrationRunner(this.provider, migrations).rollback(steps);
  }

  /** Runs work in a database transaction (the callback gets the transaction executor). */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.provider.transaction(work);
  }

  /** Connection check. */
  canConnect(): Promise<boolean> {
    return this.provider.ping();
  }

  private rewritePlaceholders(sql: string, count: number): string {
    const dialect = this.provider.dialect;
    return sql.replace(/\{(\d+)\}/g, (_match, raw: string) => {
      const index = Number(raw);
      if (index >= count) {
        throw new RangeError(`Raw SQL references {${index}} but only ${count} parameter(s) were provided.`);
      }
      return dialect.parameter(index);
    });
  }
}
