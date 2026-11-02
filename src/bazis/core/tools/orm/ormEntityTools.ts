import { Tool, ToolError, type AgentToolExecutionContext } from "../../agent";
import { type Class, ServiceProvider } from "../../di";
import { registerFrameworkClassDeps } from "../../di/module/autoDeps";
import { ModelBuilder, type DbContext, type DbSet, type EntityModel, type FieldSelector, type Operand, type Predicate, type PropertyModel } from "../../orm";

/** What a process may do with an entity. */
export type OrmEntityOperation = "find" | "create" | "update" | "delete";

export interface OrmEntityToolsOptions {
  /** The context of the entity, from `@Module({ ormBazis })`. */
  readonly context: Class<DbContext>;
  readonly ops: readonly OrmEntityOperation[];
  /** The only fields a Tool reads, filters by, sorts by and writes. The key is always read and filtered by, never written. */
  readonly fields: readonly string[];
  /**
   * Ties the Tools to the partition of the instance: every query is filtered by it,
   * a new record takes it, an instance without a partition is refused. The field
   * is neither read nor written by hand.
   */
  readonly partitionField?: string;
  /** Who may call the Tools; `["workflow"]` by default. */
  readonly callers?: readonly string[];
  /** The middle of the Tool names: `orm.<name>.find`. By default from the class: `OrderItem` → `order-item`. */
  readonly name?: string;
  /** The most records `find` returns, 1–1000; 100 by default. */
  readonly maxRows?: number;
  /** The most records one `update` or `delete` touches, or it is refused with `too_many_records`; 100 by default. */
  readonly maxChanges?: number;
}

/** What the reference kinds `orm.entity` and `orm.field` read about a made Tool. */
export interface OrmEntityToolInfo {
  readonly entity: string;
  readonly fields: readonly string[];
}

const INFO = new WeakMap<object, OrmEntityToolInfo>();

/** Which entity a Tool made by {@link ormEntityTools} opens. */
export function ormEntityToolInfo(tool: object): OrmEntityToolInfo | undefined {
  return INFO.get(tool);
}

const TOOL_NAME_PART = /^[a-z][a-z0-9_-]*$/;
const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "startsWith", "isNull"]);

type Json = Record<string, unknown>;
type EntityClass<T extends object> = new () => T;

interface Spec {
  readonly model: EntityModel;
  readonly entity: EntityClass<object>;
  readonly context: Class<DbContext>;
  readonly name: string;
  /** Fields that may be written. */
  readonly writable: ReadonlySet<string>;
  /** Fields that are read and filtered by: the key and the writable ones. */
  readonly readable: readonly string[];
  readonly partitionField: string | undefined;
  readonly maxRows: number;
  readonly maxChanges: number;
}

type Run = (set: DbSet<object>, input: Json, context: AgentToolExecutionContext, db: DbContext) => Promise<unknown>;

/**
 * Tools `orm.<entity>.find|create|update|delete` over an entity of the application
 * (WORKFLOW-002 §7.4). Nothing is open by itself: the application names the
 * operations and the fields. The result goes to `@Module({ tools })`, and the
 * module imports `StandardToolsModule` for the reference kinds `orm.entity` and
 * `orm.field`. All of them run with `context.dryRun`: nothing is written then.
 *
 * ```ts
 * @Module({ imports: [StandardToolsModule], tools: [...ormEntityTools(Order, { context: OrdersDbContext, ops: ["find", "update"], fields: ["status", "amount"], partitionField: "shopId" })] })
 * ```
 */
export function ormEntityTools(entity: EntityClass<object>, options: OrmEntityToolsOptions): Class<object>[] {
  const model = ModelBuilder.build(entity);
  const name = options.name ?? entity.name.replace(/(?<=[a-z0-9])[A-Z]/g, (letter) => `-${letter}`).toLowerCase();
  const fail = (problem: string) => new TypeError(`ormEntityTools(${entity.name}): ${problem}`);
  if (!TOOL_NAME_PART.test(name)) throw fail(`${JSON.stringify(name)} cannot be a part of a Tool name`);
  if (!Array.isArray(options.ops) || options.ops.length === 0) throw fail("ops must name at least one operation");
  const keys = model.key.map((property) => property.propertyName);
  for (const field of options.fields) {
    if (model.propertyByName(field) === undefined) throw fail(`it has no field ${field}`);
    if (keys.includes(field)) throw fail(`${field} is the key: it is read without being listed and is never written`);
    if (field === options.partitionField) throw fail(`${field} is the partition field and is not open to processes`);
  }
  if (options.partitionField !== undefined && model.propertyByName(options.partitionField) === undefined) throw fail(`it has no field ${options.partitionField}`);
  const maxRows = limit(options.maxRows, 100, 1000, fail, "maxRows");
  const maxChanges = limit(options.maxChanges, 100, 100_000, fail, "maxChanges");
  const spec: Spec = {
    model,
    entity,
    context: options.context,
    name,
    writable: new Set(options.fields),
    readable: [...keys, ...options.fields],
    partitionField: options.partitionField,
    maxRows,
    maxChanges,
  };
  const callers = options.callers ?? ["workflow"];
  return [...new Set(options.ops)].map((op) => {
    if (!Object.hasOwn(OPERATIONS, op)) throw fail(`unknown operation ${JSON.stringify(op)}`);
    return toolClass(spec, op, callers);
  });
}

