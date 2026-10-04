import type { FilterRule, ListQuery } from "../../library/jsonapi";
import type { ColumnType, EntityModel, EntityQuery, FieldSelector, Operand, Predicate } from "../../library/orm";
import { OrmError } from "../../library/orm";

const MAX_ORM_PAGE_SIZE = 1_000;
const MAX_ORM_PAGE_OFFSET = 10_000_000;

/** Страница результата: элементы и общее число записей (с учётом фильтров). */
export interface PageResult<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/**
 * Применяет универсальный {@link ListQuery} (фильтры/сортировка/пагинация) к
 * ORM-запросу и возвращает страницу элементов вместе с общим числом записей.
 *
 * `total` считается отдельным `count()` с теми же фильтрами, но без пагинации —
 * чтобы клиент мог построить навигацию по страницам.
 *
 * Имена полей в `ListQuery` уже провалидированы парсером по белому списку
 * (`parseListQuery`), поэтому здесь они применяются напрямую. SQL всегда
 * параметризован движком ORM — пользовательские значения не попадают в текст.
 *
 * ```ts
 * const { items, total } = await paginate(repo.query(), query);
 * return buildListDocument(items, query, total, { basePath: "/api/users" });
 * ```
 */
export async function paginate<T extends object, R = T>(
  query: EntityQuery<T, R>,
  list: ListQuery,
): Promise<PageResult<R>> {
  validatePage(list);
  const model = queryModel(query);
  const hasFilter = list.filters.length > 0 || list.or.length > 0;
  const filtered = hasFilter ? query.where((entity) => buildWhere(entity, list, model)) : query;

  const total = await filtered.count();

  let paged = filtered;
  for (const sort of list.sort) {
    paged =
      sort.dir === "desc"
        ? paged.orderByDescending((entity) => fieldOperand(entity, sort.field))
        : paged.orderBy((entity) => fieldOperand(entity, sort.field));
  }

  // Pagination without every primary-key component as a tiebreaker is
  // unstable: rows with equal sort values can move between pages.  `key` is
  // deliberately absent for composite models, so the ordered `primaryKey`
  // metadata is the authority here.
  for (const keyField of primaryKeyFields(model)) {
    if (!list.sort.some((sort) => sort.field === keyField)) {
      paged = paged.orderBy((entity) => fieldOperand(entity, keyField));
    }
  }

  const items = await paged.skip(list.page.offset).take(list.page.limit).toList();
  return { items, total };
}

function validatePage(list: ListQuery): void {
  const { limit, offset, number, size } = list.page;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ORM_PAGE_SIZE) {
    throw new OrmError(`List page limit must be an integer between 1 and ${MAX_ORM_PAGE_SIZE}.`);
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ORM_PAGE_SIZE) {
    throw new OrmError(`List page size must be an integer between 1 and ${MAX_ORM_PAGE_SIZE}.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_ORM_PAGE_OFFSET) {
    throw new OrmError(`List page offset must be an integer between 0 and ${MAX_ORM_PAGE_OFFSET}.`);
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new OrmError("List page number must be a positive integer.");
  }
}

function queryModel<T extends object, R>(query: EntityQuery<T, R>): EntityModel {
  // EntityQuery intentionally keeps its model protected. The core integration
  // reads the stable metadata contract for typed filters and deterministic order.
  return (query as unknown as { readonly model: EntityModel }).model;
}

function primaryKeyFields(model: EntityModel): readonly string[] {
  if (model.key.length === 0) {
    throw new OrmError("List pagination requires an entity primary key.");
  }
  return model.key.map((property) => property.propertyName);
}

/**
 * Строит итоговый предикат: `filters` (AND) и OR-группы (`(g0) OR (g1) OR ...`),
 * объединённые между собой через AND: `filters AND (g0 OR g1 ...)`.
 * Вызывается только когда есть хотя бы одно условие (см. `hasFilter` в paginate).
 */
function buildWhere<T extends object>(entity: FieldSelector<T>, list: ListQuery, model: EntityModel): Predicate {
  const base = combineAnd(entity, list.filters, model);

  let orCombined: Predicate | undefined;
  for (const group of list.or) {
    const groupPredicate = combineAnd(entity, group, model);
    if (groupPredicate === undefined) {
      continue;
    }
    orCombined = orCombined === undefined ? groupPredicate : orCombined.or(groupPredicate);
  }

  if (base === undefined) {
    return orCombined as Predicate;
  }
  return orCombined === undefined ? base : base.and(orCombined);
}

function combineAnd<T extends object>(
  entity: FieldSelector<T>,
  rules: readonly FilterRule[],
  model: EntityModel,
): Predicate | undefined {
  let combined: Predicate | undefined;
  for (const rule of rules) {
    const predicate = applyRule(fieldOperand(entity, rule.field), rule, model.propertyByName(rule.field)?.type);
    combined = combined === undefined ? predicate : combined.and(predicate);
  }
  return combined;
}

function applyRule(operand: Operand, rule: FilterRule, type: ColumnType | undefined): Predicate {
  switch (rule.op) {
    case "eq":
      return operand.eq(coerce(asScalar(rule.value), type));
    case "ne":
      return operand.ne(coerce(asScalar(rule.value), type));
    case "gt":
      return operand.gt(coerce(asScalar(rule.value), type));
    case "gte":
      return operand.gte(coerce(asScalar(rule.value), type));
    case "lt":
      return operand.lt(coerce(asScalar(rule.value), type));
    case "lte":
      return operand.lte(coerce(asScalar(rule.value), type));
    case "like":
      return operand.like(asScalar(rule.value));
    case "contains":
      return operand.contains(asScalar(rule.value));
    case "startsWith":
      return operand.startsWith(asScalar(rule.value));
    case "endsWith":
      return operand.endsWith(asScalar(rule.value));
    case "in":
      return operand.in(asArray(rule.value).map((value) => coerce(value, type)));
    case "nin":
      return operand.in(asArray(rule.value).map((value) => coerce(value, type))).not();
    case "isNull":
      return operand.isNull();
    case "isNotNull":
      return operand.isNotNull();
  }
}

function fieldOperand<T extends object>(entity: FieldSelector<T>, field: string): Operand {
  return (entity as Record<string, Operand>)[field] as Operand;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/**
 * Тип выбирается по колонке: текстовые значения нельзя пропускать через Number,
 * иначе теряются ведущие нули и точность. Конвертер и диалект применяются позже.
 */
function coerce(value: string, type: ColumnType | undefined): string | number | bigint | boolean {
  if (type !== "integer" && type !== "real" && type !== "boolean") {
    return value;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (value !== "" && NUMERIC.test(value)) {
    const numeric = Number(value);
    if (type === "integer" && INTEGER.test(value) && !Number.isSafeInteger(numeric)) {
      return BigInt(value);
    }
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return value;
}

function asScalar(value: string | readonly string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value as string);
}

function asArray(value: string | readonly string[]): string[] {
  return Array.isArray(value) ? [...value] : [value as string];
}
