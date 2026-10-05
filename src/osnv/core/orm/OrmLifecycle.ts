import { ormHostedPlanValidator } from "./OrmHostedPlan.validator";
import type { HostedService } from "../di";
import { DatabaseFacade, type DbContextOptions, type Migration } from "../../library/orm";
import { compileExpectedSchema } from "../../library/orm/Schema/ExpectedSchema";

/**
 * ORM lifecycle hosted service: at start it (optionally) creates the schema or
 * runs the auto-migration; at shutdown it closes the connection/pool.
 * Starts early (negative phase) so the database is ready before the servers.
 */
export class OrmLifecycle implements HostedService {
  readonly planValidator = ormHostedPlanValidator;
  readonly phase: number;
  /** Internal hosted-plan marker; public hosted services never receive it. */
  readonly __osnvOrmLegacyLifecycle = true;
  readonly __osnvLegacySchemaAuthority: boolean;
  readonly __osnvSchemaAdmission?: {
    readonly unit: readonly string[];
    readonly tables: readonly string[];
    readonly foreignKeys: readonly { readonly source: string; readonly target: string }[];
  };
  private connectionClosed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly options: DbContextOptions,
    private readonly ensureCreated: boolean,
    private readonly migrateOnStart: boolean,
    private readonly migrations: readonly Migration[] = [],
    private readonly runMigrationsOnStart: boolean = false,
    /**
     * Whether this lifecycle owns the connection. `false` for the feature mode on
     * top of the shared {@link DATABASE_PROVIDER}: the infrastructure owns the
     * connection (the connection module / `@Infra` connector), and the feature
     * must not close it at shutdown, or the shared pool would be closed twice.
     */
    private readonly ownsConnection: boolean = true,
  ) {
    this.phase = ensureCreated && options.provider.name === "postgres" ? -105 : -100;
    this.__osnvLegacySchemaAuthority = this.phase === -100 && (ensureCreated || migrateOnStart || (runMigrationsOnStart && migrations.length > 0));
    if (this.phase === -105) {
      const expected = compileExpectedSchema(options.model);
      const tables = Object.freeze(expected.tables.map((table) => `${table.schema}.${table.table}`));
      this.__osnvSchemaAdmission = Object.freeze({
        unit: tables,
        tables,
        foreignKeys: Object.freeze(expected.tables.flatMap((table) =>
          table.foreignKeys.map((foreignKey) => Object.freeze({
            source: `${table.schema}.${table.table}`,
            target: `${foreignKey.target.schema}.${foreignKey.target.table}`,
          })),
        )),
      });
    }
  }

  async start(): Promise<void> {
    const database = new DatabaseFacade(this.options.provider, this.options.model);
    try {
      if (this.ensureCreated) {
        await database.ensureCreated();
      }
      if (this.migrateOnStart) {
        const result = await database.migrate();
        if (result.applied > 0) {
          console.info(`[orm:migrate] applied ${result.applied} operation(s): ${result.operations.join(", ")}`);
        }
        for (const warning of result.warnings) {
          console.warn(`[orm:migrate] ${warning}`);
        }
      }
      if (this.runMigrationsOnStart && this.migrations.length > 0) {
        const result = await database.migrateVersioned(this.migrations);
        if (result.applied.length > 0) {
          console.info(`[orm:migrations] applied: ${result.applied.join(", ")}`);
        }
      }
    } catch (error) {
      if (!this.ownsConnection) {
        throw error;
      }
      try {
        await this.closeOwnedConnection();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "ORM startup failed and connection rollback also failed.");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.ownsConnection) {
      await this.closeOwnedConnection();
    }
  }

  private async closeOwnedConnection(): Promise<void> {
    if (this.connectionClosed) {
      return;
    }
    this.closePromise ??= this.options.provider.close().then(() => {
      this.connectionClosed = true;
    });
    await this.closePromise;
  }
}

/** Strict owner admission intentionally precedes the legacy -100 lifecycle. */
/** Establishes the required -110 provider slot without taking connection ownership. */
export class OrmProviderReadyLifecycle implements HostedService {
  readonly planValidator = ormHostedPlanValidator;
  public readonly phase = -110;
  readonly __osnvOrmProviderReady = true;
  start(): void {}
  stop(): void {}
}

/** Owns a provider published by connection-only `ormModule({ provider })`. */
export class OrmConnectionLifecycle implements HostedService {
  readonly planValidator = ormHostedPlanValidator;
  public readonly phase = -110;
  readonly __osnvOrmProviderReady = true;
  private stopPromise?: Promise<void>;

  public constructor(private readonly provider: DbContextOptions["provider"]) {}

  public start(): void {
    // DatabaseProvider has no separate connect contract; providers initialize
    // lazily on first operation. This lifecycle exists to establish ownership.
  }

  public stop(): Promise<void> {
    this.stopPromise ??= this.provider.close();
    return this.stopPromise;
  }
}
