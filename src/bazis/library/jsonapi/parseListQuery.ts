import { ListQueryError, type ListQueryProblem } from "./ListQueryError";
import type {
  FilterGroup,
  FilterOperator,
  FilterRule,
  ListQuery,
  ListQueryOptions,
  PageParams,
  SortDirection,
  SortField,
} from "./types";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const FILTER_OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "contains",
  "startsWith",
  "endsWith",
  "in",
  "nin",
  "isNull",
  "isNotNull",
]);

const VALUELESS_OPERATORS: ReadonlySet<FilterOperator> = new Set(["isNull", "isNotNull"]);
const MULTI_VALUE_OPERATORS: ReadonlySet<FilterOperator> = new Set(["in", "nin"]);

/** `filter[field]` or `filter[field][op]`. */
const FILTER_KEY = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;
/** `filter[or][N][field]` or `filter[or][N][field][op]` (N is the OR group index). */
const FILTER_OR_KEY = /^filter\[or\]\[(\d+)\]\[([^\]]+)\](?:\[([^\]]+)\])?$/;
/** `fields[type]`. */
const FIELDS_KEY = /^fields\[([^\]]+)\]$/;

/**
 * Parses JSON:API-style query parameters into a typed {@link ListQuery}.
 *
 * Secure by default: sorting/filtering/include are allowed only for fields
 * from {@link ListQueryOptions}; anything else produces a {@link ListQueryError}
 * (with the list of all problems at once).
 *
 * ```ts
 * const query = parseListQuery(url.searchParams, {
 *   sort: ["name", "createdAt"],
 *   filter: { age: ["gte", "lte"], name: ["contains"] },
 *   page: { defaultSize: 20, maxSize: 100 },
 * });
 * ```
 */
export function parseListQuery(params: URLSearchParams, options: ListQueryOptions = {}): ListQuery {
  const problems: ListQueryProblem[] = [];

  const sort = parseSort(params, options, problems);
  const filters = parseFilters(params, options, problems);
  const or = parseOrGroups(params, options, problems);
  const page = parsePage(params, options, problems);
  const include = parseInclude(params, options, problems);
  const fields = parseFields(params);

  if (problems.length > 0) {
    throw new ListQueryError(problems);
  }
  return { sort, filters, or, page, include, fields };
}

function parseSort(
  params: URLSearchParams,
  options: ListQueryOptions,
  problems: ListQueryProblem[],
): SortField[] {
  const result: SortField[] = [];
  const requested = splitCsv(params.getAll("sort"));
  const tokens = requested.length === 0 && options.defaultSort !== undefined ? splitCsv([options.defaultSort]) : requested;
  for (const token of tokens) {
    const dir: SortDirection = token.startsWith("-") ? "desc" : "asc";
    const field = token.replace(/^[-+]/, "");
    if (field === "") {
      problems.push({ parameter: "sort", message: `empty sort field in "${token}"` });
      continue;
    }
    if (!options.sort?.includes(field)) {
      problems.push({ parameter: "sort", message: `sorting by "${field}" is not allowed` });
      continue;
    }
    result.push({ field, dir });
  }
  return result;
}

function parseFilters(
  params: URLSearchParams,
  options: ListQueryOptions,
  problems: ListQueryProblem[],
): FilterRule[] {
  const result: FilterRule[] = [];
  for (const [key, rawValue] of params) {
    const match = FILTER_KEY.exec(key);
    if (!match) {
      continue;
    }
    const field = match[1]!;
    const opToken = match[2] ?? "eq";
    const parameter = match[2] ? `filter[${field}][${opToken}]` : `filter[${field}]`;
    const rule = parseFilterLeaf(field, opToken, rawValue, parameter, options, problems);
    if (rule !== undefined) {
      result.push(rule);
    }
  }
  return result;
}

/**
 * Parses OR groups `filter[or][N][field][op]=v`. Conditions with the same `N`
 * form a group (AND); groups are returned in ascending `N` order (different
 * groups are OR). Each leaf is validated against the same allow list as the
 * top-level filters.
 */
