import type { EntityModel } from "./Metadata/types";
import type { OrmModel } from "./Metadata/OrmModel";
import type { DatabaseProvider, DbExecutor, ExecuteResult, ForeignKeyConstraint, Row, SqlParam } from "./Providers/types";
import { Migrator, type MigrationResult } from "./Schema/Migrator";
import { MigrationRunner, type Migration, type VersionedMigrationResult } from "./Schema/MigrationRunner";
import { SchemaDiffer } from "./Schema/SchemaDiffer";
import { SchemaAdmissionEngine } from "./Schema/SchemaAdmission";
import { SchemaAdmissionError } from "./errors";
import { physicalColumnTypes } from "./Schema/physicalColumnTypes";
import { bindResolvedForeignKey } from "./Providers/resolvedForeignKey";

/**
 * Управление самой базой данных: создание схемы, сырой SQL, транзакции, ping.
 * Доступно как `dbContext.database`.
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
  async ensureCreated(): Promise<void> {
    if (this.provider.name === "postgres") {
      await new SchemaAdmissionEngine(this.provider, this.models).ensureCreated();
      return;
    }
    // The physical default contract belongs exclusively to exact PostgreSQL
    // admission. Other providers must reject it rather than silently ignore it.
    if (this.models.entities.some((model) => model.properties.some((property) => property.generation === "none" && property.databaseDefault.kind !== "none"))) {
      throw new SchemaAdmissionError("ORM_SCHEMA_PROVIDER_UNSUPPORTED", "Database defaults in exact schema admission require PostgreSQL.");
    }
    const dialect = this.provider.dialect;
    // Таблицы создаём в порядке FK-зависимостей: СУБД со строгими FK (PostgreSQL)
    // требуют, чтобы ссылаемая таблица уже существовала.
    for (const model of this.orderByDependencies(this.models.entities)) {
      await this.provider.execute(dialect.createTableSql(model, this.foreignKeysFor(model)), []);
      for (const indexSql of dialect.createIndexSql(model)) {
        await this.provider.execute(indexSql, []);
      }
    }
  }

  /**
   * Аддитивная авто-миграция схемы для всех сущностей контекста (включается
   * в модуле: `ormOsnv: { migrateOnStart: true }`): интроспектит БД, сравнивает с моделью и применяет недостающие
   * таблицы/колонки/индексы в одной транзакции. Деструктивные расхождения не
   * выполняются — возвращаются как `warnings`.
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
    // Дифф упорядочивает createTable по FK-зависимостям (referenced -> dependent).
    const targets = this.orderByDependencies(this.models.entities);
    const types = this.provider.dialect.name === "postgres" ? physicalColumnTypes(this.models.entities) : undefined;
    const foreignKeys = new Map(targets.map((model) => [model, this.foreignKeysFor(model, types)]));
    const schema = await this.provider.introspect();
    const { operations, warnings } = new SchemaDiffer().diff(targets, schema);
    const migrator = new Migrator(this.provider, (model) => foreignKeys.get(model)!);
    const applied = await migrator.apply(operations);
    return { applied: applied.length, operations: applied, warnings };
  }

  /**
   * Топологическая сортировка сущностей: модель, на которую ссылается FK,
   * идёт раньше зависимой. Самоссылки игнорируются; циклы (редкие, через
   * nullable-FK) не зацикливают обход — порядок для них произвольный.
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

  /** Разрешает FK-метаданные модели в имена колонок/таблиц для DDL. */
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

  /** Имя таблицы для FK/DDL: PostgreSQL uses `schema.table`. */
  private referencedTableName(model: EntityModel): string {
    if (this.provider.dialect.name === "postgres" && model.schema !== undefined) {
      return `${model.schema}.${model.tableName}`;
    }
    return model.tableName;
  }

  /**
   * Выполняет сырой изменяющий SQL с безопасной подстановкой параметров через
   * плейсхолдеры `{0}`, `{1}`, ... — значения уходят в параметры, не в строку.
   *
   * ```ts
   * await ctx.database.executeSqlRaw("UPDATE Users SET active = {0} WHERE id = {1}", false, id);
   * ```
   */
  executeSqlRaw(sql: string, ...params: SqlParam[]): Promise<ExecuteResult> {
    return this.provider.execute(this.rewritePlaceholders(sql, params.length), params);
  }

  /** Сырой SELECT с безопасной подстановкой параметров `{0}`. */
  querySqlRaw(sql: string, ...params: SqlParam[]): Promise<Row[]> {
    return this.provider.query(this.rewritePlaceholders(sql, params.length), params);
  }

  /**
   * Применяет версионированные миграции с историей (`__OsnvMigrations`).
   * Compile-safe: миграции передаются явным массивом.
   */
  migrateVersioned(migrations: readonly Migration[]): Promise<VersionedMigrationResult> {
    return new MigrationRunner(this.provider, migrations).migrate();
  }

  /** Откатывает последние `steps` версионированных миграций (нужен `down`). */
  rollbackVersioned(migrations: readonly Migration[], steps = 1): Promise<VersionedMigrationResult> {
    return new MigrationRunner(this.provider, migrations).rollback(steps);
  }

  /** Выполняет работу в транзакции БД (в callback — исполнитель транзакции). */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.provider.transaction(work);
  }

  /** Проверка соединения. */
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
