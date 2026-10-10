import { types } from "node:util";
import { OrmError, OrmTrackedMutationConflictError, OrmUndeclaredConflictTargetError, OrmUnsafeImmediateMutationError } from "../errors";
import { isDatabaseGenerated, type EntityModel, type PropertyModel } from "../Metadata/types";
import type { DbContextRuntime } from "../runtime";
import { hasTrackedEntriesForModel } from "../Tracking/ChangeTracker";
import { isPostgresJsonScalarParameter } from "../Providers/PostgresDialect";
import type { SqlParam } from "../Providers/types";
import type { QueryPlan } from "./QueryPlan";
import { Operand, type Condition, type FieldSelector } from "./conditions";
import { SqlTranslator } from "./SqlTranslator";

export interface OrmMutationResultV1 { readonly affectedRows: number; }
export interface OrmInsertIfAbsentResultV1 { readonly inserted: boolean; }
export type OrmUpdateValuesV1<T extends object> = Readonly<Partial<T>>;
export type OrmUniqueKeySelectorV1<T extends object> = (entity: FieldSelector<T>) => readonly Pick<Operand, "property">[];

export function executeImmediateUpdate<T extends object>(model: EntityModel, runtime: DbContextRuntime, plan: QueryPlan, values: OrmUpdateValuesV1<T>): Promise<OrmMutationResultV1> {
  return runtime.runImmediateOperation(async () => {
    guard(model, runtime); const admittedPlan = admitPlan(plan, "executeUpdate");
    const conditions = effectiveConditions(model, admittedPlan); const assignments = encodeAssignments(runtime, admitUpdateValues(model, values));
    const compiled = new SqlTranslator(model, runtime.provider.dialect).immediateUpdate(assignments, conditions, (property, value) => encode(runtime, property, snapshot(value), true));
    Object.freeze(compiled.params);
    guard(model, runtime);
    const result = await runtime.provider.execute(compiled.sql, compiled.params);
    return Object.freeze({ affectedRows: count(result.changes) });
  });
}

export function executeImmediateDelete(model: EntityModel, runtime: DbContextRuntime, plan: QueryPlan): Promise<OrmMutationResultV1> {
  return runtime.runImmediateOperation(async () => {
    guard(model, runtime); const admittedPlan = admitPlan(plan, "executeDelete"); const conditions = effectiveConditions(model, admittedPlan);
    const compiled = new SqlTranslator(model, runtime.provider.dialect).immediateDelete(conditions, (property, value) => encode(runtime, property, snapshot(value), true));
    Object.freeze(compiled.params);
    guard(model, runtime);
    const result = await runtime.provider.execute(compiled.sql, compiled.params);
    return Object.freeze({ affectedRows: count(result.changes) });
  });
}

export function insertIfAbsent<T extends object>(model: EntityModel, runtime: DbContextRuntime, entity: T, options: { readonly conflictBy: OrmUniqueKeySelectorV1<T> }): Promise<OrmInsertIfAbsentResultV1> {
  return runtime.runImmediateOperation(async () => {
    guard(model, runtime); if (runtime.provider.dialect.name !== "postgres") unsafe();
    const admitted = admitInsertValues(model, entity); const columns = conflictTarget(model, options); const values = encodeAssignments(runtime, admitted);
    const compiled = new SqlTranslator(model, runtime.provider.dialect).immediateInsert(values, columns);
    Object.freeze(compiled.params);
    guard(model, runtime);
    const result = await runtime.provider.execute(compiled.sql, compiled.params);
    const changes = count(result.changes);
    if (changes !== 0 && changes !== 1) throw new OrmError("ORM provider returned an invalid immediate mutation count.");
    return Object.freeze({ inserted: changes === 1 });
  });
}