function limit(value: number | undefined, fallback: number, max: number, fail: (problem: string) => Error, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fail(`${name} must be an integer 1–${max}`);
  return value;
}

function toolClass(spec: Spec, op: OrmEntityOperation, callers: readonly string[]): Class<object> {
  const { describe, run, sideEffect, input, output } = OPERATIONS[op];

  @Tool({
    name: `orm.${spec.name}.${op}`,
    description: describe(spec.entity.name),
    sideEffect,
    callers,
    dryRun: "supported",
    inputSchema: input(spec),
    outputSchema: output(spec),
  })
  class OrmEntityTool {
    constructor(private readonly services: ServiceProvider) {}

    async execute(raw: unknown, context: AgentToolExecutionContext): Promise<unknown> {
      const db = this.services.resolve(spec.context) as DbContext;
      return await run(spec)(db.setOf(spec.entity), inputOf(raw), context, db);
    }
  }

  registerFrameworkClassDeps([[OrmEntityTool, [ServiceProvider]]]);
  INFO.set(OrmEntityTool, { entity: spec.entity.name, fields: spec.readable });
  return OrmEntityTool;
}

interface Operation {
  readonly describe: (entity: string) => string;
  readonly sideEffect: "read" | "write";
  readonly input: (spec: Spec) => Json;
  readonly output: (spec: Spec) => Json;
  readonly run: (spec: Spec) => Run;
}

const OPERATIONS: Readonly<Record<OrmEntityOperation, Operation>> = {
  find: {
    describe: (entity) => `Finds records of ${entity}.`,
    sideEffect: "read",
    input: (spec) => objectSchema({
      where: whereSchema(spec),
      sort: { type: "array", items: objectSchema({ field: { enum: spec.readable }, dir: { enum: ["asc", "desc"] } }, ["field"]) },
      limit: { type: "integer", minimum: 1, maximum: spec.maxRows },
      offset: { type: "integer", minimum: 0 },
    }),
    output: (spec) => objectSchema({ items: { type: "array", items: recordSchema(spec) }, total: { type: "integer" } }, ["items", "total"]),
    run: (spec) => async (set, input, context) => {
      const where = predicateOf(spec, input.where, context, false);
      const take = pageSize(input.limit, spec.maxRows);
      const skip = offsetOf(input.offset);
      const sorts = sortOf(spec, input.sort);
      let query = set.asNoTracking().where(where);
      const total = await query.count();
      for (const { field, dir } of sorts) {
        query = dir === "desc" ? query.orderByDescending((row) => operandOf(row, field)) : query.orderBy((row) => operandOf(row, field));
      }
      for (const key of spec.model.key) query = query.orderBy((row) => operandOf(row, key.propertyName));
      const rows = await query.skip(skip).take(take).toList();
      return { items: rows.map((row) => recordOf(spec, row)), total };
    },
  },
  create: {
    describe: (entity) => `Creates a record of ${entity}.`,
    sideEffect: "write",
    input: (spec) => objectSchema({ values: valuesSchema(spec) }, ["values"]),
    output: (spec) => objectSchema({ item: recordSchema(spec), dryRun: { type: "boolean" } }, ["item"]),
    run: (spec) => async (set, input, context, db) => {
      const row = Object.assign(new spec.entity(), valuesOf(spec, input.values), spec.partitionField === undefined ? {} : { [spec.partitionField]: partitionOf(context) });
      if (context.dryRun === true) return { item: recordOf(spec, row), dryRun: true };
      set.add(row);
      await db.saveChanges();
      return { item: recordOf(spec, row) };
    },
  },
  update: {
    describe: (entity) => `Changes records of ${entity}.`,
    sideEffect: "write",
    input: (spec) => objectSchema({ where: { ...whereSchema(spec), minProperties: 1 }, values: valuesSchema(spec) }, ["where", "values"]),
    output: () => objectSchema({ updated: { type: "integer" }, dryRun: { type: "boolean" } }, ["updated"]),
    run: (spec) => async (set, input, context, db) => {
      const values = valuesOf(spec, input.values);
      if (Object.keys(values).length === 0) throw invalid("values must name at least one field");
      const where = predicateOf(spec, input.where, context, true);
      return await db.transactionScope(async () => {
        const query = set.asNoTracking().where(where);
        const count = await checkedCount(spec, query);
        if (context.dryRun === true) return { updated: count, dryRun: true };
        const { affectedRows } = await query.executeUpdate(values);
        return { updated: affectedRows };
      });
    },
  },
  delete: {
    describe: (entity) => `Deletes records of ${entity}.`,
    sideEffect: "write",
    input: (spec) => objectSchema({ where: { ...whereSchema(spec), minProperties: 1 } }, ["where"]),
    output: () => objectSchema({ deleted: { type: "integer" }, dryRun: { type: "boolean" } }, ["deleted"]),
    run: (spec) => async (set, input, context, db) => {
      const where = predicateOf(spec, input.where, context, true);
      return await db.transactionScope(async () => {
        const query = set.asNoTracking().where(where);
        const count = await checkedCount(spec, query);
        if (context.dryRun === true) return { deleted: count, dryRun: true };
        const { affectedRows } = await query.executeDelete();
        return { deleted: affectedRows };
      });
    },
  },
};

