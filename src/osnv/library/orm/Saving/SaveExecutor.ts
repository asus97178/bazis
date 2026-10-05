import { Validator } from "../../validation";
import { DbUpdateError, isCommittedOutcome, OrmValidationError, UniqueViolationError } from "../errors";
import type { EntityModel } from "../Metadata/types";
import { maxRowsPerInsert } from "../Providers/limits";
import { decodeProperty } from "../Providers/propertyConversion";
import type { DatabaseProvider, DbExecutor } from "../Providers/types";
import { isUnknownTransactionOutcome, registerTransactionUncertainty, TransactionOutcomeUnknownError } from "../Providers/transactionOutcome";
import { registerPostCommitFinalizer } from "../Providers/transactionCallbacks";
import { EntityState } from "../Tracking/EntityState";
import { assertUniqueTrackedKeys, holdDeletedIdentity, type ChangeTracker, type TrackedEntry } from "../Tracking/ChangeTracker";
import { CommandBuilder } from "./CommandBuilder";
import { applyConventions } from "./applyConventions";
import { ExecutionStrategy, type ExecutionStrategyOptions } from "./ExecutionStrategy";
import { isNewOrmTransactionScopeActive, markCurrentSaveRequiresUnwind } from "../Transactions/TransactionScopeCoordinator";

interface GeneratedKeySnapshot {
  readonly entry: TrackedEntry;
  readonly value: unknown;
}

interface RollbackCheckpoint {
  readonly state: EntityState;
  readonly snapshot: TrackedEntry["snapshot"];
  readonly snapshotJsonSignatures: TrackedEntry["snapshotJsonSignatures"];
  readonly modifiedProperties: Set<string>;
  readonly generatedKey: unknown;
}

interface RollbackToken {
  readonly entry: TrackedEntry;
  readonly checkpoint: RollbackCheckpoint;
  readonly parent?: RollbackToken;
  readonly releaseIdentity: () => void;
}

/** Per-tracker, per-entity save baselines. It is deliberately transient and never part of TrackedEntry. */
const rollbackTokens = new WeakMap<ChangeTracker, WeakMap<object, RollbackToken>>();
const uncertainTrackers = new WeakSet<ChangeTracker>();

export interface SaveOptions {
  /** Validate Added/Modified entities before saving (default true). */
  readonly validateOnSave: boolean;
  /** Retries on transient errors (off by default). */
  readonly executionStrategy?: ExecutionStrategyOptions;
}

/**
 * Applies the changes pending in the tracker in one transaction:
 * DetectChanges -> (optional) validation -> ordering -> parameterized
 * INSERT/UPDATE/DELETE -> reading generated keys -> AcceptChanges.
 *
 * After a confirmed rollback the changes can be retried. If the COMMIT outcome
 * is unknown, the tracker is locked until the data is reconciled in a new context.
 */
export class SaveExecutor {
  private readonly commands: CommandBuilder;
  private readonly retry?: ExecutionStrategy;

  constructor(
    private readonly provider: DatabaseProvider,
    private readonly tracker: ChangeTracker,
    private readonly options: SaveOptions,
  ) {
    this.commands = new CommandBuilder(provider.dialect);
    if (this.options.executionStrategy) {
      this.retry = new ExecutionStrategy(this.options.executionStrategy);
    }
  }

  save(): Promise<number> {
    const work = () => this.saveCore();
    // A retry inside an active ORM transaction can replay partial work on the
    // same physical session. The context-aware proxy exposes the provider's
    // ambient state without changing top-level retry behaviour.
    return this.retry && !isNewOrmTransactionScopeActive() && this.provider.isTransactionActive?.() !== true
      ? this.retry.execute(work) : work();
  }