function guard(model: EntityModel, runtime: DbContextRuntime): void {
  if (hasTrackedEntriesForModel(runtime.tracker, model)) throw new OrmTrackedMutationConflictError(model.name);
}
interface AdmittedImmediatePlan { readonly explicitConditions: readonly Condition[]; readonly ignoreQueryFilters: boolean; }
function admitPlan(plan: QueryPlan, terminal: "executeUpdate" | "executeDelete"): AdmittedImmediatePlan {
  try {
    if (types.isProxy(plan) || typeof plan !== "object" || plan === null || Object.getPrototypeOf(plan) !== Object.prototype) unsafe();
    const fields = Object.getOwnPropertyDescriptors(plan); const names = Object.getOwnPropertyNames(plan); if (Object.getOwnPropertySymbols(plan).length !== 0) unsafe();
    explainPlan(fields, terminal);
    const required = ["conditions", "orders", "noTracking", "includes", "ignoreQueryFilters", "projections"];
    const optional = ["limit", "requestedLimit", "invalidRequestedLimit", "offset", "rowLock", "skipLocked"];
    if (names.length !== required.length || required.some((key) => !Object.prototype.hasOwnProperty.call(fields, key)) || optional.some((key) => Object.prototype.hasOwnProperty.call(fields, key))) unsafe();
    for (const key of required) if (!("value" in fields[key]!)) unsafe();
    if (fields.noTracking!.value !== true || typeof fields.ignoreQueryFilters!.value !== "boolean") unsafe();
    const empty = (value: unknown) => { if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) unsafe(); const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value as object); if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== 1 || !("value" in descriptors.length!) || descriptors.length!.value !== 0) unsafe(); };
    empty(fields.orders!.value); empty(fields.includes!.value); empty(fields.projections!.value);
    const explicitConditions = readConditionList(fields.conditions!.value); if (explicitConditions.length === 0) unsafe();
    return Object.freeze({ explicitConditions: Object.freeze(explicitConditions), ignoreQueryFilters: fields.ignoreQueryFilters!.value });
  } catch (error) { if (error instanceof OrmUnsafeImmediateMutationError) throw error; unsafe(); }
}
/** Names the query method that an immediate mutation does not accept; reads data descriptors only. */
function explainPlan(fields: Record<string, PropertyDescriptor>, terminal: string): void {
  const valueOf = (key: string) => { const descriptor = fields[key]; return descriptor && "value" in descriptor ? descriptor.value as unknown : undefined; };
  const length = (key: string) => { const value = valueOf(key); return Array.isArray(value) && !types.isProxy(value) ? Object.getOwnPropertyDescriptor(value, "length")?.value as unknown : undefined; };
  if (valueOf("noTracking") !== true) unsafe(`call .asNoTracking() before ${terminal}(); immediate mutations bypass the change tracker`);
  if (["limit", "requestedLimit", "invalidRequestedLimit", "offset"].some((key) => key in fields)) unsafe(`${terminal}() does not accept take() or skip(); narrow the rows with where(...)`);
  if ("rowLock" in fields || "skipLocked" in fields) unsafe(`${terminal}() does not accept forUpdate()`);
  for (const [key, method] of [["orders", "orderBy()"], ["includes", "include()"], ["projections", "select()"]] as const) {
    const size = length(key); if (typeof size === "number" && size > 0) unsafe(`${terminal}() does not accept ${method}`);
  }
  if (length("conditions") === 0) unsafe(`add .where(...) before ${terminal}(); changing every row of a table is not allowed, use raw SQL for that`);
}
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new OrmError("ORM provider returned an invalid immediate mutation count."); return value as number; }
function unsafe(reason?: string): never { throw new OrmUnsafeImmediateMutationError(reason); }
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof Uint8Array) return "Uint8Array";
  return typeof value;
}
function functionValue(name: string): never { unsafe(`"${name}" must be a value, got a function; expressions such as views + 1 are not supported, use raw SQL for them`); }

