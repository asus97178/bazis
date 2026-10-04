import type { EntityModel, PropertyModel } from "../Metadata/types";
import { DbUpdateError, OrmError } from "../errors";
import { KeyTuple } from "../Metadata/KeyTuple";
import { EntityState } from "./EntityState";

/** Снимок исходных значений свойств (для snapshot change tracking). */
type Snapshot = Record<string, unknown>;

interface SnapshotState {
  readonly values: Snapshot;
  readonly jsonSignatures: Map<string, string>;
}

/** Запись трекера об одной сущности. */
export interface TrackedEntry {
  readonly entity: object;
  readonly model: EntityModel;
  state: EntityState;
  /** Снимок на момент загрузки/attach; отсутствует у Added. */
  snapshot?: Snapshot;
  /** Предвычисленные JSON-подписи snapshot-а, чтобы DetectChanges не сериализовал его повторно. */
  snapshotJsonSignatures?: Map<string, string>;
  /** Имена свойств, изменившихся относительно снимка (после DetectChanges). */
  modifiedProperties: Set<string>;
}

/**
 * Snapshot change tracking + identity-map.
 *
 * При загрузке/attach сохраняем копию значений; на `DetectChanges` сравниваем
 * текущие значения со снимком. Дополнительно ведётся карта идентичности по
 * (модель, значение ключа): повторная материализация той же строки возвращает
 * уже отслеживаемый инстанс (как `Find`/identity resolution в EF Core), что
 * исключает дубли объектов и рассинхрон трекинга.
 */
export class ChangeTracker {
  private readonly entries = new Map<object, TrackedEntry>();
  /** Explicit Update is an instruction to write every non-key column, even if no snapshot diff exists. */
  private readonly explicitUpdateSets = new WeakSet<Set<string>>();
  /** Вторичный индекс по ключу: model -> (keyValue -> entry). */
  private readonly identity = new Map<EntityModel, Map<string, TrackedEntry>>();

  constructor() { trackerEntries.set(this, this.entries); }

  /**
   * Регистрирует сущность, прочитанную из БД, как Unchanged. Возвращает
   * КАНОНИЧЕСКИЙ инстанс: если строка с таким ключом уже отслеживается,
   * вернётся ранее загруженный объект (а `entity` отбрасывается).
   */
  trackLoaded(entity: object, model: EntityModel): object {
    const keyValue = KeyTuple.fromEntity(model, entity as Record<string, unknown>);
    if (keyValue) {
      const existing = this.identityMap(model).get(keyValue.toString());
      if (existing) {
        return existing.entity; // уже отслеживается — канонический инстанс выигрывает
      }
    }
    if (this.entries.has(entity)) {
      return entity;
    }
    this.assertIdentityAvailable(entity, model, keyValue);
    const entry: TrackedEntry = {
      entity,
      model,
      state: EntityState.Unchanged,
      modifiedProperties: new Set(),
    };
    this.applySnapshot(entry, this.snapshot(entity, model));
    this.entries.set(entity, entry);
    this.indexByKey(entry, keyValue);
    return entity;
  }

  /**
   * Refreshes the canonical tracked instance from a locking query. Authorization
   * and the following mutation must observe the row version that was actually
   * locked, never an older identity-map snapshot.
   */
  trackReloaded(entity: object, model: EntityModel): object {
    const keyValue = KeyTuple.fromEntity(model, entity as Record<string, unknown>);
    const existing = !keyValue
      ? undefined
      : this.identityMap(model).get(keyValue.toString());
    if (!existing) {
      return this.trackLoaded(entity, model);
    }
    this.detectEntryChanges(existing);
    if (existing.state !== EntityState.Unchanged) {
      throw new OrmError(
        `Cannot refresh locked entity "${model.name}" while it has pending tracked changes.`,
      );
    }
    const source = entity as Record<string, unknown>;
    const target = existing.entity as Record<string, unknown>;
    for (const property of model.properties) {
      target[property.propertyName] = source[property.propertyName];
    }
    this.applySnapshot(existing, this.snapshot(existing.entity, model));
    existing.modifiedProperties = new Set();
    return existing.entity;
  }

  add(entity: object, model: EntityModel): void {
    // Ключ Added ещё не известен (генерируется БД) — индексируем после save.
    this.set(entity, model, EntityState.Added, undefined);
  }

  attach(entity: object, model: EntityModel): void {
    this.set(entity, model, EntityState.Unchanged, this.snapshot(entity, model));
  }