  private async saveCore(): Promise<number> {
    if (uncertainTrackers.has(this.tracker)) throw new TransactionOutcomeUnknownError();
    this.tracker.detectChanges();
    const pending = this.tracker.entriesToProcess();
    if (pending.length === 0) {
      return 0;
    }

    applyConventions(pending);

    if (this.options.validateOnSave) {
      await this.validate(pending);
    }
    // Validation may assign manual Added keys. Reject conflicts before SQL.
    assertUniqueTrackedKeys(this.tracker);

    // Must be after validation (a forever validator is user work) and before
    // any ordering, token/callback registration or provider DML.
    markCurrentSaveRequiresUnwind();

    const ordered = this.orderByDependencies(pending);
    const generatedKeys = this.captureGeneratedKeys(ordered);
    const tokens = this.captureRollbackTokens(ordered);
    const hasRollbackCallbacks = this.provider.afterCommit !== undefined && this.provider.afterRollback !== undefined;
    let trackerAccepted = false;

    try {
      await this.provider.transaction(async (tx) => {
        if (hasRollbackCallbacks) {
          for (const token of tokens) {
            const rollback = () => this.restoreRollbackToken(token);
            registerTransactionUncertainty(rollback, () => {
              uncertainTrackers.add(this.tracker);
              this.commitRollbackToken(token);
            });
            this.provider.afterRollback!(rollback);
            const commit = () => this.commitRollbackToken(token);
            registerPostCommitFinalizer(commit);
            this.provider.afterCommit!(commit);
          }
        }
        let i = 0;
        while (i < ordered.length) {
          const entry = ordered[i]!;
          // Consecutive inserts of one model are merged into a multi-row INSERT.
          if (entry.state === EntityState.Added) {
            const group: TrackedEntry[] = [];
            while (i < ordered.length && ordered[i]!.state === EntityState.Added && ordered[i]!.model === entry.model) {
              group.push(ordered[i]!);
              i += 1;
            }
            await this.insertBatch(tx, entry.model, group);
            continue;
          }
          await this.execute(tx, entry);
          i += 1;
        }
        // RETURNING may expose a collision with an already tracked row or
        // another generated key. Check every entry before accepting any of
        // them, while even callback-less providers can still roll back.
        assertUniqueTrackedKeys(this.tracker, ordered);
        // A callback-capable owner runs afterCommit before save() resolves.
        // Accept the DML snapshot now, before those callbacks can mutate the
        // entity; rollback tokens remain owned by their existing callbacks.
        if (hasRollbackCallbacks) {
          this.acceptChanges(ordered);
          trackerAccepted = true;
        }
      });
      if (!hasRollbackCallbacks) {
        for (const token of tokens) this.commitRollbackToken(token);
      }
    } catch (error) {
      if (isCommittedOutcome(error)) {
        if (!trackerAccepted) this.acceptChanges(ordered);
        for (const token of tokens) this.commitRollbackToken(token);
      } else if (isUnknownTransactionOutcome(error)) {
        uncertainTrackers.add(this.tracker);
        for (const token of tokens) this.commitRollbackToken(token);
      } else {
        // Providers with afterRollback restore ambient transactions; this
        // idempotent fallback also protects custom/top-level providers.
        this.restoreGeneratedKeys(generatedKeys);
        for (const token of tokens) this.restoreRollbackToken(token);
        throw UniqueViolationError.from(error);
      }
      throw error;
    }

    // In an ambient physical transaction `transaction()` may only release a
    // savepoint.  Keep tracker state provisional until that owner commits.
    if (!hasRollbackCallbacks) this.acceptChanges(ordered);
    return ordered.length;
  }

  private acceptChanges(entries: readonly TrackedEntry[]): void {
    for (const entry of entries) {
      this.tracker.acceptChanges(entry);
    }
  }

  private captureGeneratedKeys(entries: readonly TrackedEntry[]): GeneratedKeySnapshot[] {
    return entries
      .filter((entry) => entry.state === EntityState.Added && entry.model.key.length === 1 && entry.model.key[0].generation !== "none")
      .map((entry) => ({
        entry,
        value: entry.model.key.length === 1 ? (entry.entity as Record<string, unknown>)[entry.model.key[0].propertyName] : undefined,
      }));
  }

  private restoreGeneratedKeys(snapshots: readonly GeneratedKeySnapshot[]): void {
    for (const snapshot of snapshots) {
      this.tracker.restoreAddedAfterRollback(snapshot.entry, snapshot.value);
    }
  }