function invalid(message: string): ToolError {
  return new ToolError(message, { reason: "invalid_input" });
}

function inputOf(raw: unknown): Json {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("the input must be an object");
  return raw as Json;
}

function pageSize(value: unknown, max: number): number {
  if (value === undefined || value === null) return max;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw invalid(`limit must be an integer 1–${max}`);
  return value as number;
}

function offsetOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid("offset must be an integer from 0");
  return value as number;
}

function sortOf(spec: Spec, value: unknown): readonly { readonly field: string; readonly dir: "asc" | "desc" }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("sort must be a list of { field, dir }");
  return value.map((item) => {
    const { field, dir = "asc" } = (item ?? {}) as { field?: unknown; dir?: unknown };
    if (typeof field !== "string" || !spec.readable.includes(field)) throw invalid(`sort: field ${JSON.stringify(field)} is not open`);
    if (dir !== "asc" && dir !== "desc") throw invalid("sort: dir must be asc or desc");
    return { field, dir };
  });
}

function partitionOf(context: AgentToolExecutionContext): string {
  const { partition } = (context.metadata ?? {}) as { partition?: unknown };
  if (typeof partition !== "string" || partition === "") throw new ToolError("This Tool works inside a partition and the call has none", { reason: "partition_required" });
  return partition;
}

function operandOf(row: FieldSelector<object>, field: string): Operand {
  return (row as unknown as Record<string, Operand>)[field]!;
}

/** The filter of a call: its conditions and the partition. `required`: an empty filter would touch everything. */
function predicateOf(spec: Spec, value: unknown, context: AgentToolExecutionContext, required: boolean): (row: FieldSelector<object>) => Predicate {
  const where = value === undefined || value === null ? {} : value;
  if (typeof where !== "object" || Array.isArray(where)) throw invalid("where must be an object: { field: value } or { field: { op: value } }");
  const conditions = Object.entries(where as Json);
  if (required && conditions.length === 0) throw invalid("where must name at least one field");
  const partition = spec.partitionField === undefined ? undefined : partitionOf(context);
  const tests = conditions.flatMap(([field, test]) => {
    const property = spec.readable.includes(field) ? spec.model.propertyByName(field) : undefined;
    if (property === undefined) throw invalid(`where: field ${JSON.stringify(field)} is not open`);
    const operators = typeof test === "object" && test !== null && !Array.isArray(test) ? Object.entries(test as Json) : [["eq", test] as const];
    if (operators.length === 0) throw invalid(`where.${field} names no operator`);
    return operators.map(([op, operand]) => {
      if (!OPERATORS.has(op)) throw invalid(`where.${field}: unknown operator ${JSON.stringify(op)}`);
      return { field, op, operand: operandValue(property, op, operand, field) };
    });
  });
  return (row) => {
    let result: Predicate | undefined = partition === undefined ? undefined : operandOf(row, spec.partitionField!).eq(partition);
    for (const { field, op, operand } of tests) {
      const next = applyOperator(operandOf(row, field), op, operand);
      result = result === undefined ? next : result.and(next);
    }
    // `1 = 1` has no form here: a key never empty is what "everything" means.
    return result ?? operandOf(row, spec.model.key[0].propertyName).isNotNull();
  };
}

