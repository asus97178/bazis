import type { DatabaseProvider, DbExecutor, Row, SqlParam } from "../Providers/types";

/** Execution context of a versioned migration. */
export interface MigrationContext {
  /** Runs modifying SQL with `{0}` or `$1` parameters. */
  execute(sql: string, ...params: SqlParam[]): Promise<void>;
  /** SELECT with parameters. */
  query<T extends Row = Row>(sql: string, ...params: SqlParam[]): Promise<T[]>;
}

/** Versioned migration with `up` and an optional `down`. */
export interface Migration {
  /** Unique identifier (usually timestamp_name). */
  readonly id: string;
  readonly up: (ctx: MigrationContext) => Promise<void>;
  readonly down?: (ctx: MigrationContext) => Promise<void>;
}

export interface VersionedMigrationResult {
  readonly applied: readonly string[];
  readonly rolledBack: readonly string[];
}

const HISTORY_TABLE = "__OsnvMigrations";

/**
 * Applies the registered migrations with history in the `__OsnvMigrations` table.
 * Compile-safe: migrations are passed as an explicit array (no dynamic import,
 * which keeps `bun build --compile` working).
 */
export class MigrationRunner {
  constructor(
    private readonly provider: DatabaseProvider,
    private readonly migrations: readonly Migration[],
  ) {}

  async migrate(): Promise<VersionedMigrationResult> {
    // A cross-process PostgreSQL advisory lock keeps two starting instances
    // from racing to apply migrations.
    return this.withMigrationLock(() => this.migrateCore());
  }

  private async migrateCore(): Promise<VersionedMigrationResult> {
    await this.ensureHistory();
    const appliedSet = await this.loadApplied();
    const pending = this.migrations.filter((migration) => !appliedSet.has(migration.id));
    const applied: string[] = [];

    for (const migration of pending) {
      await this.provider.transaction(async (tx) => {
        await migration.up(this.context(tx));
        await tx.execute(
          `INSERT INTO ${this.quote(HISTORY_TABLE)} (${this.quote("MigrationId")}, ${this.quote("AppliedAt")}) VALUES (${this.param(0)}, ${this.param(1)})`,
          [migration.id, new Date().toISOString()],
        );
      });
      applied.push(migration.id);
    }
    return { applied, rolledBack: [] };
  }

  /** Rolls back the last `steps` migrations (requires `down`). */
  async rollback(steps = 1): Promise<VersionedMigrationResult> {
    if (!Number.isSafeInteger(steps) || steps < 0) {
      throw new RangeError(`Migration rollback steps must be a non-negative safe integer; received ${String(steps)}.`);
    }
    if (steps === 0) {
      return { applied: [], rolledBack: [] };
    }
    return this.withMigrationLock(() => this.rollbackCore(steps));
  }

  private async rollbackCore(steps: number): Promise<VersionedMigrationResult> {
    await this.ensureHistory();
    const applied = await this.loadAppliedOrdered();
    const toRollback = applied.slice(-steps).reverse();
    const rolledBack: string[] = [];

    for (const id of toRollback) {
      const migration = this.migrations.find((m) => m.id === id);
      if (!migration?.down) {
        throw new Error(`Migration "${id}" has no down() method.`);
      }
      await this.provider.transaction(async (tx) => {
        await migration.down!(this.context(tx));
        await tx.execute(`DELETE FROM ${this.quote(HISTORY_TABLE)} WHERE ${this.quote("MigrationId")} = ${this.param(0)}`, [
          id,
        ]);
      });
      rolledBack.push(id);
    }
    return { applied: [], rolledBack };
  }

  private withMigrationLock<T>(work: () => Promise<T>): Promise<T> {
    return this.provider.withMigrationLock ? this.provider.withMigrationLock(work) : work();
  }

  private context(tx: DbExecutor): MigrationContext {
    return {
      execute: async (sql, ...params) => {
        await tx.execute(this.rewrite(sql, params.length), params);
      },
      query: async <T extends Row = Row>(sql: string, ...params: SqlParam[]) =>
        tx.query(this.rewrite(sql, params.length), params) as Promise<T[]>,
    };
  }

  private async ensureHistory(): Promise<void> {
    await this.provider.execute(
      `CREATE TABLE IF NOT EXISTS ${this.quote(HISTORY_TABLE)} (${this.quote("MigrationId")} TEXT PRIMARY KEY, ${this.quote("AppliedAt")} TEXT NOT NULL)`,
      [],
    );
  }

  private async loadApplied(): Promise<Set<string>> {
    const rows = await this.provider.query(`SELECT ${this.quote("MigrationId")} AS id FROM ${this.quote(HISTORY_TABLE)}`, []);
    return new Set(rows.map((row) => String(row.id)));
  }

  private async loadAppliedOrdered(): Promise<string[]> {
    const rows = await this.provider.query(
      `SELECT ${this.quote("MigrationId")} AS id FROM ${this.quote(HISTORY_TABLE)} ORDER BY ${this.quote("AppliedAt")} ASC`,
      [],
    );
    return rows.map((row) => String(row.id));
  }

  private quote(name: string): string {
    return this.provider.dialect.quoteId(name);
  }

  private param(index: number): string {
    return this.provider.dialect.parameter(index);
  }

  private rewrite(sql: string, count: number): string {
    return sql.replace(/\{(\d+)\}/g, (_match, raw: string) => {
      const index = Number(raw);
      if (index >= count) {
        throw new RangeError(`Migration SQL references {${index}} but only ${count} parameter(s) provided.`);
      }
      return this.param(index);
    });
  }
}
