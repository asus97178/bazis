import { ormHostedPlanValidator } from "./OrmHostedPlan.validator";
import type { HostedService } from "../di";
import { DatabaseFacade, type DbContextOptions, type EnsureCreatedWithMigrationsResult, type Migration } from "../../library/orm";
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
  readonly __bazisOrmLegacyLifecycle = true;
  /**
   * Internal hosted-plan marker: this lifecycle changes the schema at phase -100
   * without exact admission (`ensureCreated` on a non-PostgreSQL provider,
   * `migrateOnStart` or startup migrations). The hosted-plan validator rejects
   * it in a container that also uses exact schema admission.
   */
  readonly __bazisLegacySchemaAuthority: boolean;
  /** Internal hosted-plan marker: tables and foreign keys of the phase -105 exact `ensureCreated` admission on PostgreSQL. */
  readonly __bazisSchemaAdmission?: {
    readonly owner: string;
    readonly unit: readonly string[];
    readonly tables: readonly string[];
    readonly foreignKeys: readonly { readonly source: string; readonly target: string }[];
  };
  /** Internal hosted-plan marker: the context and its startup schema mode, for readable plan errors. */
  readonly __bazisSchemaOwner: { readonly context: string; readonly mode: string };
  /** `ensureCreated` owns the versioned migrations of this context (run or baselined before the check). */
  private readonly withMigrations: boolean;
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
    contextName = "DbContext",
  ) {
    const modes = [ensureCreated && "ensureCreated", migrateOnStart && "migrateOnStart", runMigrationsOnStart && migrations.length > 0 && "migrations"].filter(Boolean);
    this.withMigrations = ensureCreated && runMigrationsOnStart && migrations.length > 0;
    this.__bazisSchemaOwner = Object.freeze({ context: contextName, mode: modes.join(" + ") || "none" });
    this.phase = ensureCreated && options.provider.name === "postgres" ? -105 : -100;
    this.__bazisLegacySchemaAuthority = this.phase === -100 && (ensureCreated || migrateOnStart || (runMigrationsOnStart && migrations.length > 0));
    if (this.phase === -105) {
      const expected = compileExpectedSchema(options.model);
      const tables = Object.freeze(expected.tables.map((table) => `${table.schema}.${table.table}`));
      this.__bazisSchemaAdmission = Object.freeze({
        owner: contextName,
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
        const result: Partial<EnsureCreatedWithMigrationsResult> & Pick<EnsureCreatedWithMigrationsResult, "warnings"> = this.withMigrations ? await database.ensureCreatedWithMigrations(this.migrations) : await database.ensureCreated();
        // Logged in execution order: migrations, schema changes, then the baseline record.
        if (result.migrated && result.migrated.length > 0) {
          console.info(`[orm:migrations] applied: ${result.migrated.join(", ")}`);
        }
        if (result.applied && result.applied.length > 0) {
          console.info(`[orm:schema] applied ${result.applied.length} operation(s): ${result.applied.join(", ")}`);
        }
        if (result.baselined && result.baselined.length > 0) {
          console.info(`[orm:migrations] baseline: the schema was created from the model, recorded as applied without running: ${result.baselined.join(", ")}`);
        }
        for (const warning of result.warnings) {
          console.warn(`[orm:schema] ${warning}`);
        }
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
      if (this.runMigrationsOnStart && this.migrations.length > 0 && !this.withMigrations) {
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

/**
 * Occupies the phase -110 provider slot that exact schema admission requires:
 * it runs before the phase -105 admissions and the phase -100 ORM lifecycle,
 * without taking connection ownership.
 */
export class OrmProviderReadyLifecycle implements HostedService {
  readonly planValidator = ormHostedPlanValidator;
  public readonly phase = -110;
  readonly __bazisOrmProviderReady = true;
  start(): void {}
  stop(): void {}
}

/** Owns a provider published by connection-only `ormModule({ provider })`. */
export class OrmConnectionLifecycle implements HostedService {
  readonly planValidator = ormHostedPlanValidator;
  public readonly phase = -110;
  readonly __bazisOrmProviderReady = true;
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