interface AdmittedAssignment { readonly property: PropertyModel; readonly value: unknown; }
function admitUpdateValues<T extends object>(model: EntityModel, values: OrmUpdateValuesV1<T>): readonly AdmittedAssignment[] {
  if (!plain(values)) unsafe('pass the new values as a plain object, for example { status: "archived" }');
  const descriptors = ownData(values); const keys = [...descriptors.keys()]; if (keys.length === 0) unsafe("pass at least one property to set");
  const out: AdmittedAssignment[] = [];
  for (const key of keys) {
    const descriptor = descriptors.get(key)!;
    const property = model.propertyByName(key);
    if (!property) unsafe(`"${key}" is not a mapped property of ${model.name}`);
    if (property.isKey) unsafe(`"${key}" is the primary key of ${model.name} and cannot be changed`);
    if (property.generation !== "none" || property.convention) unsafe(`"${key}" is filled automatically and cannot be set`);
    if (descriptor.value === undefined) unsafe(`"${key}" is undefined; omit it or pass a value`);
    if (descriptor.value === null) {
      if (property.required) unsafe(`"${key}" is required (NOT NULL) and cannot be set to null`);
      out.push(Object.freeze({ property, value: null })); continue;
    }
    if (typeof descriptor.value === "function") functionValue(key);
    out.push(Object.freeze({ property, value: snapshot(descriptor.value) }));
  }
  return Object.freeze(out.map((value) => Object.freeze(value)));
}
function admitInsertValues<T extends object>(model: EntityModel, entity: T): readonly AdmittedAssignment[] {
  if (!objectInput(entity)) unsafe("pass an entity object to insertIfAbsent()");
  const descriptors = ownData(entity);
  const out: AdmittedAssignment[] = [];
  for (const property of model.properties) {
    const descriptor = descriptors.get(property.propertyName);
    // An unset generated key is assigned as by saveChanges(); the caller's entity stays unchanged.
    if (property.isKey && model.key.length === 1 && unsetKey(descriptor?.value)) {
      if (isDatabaseGenerated(property.generation)) continue;
      if (property.generation === "uuidV7") { out.push(Object.freeze({ property, value: Bun.randomUUIDv7() })); continue; }
    }
    if (!descriptor || descriptor.value === undefined) unsafe(`"${property.propertyName}" is missing; pass an entity with every mapped property of ${model.name}`);
    if (descriptor.value === null) { if (property.required) unsafe(`"${property.propertyName}" is required (NOT NULL); got null`); out.push(Object.freeze({ property, value: null })); continue; }
    if (typeof descriptor.value === "function") functionValue(property.propertyName);
    out.push(Object.freeze({ property, value: snapshot(descriptor.value) }));
  }
  return Object.freeze(out.map((value) => Object.freeze(value)));
}
function unsetKey(value: unknown): boolean { return value === undefined || value === null || value === "" || value === 0; }
function encodeAssignments(runtime: DbContextRuntime, assignments: readonly AdmittedAssignment[]): readonly { readonly property: PropertyModel; readonly value: SqlParam }[] {
  return Object.freeze(assignments.map(({ property, value }) => Object.freeze({ property, value: value === null ? null : encode(runtime, property, value) })));
}
function encode(runtime: DbContextRuntime, property: PropertyModel, input: unknown, allowNull = false): SqlParam {
  try {
    const providerValue = property.converter ? property.converter.toProvider(input) : input;
    const safeProvider = storageValue(providerValue, property.type, allowNull);
    return snapshotEncodedSqlParam(runtime.provider.dialect.encode(safeProvider, property.type));
  } catch {
    // Hostile inputs keep the generic message; describing them could run their traps.
    if (typeof input === "object" && input !== null && types.isProxy(input)) unsafe();
    unsafe(property.converter ? `"${property.propertyName}" could not be converted for its ${property.type} column` : `"${property.propertyName}" expects ${property.type}, got ${describeValue(input)}`);
  }
}