  update(entity: object, model: EntityModel): void {
    const entry = this.entries.get(entity) ?? this.set(entity, model, EntityState.Modified, this.snapshot(entity, model));
    this.assertKeyUnchanged(entry);
    entry.state = EntityState.Modified;
    // Явный Update без снимка-источника: считаем изменёнными все не-ключевые колонки.
    entry.modifiedProperties = new Set(
      model.properties.filter((property) => !property.isKey).map((property) => property.propertyName),
    );
    this.explicitUpdateSets.add(entry.modifiedProperties);
  }

  remove(entity: object, model: EntityModel): void {
    const existing = this.entries.get(entity);
    // Удаление ещё не сохранённой (Added) сущности — просто открепляем.
    if (existing?.state === EntityState.Added) {
      this.entries.delete(entity);
      this.unindexByKey(existing);
      return;
    }
    this.set(
      entity,
      model,
      EntityState.Deleted,
      existing?.snapshot
        ? { values: existing.snapshot, jsonSignatures: existing.snapshotJsonSignatures ?? new Map() }
        : this.snapshot(entity, model),
    );
  }

  /**
   * Сравнивает текущие значения отслеживаемых Unchanged/Modified сущностей со
   * снимками и помечает изменённые свойства. Вызывается перед SaveChanges.
   */
  detectChanges(): void {
    for (const entry of this.entries.values()) {
      this.detectEntryChanges(entry);
    }
    assertUniqueTrackedKeys(this);
  }

  private detectEntryChanges(entry: TrackedEntry): void {
    if (entry.snapshot && entry.state !== EntityState.Added) {
      this.assertKeyUnchanged(entry);
    }
    if (entry.state !== EntityState.Unchanged && entry.state !== EntityState.Modified) {
      return;
    }
    const snapshot = entry.snapshot;
    if (!snapshot) {
      return;
    }
    const current = entry.entity as Record<string, unknown>;
    const explicitUpdate = this.explicitUpdateSets.has(entry.modifiedProperties);
    const modified = new Set<string>();
    for (const property of entry.model.properties) {
      if (property.isKey) {
        continue;
      }
      const name = property.propertyName;
      if (!valuesEqual(current[name], snapshot[name], property, entry.snapshotJsonSignatures?.get(name))) {
        modified.add(name);
      }
    }
    if (explicitUpdate) {
      for (const property of entry.model.properties) if (!property.isKey) modified.add(property.propertyName);
    }
    entry.modifiedProperties = modified;
    if (explicitUpdate) this.explicitUpdateSets.add(modified);
    entry.state = modified.size > 0 ? EntityState.Modified : EntityState.Unchanged;
  }

