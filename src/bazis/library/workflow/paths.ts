import { evaluateExpression, isExpressionNode } from "./expressions";

/**
 * What expressions and step inputs read. `input`, `vars` and `nodes` are the
 * instance's own data; the rest describes the run. The engine fills them all.
 */
export interface InstanceData {
  readonly input: Readonly<Record<string, unknown>>;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly nodes: Readonly<Record<string, unknown>>;
  /** The data of the event that started or continued the process. */
  readonly event?: unknown;
  /** How it was started: `{ via, at, actor, eventKey?, cause?, scheduledAt? }`. */
  readonly trigger?: unknown;
  /** `{ id, processKey, version, partition, test }`. */
  readonly run?: unknown;
  /** The engine's time as an ISO string. */
  readonly now?: string;
  /** Inside a loop body: the element of this iteration. */
  readonly item?: unknown;
  /** Inside a loop body: the number of this iteration, from 0. */
  readonly index?: number;
  /** Only while the input of a Tool is resolved: the values of `$secrets.NAME`. */
  readonly secrets?: Readonly<Record<string, string>>;
}

/** `$input.amount`, `$vars.payment.id`, `$nodes.Pay.paymentId`, `$event.record.id`, `$run.partition`, `$now`, `$item.id`, `$index`. */
export const DATA_PATH = /^\$(input|vars|nodes|event|trigger|run|now|item|index|secrets)((\.[A-Za-z_][A-Za-z0-9_]*)*)$/;

/** The roots of `$` paths, for a designer. */
export const DATA_PATHS: readonly { readonly path: string; readonly description: string }[] = Object.freeze([
  { path: "$input.<field>", description: "A field of the process input: a variable with direction in" },
  { path: "$vars.<name>", description: "A variable of the process" },
  { path: "$nodes.<node>.<field>", description: "The result of a passed step" },
  { path: "$event", description: "The data of the event that started or continued the process" },
  { path: "$trigger", description: "How it was started: { via, at, actor, eventKey?, cause?, scheduledAt? }" },
  { path: "$run", description: "This run: { id, processKey, version, partition, test }" },
  { path: "$now", description: "The engine's time" },
  { path: "$item", description: "Inside a loop body: the element of this iteration" },
  { path: "$index", description: "Inside a loop body: the number of this iteration, from 0" },
  { path: "$secrets.<name>", description: "Only in the input of a Tool: the value of a secret, which goes nowhere else" },
]);

/** The secrets a Tool input names, in paths and expressions at any depth. */
export function secretNames(input: unknown): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^\$secrets\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
      if (match) names.add(match[1]!);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  walk(input);
  return [...names];
}

/** `true` if the value is a path to instance data. */
export function isPath(value: unknown): value is string {
  return typeof value === "string" && DATA_PATH.test(value);
}

/** The value at a path, or `undefined`. Only own keys are read, never `__proto__` and the like. */
export function readPath(data: InstanceData, path: string): unknown {
  const match = DATA_PATH.exec(path);
  if (!match) return undefined;
  let current: unknown = data[match[1] as keyof InstanceData];
  for (const key of match[2]!.split(".").slice(1)) {
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * A step input: a path string and an expression become their value, objects and
 * lists are resolved deeply, anything else is a literal. A missing value becomes `null`.
 */
export function resolveInput(value: unknown, data: InstanceData): unknown {
  if (isPath(value)) return readPath(data, value) ?? null;
  if (isExpressionNode(value)) return evaluateExpression(value, data) ?? null;
  if (Array.isArray(value)) return value.map((item) => resolveInput(item, data));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, data)]));
  }
  return value;
}