function operandValue(property: PropertyModel, op: string, value: unknown, field: string): unknown {
  if (op === "isNull") {
    if (typeof value !== "boolean") throw invalid(`where.${field}.isNull must be true or false`);
    return value;
  }
  if (op === "in" || op === "nin") {
    if (!Array.isArray(value)) throw invalid(`where.${field}.${op} must be a list`);
    return value.map((item) => columnValue(property, item, `where.${field}`));
  }
  if (op === "contains" || op === "startsWith") {
    if (typeof value !== "string") throw invalid(`where.${field}.${op} must be a string`);
    return value;
  }
  return columnValue(property, value, `where.${field}`);
}

function applyOperator(operand: Operand, op: string, value: unknown): Predicate {
  switch (op) {
    case "ne": return value === null ? operand.isNotNull() : operand.ne(value as never);
    case "gt": return operand.gt(value as never);
    case "gte": return operand.gte(value as never);
    case "lt": return operand.lt(value as never);
    case "lte": return operand.lte(value as never);
    case "in": return operand.in(value as never[]);
    case "nin": return operand.in(value as never[]).not();
    case "contains": return operand.contains(value as string);
    case "startsWith": return operand.startsWith(value as string);
    case "isNull": return value === true ? operand.isNull() : operand.isNotNull();
    default: return value === null ? operand.isNull() : operand.eq(value as never);
  }
}

/** A JSON value as the column takes it. */
function columnValue(property: PropertyModel, value: unknown, at: string): unknown {
  if (value === null) {
    if (property.required && !at.startsWith("where")) throw invalid(`${at} cannot be null`);
    return null;
  }
  switch (property.type) {
    case "integer":
      if (!Number.isSafeInteger(value)) throw invalid(`${at} must be an integer`);
      return value;
    case "real":
    case "decimal":
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`${at} must be a number`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw invalid(`${at} must be true or false`);
      return value;
    case "datetime": {
      const date = typeof value === "string" ? new Date(value) : undefined;
      if (date === undefined || Number.isNaN(date.getTime())) throw invalid(`${at} must be a date`);
      return date;
    }
    case "json":
      return value;
    default:
      if (typeof value !== "string") throw invalid(`${at} must be a string`);
      return value;
  }
}

function valuesOf(spec: Spec, value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("values must be an object");
  const out: Json = {};
  for (const [field, item] of Object.entries(value)) {
    if (!spec.writable.has(field)) throw invalid(`values: field ${JSON.stringify(field)} is not open for writing`);
    out[field] = columnValue(spec.model.propertyByName(field)!, item, `values.${field}`);
  }
  return out;
}

async function checkedCount(spec: Spec, query: { count(): Promise<number> }): Promise<number> {
  const count = await query.count();
  if (count > spec.maxChanges) throw new ToolError(`The filter takes ${count} records of ${spec.entity.name}, at most ${spec.maxChanges} may change at once`, { reason: "too_many_records" });
  return count;
}

/** What goes back to the process: open fields only, in JSON. */
function recordOf(spec: Spec, row: object): Json {
  const source = row as Json;
  return Object.fromEntries(spec.readable.map((field) => {
    const value = source[field];
    return [field, value instanceof Date ? value.toISOString() : typeof value === "bigint" ? value.toString() : value ?? null];
  }));
}

function objectSchema(properties: Json, required: readonly string[] = []): Json {
  return { type: "object", properties, additionalProperties: false, ...(required.length === 0 ? {} : { required }) };
}

function columnSchema(property: PropertyModel): Json {
  const nullable = (type: string): Json => ({ type: !property.required ? [type, "null"] : type });
  switch (property.type) {
    case "integer": return nullable("integer");
    case "real":
    case "decimal": return nullable("number");
    case "boolean": return nullable("boolean");
    case "datetime": return { ...nullable("string"), format: "date-time" };
    case "json": return {};
    default: return nullable("string");
  }
}

function whereSchema(spec: Spec): Json {
  return {
    type: "object",
    description: "{ field: value } or { field: { op: value } }; ops: eq, ne, gt, gte, lt, lte, in, nin, contains, startsWith, isNull",
    "x-ref-keys": "orm.field",
    "x-ref-scope": spec.entity.name,
    properties: Object.fromEntries(spec.readable.map((field) => [field, {}])),
    additionalProperties: false,
  };
}

function valuesSchema(spec: Spec): Json {
  return {
    type: "object",
    "x-ref-keys": "orm.field",
    "x-ref-scope": spec.entity.name,
    properties: Object.fromEntries([...spec.writable].map((field) => [field, columnSchema(spec.model.propertyByName(field)!)])),
    additionalProperties: false,
  };
}

function recordSchema(spec: Spec): Json {
  return objectSchema(Object.fromEntries(spec.readable.map((field) => [field, columnSchema(spec.model.propertyByName(field)!)])));
}