function conflictTarget<T extends object>(model: EntityModel, options: { readonly conflictBy: OrmUniqueKeySelectorV1<T> }): readonly string[] {
  if (!plain(options)) unsafe();
  const optionDescriptors = ownData(options); if (optionDescriptors.size !== 1) unsafe();
  const callback = optionDescriptors.get("conflictBy")?.value; if (typeof callback !== "function" || types.isProxy(callback)) unsafe();
  const issued = new WeakMap<Operand, string>();
  const selector = new Proxy({}, { get(_target, property) { const operand = new Operand(String(property)); issued.set(operand, String(property)); return operand; } }) as FieldSelector<T>;
  let target: readonly Operand[];
  try { target = callback(selector); } catch { unsafe(); }
  if (!Array.isArray(target) || types.isProxy(target) || Object.getPrototypeOf(target) !== Array.prototype) unsafe();
  const targetDescriptors = ownData(target); const length = Object.getOwnPropertyDescriptor(target, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || targetDescriptors.size !== length + 1) unsafe();
  const properties: string[] = [];
  for (let index = 0; index < length; index += 1) { const operand = targetDescriptors.get(String(index))?.value; if (typeof operand !== "object" || operand === null || types.isProxy(operand)) unsafe(); const property = issued.get(operand as Operand); if (!property) unsafe(); properties.push(property); }
  if (new Set(properties).size !== properties.length) throw new OrmUndeclaredConflictTargetError();
  const columns = properties.map((name) => model.propertyByName(name)?.columnName);
  if (columns.some((column) => column === undefined)) throw new OrmUndeclaredConflictTargetError();
  const candidates = [model.key.map((property) => property.columnName), ...model.indexes.filter((index) => index.unique).map((index) => index.columns)];
  if (!candidates.some((candidate) => candidate.length === columns.length && candidate.every((column, index) => column === columns[index]))) throw new OrmUndeclaredConflictTargetError();
  return Object.freeze(columns as string[]);
}

function effectiveConditions(model: EntityModel, plan: AdmittedImmediatePlan): readonly Condition[] {
  const source: Condition[] = plan.ignoreQueryFilters ? [] : readConditionList(model.queryFilters);
  if (!plan.ignoreQueryFilters && model.softDeleteProperty) source.push({ kind: "null", property: model.softDeleteProperty, negated: false });
  source.push(...plan.explicitConditions); const active = new Set<object>(); const memo = new WeakMap<object, Condition>();
  return Object.freeze(source.map((condition) => cloneCondition(model, condition, active, memo)));
}
function readConditionList(value: unknown): Condition[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) unsafe(); const fields = ownData(value); const length = fields.get("length")?.value; if (!Number.isSafeInteger(length) || length < 0 || fields.size !== length + 1) unsafe(); const result: Condition[] = []; for (let index = 0; index < length; index += 1) { const descriptor = fields.get(String(index)); if (!descriptor) unsafe(); result.push(descriptor.value as Condition); } return result;
}
function cloneCondition(model: EntityModel, input: unknown, active: Set<object>, memo: WeakMap<object, Condition>): Condition {
  if (!plain(input) || active.has(input)) unsafe(); if (memo.has(input)) return memo.get(input)!; active.add(input);
  const fields = ownData(input); const kind = fields.get("kind")?.value;
  const exact = (...keys: string[]) => { if (fields.size !== keys.length || keys.some((key) => !fields.has(key))) unsafe(); };
  const property = () => { const value = fields.get("property")?.value; if (typeof value !== "string" || !model.propertyByName(value)) unsafe(); return value; };
  let result: Condition;
  if (kind === "compare") { const escaped = fields.get("escaped")?.value; if (escaped !== undefined && escaped !== true) unsafe(); exact(...(escaped === undefined ? ["kind", "property", "op", "value"] : ["kind", "property", "op", "value", "escaped"])); const op = fields.get("op")!.value; if (typeof op !== "string" || !["=", "<>", ">", ">=", "<", "<=", "LIKE", "ILIKE"].includes(op) || (escaped === true && op !== "LIKE" && op !== "ILIKE")) unsafe(); result = Object.freeze({ kind: "compare", property: property(), op: op as never, value: snapshot(fields.get("value")!.value, new Set(), new WeakMap(), true), ...(escaped === true ? { escaped: true } : {}) }); }
  else if (kind === "in") { exact("kind", "property", "values"); result = Object.freeze({ kind: "in", property: property(), values: denseValues(fields.get("values")!.value) }); }
  else if (kind === "tuples") { exact("kind", "properties", "values"); const properties = denseValues(fields.get("properties")!.value); if (properties.some((value) => typeof value !== "string" || !model.propertyByName(value as string))) unsafe(); const rows = denseValues(fields.get("values")!.value).map((row) => { const values = denseValues(row); if (values.length !== properties.length) unsafe(); return Object.freeze(values); }); result = Object.freeze({ kind: "tuples", properties: Object.freeze(properties as string[]), values: Object.freeze(rows) }); }
  else if (kind === "null") { exact("kind", "property", "negated"); const negated = fields.get("negated")!.value; if (typeof negated !== "boolean") unsafe(); result = Object.freeze({ kind: "null", property: property(), negated }); }
  else if (kind === "and" || kind === "or") { exact("kind", "left", "right"); const provisional = {} as Condition; memo.set(input, provisional); result = Object.freeze({ kind, left: cloneCondition(model, fields.get("left")!.value, active, memo), right: cloneCondition(model, fields.get("right")!.value, active, memo) }); }
  else if (kind === "not") { exact("kind", "inner"); result = Object.freeze({ kind: "not", inner: cloneCondition(model, fields.get("inner")!.value, active, memo) }); }
  else unsafe();
  active.delete(input); memo.set(input, result!); return result!;
}
function denseValues(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) unsafe(); const fields = ownData(value); const length = fields.get("length")?.value; if (!Number.isSafeInteger(length) || length < 0 || fields.size !== length + 1) unsafe(); const result: unknown[] = []; for (let index = 0; index < length; index += 1) result.push(snapshot(fields.get(String(index))?.value, new Set(), new WeakMap(), true)); return Object.freeze(result);
}