  entriesToProcess(): TrackedEntry[] {
    const pending: TrackedEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === EntityState.Added || entry.state === EntityState.Modified || entry.state === EntityState.Deleted) {
        pending.push(entry);
      }
    }
    return pending;
  }

  stateOf(entity: object): EntityState {
    return this.entries.get(entity)?.state ?? EntityState.Detached;
  }

  /** Возвращает отслеживаемую (не удалённую) сущность по ключу, если есть. */
  tryGetByKey(model: EntityModel, key: unknown): object | undefined {
    if (key === null || key === undefined) {
      return undefined;
    }
    const entry = this.identityMap(model).get(KeyTuple.fromInput(model, key).toString());
    return entry && entry.state !== EntityState.Deleted ? entry.entity : undefined;
  }

  /** Применяет результат успешного сохранения: фиксирует новый снимок/состояние. */
  acceptChanges(entry: TrackedEntry): void {
    if (entry.state === EntityState.Deleted) {
      this.entries.delete(entry.entity);
      this.unindexByKey(entry);
      return;
    }
    const key = KeyTuple.fromEntity(entry.model, entry.entity as Record<string, unknown>);
    this.assertIdentityAvailable(entry.entity, entry.model, key);
    const snapshot = this.snapshot(entry.entity, entry.model);
    entry.state = EntityState.Unchanged;
    this.applySnapshot(entry, snapshot);
    entry.modifiedProperties = new Set();
    // Added получил сгенерированный ключ — индексируем для identity resolution.
    this.indexByKey(entry, key);
  }

  /**
   * Restores an Added entry whose database-generated key was assigned while a
   * transaction was running and subsequently rolled back. This also repairs
   * the identity map when SaveChanges had provisionally accepted the entry
   * inside an ambient user transaction.
   */
  restoreAddedAfterRollback(entry: TrackedEntry, originalKey: unknown): void {
    const entity = entry.entity as Record<string, unknown>;
    const currentKey = KeyTuple.fromEntity(entry.model, entity);
    if (currentKey) {
      const identity = this.identityMap(entry.model);
      if (identity.get(currentKey.toString()) === entry) {
        identity.delete(currentKey.toString());
      }
    }
    if (entry.model.key.length === 1) entity[entry.model.key[0].propertyName] = originalKey;
    entry.state = EntityState.Added;
    entry.snapshot = undefined;
    entry.snapshotJsonSignatures = undefined;
    entry.modifiedProperties = new Set();
    this.entries.set(entry.entity, entry);
  }

  clear(): void {
    this.entries.clear();
    this.identity.clear();
  }

  private set(entity: object, model: EntityModel, state: EntityState, snapshot: SnapshotState | undefined): TrackedEntry {
    // Generated Added keys are placeholders until INSERT ... RETURNING. Manual
    // Added keys can still change before saving, but cannot replace a loaded row.
    const key = state === EntityState.Added && hasGeneratedKey(model)
      ? undefined : KeyTuple.fromEntity(model, entity as Record<string, unknown>);
    this.assertIdentityAvailable(entity, model, key);
    let entry = this.entries.get(entity);
    if (entry) {
      this.assertKeyUnchanged(entry);
      this.unindexByKey(entry);
      entry.state = state;
      this.applySnapshot(entry, snapshot);
    } else {
      entry = { entity, model, state, modifiedProperties: new Set() };
      this.applySnapshot(entry, snapshot);
      this.entries.set(entity, entry);
    }
    // Индексируем по ключу всё, кроме Added (его ключ ещё не определён).
    if (state !== EntityState.Added) {
      this.indexByKey(entry, key);
    }
    return entry;
  }

  private identityMap(model: EntityModel): Map<string, TrackedEntry> {
    let map = this.identity.get(model);
    if (!map) {
      map = new Map();
      this.identity.set(model, map);
    }
    return map;
  }

  private indexByKey(entry: TrackedEntry, keyValue: KeyTuple | undefined): void {
    if (keyValue) {
      this.assertIdentityAvailable(entry.entity, entry.model, keyValue);
      this.identityMap(entry.model).set(keyValue.toString(), entry);
    }
  }

  private assertIdentityAvailable(entity: object, model: EntityModel, key: KeyTuple | undefined): void {
    if (!key) return;
    const existing = this.identity.get(model)?.get(key.toString());
    if (existing && existing.entity !== entity) throw duplicateIdentity(model);
    const held = deletedIdentities.get(this)?.get(model)?.get(key.toString());
    if (held && held.entity !== entity) throw duplicateIdentity(model);
  }

  private unindexByKey(entry: TrackedEntry): void {
    const keyValue = KeyTuple.fromEntity(entry.model, entry.entity as Record<string, unknown>);
    if (keyValue && this.identity.get(entry.model)?.get(keyValue.toString()) === entry) {
      this.identityMap(entry.model).delete(keyValue.toString());
    }
  }

  private applySnapshot(entry: TrackedEntry, snapshot: SnapshotState | undefined): void {
    entry.snapshot = snapshot?.values;
    entry.snapshotJsonSignatures = snapshot?.jsonSignatures;
  }

  private snapshot(entity: object, model: EntityModel): SnapshotState {
    const source = entity as Record<string, unknown>;
    const snapshot: Snapshot = {};
    const jsonSignatures = new Map<string, string>();
    for (const property of model.properties) {
      const value = source[property.propertyName];
      // json-колонки мутабельны: клонируем снимок, иначе мутация "на месте"
      // (entity.meta.x = 1) сделает снимок равным текущему и не задетектится.
      if (property.type === "json") {
        const cloned = cloneJson(value);
        snapshot[property.propertyName] = cloned;
        jsonSignatures.set(property.propertyName, jsonSignature(cloned));
      } else if ((property.type === "datetime" || property.isKey) && value instanceof Date) {
        snapshot[property.propertyName] = new Date(value.getTime());
      } else if (property.isKey && value instanceof Uint8Array) {
        // KeyTuple compares byte content. Its snapshot must not retain mutable key bytes.
        snapshot[property.propertyName] = new Uint8Array(value);
      } else {
        snapshot[property.propertyName] = value;
      }
    }
    return { values: snapshot, jsonSignatures };
  }

  private assertKeyUnchanged(entry: TrackedEntry): void {
    if (!entry.snapshot || entry.state === EntityState.Added) return;
    const original = KeyTuple.fromEntity(entry.model, entry.snapshot);
    const current = KeyTuple.fromEntity(entry.model, entry.entity as Record<string, unknown>);
    if (!original || !current || !original.equals(current)) {
      throw new DbUpdateError(`Primary key for tracked entity "${entry.model.name}" cannot be changed.`);
    }
  }
}