function parseOrGroups(
  params: URLSearchParams,
  options: ListQueryOptions,
  problems: ListQueryProblem[],
): FilterGroup[] {
  const groups = new Map<number, FilterRule[]>();
  for (const [key, rawValue] of params) {
    const match = FILTER_OR_KEY.exec(key);
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    const field = match[2]!;
    const opToken = match[3] ?? "eq";
    const parameter = match[3]
      ? `filter[or][${index}][${field}][${opToken}]`
      : `filter[or][${index}][${field}]`;
    const rule = parseFilterLeaf(field, opToken, rawValue, parameter, options, problems);
    if (rule !== undefined) {
      const group = groups.get(index) ?? [];
      group.push(rule);
      groups.set(index, group);
    }
  }
  return [...groups.keys()].sort((a, b) => a - b).map((key) => groups.get(key)!);
}

/** Parses and validates one filter condition (`field`/`op`/`value`). */
function parseFilterLeaf(
  field: string,
  opToken: string,
  rawValue: string,
  parameter: string,
  options: ListQueryOptions,
  problems: ListQueryProblem[],
): FilterRule | undefined {
  if (!FILTER_OPERATORS.has(opToken)) {
    problems.push({ parameter, message: `unknown filter operator "${opToken}"` });
    return undefined;
  }
  const op = opToken as FilterOperator;

  const allowedOps = options.filter?.[field];
  if (!allowedOps) {
    problems.push({ parameter, message: `filtering by "${field}" is not allowed` });
    return undefined;
  }
  if (!allowedOps.includes(op)) {
    problems.push({ parameter, message: `operator "${op}" is not allowed for "${field}"` });
    return undefined;
  }

  if (VALUELESS_OPERATORS.has(op)) {
    return { field, op, value: "" };
  }
  if (MULTI_VALUE_OPERATORS.has(op)) {
    const values = rawValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (values.length === 0) {
      problems.push({ parameter, message: `operator "${op}" needs a non-empty comma-separated list` });
      return undefined;
    }
    return { field, op, value: values };
  }
  return { field, op, value: rawValue };
}

function parsePage(
  params: URLSearchParams,
  options: ListQueryOptions,
  problems: ListQueryProblem[],
): PageParams {
  const maxSize = options.page?.maxSize ?? MAX_PAGE_SIZE;
  const defaultSize = clamp(options.page?.defaultSize ?? DEFAULT_PAGE_SIZE, 1, maxSize);

  const requestedSize = parsePositiveInt(params.get("page[size]") ?? params.get("page[limit]"), "page[size]", problems);
  const size = requestedSize === undefined ? defaultSize : clamp(requestedSize, 1, maxSize);

  const offsetRaw = params.get("page[offset]");
  if (offsetRaw !== null && offsetRaw !== "") {
    const offset = parseNonNegativeInt(offsetRaw, "page[offset]", problems) ?? 0;
    return { number: Math.floor(offset / size) + 1, size, offset, limit: size };
  }

  const number = parsePositiveInt(params.get("page[number]"), "page[number]", problems) ?? 1;
  return { number, size, offset: (number - 1) * size, limit: size };
}

function parseInclude(
  params: URLSearchParams,
  options: ListQueryOptions,
  problems: ListQueryProblem[],
): string[] {
  const result: string[] = [];
  for (const path of splitCsv(params.getAll("include"))) {
    if (!options.include?.includes(path)) {
      problems.push({ parameter: "include", message: `include "${path}" is not allowed` });
      continue;
    }
    result.push(path);
  }
  return result;
}

function parseFields(params: URLSearchParams): Record<string, readonly string[]> {
  const fields: Record<string, string[]> = {};
  for (const [key, value] of params) {
    const match = FIELDS_KEY.exec(key);
    if (!match) {
      continue;
    }
    const type = match[1]!;
    const list = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    fields[type] = (fields[type] ?? []).concat(list);
  }
  return fields;
}

function splitCsv(values: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const value of values) {
    for (const token of value.split(",")) {
      const trimmed = token.trim();
      if (trimmed !== "") {
        tokens.push(trimmed);
      }
    }
  }
  return tokens;
}

function parsePositiveInt(
  raw: string | null,
  parameter: string,
  problems: ListQueryProblem[],
): number | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    problems.push({ parameter, message: "must be a positive integer" });
    return undefined;
  }
  return value;
}

function parseNonNegativeInt(
  raw: string,
  parameter: string,
  problems: ListQueryProblem[],
): number | undefined {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    problems.push({ parameter, message: "must be a non-negative integer" });
    return undefined;
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