function ownData(value: object): Map<string, PropertyDescriptor & { readonly value: unknown }> {
  try {
    const result = new Map<string, PropertyDescriptor & { readonly value: unknown }>();
    for (const key of Reflect.ownKeys(value)) { if (typeof key !== "string") unsafe(); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) unsafe(); result.set(key, descriptor as PropertyDescriptor & { readonly value: unknown }); }
    return result;
  } catch { unsafe(); }
}
function plain(value: unknown): value is Record<string, unknown> { return objectInput(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function objectInput(value: unknown): value is Record<string, unknown> { try { return typeof value === "object" && value !== null && !Array.isArray(value) && !types.isProxy(value); } catch { unsafe(); } }
const CapturedDate = Date;
const capturedDatePrototype = CapturedDate.prototype;
const intrinsicDateToJson = capturedDatePrototype.toJSON, intrinsicDateGetTime = capturedDatePrototype.getTime;
const CapturedUint8Array = Uint8Array;
const capturedUint8ArrayPrototype = CapturedUint8Array.prototype;
const capturedUint8ArraySet = capturedUint8ArrayPrototype.set;
const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(capturedUint8ArrayPrototype), "length")!.get!;
function snapshot(value: unknown, active = new Set<object>(), memo = new WeakMap<object, unknown>(), freeze = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) unsafe(); return value; }
  if (typeof value !== "object" || types.isProxy(value)) unsafe();
  if (active.has(value)) unsafe(); if (memo.has(value)) return memo.get(value)!;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === capturedDatePrototype) { const descriptor = Object.getOwnPropertyDescriptor(capturedDatePrototype, "toJSON"); if (!descriptor || !("value" in descriptor) || descriptor.value !== intrinsicDateToJson || Reflect.ownKeys(value).length !== 0) unsafe(); let time: number; try { time = intrinsicDateGetTime.call(value as Date); } catch { unsafe(); } if (!Number.isFinite(time)) unsafe(); return new CapturedDate(time); }
  if (prototype === capturedUint8ArrayPrototype) { try { const names = Object.getOwnPropertyNames(value); const length = typedArrayLength.call(value); if (names.length !== length || names.some((name, index) => name !== String(index)) || Object.getOwnPropertySymbols(value).length) unsafe(); const copy = new CapturedUint8Array(length); capturedUint8ArraySet.call(copy, value as Uint8Array); return copy; } catch { unsafe(); } }
  active.add(value);
  if (Array.isArray(value)) { if (prototype !== Array.prototype || unsafeToJson(prototype)) unsafe(); const descriptors = ownData(value); const length = descriptors.get("length")?.value; if (!Number.isSafeInteger(length) || length < 0 || descriptors.size !== length + 1) unsafe(); const result: unknown[] = new Array(length); memo.set(value, result); for (let index = 0; index < length; index += 1) result[index] = snapshot(descriptors.get(String(index))?.value, active, memo, freeze); active.delete(value); return freeze ? Object.freeze(result) : result; }
  if (!plain(value) || unsafeToJson(prototype)) unsafe(); const descriptors = ownData(value); const ownToJson = descriptors.get("toJSON")?.value; if (typeof ownToJson === "function") unsafe(); const result: Record<string, unknown> = Object.create(prototype); memo.set(value, result);
  for (const [key, descriptor] of descriptors) Object.defineProperty(result, key, { value: snapshot(descriptor.value, active, memo, freeze), enumerable: descriptor.enumerable, configurable: false, writable: !freeze });
  active.delete(value); return freeze ? Object.freeze(result) : result;
}
function unsafeToJson(prototype: object | null): boolean {
  for (let current = prototype; current !== null; current = Object.getPrototypeOf(current)) { const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON"); if (descriptor && (!("value" in descriptor) || typeof descriptor.value === "function")) return true; }
  return false;
}
function storageValue(value: unknown, type: PropertyModel["type"], allowNull = false): SqlParam {
  if (value === null && allowNull) return null;
  const safe = snapshot(value, new Set(), new WeakMap(), true);
  if (type === "text" && typeof safe !== "string") unsafe();
  if (type === "boolean" && typeof safe !== "boolean") unsafe();
  if (type === "integer" && !(typeof safe === "bigint" ? safe >= -9223372036854775808n && safe <= 9223372036854775807n : typeof safe === "number" && Number.isSafeInteger(safe))) unsafe();
  if (type === "real" && !(typeof safe === "number" && Number.isFinite(safe))) unsafe();
  if (type === "datetime" && (typeof safe !== "object" || safe === null || Object.getPrototypeOf(safe) !== capturedDatePrototype)) unsafe();
  if (type === "json" && !jsonValue(safe)) unsafe();
  return safe as SqlParam;
}
function snapshotEncodedSqlParam(value: unknown): SqlParam {
  if (isPostgresJsonScalarParameter(value)) return value;
  const copy = (current: unknown, nested: boolean, active = new Set<object>()): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") { if (!Number.isFinite(current)) unsafe(); return current; }
    if (typeof current === "bigint") { if (nested) unsafe(); return current; }
    if (typeof current !== "object" || types.isProxy(current)) unsafe();
    if (active.has(current)) unsafe();
    const prototype = Object.getPrototypeOf(current);
    if (prototype === capturedDatePrototype || prototype === capturedUint8ArrayPrototype) { if (nested) unsafe(); return snapshot(current, new Set(), new WeakMap(), true); }
    active.add(current);
    if (Array.isArray(current)) { if (prototype !== Array.prototype || unsafeToJson(prototype)) unsafe(); const fields = ownData(current); const length = fields.get("length")?.value; if (!Number.isSafeInteger(length) || length < 0 || fields.size !== length + 1) unsafe(); const result = new Array<unknown>(length); for (let index = 0; index < length; index += 1) result[index] = copy(fields.get(String(index))?.value, true, active); active.delete(current); return Object.freeze(result); }
    if (!plain(current) || unsafeToJson(prototype)) unsafe(); const result: Record<string, unknown> = Object.create(prototype); for (const [key, descriptor] of ownData(current)) Object.defineProperty(result, key, { value: copy(descriptor.value, true, active), enumerable: descriptor.enumerable, writable: false, configurable: false }); active.delete(current); return Object.freeze(result);
  };
  return copy(value, false) as SqlParam;
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (plain(value)) return [...ownData(value).values()].every((descriptor) => jsonValue(descriptor.value));
  return false;
}
