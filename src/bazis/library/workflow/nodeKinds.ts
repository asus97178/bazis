import { parseCron } from "./cron";
import { FIELD_NAME, checkFormSpec } from "./formFields";
import { DATA_PATH } from "./paths";
import type { NodeKind } from "./ProcessDocument";

/** The role of a node in the graph: it sets the rules of incoming and outgoing flows. */
export type NodeRole = "start" | "activity" | "gateway" | "boundary" | "end";

/** A JSON Schema, as the palette gives it to a designer. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface NodeKindDefinition {
  readonly kind: NodeKind;
  readonly role: NodeRole;
  /** Checks the node `config`; returns a problem or `null`. */
  readonly check: (config: Record<string, unknown>) => string | null;
  /** The node `config` as a JSON Schema: what a designer builds the form of a step from. */
  readonly config: JsonSchema;
}

/** ISO 8601 duration without months and years: P1D, PT2H30M, PT45S. */
export const ISO_DURATION = /^P(?!$)(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;
/** An event key or a Tool name: `payments.received`, `payments.charge`. */
export const DOTTED_KEY = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
/** A parameter of a Tool. */
const PARAMETER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ROLE = /^[a-z][a-z0-9_.-]{0,63}$/;
const USER = /^[^\s:][^\s]{0,127}$/;

const none = () => null;

function string(config: Record<string, unknown>, key: string, pattern: RegExp, required = true): string | null {
  const value = config[key];
  if (value === undefined) return required ? `config.${key} is required` : null;
  return typeof value === "string" && pattern.test(value) && value !== "__proto__" ? null : `config.${key} is invalid`;
}

function boolean(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return value === undefined || typeof value === "boolean" ? null : `config.${key} must be a boolean`;
}

function first(...checks: (string | null)[]): string | null {
  return checks.find((check) => check !== null) ?? null;
}

/** Five cron fields: minute, hour, day of month, month, day of week. */
function cron(config: Record<string, unknown>): string | null {
  const value = config.cron;
  if (typeof value !== "string") return "config.cron is required";
  return parseCron(value) === undefined ? "config.cron must be five valid fields: minute hour day month weekday (UTC)" : null;
}

/** A timer: either `duration` (ISO 8601) or `at`, a path to a date in instance data. */
function timer(config: Record<string, unknown>): string | null {
  const hasDuration = config.duration !== undefined;
  const hasAt = config.at !== undefined;
  if (hasDuration === hasAt) return "config needs exactly one of duration or at";
  return hasDuration ? string(config, "duration", ISO_DURATION) : string(config, "at", DATA_PATH);
}

/** Who gets a user task: a role code or a user id. */
function assignee(config: Record<string, unknown>): string | null {
  const value = config.assignee;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "config.assignee is required";
  const target = value as Record<string, unknown>;
  if (Object.keys(target).length !== 1) return "config.assignee needs exactly one of role or user";
  if (typeof target.role === "string") return ROLE.test(target.role) ? null : "config.assignee.role is invalid";
  if (typeof target.user === "string") return USER.test(target.user) ? null : "config.assignee.user is invalid";
  return "config.assignee needs exactly one of role or user";
}

function form(config: Record<string, unknown>): string | null {
  return config.form === undefined ? null : checkFormSpec(config.form, "config.form");
}

/** Tool input: parameter name → instance path or literal. */
function inputMapping(config: Record<string, unknown>): string | null {
  const value = config.input;
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "config.input must be an object";
  return Object.keys(value).every((key) => PARAMETER.test(key)) ? null : "config.input has an invalid parameter name";
}

/** Automatic retries of a failed Tool call. */
function retry(config: Record<string, unknown>): string | null {
  const value = config.retry;
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "config.retry must be an object";
  const policy = value as Record<string, unknown>;
  if (!Number.isSafeInteger(policy.maxAttempts) || (policy.maxAttempts as number) < 1 || (policy.maxAttempts as number) > 10) return "config.retry.maxAttempts must be 1–10";
  if (policy.growth !== undefined && policy.growth !== "fixed" && policy.growth !== "exponential") return "config.retry.growth must be fixed or exponential";
  if (policy.factor !== undefined) {
    if (policy.growth === "fixed") return "config.retry.factor is only for exponential growth";
    if (typeof policy.factor !== "number" || !(policy.factor >= 1) || policy.factor > 100) return "config.retry.factor must be a number 1–100";
  }
  return string(policy, "backoff", ISO_DURATION, false)?.replace("config.", "config.retry.") ?? null;
}

/** What a failed Tool step does when no error boundary takes it. */
function onError(config: Record<string, unknown>): string | null {
  return config.onError === undefined || config.onError === "fail" || config.onError === "skip" ? null : "config.onError must be fail or skip";
}

/** The shape of an `assign` step; its variables and expressions are checked with the whole document. */
function assignments(config: Record<string, unknown>): string | null {
  const list = config.assignments;
  if (!Array.isArray(list) || list.length === 0) return "config.assignments must be a non-empty list";
  for (const [index, item] of list.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return `config.assignments[${index}] must be an object`;
    const { var: name, value } = item as { var?: unknown; value?: unknown };
    if (typeof name !== "string" || !FIELD_NAME.test(name)) return `config.assignments[${index}].var is invalid`;
    if (value === undefined) return `config.assignments[${index}].value is required`;
  }
  return null;
}

const duration = { type: "string", format: "duration" };
const text = { type: "string" };
const dataPath = { type: "string", pattern: DATA_PATH.source };
const saveTo = { type: "string", pattern: FIELD_NAME.source };
const expression = { description: "An expression: a JSON literal, { path } or { op, args }" };
const flag = { type: "boolean" };
const object = (properties: Record<string, unknown>, required: readonly string[] = []): JsonSchema => ({ type: "object", properties, ...(required.length === 0 ? {} : { required }) });
const timerConfig = { duration, at: dataPath };
const fields = { type: "object", properties: { fields: { type: "array", items: { type: "object" } } }, required: ["fields"] };

export const NODE_KINDS: readonly NodeKindDefinition[] = Object.freeze([
  { kind: "manualStart", role: "start", check: none, config: object({}) },
  { kind: "scheduleStart", role: "start", check: cron, config: object({ cron: text }, ["cron"]) },
  { kind: "eventStart", role: "start", check: (c) => string(c, "event", DOTTED_KEY), config: object({ event: text }, ["event"]) },
  {
    kind: "userTask",
    role: "activity",
    check: (c) => first(assignee(c), form(c), string(c, "dueIn", ISO_DURATION, false), string(c, "saveTo", FIELD_NAME, false)),
    config: object({ assignee: object({ role: text, user: text }), form: fields, dueIn: duration, saveTo }, ["assignee"]),
  },
  {
    kind: "serviceTask",
    role: "activity",
    check: (c) => first(string(c, "tool", DOTTED_KEY), inputMapping(c), string(c, "saveTo", FIELD_NAME, false), retry(c), string(c, "timeout", ISO_DURATION, false), onError(c)),
    config: object({
      tool: text,
      input: { type: "object", description: "Parameter → a literal, a path string or an expression" },
      saveTo,
      timeout: duration,
      retry: object({ maxAttempts: { type: "integer", minimum: 1, maximum: 10 }, backoff: duration, growth: { enum: ["fixed", "exponential"] }, factor: { type: "number", minimum: 1, maximum: 100 } }, ["maxAttempts"]),
      onError: { enum: ["fail", "skip"] },
    }, ["tool"]),
  },
  {
    kind: "assign",
    role: "activity",
    check: assignments,
    config: object({ assignments: { type: "array", minItems: 1, items: object({ var: { type: "string", pattern: FIELD_NAME.source }, value: expression }, ["var", "value"]) } }, ["assignments"]),
  },
  { kind: "timerCatch", role: "activity", check: timer, config: object(timerConfig) },
  {
    kind: "eventWait",
    role: "activity",
    check: (c) => first(string(c, "event", DOTTED_KEY), string(c, "correlation", DATA_PATH, false), string(c, "saveTo", FIELD_NAME, false)),
    config: object({ event: text, correlation: dataPath, saveTo }, ["event"]),
  },
  { kind: "exclusiveGateway", role: "gateway", check: none, config: object({}) },
  { kind: "parallelGateway", role: "gateway", check: none, config: object({}) },
  { kind: "boundaryError", role: "boundary", check: (c) => string(c, "errorCode", /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, false), config: object({ errorCode: text }) },
  { kind: "boundaryTimer", role: "boundary", check: (c) => first(timer(c), boolean(c, "interrupting")), config: object({ ...timerConfig, interrupting: flag }) },
  {
    kind: "boundaryEvent",
    role: "boundary",
    check: (c) => first(string(c, "event", DOTTED_KEY), string(c, "correlation", DATA_PATH, false), boolean(c, "interrupting")),
    config: object({ event: text, correlation: dataPath, interrupting: flag }, ["event"]),
  },
  { kind: "end", role: "end", check: none, config: object({}) },
] satisfies NodeKindDefinition[]);

const BY_KIND = new Map(NODE_KINDS.map((definition) => [definition.kind, definition]));

/** The definition of a node kind, or `undefined` for an unknown kind. */
export function nodeKindOf(kind: unknown): NodeKindDefinition | undefined {
  return typeof kind === "string" ? BY_KIND.get(kind as NodeKind) : undefined;
}
