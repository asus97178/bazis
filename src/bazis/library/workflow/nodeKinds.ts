import { checkFormSpec } from "./formFields";
import { DATA_PATH } from "./paths";
import type { NodeKind } from "./ProcessDocument";

/** The role of a node in the graph: it sets the rules of incoming and outgoing flows. */
export type NodeRole = "start" | "activity" | "gateway" | "boundary" | "end";

export interface NodeKindDefinition {
  readonly kind: NodeKind;
  readonly role: NodeRole;
  /** Checks the node `config`; returns a problem or `null`. */
  readonly check: (config: Record<string, unknown>) => string | null;
}

/** ISO 8601 duration without months and years: P1D, PT2H30M, PT45S. */
export const ISO_DURATION = /^P(?!$)(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;
/** An event key or a Tool name: `payments.received`, `payments.charge`. */
export const DOTTED_KEY = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
/** A process variable name. */
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
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
  const parts = value.trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => /^[\d*/,\-]+$/.test(part)) ? null : "config.cron must have five fields";
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
  return Object.keys(value).every((key) => VAR_NAME.test(key)) ? null : "config.input has an invalid parameter name";
}

/** Automatic retries of a failed Tool call. */
function retry(config: Record<string, unknown>): string | null {
  const value = config.retry;
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "config.retry must be an object";
  const policy = value as Record<string, unknown>;
  if (!Number.isSafeInteger(policy.maxAttempts) || (policy.maxAttempts as number) < 1 || (policy.maxAttempts as number) > 10) return "config.retry.maxAttempts must be 1–10";
  return string(policy, "backoff", ISO_DURATION, false)?.replace("config.", "config.retry.") ?? null;
}

export const NODE_KINDS: readonly NodeKindDefinition[] = Object.freeze([
  { kind: "manualStart", role: "start", check: none },
  { kind: "scheduleStart", role: "start", check: cron },
  { kind: "eventStart", role: "start", check: (c) => string(c, "event", DOTTED_KEY) },
  { kind: "userTask", role: "activity", check: (c) => first(assignee(c), form(c), string(c, "dueIn", ISO_DURATION, false)) },
  { kind: "serviceTask", role: "activity", check: (c) => first(string(c, "tool", DOTTED_KEY), inputMapping(c), string(c, "saveTo", VAR_NAME, false), retry(c)) },
  { kind: "timerCatch", role: "activity", check: timer },
  { kind: "eventWait", role: "activity", check: (c) => first(string(c, "event", DOTTED_KEY), string(c, "correlation", DATA_PATH, false), string(c, "saveTo", VAR_NAME, false)) },
  { kind: "exclusiveGateway", role: "gateway", check: none },
  { kind: "parallelGateway", role: "gateway", check: none },
  { kind: "boundaryError", role: "boundary", check: (c) => string(c, "errorCode", /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, false) },
  { kind: "boundaryTimer", role: "boundary", check: (c) => first(timer(c), boolean(c, "interrupting")) },
  { kind: "boundaryEvent", role: "boundary", check: (c) => first(string(c, "event", DOTTED_KEY), boolean(c, "interrupting")) },
  { kind: "end", role: "end", check: none },
] satisfies NodeKindDefinition[]);

const BY_KIND = new Map(NODE_KINDS.map((definition) => [definition.kind, definition]));

/** The definition of a node kind, or `undefined` for an unknown kind. */
export function nodeKindOf(kind: unknown): NodeKindDefinition | undefined {
  return typeof kind === "string" ? BY_KIND.get(kind as NodeKind) : undefined;
}