  private captureRollbackTokens(entries: readonly TrackedEntry[]): RollbackToken[] {
    const map = this.rollbackTokenMap();
    return entries.map((entry) => {
      const key = entry.state === EntityState.Added && entry.model.key.length === 1
        ? (entry.entity as Record<string, unknown>)[entry.model.key[0].propertyName]
        : undefined;
      const token: RollbackToken = {
        entry,
        parent: map.get(entry.entity),
        releaseIdentity: holdDeletedIdentity(this.tracker, entry),
        checkpoint: {
          state: entry.state,
          snapshot: entry.snapshot,
          snapshotJsonSignatures: entry.snapshotJsonSignatures,
          modifiedProperties: entry.modifiedProperties,
          generatedKey: key,
        },
      };
      map.set(entry.entity, token);
      return token;
    });
  }

  private commitRollbackToken(token: RollbackToken): void {
    const map = this.rollbackTokenMap();
    const current = map.get(token.entry.entity);
    if (current === token || this.isAncestor(token, current)) this.setRollbackToken(map, token.entry.entity, token.parent);
    token.releaseIdentity();
  }

  private restoreRollbackToken(token: RollbackToken): void {
    try {
      this.restoreRollbackCheckpoint(token);
    } finally {
      token.releaseIdentity();
    }
  }

  private restoreRollbackCheckpoint(token: RollbackToken): void {
    const map = this.rollbackTokenMap();
    const current = map.get(token.entry.entity);
    if (!current || (!this.isAncestor(token, current) && current !== token)) return;
    const finalState = current.entry.state;
    const checkpoint = token.checkpoint;
    if (checkpoint.state === EntityState.Added) {
      if (finalState === EntityState.Detached || finalState === EntityState.Deleted) {
        // The row did not exist before the outer save and is absent again after rollback.
        // Reattach first when a child delete had provisionally detached it, then
        // remove so the tracker also returns to Detached rather than stale Deleted.
        if (finalState === EntityState.Deleted) {
          this.tracker.restoreAddedAfterRollback(current.entry, checkpoint.generatedKey);
          this.tracker.remove(current.entry.entity, current.entry.model);
        }
      } else {
        this.tracker.restoreAddedAfterRollback(current.entry, checkpoint.generatedKey);
      }
    } else if (finalState === EntityState.Detached || finalState === EntityState.Deleted) {
      this.restorePersistedEntry(current.entry, checkpoint, EntityState.Deleted);
    } else {
      this.restorePersistedEntry(current.entry, checkpoint, checkpoint.state === EntityState.Unchanged ? EntityState.Unchanged : EntityState.Modified);
      if (checkpoint.state !== EntityState.Deleted) this.tracker.detectChanges();
    }
    this.setRollbackToken(map, token.entry.entity, token.parent);
  }

  private restorePersistedEntry(entry: TrackedEntry, checkpoint: RollbackCheckpoint, state: EntityState): void {
    this.tracker.update(entry.entity, entry.model);
    const restored = this.tracker.entriesToProcess().find((candidate) => candidate.entity === entry.entity)!;
    restored.state = state;
    restored.snapshot = checkpoint.snapshot;
    restored.snapshotJsonSignatures = checkpoint.snapshotJsonSignatures;
    restored.modifiedProperties = checkpoint.modifiedProperties;
  }

  private rollbackTokenMap(): WeakMap<object, RollbackToken> {
    let map = rollbackTokens.get(this.tracker);
    if (!map) {
      map = new WeakMap();
      rollbackTokens.set(this.tracker, map);
    }
    return map;
  }

  private isAncestor(token: RollbackToken, current: RollbackToken | undefined): boolean {
    for (let candidate = current; candidate; candidate = candidate.parent) if (candidate === token) return true;
    return false;
  }

  private setRollbackToken(map: WeakMap<object, RollbackToken>, entity: object, token: RollbackToken | undefined): void {
    if (token) map.set(entity, token); else map.delete(entity);
  }

  /**
   * INSERTs use referenced -> dependent order; DELETEs reverse it. Entries of
   * one model stay adjacent for batching, and model-level FK cycles fail before
   * any SQL is sent instead of producing order-dependent constraint errors.
   */
  private orderByDependencies(entries: readonly TrackedEntry[]): TrackedEntry[] {
    const added = entries.filter((entry) => entry.state === EntityState.Added);
    const modified = entries.filter((entry) => entry.state === EntityState.Modified);
    const deleted = entries.filter((entry) => entry.state === EntityState.Deleted);
    return [
      ...this.orderStateByDependencies(added, false),
      ...modified,
      ...this.orderStateByDependencies(deleted, true),
    ];
  }