/** Non-barrel helper used only by immediate DML admission. */
export function hasTrackedEntriesForModel(tracker: ChangeTracker, model: EntityModel): boolean {
  return [...(trackerEntries.get(tracker)?.values() ?? [])].some((entry) => entry.model === model);
}

const trackerEntries = new WeakMap<ChangeTracker, Map<object, TrackedEntry>>();
const deletedIdentities = new WeakMap<ChangeTracker, Map<EntityModel, Map<string, { entity: object; count: number }>>>();

/** Non-barrel rollback ownership: a provisionally deleted row can still be
 * restored by its transaction. Keep its canonical identity until that outcome. */
export function holdDeletedIdentity(tracker: ChangeTracker, entry: TrackedEntry): () => void {
  if (entry.state !== EntityState.Deleted) return () => {};
  const key = KeyTuple.fromEntity(entry.model, entry.entity as Record<string, unknown>)?.toString();
  if (key === undefined) return () => {};
  let models = deletedIdentities.get(tracker);
  if (!models) { models = new Map(); deletedIdentities.set(tracker, models); }
  let keys = models.get(entry.model);
  if (!keys) { keys = new Map(); models.set(entry.model, keys); }
  const held = keys.get(key) ?? { entity: entry.entity, count: 0 };
  held.count++;
  keys.set(key, held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.count === 0) keys!.delete(key);
    if (keys!.size === 0) models!.delete(entry.model);
    if (models!.size === 0) deletedIdentities.delete(tracker);
  };
}

/** Non-barrel save preflight. Added keys remain mutable until save; generated
 * placeholders are excluded until the caller has collected every RETURNING row.
 * Validate the whole batch before accepting any entry or committing the SQL. */
export function assertUniqueTrackedKeys(tracker: ChangeTracker, generated: readonly TrackedEntry[] = []): void {
  const returned = new Set(generated);
  const identities = new Map<EntityModel, Map<string, object>>();
  for (const [model, held] of deletedIdentities.get(tracker) ?? []) {
    identities.set(model, new Map([...held].map(([key, value]) => [key, value.entity])));
  }
  for (const entry of trackerEntries.get(tracker)?.values() ?? []) {
    if (entry.state === EntityState.Added && hasGeneratedKey(entry.model) && !returned.has(entry)) continue;
    const key = KeyTuple.fromEntity(entry.model, entry.entity as Record<string, unknown>)?.toString();
    if (key === undefined) continue;
    let modelKeys = identities.get(entry.model);
    if (!modelKeys) { modelKeys = new Map(); identities.set(entry.model, modelKeys); }
    const existing = modelKeys.get(key);
    if (existing && existing !== entry.entity) throw duplicateIdentity(entry.model);
    modelKeys.set(key, entry.entity);
  }
}

function hasGeneratedKey(model: EntityModel): boolean {
  return model.key.length === 1 && model.key[0].generation !== "none";
}

function duplicateIdentity(model: EntityModel): DbUpdateError {
  return new DbUpdateError(`Another instance of entity "${model.name}" with the same primary key is already tracked.`);
}

/** Сравнение значения свойства со снимком (структурное для json). */
function valuesEqual(current: unknown, snapshot: unknown, property: PropertyModel, snapshotJsonSignature?: string): boolean {
  if (property.type === "json") {
    return jsonEqual(current, snapshot, snapshotJsonSignature);
  }
  if (property.type === "datetime" && current instanceof Date && snapshot instanceof Date) {
    return Object.is(current.getTime(), snapshot.getTime());
  }
  return Object.is(current, snapshot);
}

function cloneJson(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function jsonEqual(a: unknown, b: unknown, snapshotSignature?: string): boolean {
  if (a === b) {
    return true;
  }
  if (snapshotSignature !== undefined) {
    return jsonSignature(a) === snapshotSignature;
  }
  return jsonSignature(a) === jsonSignature(b);
}

function jsonSignature(value: unknown): string {
  return JSON.stringify(value ?? null);
}