  private orderStateByDependencies(entries: readonly TrackedEntry[], reverse: boolean): TrackedEntry[] {
    if (entries.length < 2) {
      return [...entries];
    }
    const models = [...new Set(entries.map((entry) => entry.model))];
    const byCtor = new Map(models.map((model) => [model.ctor, model] as const));
    const state = new Map<EntityModel, "visiting" | "done">();
    const stack: EntityModel[] = [];
    const orderedModels: EntityModel[] = [];

    const visit = (model: EntityModel): void => {
      const current = state.get(model);
      if (current === "done") {
        return;
      }
      if (current === "visiting") {
        const start = stack.indexOf(model);
        const cycle = [...stack.slice(start), model].map((item) => item.name).join(" -> ");
        throw new DbUpdateError(`Cannot order SaveChanges because of a foreign-key cycle: ${cycle}.`);
      }
      state.set(model, "visiting");
      stack.push(model);
      for (const foreignKey of model.foreignKeys) {
        let target: EntityModel | undefined;
        try {
          target = byCtor.get(foreignKey.target());
        } catch (error) {
          throw new DbUpdateError(
            `Cannot resolve foreign-key target for "${model.name}.${foreignKey.property}": ${String(error)}.`,
          );
        }
        if (target && target !== model) {
          visit(target);
        }
      }
      stack.pop();
      state.set(model, "done");
      orderedModels.push(model);
    };

    for (const model of models) {
      visit(model);
    }
    if (reverse) {
      orderedModels.reverse();
    }
    const byModel = new Map<EntityModel, TrackedEntry[]>();
    for (const entry of entries) {
      const group = byModel.get(entry.model) ?? [];
      group.push(entry);
      byModel.set(entry.model, group);
    }
    return orderedModels.flatMap((model) => byModel.get(model) ?? []);
  }

  /** Batch insert of an Added group of one model (chunked by the parameter limit). */
  private async insertBatch(tx: DbExecutor, model: EntityModel, group: TrackedEntry[]): Promise<void> {
    const columnsPerRow =
      model.properties.filter((property) => property.generation !== "identity" && property.generation !== "uuid")
        .length;
    // PostgreSQL DEFAULT VALUES inserts exactly one row per statement.
    const maxRows = columnsPerRow === 0 ? 1 : maxRowsPerInsert(this.provider, columnsPerRow);
    for (let start = 0; start < group.length; start += maxRows) {
      const chunk = group.slice(start, start + maxRows);
      const command = this.commands.insertMany(
        chunk.map((entry) => entry.entity as Record<string, unknown>),
        model,
      );
      const generated = command.returnsGeneratedKey;
      if (generated) {
        // RETURNING returns rows in VALUES order, so match them by index.
        const rows = await tx.query(command.sql, command.params);
        for (let k = 0; k < chunk.length; k += 1) {
          const raw = rows[k]?.[generated.column];
          (chunk[k]!.entity as Record<string, unknown>)[generated.property] =
            raw === undefined ? undefined : decodeProperty(model.key[0], raw, this.provider.dialect);
        }
      } else {
        await tx.execute(command.sql, command.params);
      }
    }
  }

  private async execute(tx: DbExecutor, entry: TrackedEntry): Promise<void> {
    const command = this.commands.build(entry);
    const generated = command.returnsGeneratedKey;
    if (generated) {
      // Identity INSERT through RETURNING: read the key from the returned row.
      // Decode through the dialect: PG returns a bigint identity as a string/bigint;
      // convert it to the key property type (integer -> number).
      const rows = await tx.query(command.sql, command.params);
      const raw = rows.length > 0 ? rows[0]![generated.column] : undefined;
      (entry.entity as Record<string, unknown>)[generated.property] =
        raw === undefined ? undefined : decodeProperty(entry.model.key[0], raw, this.provider.dialect);
      return;
    }
    await tx.execute(command.sql, command.params);
  }

  private async validate(pending: readonly TrackedEntry[]): Promise<void> {
    for (const entry of pending) {
      if (entry.state === EntityState.Deleted) {
        continue;
      }
      const result = await Validator.validateAsync(entry.entity);
      if (!result.isValid) {
        throw new OrmValidationError(entry.model.name, result.errors);
      }
    }
  }
}
